/**
 * catalog-mapper.mjs — S8-003: presets/catalog.json → §5 machine capability schema.
 *
 * The capability schema is the SOURCE OF TRUTH; the catalog is a PROVIDER.
 * Mapping rules (never guess, never silent-default):
 *   - Known keys map to typed capability/profile fields with provenance.
 *   - Every unmapped/conflicting field is stored as `unknown`/null with a
 *     provenance + confidence note — never a default that hides ignorance.
 *   - Conflicts between catalog entries and an existing profile raise a
 *     human-resolution entry (journaled), never auto-preference.
 *   - A profile is only QUALIFIED for a feature after the §5 qualification
 *     rules pass (S6-003 lifecycle: unqualified → shadow → qualified).
 *
 * Pure module — no MCP registration, no I/O inside the pure functions
 * (loadCatalog/findPreset live in presets-tools.mjs; this module takes the
 * catalog profile object as input).
 */
import assert from "node:assert/strict";

export const CAPABILITY_CONTRACT_VERSION = "1.0";

/** Known catalog → capability field names (name, type, always-declared). */
const CAPABILITY_FIELDS = [
  ["build_volume_x", "number"],
  ["build_volume_y", "number"],
  ["build_volume_z", "number"],
  ["nozzle_diameter_mm", "number"],
  ["continuous_z", "boolean"],
];

/**
 * Map a catalog preset → capability-style fields.
 *
 * Returns an array of { name, value, known } where `known` is false when the
 * catalog key could not be mapped (value stays null). The process preset is
 * mapped via `slicing params` — those keys (layer height, wall loops, infill
 * density) become process/toolpath params, not machine capabilities.
 *
 * @param {object} catalogPreset — one entry of presets/catalog.json (`presets[]`)
 * @param {object} opts — { processPresetOverride } optionally overrides the
 *   default slicing params (used for conflict tests).
 * @returns {{ capabilities: Array<{name:string,value:(number|string|boolean|null),known:boolean}>, processParams: Object, unknownKeys: Array<{key:string,reason:string}>, conflicts: Array<{field:string,reason:string}> }}
 */
export function mapCatalogPreset(catalogPreset, opts = {}) {
  assert.ok(catalogPreset && typeof catalogPreset === "object", "catalogPreset required");

  const caps = [];
  for (const [name, type] of CAPABILITY_FIELDS) {
    const value = catalogPreset[name];
    caps.push({
      name,
      value: value === undefined ? null : value,
      known: value !== undefined,
      expectedType: type,
    });
  }

  // Process/slicing params from a catalog preset (thin subset the engine uses).
  const processParams = {
    layer_height_mm: catalogPreset.layer_height_mm ?? null,
    wall_loops: catalogPreset.wall_loops ?? null,
    infill_pattern: catalogPreset.infill_pattern ?? null,
    infill_density_pct: catalogPreset.infill_density_pct ?? null,
  };

  // Any key we did not map → flagged unknown, never guessed.
  const knownKeys = new Set([
    ...CAPABILITY_FIELDS.map(([n]) => n),
    ...Object.keys(processParams),
    "id",
    "name",
    "alias",
    "base",
    "filaments",
    "roles",
    "flush_volumes_matrix",
    "flush_volumes_vector",
    "behavior",
    "test_history",
    "notes",
  ]);
  const unknownKeys = [];
  for (const [key, value] of Object.entries(catalogPreset)) {
    if (value === undefined) continue;
    if (knownKeys.has(key)) continue;
    unknownKeys.push({
      key,
      reason: `no capability or process-param mapping for \`${key}\``,
      value: typeof value === "object" ? "[object]" : value,
    });
  }

  const conflicts = [];
  // Conflicts: process override that disagrees with the catalog preset.
  if (opts.processPresetOverride) {
    for (const [k, v] of Object.entries(opts.processPresetOverride)) {
      const cur = catalogPreset[k];
      if (cur !== undefined && cur !== v) {
        conflicts.push({
          field: k,
          reason: `process override ${JSON.stringify(v)} conflicts with catalog ${JSON.stringify(cur)} — human resolution required`,
        });
      }
    }
  }

  return { capabilities: caps, processParams, unknownKeys, conflicts };
}

