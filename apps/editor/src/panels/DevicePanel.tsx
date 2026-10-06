import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/state/i18n";
import { usePrinters } from "@/state/printers";
import { usePrinterDevice, type PollingStatus } from "@/state/printer-device";
import type { PrinterSnapshot, SpeedMode } from "@/bridge/types";
import type { MsgKey } from "@/state/i18n-core";

/**
 * S9.9-004 — Device panel: Monitor tab (read-only).
 *
 * Thick-panel content for the floating/docked "Device" host. Left column:
 * temperature cards (current big / target small), fan speeds, motion/AI/
 * lights, storage; right column: peripherals + on-demand camera start.
 * Every section is `capabilities`-gated so a bare printer shows only what
 * it has. The camera ONLY starts on user action (firmware turns the chamber
 * light on at capture start — never preload).
 *
 * Data comes from the adaptive polling store (`usePrinterDevice`); the
 * LAN selection lives in `usePrinters`. No write actions here — writes are
 * Sprint 9.10.
 */

interface TempCardProps {
  readonly label: string;
  readonly currentC: number | null;
  readonly targetC: number | null;
}

function TempCard({ label, currentC, targetC }: TempCardProps) {
  return (
    <div className="device-temp-card" data-testid="device-temp-card">
      <span className="device-temp-label">{label}</span>
      <span className="device-temp-current mono-num" data-testid="device-temp-current">
        {currentC === null ? "—" : `${Math.round(currentC)}°`}
      </span>
      <span className="device-temp-target mono-num" data-testid="device-temp-target">
        {targetC === null ? null : `→ ${Math.round(targetC)}°`}
      </span>
    </div>
  );
}

function FanRow({ label, pct }: { readonly label: string; readonly pct: number | null }) {
  return (
    <div className="device-fan-row" data-testid="device-fan-row">
      <span className="device-fan-label">{label}</span>
      <div className="device-fan-track" role="img" aria-label={`${label} ${pct ?? 0}%`}>
        <div
          className="device-fan-fill"
          data-testid="device-fan-fill"
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      <span className="device-fan-pct mono-num">{pct === null ? "—" : `${Math.round(pct)}%`}</span>
    </div>
  );
}

const PRINT_STATE_KEY: Record<string, MsgKey> = {
  unknown: "device.print.state.unknown",
  idle: "device.print.state.idle",
  printing: "device.print.state.printing",
  paused: "device.print.state.paused",
  error: "device.print.state.error",
  offline: "device.print.state.offline",
};

const SPEED_KEY: Record<SpeedMode, MsgKey> = {
  silent: "device.print.speed.silent",
  standard: "device.print.speed.standard",
  sport: "device.print.speed.sport",
};

