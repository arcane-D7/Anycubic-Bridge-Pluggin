import { useState } from "react";
import { usePresets } from "../state/presets";
import { useI18n } from "../state/i18n";
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
  const t = useI18n((s) => s.t);
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
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
    setExportStatus(t("settings.applyPresetToast"));
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
    setExportStatus(t("settings.export") + " ✓");
  }

  const tabKeys = [
    "settings.tabs.printer",
    "settings.tabs.filament",
    "settings.tabs.process",
  ] as const;
  const tabNames = ["Printer", "Filament", "Process"] as const;
  return (
    <section className="settings-panel" aria-label={t("settings.aria")}>
      <div className="settings-heading">
        <strong>{t("settings.heading")}</strong>
        <span className="draft-badge">{t("settings.draftBadge")}</span>
      </div>
      {/* S9.8-005 — UI language toggle (switches live, persisted to localStorage). */}
      <div className="settings-language">
        <label className="settings-stack" title={t("settings.language.hint")}>
          <span>{t("settings.language")}</span>
          <select
            data-testid="settings-language"
            aria-label={t("settings.language")}
            value={locale}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === "en" || value === "pt-BR") setLocale(value);
            }}
          >
            <option value="en">English</option>
            <option value="pt-BR">Português (BR)</option>
          </select>
        </label>
      </div>
      <div
        className="settings-tabs"
        data-testid="settings-tabs"
        role="tablist"
        aria-label={t("settings.tabs.aria")}
      >
        {tabNames.map((name, i) => (
          <button
            key={name}
            id={`settings-tab-${name}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls="settings-content"
            onClick={() => setTab(name)}
          >
            {t(tabKeys[i] ?? "settings.tabs.printer")}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="settings-content" aria-labelledby={`settings-tab-${tab}`}>
        {tab === "Printer" ? (
          <>
            <div className="settings-group">
              <h3>{t("settings.presets")}</h3>
              <label className="settings-stack">
                {t("settings.printerProfile")}
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
                {t("settings.qualityPreset")}
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
                  <span>{t("settings.customLayerHeight")}</span>
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
              <h3>{t("settings.machine")}</h3>
              <label className="settings-stack">
                {t("settings.selectPrinter")}
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
                  <option value="">{t("settings.selectPrinter")}</option>
                  {CATALOG_MACHINES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-summary" data-testid="plate-volume">
                {profile.buildVolume
                  ? t("settings.plateVolume", {
                      w: String(profile.buildVolume.widthMm),
                      d: String(profile.buildVolume.depthMm),
                      h: String(profile.buildVolume.heightMm),
                    })
                  : t("settings.noProfile")}
              </div>
              {numeric("nozzle_diameter_mm", t("settings.nozzleDiameter"), "mm", 0.1, 2, 0.05)}
            </div>
            <div className="settings-group">
              <h3>{t("settings.motionCapabilities")}</h3>
              <label className="settings-field">
                <span>{t("settings.continuousZ")}</span>
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
                  <option value="unknown">{t("settings.continuousZ.unknown")}</option>
                  <option value="supported">{t("settings.continuousZ.supported")}</option>
                  <option value="unsupported">{t("settings.continuousZ.unsupported")}</option>
                </select>
              </label>
              <p className="settings-summary" data-testid="capability-source">
                {profile.provenance === "operator-declared"
                  ? t("settings.source.operator")
                  : t("settings.source.undeclared")}
              </p>
            </div>
          </>
        ) : tab === "Filament" ? (
          <>
            <div className="settings-group">
              <h3>{t("settings.presets")}</h3>
              <label className="settings-stack">
                {t("settings.filament")}
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
                {t("settings.activeColor", { color: presetSelection.draftValues?.color ?? "—" })}
              </p>
            </div>
            <div className="settings-group">
              <h3>{t("settings.material")}</h3>
              <label className="settings-field">
                <span>{t("settings.materialType")}</span>
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
              {numeric("filament_diameter_mm", t("settings.diameter"), "mm", 1, 3, 0.01)}
            </div>
            <div className="settings-group">
              <h3>{t("settings.temperature")}</h3>
              {numeric("nozzle_temperature_c", t("settings.nozzle"), "C", 0, 320, 1)}
              {numeric("bed_temperature_c", t("settings.bed"), "C", 0, 120, 1)}
            </div>
            <div className="settings-group">
              <h3>{t("settings.cooling")}</h3>
              {numeric("fan_pct", t("settings.partFan"), "%", 0, 100, 1)}
            </div>
          </>
        ) : (
          <>
            <details className="settings-group" open>
              <summary>{t("settings.quality")}</summary>
              {numeric("layer_height_mm", t("settings.layerHeight"), "mm", 0.05, 1, 0.01)}
              {numeric("line_width_mm", t("settings.lineWidth"), "mm", 0.1, 3, 0.01)}
            </details>
            <details className="settings-group" open>
              <summary>{t("settings.strength")}</summary>
              {numeric("wall_loops", t("settings.wallLoops"), "", 1, 20, 1)}
              {numeric("top_bottom_layers", t("settings.topBottom"), "", 0, 30, 1)}
              {numeric("infill_density_pct", t("settings.infillDensity"), "%", 0, 100, 1)}
              <label className="settings-field">
                <span>{t("settings.infillPattern")}</span>
                <select
                  value={draft.infill_pattern}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      infill_pattern: event.currentTarget.value,
                    }))
                  }
                >
                  <option value="Grid">{t("settings.infill.grid")}</option>
                  <option value="GyroidSubset">{t("settings.infill.gyroid")}</option>
                </select>
              </label>
            </details>
            <details className="settings-group">
              <summary>{t("settings.speed")}</summary>
              {numeric("print_speed_mm_s", t("settings.print"), "mm/s", 1, 600, 1)}
              {numeric("travel_speed_mm_s", t("settings.travel"), "mm/s", 1, 600, 1)}
            </details>
            <details className="settings-group">
              <summary>{t("settings.supportAdhesion")}</summary>
              <fieldset disabled={!supportsEligible}>
                <label className="settings-field">
                  <span>{t("settings.generateSupports")}</span>
                  <input
                    type="checkbox"
                    data-testid="setting-supports"
                    checked={supports}
                    onChange={(event) => setSupports(event.currentTarget.checked)}
                  />
                </label>
                <label className="settings-field">
                  <span>{t("settings.brim")}</span>
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
                  ? `${t(supports ? "settings.supports.on" : "settings.supports.off")}${brim ? t("settings.supports.brimSuffix") : ""}${t("settings.supports.summaryTail")}`
                  : t("settings.notEligible")}
              </p>
            </details>
          </>
        )}
      </div>
      <div className="settings-export">
        <p className="settings-summary">{t("settings.draftNote")}</p>
        <button type="button" data-testid="settings-export" onClick={exportDraft}>
          {t("settings.export")}
        </button>
        <span role="status">{exportStatus}</span>
      </div>
    </section>
  );
}
