import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(path.join(root, "apps/editor/src/bridge/slice-job.ts"));
const { createNativeSliceRequest } = await import(`${moduleUrl.href}?key=${Date.now()}`);

const settings = {
  layer_height_mm: 0.16,
  line_width_mm: 0.42,
  nozzle_diameter_mm: 0.4,
  wall_loops: 3,
  top_bottom_layers: 5,
  infill_density_pct: 18,
  infill_pattern: "Grid",
  filament_diameter_mm: 1.75,
  material: "PLA",
  nozzle_temperature_c: 210,
  bed_temperature_c: 60,
  fan_pct: 100,
  print_speed_mm_s: 30,
  travel_speed_mm_s: 120,
};

function input(overrides = {}) {
  return {
    revision: 12,
    slicingMode: "standard",
    plateId: "plate-2",
    profileId: "kobra-s1",
    buildVolume: { widthMm: 250, depthMm: 250, heightMm: 250 },
    materialId: "catalog-pla-standard",
    materialType: "PLA",
    settings,
    supports: false,
    brimWidthMm: 0,
    targetIds: ["object-b", "object-a"],
    ...overrides,
  };
}

test("native slice capture pins revision, target IDs, profile and output-affecting settings", () => {
  const request = createNativeSliceRequest(input());
  assert.equal(request.expected_revision, 12);
  assert.equal(request.slicing_mode, "standard");
  assert.equal(request.plate_id, "plate-2");
  assert.deepEqual(request.target_ids, ["object-a", "object-b"]);
  assert.equal(request.profile_id, "kobra-s1");
  assert.equal(request.profile_version, "catalog-v1");
  assert.equal(request.layer_height_mm, 0.16);
  assert.equal(request.wall_loops, 3);
  assert.equal(request.material_id, "catalog-pla-standard");
  assert.equal(request.material_type, "PLA");
  assert.equal(request.coordinate_frame, "editor-world");
});

test("slice frame basis is derived from the shared coordinate-frames contract exactly once", () => {
  const frame = createNativeSliceRequest(input()).editor_to_slice_frame;
  assert.deepEqual(frame.origin_mm, [0, 0, 0]);
  assert.deepEqual(frame.x_axis, [1, 0, 0]);
  assert.deepEqual(frame.y_axis, [0, 0, 1]);
  assert.deepEqual(frame.z_axis, [0, -1, 0]);
});

test("empty target capture is rejected before invoking the backend", () => {
  assert.throws(() => createNativeSliceRequest(input({ targetIds: [] })), /no placed objects/);
});
