/**
 * S9.5-003 printer discovery — dependency-free pure core.
 *
 * No React / zustand dependencies so Node 24 runs it headless under the
 * `node --test` harness (same pattern as plates-core / printjob-core). The
 * zustand store (`state/printers.ts`) and `components/PrinterPicker.tsx` are
 * thin wrappers over these pure functions.
 *
 * G43: the printer list is discovered from the `ANYCUBIC_PRINTER_IPS` env var
 * (comma-separated IP list) — NEVER hardcoded device identifiers in source.
 * The parse/dedupe/validation logic lives here so the env format is testable
 * headless; reachability is probed by the React layer (it owns import.meta.env
 * and fetch), not by this core.
 */

import type { PrinterInfo } from "../bridge/types";

export type { PrinterInfo };

/** Strict IPv4 dotted-quad (octets 0-255) or an IPv6 literal (contains ":").
 * The env contract is IP addresses — a bare hostname ("my-printer") is NOT a
 * valid entry (a future mDNS scan would add hostname support behind the same
 * lane, never inside the env parser). */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6 =
  /^[0-9a-fA-F:.]+$/; /** Strict IP validation: dotted-quad IPv4 (octets ≤ 255) or IPv6 literal. */
export function isValidIp(token: string): boolean {
  if (IPV4.test(token)) {
    return token.split(".").every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
  }
  return token.includes(":") && IPV6.test(token);
}

/**
 * Parse the `ANYCUBIC_PRINTER_IPS` env value into a deduped list of entries.
 * Commas separate entries; whitespace around each is trimmed; empty tokens
 * (e.g. a trailing comma) are dropped; invalid tokens are skipped and
 * reported so the UI can surface a misconfiguration hint.
 */
export function parsePrinterIps(raw: string): {
  readonly ips: readonly string[];
  readonly invalid: readonly string[];
} {
  const ips: string[] = [];
  const invalid: string[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (t.length === 0) continue;
    if (isValidIp(t)) {
      if (!ips.includes(t)) ips.push(t);
    } else {
      invalid.push(t);
    }
  }
  return { ips, invalid };
}

/** Stable id for a printer entry — from the literal (never a machine-derived secret). */
export function printerId(ip: string): string {
  return `printer-${ip.replace(/[^a-zA-Z0-9_]/g, "-")}`;
}

/**
 * Derive a display name from an IP; the machine type is unknown until the
 * reachability probe reports it, so the picker falls back to the IP itself.
 */
export function printerName(ip: string): string {
  return `Printer @ ${ip}`;
}

/** Printer list + selection state driven by the LAN probe results. */
export interface PrintersState {
  readonly printers: readonly PrinterInfo[];
  /** Source of the list — mirrors the lane contract (`env` for now). */
  readonly source: "env";
  /** Id of the armed send target (null until the user selects one). */
  readonly selectedId: string | null;
  /** True while a reachability probe round is in flight. */
  readonly probing: boolean;
  /** Human summary of why the list is empty (missing env / invalid tokens). */
  readonly hint: string | null;
  /** Last probe timestamp (ms) — the picker shows "refreshed Xs ago". */
  readonly lastProbedAt: number | null;
}

/** Build the initial state from a raw env value (parse happens here). */
export function initialPrintersState(rawEnv = ""): PrintersState {
  const { ips, invalid } = parsePrinterIps(rawEnv);
  const hint =
    ips.length === 0
      ? invalid.length > 0
        ? `Invalid entries in ANYCUBIC_PRINTER_IPS: ${invalid.join(", ")}`
        : "Set ANYCUBIC_PRINTER_IPS (comma-separated IPs) to discover printers"
      : invalid.length > 0
        ? `Ignored invalid entries: ${invalid.join(", ")}`
        : null;
  return {
    printers: ips.map((ip) => ({
      id: printerId(ip),
      name: printerName(ip),
      ip,
      machineType: null,
      reachable: null,
      lastSeenAt: null,
    })),
    source: "env",
    selectedId: null,
    probing: false,
    hint,
    lastProbedAt: null,
  };
}

export type PrintersEvent =
  | { readonly kind: "probe-start" }
  | {
      readonly kind: "probe-done";
      readonly reachable: Readonly<Record<string, boolean>>;
      readonly at: number;
    }
  | { readonly kind: "select"; readonly id: string | null };

export interface PrintersOutcome {
  readonly state: PrintersState;
  readonly rejected?: readonly string[];
}

/**
 * Pure reducer — the whole printer picker lifecycle in one function.
 * `probe-done` merges result per printer id; `select` arms the send target
 * only when the id resolves to a known printer (never an arbitrary string).
 */
export function reducePrinters(state: PrintersState, event: PrintersEvent): PrintersOutcome {
  switch (event.kind) {
    case "probe-start": {
      if (state.probing) return { state, rejected: ["probe already in flight"] };
      return {
        state: {
          ...state,
          probing: true,
          printers: state.printers.map((p) => ({ ...p, reachable: null, lastSeenAt: null })),
        },
      };
    }
    case "probe-done": {
      if (!state.probing) return { state, rejected: ["no probe in flight"] };
      const printers = state.printers.map((p) => {
        const known = event.reachable[p.id];
        return {
          ...p,
          reachable: known === undefined ? p.reachable : known,
          lastSeenAt: known === undefined ? p.lastSeenAt : event.at,
        };
      });
      const selectedId =
        state.selectedId !== null && printers.some((p) => p.id === state.selectedId)
          ? state.selectedId
          : null;
      return { state: { ...state, printers, probing: false, lastProbedAt: event.at, selectedId } };
    }
    case "select": {
      if (event.id === null) {
        return { state: { ...state, selectedId: null } };
      }
      if (!state.printers.some((p) => p.id === event.id)) {
        return { state, rejected: [`unknown printer "${event.id}"`] };
      }
      return { state: { ...state, selectedId: event.id } };
    }
  }
}
