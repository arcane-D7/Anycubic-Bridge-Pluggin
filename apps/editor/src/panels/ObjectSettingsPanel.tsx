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
      <section className="panel-object-settings" aria-label="Object print settings">
        <header className="panel-title">Object settings</header>
        <p className="panel-hint">
          Select an object to override its print settings or assign a filament.
        </p>
      </section>
    );
  }

  const fields: ReadonlyArray<{
    readonly key: keyof ObjectPrintSettings;
    readonly label: string;
    readonly unit?: string;
  }> = [
    { key: "layerHeightMm", label: "Layer height", unit: "mm" },
    { key: "lineWidthMm", label: "Line width", unit: "mm" },
    { key: "nozzleDiameterMm", label: "Nozzle", unit: "mm" },
    { key: "wallLoops", label: "Wall loops" },
    { key: "topBottomLayers", label: "Top/bottom layers" },
    { key: "infillDensityPct", label: "Infill density", unit: "%" },
    { key: "nozzleTempC", label: "Nozzle temp", unit: "°C" },
    { key: "bedTempC", label: "Bed temp", unit: "°C" },
    { key: "fanPct", label: "Part fan", unit: "%" },
    { key: "printSpeedMmS", label: "Print speed", unit: "mm/s" },
  ];

  return (
    <section className="panel-object-settings" aria-label="Object print settings">
      <header className="panel-title">Object settings</header>

      <div
        className={`object-settings-mode${forked ? " overridden" : ""}`}
        data-testid="object-settings-mode"
      >
        <span className="object-settings-indicator" aria-hidden="true" />
        {forked
          ? "Overridden — this object does not use the global draft."
          : "Using global — object inherits the global print draft."}
      </div>

      <div className="object-settings-actions">
        {forked ? (
          <button
            type="button"
            data-testid="object-settings-reset"
            onClick={() => void resetToParent()}
          >
            Reset to parent
          </button>
        ) : (
          <button
            type="button"
            data-testid="object-settings-toggle"
            onClick={() => void enableFork()}
          >
            Override settings
          </button>
        )}
      </div>

      <label className="settings-stack">
        Filament
        <select
          data-testid="object-filament-select"
          value={filamentId ?? "global"}
          onChange={(event) => {
            const value = event.currentTarget.value;
            void (value === "global" ? resetToParent() : assignFilament(value));
          }}
        >
          <option value="global">Global</option>
          {FILAMENT_PRESETS.map((filament) => (
            <option key={filament.id} value={filament.id}>
              {filament.material}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="object-settings-fields" disabled={!forked}>
        <legend>Forked values</legend>
        {fields.map((field) => (
          <label className="settings-field" key={field.key}>
            <span>{field.label}</span>
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
