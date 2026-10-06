/**
 * S9.5-003 printer store (zustand). Thin wrapper over the pure
 * `printers-core` state machine plus the LAN reachability probe.
 *
 * The discovery list comes from `ANYCUBIC_PRINTER_IPS` (env, comma list) via
 * the bridge discovery lane — never hardcoded identifiers. The probe pings
 * each candidate over its LAN port (Anycubic printers expose the MQTT/serial
 * gateway on 990; the controller/board on 6000) with a short timeout, so the
 * connection LED reflects real reachability on the user's network.
 *
 * This store deliberately owns import.meta.env + fetch — the pure core stays
 * headless-testable; the React `PrinterPicker` is the only consumer.
 */

import { create } from "zustand";
import {
  cloudPrintersState,
  initialPrintersState,
  printerId,
  reducePrinters,
  type PrintersState,
} from "./printers-core";
import type { PrinterInfo } from "../bridge/types";
import { cloudDiscoverPrinters } from "../bridge/cloud";

export type { PrinterInfo, PrintersState };
export { printerId };

export type { PrintersEvent } from "./printers-core";

/** Ports probed per candidate — the picker shows online when ANY responds. */
const PROBE_PORTS = [990, 6000, 8080];
/** Per-candidate probe timeout (ms) — short so the LED resolves fast. */
const PROBE_TIMEOUT_MS = 1200;

interface ProbeCandidate {
  readonly id: string;
  readonly ip: string;
}

export type PrinterProbeFn = (candidate: ProbeCandidate) => Promise<boolean>;

/** Default probe: reachability by HTTP(S) attempt against the known LAN
 * ports. `mode: "no-cors"` means the browser does not read the response — an
 * opaque Response (any HTTP status) still proves the port is open, and a
 * refusal/timeout proves offline. Ports below 1000 (990/6000) are rejected by
 * the browser as ERR_UNSAFE_PORT; those failures are treated as a port that
 * did not respond, so the candidate flips online only via 8080 (or a future
 * real bridge that probes at the transport layer, not in the browser). */
async function probeReachability(candidate: ProbeCandidate): Promise<boolean> {
  const controller = new AbortController();
  let aborted = false;
  const timeout = setTimeout(() => {
    aborted = true;
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  try {
    for (const port of PROBE_PORTS) {
      if (aborted) return false;
      try {
        await fetch(`http://${candidate.ip}:${port}/`, {
          mode: "no-cors",
          cache: "no-store",
          signal: controller.signal,
        });
        // no-cors returns an opaque 0/ok response — the port answered.
        return true;
      } catch {
        // refused / unsafe / timeout — try the next port.
      }
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

interface PrintersStore extends PrintersState {
  /** (Re)run discovery + reachability probe from the env value. */
  readonly refresh: (rawEnv: string, probe?: PrinterProbeFn) => Promise<void>;
  /** (Re)run CLOUD account-printer discovery via the loopback cloud bridge.
   * S9.13-002 — merges into the same `printers` list with `source: "cloud"`.
   * The cloud lane is best-effort: a missing/offline bridge leaves the list
   * unchanged (LAN discovery still works). */
  readonly refreshCloud: () => Promise<void>;
  /** Arm the send target by printer id (null clears the selection). */
  readonly select: (id: string | null) => void;
}

/**
 * Live printer store (zustand, S9.5-003). `refresh` is the only async path —
 * it parses the env via the pure core (so the list is deterministic), then
 * probes each candidate concurrently and folds the results back through the
 * reducer. `probe` is injectable for tests (Node has no import.meta.env).
 */
export const usePrinters = create<PrintersStore>()((set, get) => {
  const apply = (event: Parameters<typeof reducePrinters>[1]) =>
    set((s) => reducePrinters(s, event).state);

  return {
    ...initialPrintersState(),

    async refresh(rawEnv, probe = probeReachability) {
      // Fold the parse + probe results through the same pure reducer flow.
      const parsed = initialPrintersState(rawEnv);
      const discovered: PrinterInfo[] = [...parsed.printers];
      apply({ kind: "probe-start" });
      // Reset to the freshly discovered list (parse may have changed).
      set((s) => ({
        ...s,
        printers: discovered,
        source: parsed.source,
        hint: parsed.hint,
      }));
      const at = Date.now();
      const reachable: Record<string, boolean> = {};
      await Promise.all(
        discovered.map(async (p) => {
          reachable[p.id] = await probe({ id: p.id, ip: p.ip });
        }),
      );
      apply({ kind: "probe-done", reachable, at });
    },

    select(id) {
      const { state } = reducePrinters(get(), { kind: "select", id });
      set(state);
    },

    async refreshCloud() {
      // CLOUD lane (S9.13-002): best-effort account discovery. On any error
      // (bridge down / not logged in / rate-limited) keep the current list.
      let cloudList: readonly PrinterInfo[];
      try {
        const result = await cloudDiscoverPrinters();
        cloudList = result.printers;
      } catch {
        return; // non-fatal — the LAN list (if any) stays usable.
      }
      const next = cloudPrintersState(cloudList);
      const existing = get().printers;
      // Merge: keep LAN entries the user may have armed, add/refresh cloud
      // entries, and prefer the CLOUD ones in the list (account is fresh).
      const byId = new Map(existing.map((p) => [p.id, p]));
      for (const p of cloudList) byId.set(p.id, { ...p, lastSeenAt: Date.now() });
      set((s) => ({
        ...s,
        printers: [...byId.values()],
        source: next.source,
        hint: next.hint,
        lastProbedAt: Date.now(),
      }));
    },
  };
});
