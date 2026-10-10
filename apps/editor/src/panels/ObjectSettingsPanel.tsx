/**
 * S9.6-002 — Per-object print settings + filament assignment panel.
 *
 * Shows the selected object's settings as either "using global" (no fork) or
 * "overridden" (per-object fork). The override toggle forks the current
 * global draft fields; Reset-to-parent clears the fork; filament assignment
 * stores a `filamentId` on the object (prepares G19 painting later). Every
 * mutation persists through the authoritative bridge lane (ObjectTree /
 * TransformInspector pattern) — the snapshot rehydrates the store.
 */

import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import type { ObjectPrintSettings } from "../bridge/types";
import type { SceneObjectSnapshot } from "../bridge/types";
import { FILAMENT_PRESETS } from "../presets/catalog";
import { useScene } from "../state/scene";
import { useI18n } from "../state/i18n";
import { useUi } from "../state/ui";
import { usePrinterDevice } from "../state/printer-device";
import { usePrinters } from "../state/printers";
import type { MsgKey } from "../state/i18n-core";

interface ObjectSettingsPanelProps {
  readonly scene: BridgeHandle | undefined;
}

/** Global defaults the fork starts from (mirrors SettingsPanel DEFAULT_DRAFT). */
const GLOBAL_DEFAULTS: ObjectPrintSettings = {
  layerHeightMm: 0.2,
  lineWidthMm: 0.45,
  nozzleDiameterMm: 0.4,
  wallLoops: 2,
  topBottomLayers: 4,
  infillDensityPct: 15,
  infillPattern: "Grid",
  nozzleTempC: 210,
  bedTempC: 60,
  fanPct: 100,
  printSpeedMmS: 30,
};

