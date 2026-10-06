import { useEffect, useRef } from "react";
import { useI18n } from "@/state/i18n";
import { usePrinterDevice } from "@/state/printer-device";
import { useUi } from "@/state/ui";
import { useDock } from "@/state/dock";
import type { MsgKey } from "@/state/i18n-core";
import {
  aceErrorCode,
  filamentAlertFor,
  formatClock,
  formatLayerPart,
  formatPct,
  formatTempProbe,
  isAceErrorCode,
  loadedSlotNumber,
  lowestFilamentPct,
  tempOutsideWindow,
} from "@/state/printer-status-core";
import type { PrinterSnapshot } from "@/bridge/types";

/**
 * S9.9-006 — printer status strip with alert toasts.
 *
 * Slim bar over the viewport (docked under the header — see CSS): chips for
 * temps, layer, progress, clock, fan and ACE slot; a state LED on the left.
 * Every chip opens the Device panel at its section (`focusDevicePanel`),
 * so the status bar is a navigation + alert surface, never a write.
 *
 * Alerts (thresholds from `printer-status-core`, shared with tests):
 *   - filament <15% → warning toast (+ crit <5% persistent emphasis)
 *   - temp outside the material window → preventive toast
 *   - ACE error code 129–135 → error toast + DevTools hint
 *   - pollingStatus stale/offline → reachability banner chip
 *
 * Toast keys are emitted AT MOST once per snapshot identity (ref guard), so
 * the 2 s poll doesn't spam while a condition persists.
 */

interface PrinterStatusBarProps {
  readonly enabled?: boolean;
}

