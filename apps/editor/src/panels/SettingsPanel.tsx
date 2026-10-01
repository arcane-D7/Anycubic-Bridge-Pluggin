import { useState } from "react";
import { usePresets } from "../state/presets";
import { Swatch } from "../components/Swatch";
import { FILAMENT_PRESETS, PRINTER_PRESETS, QUALITY_PRESETS } from "../presets/catalog";
import type { QualityPresetId } from "../presets/catalog";
import {
  CATALOG_MACHINES,
  defaultOperatorProfile,
  withCatalogSelection,
  withContinuousZDeclaration,
} from "../profile/operatorProfile";
import type { OperatorProfile } from "../profile/operatorProfile";

const DEFAULT_DRAFT = {
  layer_height_mm: 0.2,
  line_width_mm: 0.45,
  nozzle_diameter_mm: 0.4,
  wall_loops: 2,
  top_bottom_layers: 4,
  infill_density_pct: 15,
  infill_pattern: "Grid",
  filament_diameter_mm: 1.75,
  material: "PLA",
  nozzle_temperature_c: 210,
  bed_temperature_c: 60,
  fan_pct: 100,
  print_speed_mm_s: 30,
  travel_speed_mm_s: 120,
};

type NumericKey = {
  [Key in keyof typeof DEFAULT_DRAFT]: (typeof DEFAULT_DRAFT)[Key] extends number ? Key : never;
}[keyof typeof DEFAULT_DRAFT];

interface SettingsPanelProps {
  readonly profile: OperatorProfile;
  readonly onProfileChange: (profile: OperatorProfile) => void;
}