export function ObjectSettingsPanel({ scene }: ObjectSettingsPanelProps) {
  const t = useI18n((s) => s.t);
  const queryClient = useQueryClient();
  const pushToast = useUi((s) => s.pushToast);
  const selected = useScene((s) => s.selected);
  const selectedNames = useScene((s) => s.selectedNames);
  const objects = useScene((s) => s.objects);

  const name = selected?.name ?? null;
  const object = name ? (objects.find((o) => o.name === name) ?? null) : null;
  const forked = object?.printSettings != null;
  const filamentId = object?.filamentId;
  const materialBinding = object?.materialBinding;
  const selectedPrinterId = usePrinters((state) => state.selectedId);
  const printerSnapshot = usePrinterDevice((state) => state.snapshot);
  const printerStatus = usePrinterDevice((state) => state.pollingStatus);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [toolId, setToolId] = useState(materialBinding?.toolId ?? "");

  useEffect(() => {
    setToolId(materialBinding?.toolId ?? "");
    setSelectedSlot("");
  }, [name, materialBinding?.toolId]);

  // P1-7 — multi-selection mixed state (plan: `object.mixed`). When more than
  // one object is selected and their filament assignments differ, show the
  // mixed label instead of a single resolved value.
  const multiSelected = selectedNames.filter((n) => objects.some((o) => o.name === n));
  const filamentIds = new Set(
    multiSelected.map((n) => objects.find((o) => o.name === n)?.filamentId ?? null),
  );
  const filamentMixed = multiSelected.length > 1 && filamentIds.size > 1;

  const persist = useCallback(
    async (mutation: Parameters<BridgeHandle["mutateObject"]>[0]) => {
      if (!scene) return;
      try {
        const res = await scene.mutateObject(mutation);
        if (!res.ok) {
          console.warn(`[object-settings] mutate rejected: ${res.error}`);
          pushToast({
            kind: "error",
            title: t("object.updateFailed"),
            message: res.error,
          });
        }
      } catch (err) {
        console.warn("[object-settings] mutate failed", err);
        pushToast({
          kind: "error",
          title: t("object.updateFailed"),
          message: String(err),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
    },
    [scene, queryClient, pushToast, t],
  );

  const enableFork = async () => {
    if (!name) return;
    // Fork = snapshot of the current global defaults (all fields set so the
    // override is explicit and editable).
    await persist({ kind: "setObjectSettings", name, settings: { ...GLOBAL_DEFAULTS } });
  };

  const updateField = async (key: keyof ObjectPrintSettings, value: number | string) => {
    if (!name) return;
    const base = object?.printSettings ?? GLOBAL_DEFAULTS;
    await persist({
      kind: "setObjectSettings",
      name,
      settings: { ...base, [key]: value },
    });
  };

  const resetToParent = async () => {
    if (!name) return;
    await persist({ kind: "setObjectSettings", name });
  };

  const assignFilament = async (nextFilamentId: string) => {
    if (!name) return;
    const base = object?.printSettings ?? GLOBAL_DEFAULTS;
    await persist({
      kind: "setObjectSettings",
      name,
      settings: { ...base },
      filamentId: nextFilamentId,
    });
  };

  const assignBinding = async (nextBinding: SceneObjectSnapshot["materialBinding"] | null) => {
    if (!name) return;
    await persist({ kind: "setMaterialBinding", name, binding: nextBinding });
  };

  const availableSlots =
    printerSnapshot?.printerId === selectedPrinterId
      ? printerSnapshot.ace.boxes.flatMap((box) =>
          box.slots
            .filter((slot) => slot.material != null && slot.material !== "")
            .map((slot) => ({ box, slot })),
        )
      : [];
  const selectedSlotIsAvailable = availableSlots.some(
    ({ box, slot }) => `${box.index}:${slot.index}` === selectedSlot,
  );
  const canSaveBinding =
    Boolean(
      name && selectedPrinterId && selectedSlot && selectedSlotIsAvailable && toolId.trim(),
    ) &&
    printerStatus !== "offline" &&
    printerStatus !== "stale" &&
    printerSnapshot?.printerId === selectedPrinterId;

  if (!name || !object) {
    return (
      <section className="panel-object-settings" aria-label={t("objectSettings.label")}>
        <header className="panel-title">{t("objectSettings.title")}</header>
        <p className="panel-hint">{t("objectSettings.selectHint")}</p>
      </section>
    );
  }

  const fields: ReadonlyArray<{
    readonly key: keyof ObjectPrintSettings;
    readonly labelKey: MsgKey;
    readonly unit?: string;
  }> = [
    { key: "layerHeightMm", labelKey: "objectSettings.field.layerHeight", unit: "mm" },
    { key: "lineWidthMm", labelKey: "objectSettings.field.lineWidth", unit: "mm" },
    { key: "nozzleDiameterMm", labelKey: "objectSettings.field.nozzle", unit: "mm" },
    { key: "wallLoops", labelKey: "objectSettings.field.wallLoops" },
    { key: "topBottomLayers", labelKey: "objectSettings.field.topBottom" },
    { key: "infillDensityPct", labelKey: "objectSettings.field.infillDensity", unit: "%" },
    { key: "nozzleTempC", labelKey: "objectSettings.field.nozzleTemp", unit: "°C" },
    { key: "bedTempC", labelKey: "objectSettings.field.bedTemp", unit: "°C" },
    { key: "fanPct", labelKey: "objectSettings.field.partFan", unit: "%" },
    { key: "printSpeedMmS", labelKey: "objectSettings.field.printSpeed", unit: "mm/s" },
  ];

  return (
    <section className="panel-object-settings" aria-label={t("objectSettings.label")}>
      <header className="panel-title">{t("objectSettings.title")}</header>

      <div
        className={`object-settings-mode${forked ? " overridden" : ""}`}
        data-testid="object-settings-mode"
      >
        <span className="object-settings-indicator" aria-hidden="true" />
        {forked ? t("objectSettings.mode.overridden") : t("objectSettings.mode.global")}
      </div>

      <div className="object-settings-actions">
        {forked ? (
          <button
            type="button"
            data-testid="object-settings-reset"
            onClick={() => void resetToParent()}
          >
            {t("objectSettings.resetParent")}
          </button>
        ) : (
          <button
            type="button"
            data-testid="object-settings-toggle"
            onClick={() => void enableFork()}
          >
            {t("objectSettings.override")}
          </button>
        )}
      </div>

      <label className="settings-stack">
        {t("objectSettings.filament")}
        <span className="object-filament-compact" data-testid="object-filament-compact">
          <span
            className="obj-filament-swatch"
            aria-hidden="true"
            style={{
              background:
                (filamentId ? FILAMENT_PRESETS.find((f) => f.id === filamentId)?.color : null) ??
                "#bdbdbd",
            }}
          />
          <select
            data-testid="object-filament-select"
            value={filamentId ?? "global"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              void (value === "global" ? resetToParent() : assignFilament(value));
            }}
          >
            <option value="global">
              {t("objectSettings.filament.global")} — {t("object.inherited")}
            </option>
            {FILAMENT_PRESETS.map((filament) => (
              <option key={filament.id} value={filament.id}>
                {filament.material}
              </option>
            ))}
          </select>
          <span className="object-filament-state">
            {filamentMixed
              ? t("object.mixed")
              : filamentId
                ? t("object.overridden")
                : t("object.inherited")}
          </span>
        </span>
        {filamentId ? (
          <button
            type="button"
            className="object-filament-reset"
            data-testid="object-filament-reset"
            onClick={() => void resetToParent()}
          >
            {t("object.resetOverrides")}
          </button>
        ) : null}
      </label>

      <label className="settings-stack">
        {t("objectSettings.binding.title")}
        <select
          data-testid="material-binding-slot"
          value={selectedSlot}
          onChange={(event) => setSelectedSlot(event.currentTarget.value)}
        >
          <option value="">{t("objectSettings.binding.selectLoaded")}</option>
          {availableSlots.map(({ box, slot }) => (
            <option key={`${box.index}:${slot.index}`} value={`${box.index}:${slot.index}`}>
              Box {box.index + 1} · Slot {slot.index + 1} ·{" "}
              {slot.material ?? t("objectSettings.binding.unknownMaterial")}
            </option>
          ))}
        </select>
        <input
          aria-label={t("objectSettings.binding.toolId")}
          data-testid="material-binding-tool"
          value={toolId}
          onChange={(event) => setToolId(event.currentTarget.value)}
          placeholder={t("objectSettings.binding.toolIdentifier")}
        />
        <span className="object-filament-state" data-testid="material-binding-status">
          {!materialBinding
            ? t("objectSettings.binding.unassigned")
            : printerStatus === "offline"
              ? t("objectSettings.binding.printerOffline")
              : printerStatus === "stale"
                ? t("objectSettings.binding.snapshotStale")
                : materialBinding.printerId === selectedPrinterId
                  ? t("objectSettings.binding.boundSlot", {
                      box: String(materialBinding.boxId + 1),
                      slot: String(materialBinding.slotIndex + 1),
                    })
                  : t("objectSettings.binding.otherPrinter")}
        </span>
        <small>{t("objectSettings.binding.metadataOnly")}</small>
        <span className="object-settings-actions">
          <button
            type="button"
            data-testid="material-binding-save"
            disabled={!canSaveBinding}
            onClick={() => {
              if (!canSaveBinding) return;
              const [boxId, slotIndex] = selectedSlot.split(":").map(Number);
              if (boxId === undefined || slotIndex === undefined || !selectedPrinterId || !name)
                return;
              void assignBinding({
                printerId: selectedPrinterId,
                toolId: toolId.trim(),
                boxId,
                slotIndex,
                revision: printerSnapshot?.capturedAt ?? 0,
              });
              setSelectedSlot("");
            }}
          >
            {t("objectSettings.binding.save")}
          </button>
          <button
            type="button"
            data-testid="material-binding-clear"
            disabled={!materialBinding}
            onClick={() => void assignBinding(null)}
          >
            {t("objectSettings.binding.clear")}
          </button>
        </span>
      </label>

      <fieldset className="object-settings-fields" disabled={!forked}>
        <legend>{t("objectSettings.forkedValues")}</legend>
        {fields.map((field) => (
          <label className="settings-field" key={field.key}>
            <span>{t(field.labelKey)}</span>
            <span className="settings-value">
              <input
                type="number"
                step="any"
                value={object.printSettings?.[field.key] ?? GLOBAL_DEFAULTS[field.key]}
                data-testid={`object-setting-${field.key}`}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value)) void updateField(field.key, value);
                }}
              />
              {field.unit ? <small>{field.unit}</small> : null}
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
