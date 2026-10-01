import { useCallback, useEffect, useState } from "react";
import { usePrintJob, tokenHash, sendTokenFor } from "@/state/printjob";
import { usePrinters } from "@/state/printers";
import { useUi } from "@/state/ui";

/**
 * Send-to-print dialog (S9.5-004, G25) — reuses the S9-006 approval-card
 * pattern (pending/approved/rejected + token hashing) to gate the ONLY path
 * that sends a control order to a printer.
 *
 * Flow:
 *  1. A ready slice (stats panel) + an armed printer (PrinterPicker) lets the
 *     user click "Send to printer" — the dialog opens with a pending card.
 *  2. The card shows the exact payload (printer, stats summary) + a token hash
 *     that pins that payload. Nothing is sent until the user approves.
 *  3. Approve → the send lane runs (progress via the print job machine) →
 *     completion toast; reject/close → nothing leaves the editor.
 *  4. Offline / region failures surface as semantic error toasts.
 */
const SEND_STAGES = [
  { stage: "negotiate", label: "Negotiating with printer…" },
  { stage: "upload", label: "Uploading slice…" },
  { stage: "queue", label: "Queuing job…" },
] as const;

export function PrintJobDialog() {
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

  const selected = printers.find((p) => p.id === selectedId) ?? null;
  const ready = status === "ready" && stats !== null;
  const sending = status === "sending";
  const sent = status === "sent";
  const [ranSend, setRanSend] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const busy = sending || sent;

  // When a slice lands ready AND a printer is armed, surface the send affordance.
  const canOpen = ready && selected !== null && !busy && approval === null;

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
    openSendApproval({
      summary: `${stats.layers} layers · ${stats.estimatedMinutes} min · ${stats.materialGrams.toFixed(1)} g`,
      printerIp: selected.ip,
      printerName: selected.name,
      stats,
    });
  }, [stats, selected, openSendApproval]);

  // The hash the user approved vs the hash of the CURRENT payload: if they
  // differ, the send would go out with a payload that was not approved.
  const currentHash = stats && selected ? tokenHash(sendTokenFor(selected.ip, stats)) : null;

  const runSend = useCallback(async () => {
    if (!selected || !approval) return;
    // Token-hash gate: never send a payload that was not approved.
    if (approval.state !== "approved") {
      pushToast({ kind: "error", title: "Send blocked", message: "approve the card first" });
      return;
    }
    if (currentHash !== approval.tokenHashHex || currentHash !== lastApprovedHash) {
      pushToast({ kind: "error", title: "Send blocked", message: "payload changed — re-approve" });
      return;
    }
    setRanSend(true);
    sendStart();
    try {
      const lane = await import("@/bridge/mock");
      const handle = await lane.fetchSceneSnapshot();
      for (let i = 0; i < SEND_STAGES.length; i += 1) {
        const { stage, label } = SEND_STAGES[i]!;
        reportSendStage((i + 1) / SEND_STAGES.length, stage);
        await new Promise((r) => setTimeout(r, 320));
        // `label` is intentionally unused — the progress bar carries the
        // stage; the label is rendered from the live `sendStage` instead.
        void label;
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
          title: result.kind === "offline" ? "Printer offline" : "Send blocked",
          message: result.error,
        });
        return;
      }
      setTaskId(result.taskId);
      sendFinished();
      pushToast({
        kind: "success",
        title: "Print job sent",
        message: `${selected.name} · ${result.taskId}`,
      });
    } catch (err) {
      sendError(err instanceof Error ? err.message : String(err));
      closeSendApproval();
      pushToast({ kind: "error", title: "Send failed", message: String(err) });
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
  ]);

  // Auto-run the send as soon as the card is approved (the dialog shows
  // progress; the user already confirmed by clicking Approve).
  useEffect(() => {
    if (approval?.state === "approved" && !ranSend && !sending && !sent) {
      void runSend();
    }
  }, [approval?.state, approval?.id, ranSend, sending, sent, runSend]);

  if (approval === null) {
    return (
      <div className="print-job-dialog" data-testid="print-job-dialog">
        {canOpen ? (
          <button
            type="button"
            className="print-job-send"
            data-testid="print-job-send"
            onClick={openCard}
          >
            Send to printer
          </button>
        ) : null}
      </div>
    );
  }

  const decided = approval.state !== "pending";
  const stageLabel = sending ? SEND_STAGES.find((s) => s.stage === sendStage)?.label : null;

  return (
    <div
      className="print-job-dialog"
      data-testid="print-job-dialog"
      role="dialog"
      aria-modal="false"
    >
      <div
        className="print-job-card approval-card"
        data-state={approval.state}
        data-testid="send-approval-card"
      >
        <header className="panel-title">Send to print</header>

        <div className="approval-effect" data-testid="send-approval-effect">
          {approval.summary}
        </div>
        <div className="approval-target" data-testid="send-approval-target">
          → {approval.printerName} ({approval.printerIp})
        </div>
        <div
          className="approval-token"
          data-testid="send-approval-token"
          title="Token hash — pins the exact approved payload"
        >
          token {approval.tokenHashHex}
        </div>
        {currentHash !== null && currentHash !== approval.tokenHashHex ? (
          <div className="approval-mismatch" data-testid="send-approval-mismatch">
            payload changed since approval
          </div>
        ) : null}
        {taskId ? (
          <div className="approval-task" data-testid="send-approval-task">
            task {taskId}
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
              Reject
            </button>
            <button
              type="button"
              className="approval-approve"
              data-testid="send-approval-approve"
              onClick={() => decideSendApproval(approval.id, true)}
            >
              Approve &amp; send
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
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