export function SettingsPanel({ profile, onProfileChange }: SettingsPanelProps) {
  const [tab, setTab] = useState<"Printer" | "Filament" | "Process">("Printer");
  const [draft, setDraft] = useState(DEFAULT_DRAFT);
  const [exportStatus, setExportStatus] = useState("");
  const [supports, setSupports] = useState(false);
  const [brim, setBrim] = useState(false);
  const supportsEligible = true;
  const machine = CATALOG_MACHINES.find((entry) => entry.displayName === profile.displayName);
  const presetPrinterId = usePresets((state) => state.printerId);
  const presetFilamentId = usePresets((state) => state.filamentId);
  const presetQualityId = usePresets((state) => state.qualityId);
  const presetDraftValues = usePresets((state) => state.draftValues);
  const setPrinter = usePresets((state) => state.setPrinter);
  const setFilament = usePresets((state) => state.setFilament);
  const setQuality = usePresets((state) => state.setQuality);
  const setCustomLayerHeight = usePresets((state) => state.setCustomLayerHeight);
  const presetSelection = {
    printerId: presetPrinterId,
    filamentId: presetFilamentId,
    qualityId: presetQualityId,
    draftValues: presetDraftValues,
  };
  const presetActions = { setPrinter, setFilament, setQuality, setCustomLayerHeight };

  /** Apply preset values into the numeric draft (export path unchanged). */
  function applyPresetDraft() {
    const values = presetSelection.draftValues;
    if (!values) return;
    setDraft((current) => ({
      ...current,
      nozzle_diameter_mm: values.nozzleDiameterMm,
      nozzle_temperature_c: values.nozzleTempC,
      bed_temperature_c: values.bedTempC,
      layer_height_mm: values.layerHeightMm,
      line_width_mm: values.lineWidthMm,
      material: values.material,
    }));
    setExportStatus("Preset applied to draft");
  }

  function numeric(
    key: NumericKey,
    label: string,
    unit: string,
    min: number,
    max: number,
    step: number,
  ) {
    return (
      <label className="settings-field" key={key}>
        <span>{label}</span>
        <span className="settings-value">
          <input
            data-testid={`setting-${key}`}
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft[key]}
            onChange={(event) => {
              const value = event.currentTarget.valueAsNumber;
              if (event.currentTarget.validity.valid && Number.isFinite(value)) {
                setDraft((current) => ({ ...current, [key]: value }));
                setExportStatus("");
              }
            }}
          />
          <small>{unit}</small>
        </span>
      </label>
    );
  }

  function exportDraft() {
    const blob = new Blob(
      [
        JSON.stringify(
          { version: "1.0", status: "draft", printer: profile, settings: draft },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "slicer-settings-draft.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setExportStatus("Draft exported");
  }

  return (
    <section className="settings-panel" aria-label="Slicer settings">
      <div className="settings-heading">
        <strong>Print settings</strong>
        <span className="draft-badge">Draft</span>
      </div>
      <div
        className="settings-tabs"
        data-testid="settings-tabs"
        role="tablist"
        aria-label="Settings category"
      >
        {(["Printer", "Filament", "Process"] as const).map((name) => (
          <button
            key={name}
            id={`settings-tab-${name}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls="settings-content"
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="settings-content" aria-labelledby={`settings-tab-${tab}`}>
        {tab === "Printer" ? (
          <>
            <div className="settings-group">
              <h3>Presets</h3>
              <label className="settings-stack">
                Printer profile
                <select
                  data-testid="printer-preset-select"
                  value={presetSelection.printerId}
                  onChange={(event) => {
                    presetActions.setPrinter(event.currentTarget.value);
                    applyPresetDraft();
                  }}
                >
                  {PRINTER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.machine} · {preset.nozzleMm} mm · {preset.nozzleTempC} °C
                    </option>
                  ))}
                </select>
              </label>
              <label className="settings-stack">
                Quality preset
                <select
                  data-testid="quality-preset-select"
                  value={presetSelection.qualityId}
                  onChange={(event) => {
                    presetActions.setQuality(event.currentTarget.value as QualityPresetId);
                    applyPresetDraft();
                  }}
                >
                  {QUALITY_PRESETS.map((quality) => (
                    <option key={quality.id} value={quality.id}>
                      {quality.label}
                    </option>
                  ))}
                </select>
              </label>
              {presetSelection.qualityId === "custom" ? (
                <label className="settings-field">
                  <span>Custom layer height</span>
                  <span className="settings-value">
                    <input
                      data-testid="preset-custom-layer"
                      type="number"
                      min={0.05}
                      max={1}
                      step={0.01}
                      value={presetSelection.draftValues?.layerHeightMm ?? 0.2}
                      onChange={(event) => {
                        const value = event.currentTarget.valueAsNumber;
                        if (event.currentTarget.validity.valid && Number.isFinite(value)) {
                          presetActions.setCustomLayerHeight(value);
                          applyPresetDraft();
                        }
                      }}
                    />
                    <small>mm</small>
                  </span>
                </label>
              ) : null}
            </div>
            <div className="settings-group">
              <h3>Machine</h3>
              <label className="settings-stack">
                Printer
                <select
                  data-testid="printer-select"
                  value={machine?.id ?? ""}
                  onChange={(event) =>
                    onProfileChange(
                      event.currentTarget.value
                        ? withCatalogSelection(profile, event.currentTarget.value)
                        : defaultOperatorProfile(),
                    )
                  }
                >
                  <option value="">Select printer</option>
                  {CATALOG_MACHINES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-summary" data-testid="plate-volume">
                {profile.buildVolume
                  ? `${profile.buildVolume.widthMm} x ${profile.buildVolume.depthMm} x ${profile.buildVolume.heightMm} mm`
                  : "No printer profile selected"}
              </div>
              {numeric("nozzle_diameter_mm", "Nozzle diameter", "mm", 0.1, 2, 0.05)}
            </div>
            <div className="settings-group">
              <h3>Motion capabilities</h3>
              <label className="settings-field">
                <span>Continuous Z</span>
                <select
                  data-testid="continuous-z-select"
                  value={profile.continuousZ}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === "supported" || value === "unsupported" || value === "unknown")
                      onProfileChange(
                        withContinuousZDeclaration(profile, value, {
                          jointModel: machine?.id === "kobra-s1" ? "cartesian" : profile.jointModel,
                        }),
                      );
                  }}
                >
                  <option value="unknown">Unknown</option>
                  <option value="supported">Supported</option>
                  <option value="unsupported">Unsupported</option>
                </select>
              </label>
              <p className="settings-summary" data-testid="capability-source">
                {profile.provenance === "operator-declared"
                  ? "Source: operator declaration"
                  : "Capability not yet declared"}
              </p>
            </div>
          </>
        ) : tab === "Filament" ? (
          <>
            <div className="settings-group">
              <h3>Preset</h3>
              <label className="settings-stack">
                Filament
                <select
                  data-testid="filament-preset-select"
                  value={presetSelection.filamentId}
                  onChange={(event) => {
                    presetActions.setFilament(event.currentTarget.value);
                    applyPresetDraft();
                  }}
                >
                  {FILAMENT_PRESETS.map((filament) => (
                    <option key={filament.id} value={filament.id}>
                      {filament.material}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-swatches" data-testid="filament-swatches">
                {FILAMENT_PRESETS.map((filament) => (
                  <Swatch
                    key={filament.id}
                    testid={`swatch-${filament.id}`}
                    color={filament.color}
                    label={filament.material}
                  />
                ))}
              </div>
              <p className="settings-summary" data-testid="filament-color-summary">
                Active: {presetSelection.draftValues?.color ?? "—"}
              </p>
            </div>
            <div className="settings-group">
              <h3>Material</h3>
              <label className="settings-field">
                <span>Type</span>
                <select
                  value={draft.material}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, material: event.currentTarget.value }))
                  }
                >
                  {["PLA", "PETG", "ABS", "ASA", "TPU"].map((material) => (
                    <option key={material}>{material}</option>
                  ))}
                </select>
              </label>
              {numeric("filament_diameter_mm", "Diameter", "mm", 1, 3, 0.01)}
            </div>
            <div className="settings-group">
              <h3>Temperature</h3>
              {numeric("nozzle_temperature_c", "Nozzle", "C", 0, 320, 1)}
              {numeric("bed_temperature_c", "Bed", "C", 0, 120, 1)}
            </div>
            <div className="settings-group">
              <h3>Cooling</h3>
              {numeric("fan_pct", "Part fan", "%", 0, 100, 1)}
            </div>
          </>
        ) : (
          <>
            <details className="settings-group" open>
              <summary>Quality</summary>
              {numeric("layer_height_mm", "Layer height", "mm", 0.05, 1, 0.01)}
              {numeric("line_width_mm", "Line width", "mm", 0.1, 3, 0.01)}
            </details>
            <details className="settings-group" open>
              <summary>Strength</summary>
              {numeric("wall_loops", "Wall loops", "", 1, 20, 1)}
              {numeric("top_bottom_layers", "Top / bottom layers", "", 0, 30, 1)}
              {numeric("infill_density_pct", "Infill density", "%", 0, 100, 1)}
              <label className="settings-field">
                <span>Infill pattern</span>
                <select
                  value={draft.infill_pattern}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      infill_pattern: event.currentTarget.value,
                    }))
                  }
                >
                  <option>Grid</option>
                  <option value="GyroidSubset">Gyroid subset</option>
                </select>
              </label>
            </details>
            <details className="settings-group">
              <summary>Speed</summary>
              {numeric("print_speed_mm_s", "Print", "mm/s", 1, 600, 1)}
              {numeric("travel_speed_mm_s", "Travel", "mm/s", 1, 600, 1)}
            </details>
            <details className="settings-group">
              <summary>Support &amp; adhesion</summary>
              <fieldset disabled={!supportsEligible}>
                <label className="settings-field">
                  <span>Generate supports</span>
                  <input
                    type="checkbox"
                    data-testid="setting-supports"
                    checked={supports}
                    onChange={(event) => setSupports(event.currentTarget.checked)}
                  />
                </label>
                <label className="settings-field">
                  <span>Brim</span>
                  <input
                    type="checkbox"
                    data-testid="setting-brim"
                    checked={brim}
                    onChange={(event) => setBrim(event.currentTarget.checked)}
                  />
                </label>
              </fieldset>
              <p className="settings-summary" data-testid="supports-summary">
                {supportsEligible
                  ? `${supports ? "Supports" : "No supports"}${brim ? " · brim" : ""} — applied at slice time, gated by the watertight preflight.`
                  : "Not eligible yet — objects on the plate must be watertight."}
              </p>
            </details>
          </>
        )}
      </div>
      <div className="settings-export">
        <p className="settings-summary">Draft parameters. Existing toolpaths are unchanged.</p>
        <button type="button" data-testid="settings-export" onClick={exportDraft}>
          Export settings
        </button>
        <span role="status">{exportStatus}</span>
      </div>
    </section>
  );
}
