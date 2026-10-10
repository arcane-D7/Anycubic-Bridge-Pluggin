import { useCallback, useEffect, useState } from "react";
import { usePrintJob, tokenHash, sendTokenFor } from "@/state/printjob";
import { usePrinters } from "@/state/printers";
import { useUi } from "@/state/ui";
import { useI18n } from "@/state/i18n";
import { usePrinterDevice } from "@/state/printer-device";
import { printReady } from "@/state/printer-print-guard-core";
import type { MsgKey } from "@/state/i18n-core";
import { activeProjectProvider, activeProjectScene } from "@/bridge/project-provider";
import { useScene } from "@/state/scene";
import { usePresets } from "@/state/presets";
import { materialBindingDiagnostics } from "@/state/material-assign-core";
import { FILAMENT_PRESETS } from "@/presets/catalog";

/**
 * Print job approval dialog (S9.5-004, G25 + S9.17-003 SimSend).
 *
 * UI TRUTHFULNESS: the dialog is SIMULATION-ONLY. It mounts exclusively in
 * demo mode (App.tsx) and requires the caller to pass `simulationOnly` — an
 * approved card runs the DEMO simulator lane and reports "Simulation
 * complete", NEVER "Job sent": no data is uploaded and no printer command
 * is sent. The card itself states this ("Demo simulation, no data uploaded
 * and no printer command sent.") and the token line is a local FNV hash
 * that pins the payload — it is not an authentication proof or a transport
 * authority.
 *
 * Flow:
 *  1. A ready slice (stats panel) + an armed printer lets the user click
 *     "Simulate send" — the dialog opens with a pending card.
 *  2. The card shows the exact payload + a token hash pinning it. Nothing
 *     runs until the user approves; reject/close → nothing leaves the
 *     editor (no real transport exists to leave).
 *  3. Approve → the simulation stage runs (timers only, no network) →
 *     "Simulation complete".
 *  4. A hard guard re-checks the provider at run time: if the provider is
 *     no longer demo, the run is ABORTED — there is deliberately NO real
 *     fallback path that could reach a real project handle.
 */
const SEND_STAGES_REAL = [
  { stage: "negotiate", key: "send.stage.negotiate" },
  { stage: "upload", key: "send.stage.upload" },
  { stage: "queue", key: "send.stage.queue" },
] as const satisfies readonly { readonly stage: string; readonly key: MsgKey }[];

/** Single simulation stage — timers only, no upload/queue claims when
 * simulating (S9.17-003). */
const SEND_STAGES_SIM = [
  { stage: "simulate", key: "send.stage.simulate" },
] as const satisfies readonly { readonly stage: string; readonly key: MsgKey }[];

interface PrintJobDialogProps {
  /** MANDATORY: true only when the provider is the demo simulator. When
   * false the dialog renders nothing — there is no real send UI behind it. */
  readonly simulationOnly: boolean;
}