/**
 * Build a §5 MachineProfile from catalog capabilities.
 * - source_class = catalog, provenance = `catalog@<version>`.
 * - Unmapped fields are `unknown=true` + value null (never defaulted).
 * - Qualification stays UNQUALIFIED until the §5 rules pass (S6-003).
 *
 * @param {object} catalog — the whole catalog object (for version/machine)
 * @param {object} catalogPreset — one preset
 * @param {Array} capabilities — from mapCatalogPreset().capabilities
 * @returns {object} MachineProfile-shaped object
 */
export function catalogProfileFromCapabilities(catalog, catalogPreset, capabilities) {
  assert.ok(catalog && typeof catalog.version === "number", "catalog.version required");
  assert.ok(catalogPreset?.id, "catalogPreset.id required");

  const caps = capabilities.map((c) => ({
    name: c.name,
    value: c.value,
    // null → unknown, never silently defaulted:
    unknown: c.value === undefined || c.value === null || c.known === false,
    source_class: "catalog",
    confidence: c.value === null ? null : 0.8,
    tolerance: null,
    provenance: `catalog@${catalog.version}`,
  }));

  return {
    id: `catalog-${catalogPreset.id}`,
    machine_type: catalog.machine ?? null,
    firmware_version: null,
    qualification: "unqualified",
    revoked_reason: null,
    capabilities: caps,
  };
}

/**
 * Map catalog filaments → material capability entries (S8-003 AC: "filaments
 * → material capability entries"). The catalog carries filament NAMES only —
 * temps/type are never invented here: if the preset declares them they map,
 * otherwise they stay null/unknown (source stays catalog).
 *
 * @param {Array<string|object>} filaments — catalog `filaments` list (names
 *   or objects with {name, ...})
 * @returns {Array<{name: string, material_type: (string|null), nozzle_temp_c: (number|null), bed_temp_c: (number|null), source_class: string, unknown: boolean}>}
 */
export function mapFilamentsToMaterialEntries(filaments) {
  const out = [];
  for (const f of filaments ?? []) {
    const entry = typeof f === "string" ? { name: f } : { ...f };
    assert.ok(entry.name && typeof entry.name === "string", "filament name required");
    const tempKeys = ["material_type", "nozzle_temp_c", "bed_temp_c"];
    for (const k of tempKeys) {
      if (entry[k] === undefined) entry[k] = null;
    }
    out.push({
      name: entry.name,
      material_type: entry.material_type,
      nozzle_temp_c: entry.nozzle_temp_c,
      bed_temp_c: entry.bed_temp_c,
      source_class: "catalog",
      unknown: [entry.material_type, entry.nozzle_temp_c, entry.bed_temp_c].every(
        (v) => v === null,
      ),
    });
  }
  return out;
}

/**
 * Qualification gate (S6-003 §5): a profile may only be QUALIFIED when the
 * capabilities it depends on are declared (non-unknown) at or above a
 * confidence floor. Qualified state is a lifecycle decision the operator
 * makes after corroboration — this function only returns the list of
 * missing/unknown capabilities that BLOCK qualification (empty = passable).
 *
 * @param {object} profile — MachineProfile-shaped object
 * @param {Array<string>} requiredCaps — capability names the feature needs
 * @returns {Array<{name:string, reason:string}>}
 */
export function blockingMissingCapabilities(profile, requiredCaps) {
  assert.ok(Array.isArray(profile.capabilities), "profile.capabilities required");
  const missing = [];
  for (const name of requiredCaps) {
    const cap = profile.capabilities.find((c) => c.name === name);
    if (!cap || cap.unknown || cap.value === null || cap.value === undefined) {
      missing.push({
        name,
        reason: cap
          ? `declared unknown (never defaulted) — blocked`
          : `not declared on profile — blocked`,
      });
    }
  }
  return missing;
}

/**
 * Journal a human-resolution entry (S6-003 §5.2/§5.3): a conflict or unknown
 * is NEVER auto-preferenced — it surfaces for a human. Returns a serializable
 * journal object (caller persists it).
 *
 * @param {object} opts — { id, kind, detail, date }
 * @returns {object} journal entry
 */
export function journalResolutionEntry({ id, kind, detail, date }) {
  assert.ok(id && typeof id === "string", "id required");
  assert.ok(["unknown", "conflict"].includes(kind), `unexpected kind ${kind}`);
  return {
    kind,
    id,
    detail,
    date: date ?? new Date().toISOString(),
    resolution: null,
  };
}
