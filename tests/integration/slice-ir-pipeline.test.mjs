import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const { toIrDocument, validateIr } = await import(
  pathToFileURL(path.join(root, "scripts", "slice-ir.mjs")).href
);
const { postprocess, validateEmittedProgram } = await import(
  pathToFileURL(path.join(root, "scripts", "gcode-postprocessor.mjs")).href
);
const { parseIrDocument } = await import(
  pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "ir.ts")).href
);
const { buildPreviewModel, previewLayerAt } = await import(
  pathToFileURL(path.join(root, "apps", "editor", "src", "viewport", "preview-model.ts")).href
);

function cargoExe() {
  const homeBin = path.join(
    homedir(),
    ".cargo",
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  return process.env.CARGO || (existsSync(homeBin) ? homeBin : "cargo");
}

const MACHINE_PROFILE = {
  id: "kobra-s1-cartesian",
  kinematics: "cartesian",
  joints: [
    { id: "X", type: "linear", min: 0, max: 220 },
    { id: "Y", type: "linear", min: 0, max: 220 },
    { id: "Z", type: "linear", min: 0, max: 250 },
  ],
  controller_dialect: {
    fw_family: "anycubic",
    gcode_whitelist: ["G0", "G1"],
    max_extrude_rate_mm3_s: null,
  },
  build_volume: { x: 220, y: 220, z: 250 },
};

const PROFILE = {
  dialect: "anycubic",
  mode: "standard",
  layer_height_mm: 0.2,
  wall_loops: 2,
  infill_pattern: "Grid",
  infill_density_pct: 15.0,
  top_bottom_layers: 4,
  brim_mskirt: null,
  line_width_mm: 0.45,
  nozzle_diameter_mm: 0.4,
  filament: { diameter_mm: 1.75 },
  build_volume: { x: 220, y: 220, z: 250 },
};

const PLACEMENT_MM = { x: 100, y: 100, z: 0 };

test(
  "S8-005 real fixture pipeline: STL → planar-core → IR → postprocess → preview",
  { timeout: 600_000 },
  () => {
    const cargo = cargoExe();
    const ver = spawnSync(cargo, ["--version"], { encoding: "utf8" });
    assert.equal(
      ver.status,
      0,
      `cargo is required for the S8-005 integration test and was not usable via CARGO/PATH (~/.cargo/bin): ${ver.error ?? ver.stderr}`,
    );

    const tmp = mkdtempSync(path.join(tmpdir(), "s8-005-ir-pipeline-"));
    try {
      const profilePath = path.join(tmp, "profile.json");
      writeFileSync(profilePath, JSON.stringify(PROFILE, null, 2));
      const fixture = path.join(root, "tests", "fixtures", "cube-20mm.stl");
      assert.ok(existsSync(fixture), "fixture cube-20mm.stl missing");
      const res = spawnSync(
        cargo,
        [
          "run",
          "-q",
          "-p",
          "planar-core",
          "--bin",
          "slice-json",
          "--manifest-path",
          path.join(root, "crates", "Cargo.toml"),
          "--",
          fixture,
          profilePath,
        ],
        { encoding: "utf8", timeout: 300_000, cwd: root },
      );
      assert.equal(
        res.status,
        0,
        `slice-json failed (status=${res.status}): ${(res.stderr ?? "").slice(0, 400)}`,
      );
      const sliceMeta = JSON.parse(res.stdout.trim());
      assert.ok(Array.isArray(sliceMeta.layers) && sliceMeta.layers.length > 0);

      const ir = toIrDocument(sliceMeta);
      assert.equal(ir.mode, "standard");
      assert.equal(ir.dialect, "anycubic");
      assert.equal(ir.version, "1.0");

      const validation = validateIr(ir);
      assert.deepEqual(validation.errors, []);
      assert.ok(ir.segments.length >= sliceMeta.layers.length, "meaningful segment count");
      assert.equal(
        sliceMeta.layers.length,
        Math.round(20 / 0.2),
        "deterministic full-height layer count for the 20mm cube at 0.2mm",
      );
      assert.ok(
        sliceMeta.layers.every((l) => l.segments.length > 0),
        "every layer has paths",
      );
      assert.ok(
        sliceMeta.layers.every((l) => (l.per_loop_wall ?? []).length > 0),
        "every layer has wall loops",
      );

      const parsed = parseIrDocument(JSON.parse(JSON.stringify(ir)));
      assert.equal(parsed.segments.length, ir.segments.length);
      assert.equal(parsed.mode, "standard");
      assert.equal(parsed.dialect, "anycubic");

      const { lines, errors, program } = postprocess(ir, MACHINE_PROFILE, {
        placement_mm: PLACEMENT_MM,
      });
      assert.deepEqual(errors, []);
      assert.equal(program.rejected, undefined);
      assert.ok(
        lines.length >= 2 + program.segmentCount,
        "2 headers + at least one line per segment",
      );
      const g1 = lines.filter((l) => l.startsWith("G1 "));
      const g0 = lines.filter((l) => l.startsWith("G0 "));
      assert.ok(g1.length > 0, "extrusion moves emitted");
      assert.ok(g0.length > 0, "travel/repositioning moves emitted");
      for (const line of g1) {
        const eWord = line.split(" ").find((w) => w.startsWith("E"));
        assert.ok(eWord, `extrusion line carries E: ${line}`);
        const e = Number(eWord.slice(1));
        assert.ok(Number.isFinite(e) && e > 0, `E finite and > 0 on: ${line}`);
      }
      for (const line of g0) {
        assert.ok(!line.split(" ").some((w) => w.startsWith("E")), `travel carries no E: ${line}`);
      }

      const emitted = validateEmittedProgram(program, MACHINE_PROFILE);
      assert.deepEqual(emitted.errors, []);
      assert.equal(emitted.pass, true);
      for (const line of g1.concat(g0)) {
        const nums = line
          .split(" ")
          .slice(1)
          .filter((w) => /^[XYZ]/.test(w))
          .map((w) => Number(w.slice(1)));
        for (const [i, v] of nums.entries()) {
          assert.ok(Number.isFinite(v) && v >= 0 && v <= (i === 2 ? 250 : 220));
        }
      }

      const model = buildPreviewModel(parsed);
      assert.equal(model.version, "1.0");
      assert.equal(model.mode, "standard");
      assert.equal(model.layerCount, sliceMeta.layers.length);
      assert.equal(model.hasRamps, false);
      assert.ok(model.layers[0].toolpaths.length > 0);
      assert.ok(model.layers[0].kindCounts.wall > 0);
      assert.ok(model.layers.some((l) => l.kindCounts.infill > 0));
      const z0 = model.layers[0].z;
      assert.ok(Math.abs(z0 - 0.2) < 1e-6);
      assert.ok(previewLayerAt(model, 0).length > 0);
      assert.deepEqual(previewLayerAt(model, 9999), []);

      const tampered = JSON.parse(JSON.stringify(parsed));
      const target = tampered.segments.find((s) => s.kind === "WALL");
      target.pose.to.x += 500;
      const tamperedValidation = validateIr(tampered);
      assert.equal(tamperedValidation.pass, false);
      assert.ok(
        tamperedValidation.errors.some((e) => e.code === "OUT_OF_VOLUME"),
        "tampered coordinate must be rejected with a named reason",
      );
      const malformed = JSON.parse(JSON.stringify(parsed));
      malformed.segments[0].pose.to.x = Number.NaN;
      assert.throws(() => parseIrDocument(malformed), /finite/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