export function PrintJobDialog({ simulationOnly }: PrintJobDialogProps) {
  const t = useI18n((s) => s.t);
  const status = usePrintJob((s) => s.status);
  const stats = usePrintJob((s) => s.stats);
  const approval = usePrintJob((s) => s.approval);
  const lastApprovedHash = usePrintJob((s) => s.lastApprovedHash);
  const openSendApproval = usePrintJob((s) => s.openSendApproval);
  const decideSendApproval = usePrintJob((s) => s.decideSendApproval);
  const closeSendApproval = usePrintJob((s) => s.closeSendApproval);
  const sendStart = usePrintJob((s) => s.sendStart);
  const reportSendStage = usePrintJob((s) => s.reportSendStage);
  const sendFinished = usePrintJob((s) => s.sendFinished);
  const sendError = usePrintJob((s) => s.sendError);
  const sendProgress = usePrintJob((s) => s.sendProgress);
  const sendStage = usePrintJob((s) => s.sendStage);
  const pushToast = useUi((s) => s.pushToast);
  const selectedId = usePrinters((s) => s.selectedId);
  const printers = usePrinters((s) => s.printers);
  // S9.10-004 — live snapshot for the approval card (temps + ACE filament).
  const snapshot = usePrinterDevice((s) => s.snapshot);
  const printerId = usePrinterDevice((s) => s.printerId);
  const printerStatus = usePrinterDevice((s) => s.pollingStatus);
  const objects = useScene((s) => s.objects);
  const globalFilamentId = usePresets((s) => s.filamentId);

  const selected = printers.find((p) => p.id === selectedId) ?? null;
  const ready = status === "ready" && stats !== null;
  const sending = status === "sending";
  const sent = status === "sent";
  const [ranSend, setRanSend] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const busy = sending || sent;

  // When a slice lands ready AND a printer is armed, surface the send affordance.
  const canOpen = ready && selected !== null && !busy && approval === null;

  // S9.10-004 — filament readiness from the LIVE ACE snapshot (never MOCK).
  // Local-spool printers pass-through (no ACE → honest unknown).
  const aceBoxes = snapshot?.ace.boxes ?? [];
  const readiness = printReady(aceBoxes);
  const materialDiagnostics = materialBindingDiagnostics({
    objects,
    globalFilamentId,
    boxes: aceBoxes,
    printerId: printerId ?? undefined,
    snapshotStatus: printerStatus,
    presets: FILAMENT_PRESETS,
  });
  const unresolvedBindings = materialDiagnostics.filter(
    ({ match }) => match.bindingStatus !== "available",
  );
  // A hard block is switch-level: the physical printer has no usable
  // filament at all — Approve must not send.
  const filamentBlocked = !readiness.ready;

  // Close/settle the dialog after a sent job (or when the slice resets).
  useEffect(() => {
    if (sent && ranSend) {
      const t = setTimeout(() => {
        closeSendApproval();
        setRanSend(false);
        setTaskId(null);
      }, 4000);
      return () => clearTimeout(t);
    }
  }, [sent, ranSend, closeSendApproval]);

  const openCard = useCallback(() => {
    if (!stats || !selected) return;
    // S9.10-004 — refuse to even show the approve affordance when the live
    // ACE has no usable filament (absent/too low). Block with a message.
    if (filamentBlocked) {
      pushToast({
        kind: "error",
        title: t("send.blockedTitle"),
        message: readiness.reason,
      });
      return;
    }
    openSendApproval({
      summary: `${stats.layers} layers · ${stats.estimatedMinutes ?? "—"} min · ${stats.materialGrams === null ? "—" : stats.materialGrams.toFixed(1)} g`,
      printerIp: selected.ip,
      printerName: selected.name,
      stats,
    });
  }, [stats, selected, openSendApproval, filamentBlocked, readiness, pushToast, t]);

  // The hash the user approved vs the hash of the CURRENT payload: if they
  // differ, the send would go out with a payload that was not approved.
  const currentHash = stats && selected ? tokenHash(sendTokenFor(selected.ip, stats)) : null;

  const runSend = useCallback(async () => {
    if (!selected || !approval) return;
    // Token-hash gate: never send a payload that was not approved.
    if (approval.state !== "approved") {
      pushToast({
        kind: "error",
        title: t("send.sendBlocked"),
        message: t("send.approveCardFirst"),
      });
      return;
    }
    // S9.10-004 — re-check the live filament guard at send time. The ACE
    // may have emptied/been unloaded after the card was shown; never let a
    // print go to a printer without usable filament.
    const guard = printReady(usePrinterDevice.getState().snapshot?.ace.boxes ?? []);
    if (!guard.ready) {
      closeSendApproval();
      pushToast({
        kind: "error",
        title: t("send.blockedTitle"),
        message: guard.reason,
      });
      return;
    }
    if (currentHash !== approval.tokenHashHex || currentHash !== lastApprovedHash) {
      pushToast({
        kind: "error",
        title: t("send.sendBlocked"),
        message: t("send.payloadChangedMessage"),
      });
      return;
    }
    setRanSend(true);
    sendStart();
    try {
      // S9.17-003 hard guard: the demo simulator must NEVER fall through to
      // a real provider's transport if the provider flipped mid-run — there
      // is deliberately NO real fallback from an unavailable state.
      const provider = await activeProjectProvider();
      if (provider.mode !== "demo") {
        sendError(provider.reason ?? "simulation provider unavailable");
        closeSendApproval();
        setRanSend(false);
        pushToast({
          kind: "error",
          title: t("send.unavailable.title"),
          message: t("send.unavailable.message"),
        });
        return;
      }
      const handle = await activeProjectScene();
      const stages = simulationOnly ? SEND_STAGES_SIM : SEND_STAGES_REAL;
      for (let i = 0; i < stages.length; i += 1) {
        const { stage } = stages[i]!;
        reportSendStage((i + 1) / stages.length, stage);
        // Simulation timing only — no network traffic is produced.
        await new Promise((r) => setTimeout(r, 320));
      }
      const result = await handle.sendJob({
        printerId: selected.id,
        ip: selected.ip,
        stats: approval.stats,
        summary: approval.summary,
      });
      if (!result.ok) {
        sendError(result.error);
        closeSendApproval();
        pushToast({
          kind: result.kind === "offline" ? "warning" : "error",
          title: result.kind === "offline" ? t("send.offline.title") : t("send.sendBlocked"),
          message: result.error,
        });
        return;
      }
      // Honest result: a demo run completes with a SIMULATION receipt, not a
      // physical task — the UI reports "Simulation complete", never "Job sent".
      const simulationId = result.simulation?.simulationId ?? result.taskId;
      setTaskId(simulationId);
      sendFinished();
      if (simulationOnly) {
        pushToast({
          kind: "success",
          title: t("send.simulationComplete"),
          message: t("send.simulationCompleteMessage", {
            name: selected.name,
            simulationId,
          }),
        });
      } else {
        pushToast({
          kind: "success",
          title: t("send.jobSent.title"),
          message: t("send.jobSent.message", { name: selected.name, taskId: result.taskId }),
        });
      }
    } catch (err) {
      sendError(err instanceof Error ? err.message : String(err));
      closeSendApproval();
      pushToast({ kind: "error", title: t("send.sendFailed"), message: String(err) });
    }
  }, [
    approval,
    closeSendApproval,
    currentHash,
    lastApprovedHash,
    pushToast,
    reportSendStage,
    selected,
    sendError,
    sendFinished,
    sendStart,
    simulationOnly,
    t,
  ]);
  // Auto-run the send as soon as the card is approved (the dialog shows
  // progress; the user already confirmed by clicking Approve).
  useEffect(() => {
    if (approval?.state === "approved" && !ranSend && !sending && !sent) {
      void runSend();
    }
  }, [approval?.state, approval?.id, ranSend, sending, sent, runSend]);

  // Demo-only dialog: when the caller does not declare simulation, there is
  // no send UI at all — a real transport is NOT wired anywhere. All hooks
  // run BEFORE this guard so hook order stays stable per instance.
  if (!simulationOnly) return null;

  if (approval === null) {
    return (
      <div className="print-job-dialog" data-testid="print-job-dialog" data-origin="demo">
        {canOpen ? (
          <button
            type="button"
            className="print-job-send"
            data-testid="print-job-send"
            onClick={openCard}
          >
            {t("send.simulateSend")}
          </button>
        ) : null}
      </div>
    );
  }

  const decided = approval.state !== "pending";
  const sandboxStages = simulationOnly ? SEND_STAGES_SIM : SEND_STAGES_REAL;
  const stageLabel = sending
    ? (() => {
        const s = sandboxStages.find((x) => x.stage === sendStage);
        return s ? t(s.key) : null;
      })()
    : null;

  return (
    <div
      className="print-job-dialog"
      data-testid="print-job-dialog"
      data-origin="demo"
      role="dialog"
      aria-modal="false"
    >
      <div
        className="print-job-card approval-card"
        data-state={approval.state}
        data-testid="send-approval-card"
      >
        <header className="panel-title">
          {simulationOnly ? t("send.demoTitle") : t("send.sendTitle")}
        </header>

        <div className="approval-effect" data-testid="send-approval-effect">
          {approval.summary}
        </div>
        <div className="approval-target" data-testid="send-approval-target">
          → {approval.printerName} ({approval.printerIp})
        </div>
        {unresolvedBindings.length > 0 ? (
          <p className="panel-hint" data-testid="send-material-binding-diagnostic">
            {t("send.materialBindingDiagnostic", { count: String(unresolvedBindings.length) })}
          </p>
        ) : null}
        {/* S9.10-004 — live snapshot in the card (temps + ACE filament). */}
        {snapshot ? (
          <div className="approval-live" data-testid="send-approval-live">
            <span className="approval-live-temps">
              {t("send.live.temps")}:{" "}
              {snapshot.temps.nozzle.currentC === null
                ? "—"
                : `${Math.round(snapshot.temps.nozzle.currentC)}°`}
              {" / "}
              {snapshot.temps.bed.currentC === null
                ? "—"
                : `${Math.round(snapshot.temps.bed.currentC)}°`}
            </span>
            {aceBoxes.length > 0 ? (
              <span className="approval-live-ace">
                {t("send.live.ace")}:{" "}
                {aceBoxes.map((box) =>
                  box.slots.map((slot) => (
                    <span
                      key={`${box.index}-${slot.index}`}
                      className="approval-live-slot"
                      data-testid="send-approval-slot"
                    >
                      <i
                        className="approval-live-swatch"
                        style={{ background: slot.color ?? "transparent" }}
                      />
                      {slot.state === "empty" ? "empty" : `${slot.remainingPct ?? "—"}%`}
                    </span>
                  )),
                )}
              </span>
            ) : null}
          </div>
        ) : null}
        {filamentBlocked ? (
          <div className="approval-block" data-testid="send-approval-block">
            {t("send.filamentBlocked")}: {readiness.reason}
          </div>
        ) : null}
        <div
          className="approval-token"
          data-testid="send-approval-token"
          title={simulationOnly ? t("send.token.demoTitle") : t("send.token.title")}
        >
          token {approval.tokenHashHex}
        </div>
        {currentHash !== null && currentHash !== approval.tokenHashHex ? (
          <div className="approval-mismatch" data-testid="send-approval-mismatch">
            {t("send.payloadChanged")}
          </div>
        ) : null}
        {taskId ? (
          <div className="approval-task" data-testid="send-approval-task">
            {simulationOnly
              ? t("send.simulationTask", { id: taskId })
              : t("send.task", { id: taskId })}
          </div>
        ) : null}

        {sending ? (
          <div className="send-progress">
            <div className="send-progress-bar" data-testid="send-progress">
              <div
                className="send-progress-fill"
                data-testid="send-progress-fill"
                style={{ width: `${(sendProgress ?? 0) * 100}%` }}
              />
            </div>
            <span className="send-stage-label" data-testid="send-stage-label">
              {stageLabel ?? sendStage}
            </span>
          </div>
        ) : null}

        {!decided && !sending && !sent ? (
          <div className="approval-actions">
            <button
              type="button"
              className="approval-reject"
              data-testid="send-approval-reject"
              onClick={() => decideSendApproval(approval.id, false)}
            >
              {t("send.reject")}
            </button>
            <button
              type="button"
              className="approval-approve"
              data-testid="send-approval-approve"
              disabled={filamentBlocked}
              onClick={() => decideSendApproval(approval.id, true)}
            >
              {t("send.approve")}
            </button>
          </div>
        ) : null}

        {!sending && !sent ? (
          <button
            type="button"
            className="approval-close"
            data-testid="send-approval-close"
            onClick={() => closeSendApproval()}
          >
            {t("send.dismiss")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
