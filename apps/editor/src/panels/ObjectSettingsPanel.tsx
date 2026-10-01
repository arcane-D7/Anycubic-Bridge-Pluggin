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

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import type { ObjectPrintSettings } from "../bridge/types";
import { FILAMENT_PRESETS } from "../presets/catalog";
import { useScene } from "../state/scene";
import { useI18n } from "../state/i18n";
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
  const selected = useScene((s) => s.selected);
  const objects = useScene((s) => s.objects);

  const name = selected?.name ?? null;
  const object = name ? (objects.find((o) => o.name === name) ?? null) : null;
  const forked = object?.printSettings != null;
  const filamentId = object?.filamentId;

  const persist = useCallback(
    async (mutation: Parameters<BridgeHandle["mutateObject"]>[0]) => {
      if (!scene) return;
      try {
        const res = await scene.mutateObject(mutation);
        if (!res.ok) {
          console.warn(`[object-settings] mutate rejected: ${res.error}`);
        }
      } catch (err) {
        console.warn("[object-settings] mutate failed", err);
      }
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
    },
    [scene, queryClient],
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
        <select
          data-testid="object-filament-select"
          value={filamentId ?? "global"}
          onChange={(event) => {
            const value = event.currentTarget.value;
            void (value === "global" ? resetToParent() : assignFilament(value));
          }}
        >
          <option value="global">{t("objectSettings.filament.global")}</option>
          {FILAMENT_PRESETS.map((filament) => (
            <option key={filament.id} value={filament.id}>
              {filament.material}
            </option>
          ))}
        </select>
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
