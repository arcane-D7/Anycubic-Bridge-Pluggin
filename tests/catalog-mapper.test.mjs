// S8-003 unit tests for the catalog → §5 machine capability schema mapper.
// Pure functions, no I/O, no slicer required.

import test from "node:test";
import assert from "node:assert/strict";

import {
  mapCatalogPreset,
  catalogProfileFromCapabilities,
  blockingMissingCapabilities,
  journalResolutionEntry,
  mapFilamentsToMaterialEntries,
} from "../scripts/catalog-mapper.mjs";

const CATALOG = {
  version: 1,
  machine: "Anycubic Kobra S1",
  nozzle_note: "0.4mm nozzle; 0.20mm = layer height",
  presets: [],
};

const KOBRA_PRESET = {
  id: "marble-mix-2-colors",
  name: "0.20mm Marble Mix 2 Colors",
  alias: ["marble mix", "v4"],
  base: "0.20mm Standard @Anycubic Kobra S1 0.4 nozzle",
  filaments: ["PLA Basico Precisao", "Anycubic PLA Gold HQ"],
  build_volume_x: 220,
  build_volume_y: 220,
  build_volume_z: 250,
  nozzle_diameter_mm: 0.4,
  continuous_z: false, // the reference machine has no continuous-Z
  layer_height_mm: 0.2,
  wall_loops: 2,
  infill_pattern: "Grid",
  infill_density_pct: 15,
  roles: { outer_wall: "1", inner_wall: "2" },
  flush_volumes_matrix: [0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  unknown_extra_key: true, // deliberately unmapped
};

test("maps known catalog keys to capabilities + process params", () => {
  const { capabilities, processParams, unknownKeys, conflicts } = mapCatalogPreset(KOBRA_PRESET);
  assert.equal(conflicts.length, 0);

  const bvx = capabilities.find((c) => c.name === "build_volume_x");
  assert.equal(bvx.value, 220);
  assert.equal(bvx.known, true);

  const cz = capabilities.find((c) => c.name === "continuous_z");
  assert.equal(cz.value, false); // declared false → known
  assert.equal(cz.known, true);

  // process params map
  assert.equal(processParams.layer_height_mm, 0.2);
  assert.equal(processParams.wall_loops, 2);
  assert.equal(processParams.infill_pattern, "Grid");

  // unknown_extra_key must be flagged, never guessed
  const unk = unknownKeys.find((u) => u.key === "unknown_extra_key");
  assert.ok(unk, "unmapped key must be surfaced as unknown");
});

test("missing catalog keys stay null/unknown — never silently defaulted", () => {
  const preset = { id: "minimal", name: "minimal", base: "x" }; // no capabilities
  const { capabilities, unknownKeys } = mapCatalogPreset(preset);
  for (const c of capabilities) {
    assert.equal(c.value, null);
    assert.equal(c.known, false);
  }
  assert.equal(unknownKeys.length, 0); // none of the base keys are unknown keys
});

test("conflicting process override raises a journaled human-resolution entry", () => {
  const { conflicts } = mapCatalogPreset(KOBRA_PRESET, {
    processPresetOverride: { layer_height_mm: 0.3, infill_density_pct: 15 },
  });
  assert.equal(conflicts.length, 1, "only the differing key conflicts");
  assert.equal(conflicts[0].field, "layer_height_mm");
  const entry = journalResolutionEntry({
    id: "marble-mix-2-colors",
    kind: "conflict",
    detail: conflicts[0].reason,
    date: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(entry.kind, "conflict");
  assert.equal(entry.id, "marble-mix-2-colors");
  assert.equal(entry.resolution, null); // never auto-preference
});

test("catalogProfileFromCapabilities: unknown=true + catalog provenance", () => {
  const { capabilities } = mapCatalogPreset(KOBRA_PRESET);
  const profile = catalogProfileFromCapabilities(CATALOG, KOBRA_PRESET, capabilities);
  assert.equal(profile.id, "catalog-marble-mix-2-colors");
  assert.equal(profile.machine_type, "Anycubic Kobra S1");
  assert.equal(profile.qualification, "unqualified"); // lifecycle only after §5 pass

  const bvx = profile.capabilities.find((c) => c.name === "build_volume_x");
  assert.equal(bvx.value, 220);
  assert.equal(bvx.unknown, false);
  assert.equal(bvx.source_class, "catalog");
  assert.equal(bvx.provenance, "catalog@1");

  // process params are NOT capabilities — layer height lives in processParams
  const { processParams } = mapCatalogPreset(KOBRA_PRESET);
  assert.equal(processParams.layer_height_mm, 0.2);
  assert.equal(
    profile.capabilities.find((c) => c.name === "layer_height_mm"),
    undefined,
  );
});

test("unknown capability stays unknown in the built profile", () => {
  const { capabilities } = mapCatalogPreset({ id: "minimal", name: "min" });
  const profile = catalogProfileFromCapabilities(CATALOG, { id: "minimal" }, capabilities);
  const bvx = profile.capabilities.find((c) => c.name === "build_volume_x");
  assert.equal(bvx.value, null);
  assert.equal(bvx.unknown, true);
});

test("qualification: needing an undeclared capability blocks (S6-003)", () => {
  const { capabilities } = mapCatalogPreset(KOBRA_PRESET);
  const profile = catalogProfileFromCapabilities(CATALOG, KOBRA_PRESET, capabilities);

  // continuous_z is DECLARED false (known) → not blocking for standard mode.
  assert.deepEqual(
    blockingMissingCapabilities(profile, ["build_volume_x", "build_volume_y", "build_volume_z"]),
    [],
  );

  // But a non-standard feature needing an undeclared capability blocks.
  const missing = blockingMissingCapabilities(profile, ["continuous_z_linear_axis"]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].name, "continuous_z_linear_axis");
  assert.match(missing[0].reason, /not declared/);

  // And an explicitly unknown capability blocks too (never defaulted).
  const profileWithUnknown = {
    ...profile,
    capabilities: profile.capabilities.map((c) =>
      c.name === "continuous_z" ? { ...c, value: null, unknown: true } : c,
    ),
  };
  const blocked = blockingMissingCapabilities(profileWithUnknown, ["continuous_z"]);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].reason, /unknown/);
});

test("journal resolution entry never auto-prefers", () => {
  const entry = journalResolutionEntry({
    id: "x",
    kind: "unknown",
    detail: "no mapping for `gamma_axis`",
    date: "2026-09-29T00:00:00.000Z",
  });
  assert.equal(entry.kind, "unknown");
  assert.equal(entry.resolution, null);
  assert.throws(() => journalResolutionEntry({ id: "y", kind: "bogus" }), /unexpected kind/);
});

test("filaments map to material entries; temps never invented", () => {
  const entries = mapFilamentsToMaterialEntries([
    "PLA Basico Precisao",
    { name: "Anycubic PLA Gold HQ", nozzle_temp_c: 210, bed_temp_c: 60 },
  ]);
  assert.equal(entries.length, 2);
  // name-only → material stays unknown (never defaulted)
  assert.equal(entries[0].material_type, null);
  assert.equal(entries[0].unknown, true);
  // declared temps map through
  assert.equal(entries[1].nozzle_temp_c, 210);
  assert.equal(entries[1].bed_temp_c, 60);
  assert.equal(entries[1].unknown, false);
  assert.equal(entries[1].source_class, "catalog");
});
