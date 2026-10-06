import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/state/i18n";
import { usePrinters } from "@/state/printers";
import { usePrinterDevice, type PollingStatus } from "@/state/printer-device";
import { usePrinterControl, type ControlRequest } from "@/state/printer-control";
import { useUi } from "@/state/ui";
import { useDock } from "@/state/dock";
import {
  editOriginKey,
  isLoadedSlot,
  materialLabel,
  ringClassFor,
  type AceBox,
  type AceSlot,
} from "@/state/printer-filament-core";
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
  /** When provided the card gets target steppers (S9.10-002). */
  readonly onTarget?: (targetC: number) => void;
  readonly stepC?: number;
  readonly disabled?: boolean;
}

function TempCard({ label, currentC, targetC, onTarget, stepC = 5, disabled }: TempCardProps) {
  const t = useI18n((s) => s.t);
  const target = targetC ?? currentC ?? 0;
  return (
    <div className="device-temp-card" data-testid="device-temp-card">
      <span className="device-temp-label">{label}</span>
      <span className="device-temp-current mono-num" data-testid="device-temp-current">
        {currentC === null ? "—" : `${Math.round(currentC)}°`}
      </span>
      <div className="device-temp-target-row">
        <span className="device-temp-target mono-num" data-testid="device-temp-target">
          {targetC === null ? null : `→ ${Math.round(targetC)}°`}
        </span>
        {onTarget ? (
          <div className="device-step" data-testid="device-temp-step">
            <button
              type="button"
              className="device-step-btn"
              aria-label={t("control.step.decrement")}
              disabled={disabled}
              onClick={() => onTarget(target - stepC)}
            >
              −
            </button>
            <button
              type="button"
              className="device-step-btn"
              aria-label={t("control.step.increment")}
              disabled={disabled}
              onClick={() => onTarget(target + stepC)}
            >
              +
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface FanRowProps {
  readonly label: string;
  readonly pct: number | null;
  /** When provided the row gets speed steppers (S9.10-002). */
  readonly onSpeed?: (pct: number) => void;
  readonly stepPct?: number;
  readonly disabled?: boolean;
}

function FanRow({ label, pct, onSpeed, stepPct = 5, disabled }: FanRowProps) {
  const t = useI18n((s) => s.t);
  const value = pct ?? 0;
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
      {onSpeed ? (
        <div className="device-step" data-testid="device-fan-step">
          <button
            type="button"
            className="device-step-btn"
            aria-label={t("control.step.decrement")}
            disabled={disabled}
            onClick={() => onSpeed(value - stepPct)}
          >
            −
          </button>
          <button
            type="button"
            className="device-step-btn"
            aria-label={t("control.step.increment")}
            disabled={disabled}
            onClick={() => onSpeed(value + stepPct)}
          >
            +
          </button>
        </div>
      ) : null}
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

/**
 * S9.10-002 — single control-send path for the Device Monitor controls.
 * Every stepper/slider/select maps to `printer_command_send` through the
 * pure envelope core (bounds + confirm + policy) and the store's semantic
 * toasts (accepted/refused/timeout/invalid — no silent failures).
 */
function useControlSender() {
  const t = useI18n((s) => s.t);
  const sendControl = usePrinterControl((s) => s.sendControl);
  const busy = usePrinterControl((s) => s.busy);
  const selectedId = usePrinters((s) => s.selectedId);
  const pushToast = useUi((s) => s.pushToast);

  const send = useCallback(
    (payload: ControlRequest) => {
      if (!selectedId) {
        pushToast({
          kind: "warning",
          title: t("device.empty.title"),
          message: t("device.empty.msg"),
        });
        return;
      }
      void (async () => {
        const lane = await import("@/bridge/mock");
        const handle = await lane.fetchSceneSnapshot();
        await sendControl({
          action: payload.action,
          payload,
          printerId: selectedId,
          lane: handle,
          toast: pushToast,
          t,
        });
      })();
    },
    [selectedId, sendControl, pushToast, t],
  );

  return { send, busy };
}

/**
 * S9.9-005 — Filament tab (read-only ACE view).
 *
 * Grid of slots (4 per box, up to 2 boxes): real color swatch, material,
 * remaining% progress ring (amber <50%, red <15% → toast), RFID-vs-manual
 * badge, box temp/humidity, dryer state + temp + remaining, auto-feed tag,
 * loaded_slot highlight. Write actions (dryer/auto-feed/bind) are Sprint 9.10.
 */
function SlotCard({
  t,
  box,
  slot,
}: {
  t: (k: MsgKey, vars?: Readonly<Record<string, string>>) => string;
  box: AceBox;
  slot: AceSlot;
}) {
  const loaded = isLoadedSlot(box, slot.index);
  const ring = ringClassFor(slot.remainingPct);
  const pct = slot.remainingPct;
  return (
    <div
      className={`device-slot${loaded ? " is-loaded" : ""}${slot.state === "empty" ? " is-empty" : ""}`}
      data-testid="device-slot"
      data-slot-index={slot.index}
      data-loaded={loaded ? "true" : "false"}
    >
      <header className="device-slot-head">
        <span className="device-slot-name">
          {t("device.fil.slot", { index: String(slot.index + 1) })}
        </span>
        {loaded ? (
          <span className="device-slot-loaded" data-testid="device-slot-loaded">
            {t("device.fil.loaded")}
          </span>
        ) : null}
      </header>
      <div className="device-slot-body">
        <div
          className={`device-ring${ring}`}
          role="img"
          aria-label={t("device.fil.remaining", { pct: String(pct ?? "—") })}
          data-testid="device-ring"
          data-tone={ring.replace(" device-ring-", "") || "na"}
        >
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle className="device-ring-track" cx="18" cy="18" r="15.5" />
            <circle
              className="device-ring-fill"
              cx="18"
              cy="18"
              r="15.5"
              strokeDasharray={`${pct === null ? 0 : Math.max(0, Math.min(100, pct))} 100`}
            />
          </svg>
          <span className="device-ring-pct mono-num">{pct === null ? "—" : `${pct}%`}</span>
        </div>
        <div className="device-slot-info">
          <span className="device-swatch-line">
            <span
              className="device-swatch"
              style={{ background: slot.color ?? "transparent" }}
              data-testid="device-swatch"
            />
            <span className="device-material">{materialLabel(slot)}</span>
          </span>
          <span className="device-origin">
            {t("device.fil.origin.title")}: {t(editOriginKey(slot.editOrigin))}
          </span>
        </div>
      </div>
    </div>
  );
}

function FilamentTab({ snap }: { snap: PrinterSnapshot | null }) {
  const t = useI18n((s) => s.t);
  const boxes: readonly AceBox[] = snap?.ace.boxes ?? [];
  if (boxes.length === 0) {
    return (
      <div className="device-empty" data-testid="device-fil-empty">
        <span className="device-empty-title">{t("device.fil.title")}</span>
        <span className="device-empty-msg">{t("device.fil.noBoxes")}</span>
      </div>
    );
  }
  return (
    <div className="device-panel device-fil-tab" data-testid="device-fil-tab">
      {boxes.map((box) => (
        <section className="device-section" key={box.index} data-testid="device-fil-box">
          <header className="device-section-title">
            {t("device.fil.box", { index: String(box.index + 1) })}
          </header>
          {box.ambientTempC !== null ? (
            <div className="device-box-env mono-num" data-testid="device-box-env">
              {Math.round(box.ambientTempC)}°C
              {box.humidityPct !== null ? ` · ${Math.round(box.humidityPct)}%` : ""}
            </div>
          ) : null}
          <div className="device-slot-grid">
            {box.slots.map((slot) => (
              <SlotCard t={t} box={box} slot={slot} key={slot.index} />
            ))}
          </div>
          {/* Dryer + auto-feed (read-only here — writes are 9.10) */}
          <div className="device-box-meta">
            <span className="device-meta-chip" data-testid="device-dryer">
              {t("device.fil.dryer.title")}: {box.drying.active ? "on" : "off"}
              {box.drying.active && box.drying.targetTempC !== null
                ? ` · ${Math.round(box.drying.targetTempC)}°C`
                : ""}
              {box.drying.active && box.drying.remainingSeconds !== null
                ? ` · ${FormatSeconds(box.drying.remainingSeconds)}`
                : ""}
            </span>
            <span className="device-meta-chip" data-testid="device-autofeed">
              {t("device.fil.autoFeed.title")}: {box.autoFeed ? "on" : "off"}
            </span>
          </div>
        </section>
      ))}
    </div>
  );
}

export function DevicePanelMonitor() {
  const t = useI18n((s) => s.t);
  const selectedId = usePrinters((s) => s.selectedId);
  const { printerId, snapshot, pollingStatus } = usePrinterDevice();
  const [cameraOn, setCameraOn] = useState(false);
  const [tab, setTab] = useState<"monitor" | "filament">("monitor");

  // S9.9-006 — status-bar chips navigate here: focus flips the tab and, when
  // a section id is given, scrolls the panel to that section after render.
  const deviceFocus = useDock((s) => s.deviceFocus);
  useEffect(() => {
    if (!deviceFocus) return;
    setTab(deviceFocus.tab);
    if (deviceFocus.section) {
      // Let the tab content mount first, then reveal the section.
      const raf = requestAnimationFrame(() => {
        const el = document.querySelector(`[data-testid="${deviceFocus?.section}"]`);
        el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [deviceFocus]);

  const snap: PrinterSnapshot | null = useMemo(
    () => snapshot,
    // The store replaces the snapshot object reference on every fetch.
    [snapshot],
  );

  // S9.10-002 — Device Monitor write controls map to printer_command_send.
  const { send, busy } = useControlSender();
  const toggleLight = useCallback(() => {
    void send({
      action: "lights.setEnabled",
      enabled: !snap?.lights?.enabled,
    });
  }, [send, snap?.lights?.enabled]);
  const setBrightness = useCallback(
    (brightnessPct: number) => {
      void send({ action: "lights.setBrightness", brightnessPct });
    },
    [send],
  );
  const setNozzleTarget = useCallback(
    (targetC: number) => void send({ action: "temps.setNozzle", targetC }),
    [send],
  );
  const setBedTarget = useCallback(
    (targetC: number) => void send({ action: "temps.setBed", targetC }),
    [send],
  );
  const setPartFan = useCallback(
    (speedPct: number) => void send({ action: "fans.setPart", speedPct }),
    [send],
  );
  const setSpeedMode = useCallback(
    (mode: SpeedMode) => void send({ action: "speed.setMode", mode }),
    [send],
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
      <div className="device-tabs" role="tablist" aria-label={t("device.panel.title")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "monitor"}
          className={`device-tab${tab === "monitor" ? " is-active" : ""}`}
          data-testid="device-tab-monitor"
          onClick={() => setTab("monitor")}
        >
          {t("device.tab.monitor")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "filament"}
          className={`device-tab${tab === "filament" ? " is-active" : ""}`}
          data-testid="device-tab-filament"
          onClick={() => setTab("filament")}
        >
          {t("device.tab.filament")}
        </button>
      </div>
      {tab === "filament" ? (
        <FilamentTab snap={snap} />
      ) : (
        <>
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
            {snap?.capabilities.print ? (
              <div className="device-speed-select" data-testid="device-speed-select">
                <label className="device-speed-label" htmlFor="device-speed-mode">
                  {t("control.speed.aria")}
                </label>
                <select
                  id="device-speed-mode"
                  className="device-speed-input"
                  value={snap.print.speedMode ?? "standard"}
                  disabled={busy}
                  data-testid="device-speed-mode"
                  onChange={(e) => setSpeedMode(e.target.value as SpeedMode)}
                >
                  <option value="silent">{t("device.print.speed.silent")}</option>
                  <option value="standard">{t("device.print.speed.standard")}</option>
                  <option value="sport">{t("device.print.speed.sport")}</option>
                </select>
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
                onTarget={snap?.capabilities.tempature ? setNozzleTarget : undefined}
                disabled={busy}
              />
              <TempCard
                label={t("device.temp.bed")}
                currentC={snap?.temps.bed.currentC ?? null}
                targetC={snap?.temps.bed.targetC ?? null}
                onTarget={snap?.capabilities.tempature ? setBedTarget : undefined}
                disabled={busy}
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
            <FanRow
              label={t("device.fans.part")}
              pct={snap?.fans.partCoolingPct ?? null}
              onSpeed={snap?.capabilities.fans ? setPartFan : undefined}
              disabled={busy}
            />
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
              <div className="device-light-row">
                <button
                  type="button"
                  className={`device-light-toggle${snap.lights.enabled ? " is-on" : ""}`}
                  data-testid="device-light-toggle"
                  disabled={busy}
                  onClick={toggleLight}
                >
                  {t(snap.lights.enabled ? "device.lights.on" : "device.lights.off")}
                </button>
                {snap.lights.enabled && snap.lights.brightnessPct !== null ? (
                  <div className="device-step" data-testid="device-light-step">
                    <button
                      type="button"
                      className="device-step-btn"
                      aria-label={t("control.step.decrement")}
                      disabled={busy}
                      onClick={() => setBrightness((snap.lights?.brightnessPct ?? 0) - 10)}
                    >
                      −
                    </button>
                    <span className="device-light-pct mono-num">
                      {Math.round(snap.lights.brightnessPct)}%
                    </span>
                    <button
                      type="button"
                      className="device-step-btn"
                      aria-label={t("control.step.increment")}
                      disabled={busy}
                      onClick={() => setBrightness((snap.lights?.brightnessPct ?? 0) + 10)}
                    >
                      +
                    </button>
                  </div>
                ) : null}
              </div>
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
        </>
      )}
    </div>
  );
}

function mb(bytes: number): string {
  return String(Math.max(0, Math.round(bytes / (1024 * 1024))));
}

export type { PollingStatus };
