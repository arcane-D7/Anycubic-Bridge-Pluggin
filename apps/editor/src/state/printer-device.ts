/**
 * S9.9-003 — printer device store: adaptive polling + stale-while-revalidate.
 *
 * Thin zustand store over the polling DECISION helpers in
 * `printer-device-core.ts` (pure, headless). Polls the MCP server via the
 * bridge lane for the ACTIVE printer's full snapshot.
 *
 * Caching/staleness: every snapshot gets `capturedAt`; on fetch failure the
 * LAST GOOD snapshot is kept and `pollingStatus` flips to `stale`/`offline`
 * (stale-while-revalidate — the UI never blanks). The fetcher is injectable
 * (`setFetcher`) so tests and the real MCP lane can both drive it.
 */

import { create } from "zustand";
import type { PrinterSnapshot } from "../bridge/types.ts";
import {
  intervalFor,
  modeFromState,
  OFFLINE_AFTER_FAILURES,
  type PollingMode,
  type PollingStatus,
} from "./printer-device-core.ts";

export type { PollingMode, PollingStatus };
export * from "./printer-device-core.ts";

export interface PrinterDeviceState {
  /** Printer id being polled (null = none — picker has no selection). */
  readonly printerId: string | null;
  readonly snapshot: PrinterSnapshot | null;
  /** Last successful fetch, ms epoch. */
  readonly lastFetchedAt: number | null;
  readonly lastError: string | null;
  readonly pollingStatus: PollingStatus;
  readonly lastMode: PollingMode;
  /** Failures in a row — used to back off. */
  readonly consecutiveFailures: number;
}

export type PrinterSnapshotFetcher = (printerId: string) => Promise<PrinterSnapshot>;

export interface DeviceStoreApi extends PrinterDeviceState {
  /** Start/restart the polling loop for a printer. */
  startPolling(printerId: string, intervalMs?: number): void;
  /** Stop the loop entirely. */
  stopPolling(): void;
  /** Force an immediate refetch now (respects stale-while-revalidate). */
  refreshNow(): Promise<void>;
  /** Swap the snapshot fetcher (tests inject a stub here). */
  setFetcher(fn: PrinterSnapshotFetcher): void;
}

/** Initial empty state. */
export function initialDeviceState(): PrinterDeviceState {
  return {
    printerId: null,
    snapshot: null,
    lastFetchedAt: null,
    lastError: null,
    pollingStatus: "idle",
    lastMode: "idle",
    consecutiveFailures: 0,
  };
}

/**
 * Adaptive polling store. The loop re-schedules itself with the
 * mode-appropriate interval AFTER each fetch (printing 2 s, idle 15 s,
 * hidden tab 60 s), so the cadence follows the print state without a fixed
 * timer. A failed fetch keeps the last good snapshot and back-offs to
 * `stale` then `offline` after `OFFLINE_AFTER_FAILURES` consecutive misses.
 *
 * Default fetcher: the deterministic mock lane (`createMockSnapshotFetcher`)
 * — a provider swap for the real MCP lane later, never a type change.
 */
export const usePrinterDevice = create<DeviceStoreApi>((set, get) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let loader: PrinterSnapshotFetcher;

  async function ensureLoader() {
    if (!loader) {
      const { createMockSnapshotFetcher } = await import("../bridge/mock.ts");
      loader = createMockSnapshotFetcher();
    }
    return loader;
  }

  function setFetcher(fn: PrinterSnapshotFetcher) {
    loader = fn;
  }

  function scheduleNext(intervalMs: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, intervalMs);
  }

  async function run() {
    const { printerId } = get();
    if (!printerId) return;
    const hidden = typeof document === "undefined" ? false : document.hidden;
    const prior = get().snapshot;
    const mode: PollingMode = hidden
      ? "background"
      : prior && modeFromState(prior.print.state) === "printing"
        ? "printing"
        : "idle";
    try {
      const fetcher = await ensureLoader();
      const next = await fetcher(printerId);
      const captured: PrinterSnapshot = { ...next, capturedAt: Date.now() };
      set({
        snapshot: captured,
        lastFetchedAt: Date.now(),
        lastError: null,
        pollingStatus: "polling",
        lastMode: mode,
        consecutiveFailures: 0,
      });
      scheduleNext(intervalFor(mode, hidden));
    } catch (err) {
      const failures = get().consecutiveFailures + 1;
      const offline = failures >= OFFLINE_AFTER_FAILURES;
      set({
        lastError: err instanceof Error ? err.message : String(err),
        pollingStatus: offline ? "offline" : "stale",
        lastMode: mode,
        consecutiveFailures: failures,
      });
      scheduleNext(intervalFor(mode, hidden));
    }
  }

  return {
    ...initialDeviceState(),
    setFetcher,
    startPolling(printerId) {
      if (timer) clearTimeout(timer);
      set((s) => ({
        ...s,
        printerId,
        pollingStatus: "polling",
        lastError: null,
        consecutiveFailures: 0,
      }));
      void run();
    },
    stopPolling() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      set((s) => ({ ...s, printerId: null, pollingStatus: "idle" }));
    },
    async refreshNow() {
      await run();
    },
  };
});
