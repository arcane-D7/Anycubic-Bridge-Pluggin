/**
 * S9.10-002 — printer control store (zustand, thin).
 *
 * Wires the Device Monitor controls to the `printer_command_send` bridge
 * lane. All GRAMMAR (envelope build + bounds + policy) lives in the pure
 * `printer-control-core.ts`; this store is the thin glue:
 *
 *   - `sendControl(action, payload)` → builds the envelope through the core,
 *     submits it to the mock lane (`printerControl`), maps the semantic
 *     result to distinct toasts (accepted → success; refused / timeout →
 *     distinct warnings; invalid → error). NO silent failures.
 *   - `reset()` clears transient command state.
 *
 * The toast texts come from the i18n table (single source of truth). The
 * store is React-free at the core level (`printer-control-core` has no
 * React/zustand imports) — this file's zustand surface only consumes the
 * lane handle that the view already owns.
 */

import { create } from "zustand";
import {
  buildCommandEnvelope,
  type ControlAction,
  type ControlRequest,
} from "./printer-control-core.ts";
import type { MsgKey } from "./i18n-core.ts";

export type { ControlAction, ControlRequest } from "./printer-control-core.ts";

export interface PrinterControlState {
  /** Last envelope submitted (validation artifact for DevTools). */
  readonly lastEnvelope: Readonly<{ command: string; args: unknown }> | null;
  /** True while a control write is in flight (disable repeat presses). */
  readonly busy: boolean;
  readonly lastError: string | null;
}

export interface PrinterControlApi extends PrinterControlState {
  /** Build + submit one control through the lane; toasts the outcome. */
  sendControl(req: {
    readonly action: ControlAction;
    readonly payload: ControlRequest;
    readonly printerId: string;
    readonly lane: {
      printerControl(req: { printerId: string; envelope: unknown }): Promise<unknown>;
    };
    readonly toast: (t: {
      kind: "info" | "success" | "warning" | "error";
      title: string;
      message?: string;
    }) => void;
    readonly t: (k: MsgKey, vars?: Readonly<Record<string, string>>) => string;
  }): Promise<void>;
  reset(): void;
}

/** Initial empty state. */
export function initialControlState(): PrinterControlState {
  return { lastEnvelope: null, busy: false, lastError: null };
}

export const usePrinterControl = create<PrinterControlApi>((set) => ({
  ...initialControlState(),
  async sendControl({ action, payload, printerId, lane, toast, t }) {
    // 1) Grammar: build + validate the envelope (never sends anything invalid).
    const envelope = buildCommandEnvelope(payload);
    if (!envelope.ok) {
      set({ lastError: envelope.reason, busy: false });
      toast({
        kind: "error",
        title: t("control.invalid.title"),
        message: `${t("control.invalid.message")} ${envelope.reason}`,
      });
      return;
    }
    set({
      busy: true,
      lastEnvelope: { command: envelope.envelope.command, args: envelope.envelope.args },
    });
    try {
      const result = await lane.printerControl({
        printerId,
        envelope: envelope.envelope,
      });
      const r = result as {
        readonly ok: boolean;
        readonly command?: string;
        readonly error?: string;
        readonly kind?: string;
      };
      if (!r.ok) {
        // Refused vs timeout are DISTINCT toasts (AC-2: no silent failures).
        if (r.kind === "refused") {
          set({ lastError: r.error ?? null });
          toast({
            kind: "warning",
            title: t("control.refused.title"),
            message: r.error ?? t("control.refused.message"),
          });
        } else if (r.kind === "timeout") {
          set({ lastError: r.error ?? null });
          toast({
            kind: "warning",
            title: t("control.timeout.title"),
            message: r.error ?? t("control.timeout.message"),
          });
        } else {
          set({ lastError: r.error ?? null });
          toast({
            kind: "error",
            title: t("control.invalid.title"),
            message: r.error ?? t("control.invalid.message"),
          });
        }
        return;
      }
      set({ lastError: null });
      toast({
        kind: "success",
        title: t("control.accepted.title"),
        message: t("control.accepted.message", { command: r.command ?? action }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ lastError: message });
      toast({ kind: "error", title: t("control.failed.title"), message });
    } finally {
      set({ busy: false });
    }
  },
  reset() {
    set(initialControlState());
  },
}));