function FormatSeconds(total: number | null): string | null {
  if (total === null) return null;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function DevicePanelMonitor() {
  const t = useI18n((s) => s.t);
  const selectedId = usePrinters((s) => s.selectedId);
  const { printerId, snapshot, pollingStatus } = usePrinterDevice();
  const [cameraOn, setCameraOn] = useState(false);

  const snap: PrinterSnapshot | null = useMemo(
    () => snapshot,
    // The store replaces the snapshot object reference on every fetch.
    [snapshot],
  );

  // Wire the polling loop to the LAN selection: pick a printer → poll it.
  useEffect(() => {
    const store = usePrinterDevice;
    if (selectedId) {
      store.getState().startPolling(selectedId);
    } else {
      store.getState().stopPolling();
    }
    return () => {
      store.getState().stopPolling();
    };
  }, [selectedId]);

  if (!selectedId) {
    return (
      <div className="device-empty" data-testid="device-empty">
        <span className="device-empty-title">{t("device.empty.title")}</span>
        <span className="device-empty-msg">{t("device.empty.msg")}</span>
      </div>
    );
  }

  const statusBanner =
    pollingStatus === "offline" ? (
      <div className="device-banner device-banner-offline" data-testid="device-banner-offline">
        {t("device.offline.banner")}
      </div>
    ) : pollingStatus === "stale" && printerId ? (
      <div className="device-banner device-banner-stale" data-testid="device-banner-stale">
        {t("device.stale.banner")}
      </div>
    ) : null;

  const printState = snap?.print.state ?? "unknown";
  const speedKey = snap?.print.speedMode ? SPEED_KEY[snap.print.speedMode] : null;

  return (
    <div className="device-panel" data-testid="device-panel">
      {statusBanner}
      <section className="device-section" data-testid="device-section-print">
        <header className="device-section-title">{t("device.print.title")}</header>
        <div className="device-print-state" data-testid="device-print-state">
          <span className={`device-state-dot device-state-${printState}`} aria-hidden="true" />
          {t(PRINT_STATE_KEY[printState] ?? "device.print.state.unknown")}
          {speedKey ? <span className="device-speed mono-num">{t(speedKey)}</span> : null}
        </div>
        {snap?.print.filename ? (
          <div className="device-print-file mono-num" data-testid="device-print-file">
            {t("device.print.file")}: {snap.print.filename}
          </div>
        ) : null}
        {snap?.print.totalLayers ? (
          <div className="device-print-layer mono-num" data-testid="device-print-layer">
            {t("device.print.layer", {
              curr: String(snap.print.currLayer ?? 0),
              total: String(snap.print.totalLayers),
            })}
          </div>
        ) : null}
        {snap?.print.progressPct !== null && snap?.print.progressPct !== undefined ? (
          <div className="device-print-progress mono-num" data-testid="device-print-progress">
            {t("device.print.progress", { pct: String(Math.round(snap.print.progressPct)) })}
          </div>
        ) : null}
        {snap?.print.remainingSeconds != null ? (
          <div className="device-print-remaining mono-num" data-testid="device-print-remaining">
            {t("device.print.remaining", {
              secs: FormatSeconds(snap.print.remainingSeconds) ?? "0",
            })}
          </div>
        ) : null}
      </section>

      <section className="device-section" data-testid="device-section-temps">
        <header className="device-section-title">{t("device.temp.nozzle")}</header>
        <div className="device-temps-grid">
          <TempCard
            label={t("device.temp.nozzle")}
            currentC={snap?.temps.nozzle.currentC ?? null}
            targetC={snap?.temps.nozzle.targetC ?? null}
          />
          <TempCard
            label={t("device.temp.bed")}
            currentC={snap?.temps.bed.currentC ?? null}
            targetC={snap?.temps.bed.targetC ?? null}
          />
          {snap?.capabilities.chamber ? (
            <TempCard
              label={t("device.temp.chamber")}
              currentC={snap?.temps.chamber.currentC ?? null}
              targetC={snap?.temps.chamber.targetC ?? null}
            />
          ) : null}
        </div>
      </section>

      <section className="device-section" data-testid="device-section-fans">
        <header className="device-section-title">{t("device.fans.aria")}</header>
        <FanRow label={t("device.fans.part")} pct={snap?.fans.partCoolingPct ?? null} />
        <FanRow label={t("device.fans.hotend")} pct={snap?.fans.hotendPct ?? null} />
      </section>

      {snap?.motion ? (
        <section className="device-section" data-testid="device-section-motion">
          <header className="device-section-title">{t("device.motion.title")}</header>
          <span className="device-motion mono-num">
            {t("device.motion.xyz", {
              x: String(snap.motion.xMm ?? 0),
              y: String(snap.motion.yMm ?? 0),
              z: String(snap.motion.zMm ?? 0),
            })}
          </span>
        </section>
      ) : null}

      {snap?.ai ? (
        <section className="device-section" data-testid="device-section-ai">
          <header className="device-section-title">{t("device.ai.title")}</header>
          <span className="device-ai-enabled">
            {t(snap.ai.enabled ? "device.ai.enabled" : "device.lights.off")}
            {snap.ai.sensitivity !== null ? (
              <span className="device-ai-sens mono-num">
                {" "}
                · {t("device.ai.sensitivity")} {snap.ai.sensitivity}
              </span>
            ) : null}
          </span>
        </section>
      ) : null}

      {snap?.lights ? (
        <section className="device-section" data-testid="device-section-lights">
          <header className="device-section-title">{t("device.lights.title")}</header>
          <span className={`device-light device-light-${snap.lights.enabled ? "on" : "off"}`}>
            {t(snap.lights.enabled ? "device.lights.on" : "device.lights.off")}
            {snap.lights.brightnessPct !== null ? (
              <span className="mono-num"> {Math.round(snap.lights.brightnessPct)}%</span>
            ) : null}
          </span>
        </section>
      ) : null}

      <section className="device-section" data-testid="device-section-peripherals">
        <header className="device-section-title">{t("device.peripherals.title")}</header>
        <div className="device-chip-row">
          <span
            className={`device-chip${snap?.peripherals.hasCamera ? " device-chip-on" : ""}`}
            data-testid="device-chip-camera"
          >
            {t("device.peripherals.camera")}
          </span>
          <span
            className={`device-chip${snap?.peripherals.hasMultiColorBox ? " device-chip-on" : ""}`}
            data-testid="device-chip-ace"
          >
            {t("device.peripherals.ace")}
          </span>
          <span
            className={`device-chip${snap?.peripherals.hasUsbDrive ? " device-chip-on" : ""}`}
            data-testid="device-chip-usb"
          >
            {t("device.peripherals.usb")}
          </span>
        </div>
      </section>

      {snap?.capabilities.camera ? (
        <section className="device-section" data-testid="device-section-camera">
          <header className="device-section-title">{t("device.camera.title")}</header>
          {cameraOn ? (
            <div className="device-camera-preview" data-testid="device-camera-preview">
              <span className="device-camera-hint">{t("device.camera.title")} —</span>
              {/* The player wires here in S9.11-003 live overlay (H.264/FLV by
                  capability); starting ONLY on demand avoids turning the
                  chamber light on without user intent. */}
              <video
                className="device-camera-video"
                muted
                playsInline
                data-testid="device-camera-video"
              />
            </div>
          ) : (
            <button
              type="button"
              className="device-camera-start"
              data-testid="device-camera-start"
              onClick={() => setCameraOn(true)}
            >
              {t("device.camera.start")}
            </button>
          )}
        </section>
      ) : null}

      {snap?.storage ? (
        <section className="device-section" data-testid="device-section-storage">
          <header className="device-section-title">{t("device.storage.title")}</header>
          <div className="device-storage-row mono-num">
            <span>
              {t("device.storage.kind")}: {snap.storage.kind}
            </span>
            {snap.storage.usedBytes != null ? (
              <span>
                {t("device.storage.used")}: {mb(snap.storage.usedBytes)} MB
              </span>
            ) : null}
            {snap.storage.totalBytes != null ? (
              <span>
                {t("device.storage.free")}:{" "}
                {mb(snap.storage.totalBytes - (snap.storage.usedBytes ?? 0))} MB
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function mb(bytes: number): string {
  return String(Math.max(0, Math.round(bytes / (1024 * 1024))));
}

export type { PollingStatus };
