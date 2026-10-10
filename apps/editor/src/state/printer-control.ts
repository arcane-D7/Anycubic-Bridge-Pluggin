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
  controlEffectObserved,
  executeControl,
  unavailableControlProvider,
  capabilityForControlAction,
  type ControlExecutionProvider,
  type ControlAction,
  type ControlRequest,
} from "./printer-control-core.ts";
import { validateControlTarget, type ControlTargetContext } from "./device-availability-core.ts";
import type { MsgKey } from "./i18n-core.ts";

export type ControlObservationMatcher = typeof controlEffectObserved;

export type { ControlAction, ControlRequest } from "./printer-control-core.ts";

export interface PrinterControlState {
  /** Last envelope submitted (validation artifact for DevTools). */
  readonly lastEnvelope: Readonly<{ command: string; args: unknown }> | null;
  /** True while a control write is in flight (disable repeat presses). */
  readonly busy: boolean;
  readonly lastError: string | null;
  readonly lastOutcome: Readonly<{
    kind:
      "accepted" | "observed" | "refused" | "timeout" | "invalid" | "unavailable" | "indeterminate";
    command: string | null;
    reason: string | null;
    snapshotCapturedAt: number | null;
  }> | null;
}

export interface PrinterControlApi extends PrinterControlState {
  /** Build + submit one control through the lane; toasts the outcome. */
  sendControl(req: {
    readonly action: ControlAction;
    readonly payload: ControlRequest;
    readonly target: ControlTargetContext;
    readonly selectedPrinterId: string | null;
    readonly currentCapturedAt: number | null;
    readonly provider?: ControlExecutionProvider;
    readonly observationMatcher?: ControlObservationMatcher;
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
  return { lastEnvelope: null, busy: false, lastError: null, lastOutcome: null };
}

export const usePrinterControl = create<PrinterControlApi>((set, get) => ({
  ...initialControlState(),
  async sendControl({
    action: _action,
    payload,
    target,
    selectedPrinterId,
    currentCapturedAt,
    provider = unavailableControlProvider,
    observationMatcher = controlEffectObserved,
    toast,
    t,
  }) {
    if (get().busy) return;
    // 1) Grammar: build + validate the envelope (never sends anything invalid).
    const envelope = buildCommandEnvelope(payload);
    if (!envelope.ok) {
      set({
        lastError: envelope.reason,
        busy: false,
        lastOutcome: {
          kind: "invalid",
          command: null,
          reason: envelope.reason,
          snapshotCapturedAt: null,
        },
      });
      toast({
        kind: "error",
        title: t("control.invalid.title"),
        message: `${t("control.invalid.message")} ${envelope.reason}`,
      });
      return;
    }
    const capabilityKey = capabilityForControlAction(payload.action);
    const targetCheck = validateControlTarget(
      target,
      selectedPrinterId,
      currentCapturedAt,
      capabilityKey,
    );
    if (!targetCheck.ok) {
      const kind = targetCheck.kind === "invalid" ? "invalid" : "unavailable";
      set({
        lastError: targetCheck.reason,
        busy: false,
        lastOutcome: {
          kind,
          command: null,
          reason: targetCheck.reason,
          snapshotCapturedAt: null,
        },
      });
      toast({
        kind: targetCheck.kind === "invalid" ? "error" : "warning",
        title: t(kind === "invalid" ? "control.invalid.title" : "control.unavailable.title"),
        message: kind === "invalid" ? targetCheck.reason : t("control.unavailable.message"),
      });
      return;
    }
    set({
      busy: true,
      lastEnvelope: { command: envelope.envelope.command, args: envelope.envelope.args },
    });
    try {
      const r = await executeControl(provider, { target, envelope: envelope.envelope });
      if (!r.ok) {
        const outcomeKind = r.kind;
        set({
          lastOutcome: {
            kind: outcomeKind,
            command: envelope.envelope.command,
            reason: r.error ?? null,
            snapshotCapturedAt: null,
          },
        });
        // Refused vs timeout are DISTINCT toasts (AC-2: no silent failures).
        if (r.kind === "refused") {
          set({ lastError: r.error ?? null });
          toast({
            kind: "warning",
            title: t("control.refused.title"),
            message: r.error ?? t("control.refused.message"),
          });
        } else if (r.kind === "unavailable") {
          set({ lastError: r.error ?? null });
          toast({
            kind: "warning",
            title: t("control.unavailable.title"),
            message: t("control.unavailable.message"),
          });
        } else if (r.kind === "indeterminate") {
          set({ lastError: r.error ?? null });
          toast({
            kind: "warning",
            title: t("control.indeterminate.title"),
            message: t("control.indeterminate.message"),
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
      const observed = observationMatcher(
        envelope.envelope,
        r.observed,
        target,
        target.snapshotCapturedAt,
        provider.currentContext().currentCapturedAt,
      );
      const kind = observed ? "observed" : "accepted";
      set({
        lastError: null,
        lastOutcome: {
          kind,
          command: r.command,
          reason: null,
          snapshotCapturedAt: observed ? (r.observed?.capturedAt ?? null) : null,
        },
      });
      toast({
        kind: observed ? "success" : "info",
        title: t(observed ? "control.observed.title" : "control.accepted.title"),
        message: observed
          ? t("control.observed.message", { command: r.command })
          : t("control.accepted.message"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        lastError: message,
        lastOutcome: {
          kind: "indeterminate",
          command: envelope.envelope.command,
          reason: message,
          snapshotCapturedAt: null,
        },
      });
      toast({ kind: "error", title: t("control.failed.title"), message });
    } finally {
      set({ busy: false });
    }
  },
  reset() {
    set(initialControlState());
  },
}));