export function PrinterStatusBar({ enabled = true }: PrinterStatusBarProps) {
  const t = useI18n((s) => s.t);
  const pushToast = useUi((s) => s.pushToast);
  const focus = useDock((s) => s.focusDevicePanel);

  const snapshot = usePrinterDevice((s) => s.snapshot);
  const pollingStatus = usePrinterDevice((s) => s.pollingStatus);
  const snap: PrinterSnapshot | null = snapshot;

  // Alert dedupe: keyed on snapshot `capturedAt` so the 2 s polling never
  // re-fires the same condition's toast (still fires again after a change).
  const lastAlerted = useRef<Record<string, number | null>>({});
  const fireOnce = (key: string, at: number | null) => {
    if (lastAlerted.current[key] === at) return false;
    lastAlerted.current[key] = at;
    return true;
  };

  useEffect(() => {
    if (!enabled || !snap) return;
    const at = snap.capturedAt;

    // 1) Filament low/crit (uses the same thresholds as the Filament tab).
    const pct = lowestFilamentPct(snap.ace.boxes);
    const alert = filamentAlertFor(pct);
    if (alert !== "none" && fireOnce(`fil:${alert}`, at)) {
      pushToast({
        kind: alert === "crit" ? "error" : "warning",
        title: t(alert === "crit" ? "toast.filament.crit.title" : "toast.filament.low.title"),
        message: t(
          alert === "crit" ? "toast.filament.crit.message" : "toast.filament.low.message",
          pct !== null ? { pct: String(Math.round(pct)) } : undefined,
        ),
      });
    }

    // 2) Temp outside the loaded slot's recommended window (preventive).
    for (const box of snap.ace.boxes) {
      for (const s of box.slots) {
        if (s.state === "empty") continue;
        const rec = s.recommendedTempsC.nozzle;
        if (!rec) continue;
        if (tempOutsideWindow(snap.temps.nozzle.currentC, rec)) {
          if (fireOnce("temp:off", at)) {
            pushToast({
              kind: "warning",
              title: t("toast.temp.off.title"),
              message: t("toast.temp.off.message"),
            });
          }
        }
      }
    }

    // 3) ACE error code 129–135 → red toast.
    const errCode = aceErrorCode(snap.ace.boxes);
    if (errCode !== null && isAceErrorCode(errCode) && fireOnce("ace:err", at)) {
      pushToast({
        kind: "error",
        title: t("toast.ace.error.title"),
        message: t("toast.ace.error.message", { code: String(errCode) }),
      });
    }
  }, [enabled, snap, pushToast, t]);

  if (!enabled || !snap) return null;

  const focusSection = (tab: "monitor" | "filament", section?: string) => {
    focus(tab, section);
  };

  const printState = snap.print.state;
  const led: string =
    printState === "printing"
      ? "led-printing"
      : printState === "paused"
        ? "led-paused"
        : printState === "error"
          ? "led-error"
          : pollingStatus === "offline"
            ? "led-offline"
            : "led-idle";

  // Static key lookup (i18n keys must be literal, never templated).
  const LED_KEY: Record<string, MsgKey> = {
    printing: "status.printer.led.printing",
    paused: "status.printer.led.paused",
    error: "status.printer.led.error",
    idle: "status.printer.led.idle",
    offline: "status.printer.led.offline",
  } as const;

  const lowest = lowestFilamentPct(snap.ace.boxes);
  const lowestAlert = filamentAlertFor(lowest);
  const aceSlot = loadedSlotNumber(snap.ace.boxes);
  const errCode = aceErrorCode(snap.ace.boxes);

  return (
    <div className="printer-status-bar" data-testid="printer-status-bar">
      {/* State LED + print state */}
      <button
        type="button"
        className="printer-chip printer-led-chip"
        data-testid="printer-chip-state"
        data-led={printState}
        onClick={() => focusSection("monitor", "device-section-print")}
        title={t(LED_KEY[printState] ?? "status.printer.led.idle")}
      >
        <span className={`printer-led printer-${led}`} aria-hidden="true" />
      </button>

      {/* Temps chips — click → Monitor temps section */}
      <button
        type="button"
        className="printer-chip mono-num"
        data-testid="printer-chip-nozzle"
        onClick={() => focusSection("monitor", "device-section-temps")}
        title={t("status.printer.nozzle")}
      >
        {t("status.printer.nozzle")} {formatTempProbe(snap.temps.nozzle)}
      </button>
      <button
        type="button"
        className="printer-chip mono-num"
        data-testid="printer-chip-bed"
        onClick={() => focusSection("monitor", "device-section-temps")}
        title={t("status.printer.bed")}
      >
        {t("status.printer.bed")} {formatTempProbe(snap.temps.bed)}
      </button>

      {/* Print chips — click → Monitor print section */}
      {formatLayerPart(snap.print.currLayer, snap.print.totalLayers) ? (
        <button
          type="button"
          className="printer-chip mono-num"
          data-testid="printer-chip-layer"
          onClick={() => focusSection("monitor", "device-section-print")}
          title={t("status.printer.layer")}
        >
          {t("status.printer.layer")}{" "}
          {formatLayerPart(snap.print.currLayer, snap.print.totalLayers)}
        </button>
      ) : null}
      {formatPct(snap.print.progressPct) ? (
        <button
          type="button"
          className="printer-chip mono-num"
          data-testid="printer-chip-progress"
          onClick={() => focusSection("monitor", "device-section-print")}
          title={t("status.printer.progress")}
        >
          {formatPct(snap.print.progressPct)}
        </button>
      ) : null}
      {formatClock(snap.print.remainingSeconds) ? (
        <button
          type="button"
          className="printer-chip mono-num"
          data-testid="printer-chip-clock"
          onClick={() => focusSection("monitor", "device-section-print")}
          title={t("status.printer.clock")}
        >
          {formatClock(snap.print.remainingSeconds)}
        </button>
      ) : null}

      {/* Fan + ACE chips — click → Fans / Filament section */}
      <button
        type="button"
        className="printer-chip mono-num"
        data-testid="printer-chip-fan"
        onClick={() => focusSection("monitor", "device-section-fans")}
        title={t("status.printer.fan")}
      >
        ❄{formatPct(snap.fans.partCoolingPct) ?? "—"}
      </button>
      {aceSlot !== null ? (
        <button
          type="button"
          className="printer-chip mono-num"
          data-testid="printer-chip-ace-slot"
          onClick={() => focusSection("filament")}
          title={t("status.printer.ace.slot")}
        >
          {t("status.printer.ace.slot")} {aceSlot}
        </button>
      ) : null}

      {/* Low/crit filament dot */}
      {lowestAlert !== "none" ? (
        <span
          className={`printer-dot printer-dot-${lowestAlert}`}
          data-testid="printer-dot-filament"
          title={t(
            lowestAlert === "crit" ? "toast.filament.crit.message" : "toast.filament.low.message",
          )}
        />
      ) : null}

      {/* ACE error chip (red) */}
      {errCode !== null && isAceErrorCode(errCode) ? (
        <button
          type="button"
          className="printer-chip printer-chip-error mono-num"
          data-testid="printer-chip-ace-error"
          onClick={() => focusSection("filament")}
          title={t("status.printer.ace.error")}
        >
          {t("status.printer.ace.error")} {errCode}
        </button>
      ) : null}

      {/* Reachability banner chip */}
      {pollingStatus === "offline" ? (
        <span className="printer-chip printer-chip-offline" data-testid="printer-chip-offline">
          {t("status.printer.reachability.offline")}
        </span>
      ) : pollingStatus === "stale" ? (
        <span className="printer-chip printer-chip-stale" data-testid="printer-chip-stale">
          {t("status.printer.reachability.stale")}
        </span>
      ) : null}
    </div>
  );
}
