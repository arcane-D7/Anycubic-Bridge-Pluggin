import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.8-003 measure tool — pure core behavior (`viewport/measure-core.ts`)
 * under Node 24, no DOM. Covers:
 * - `distance3` Euclidean math
 * - `circumRadius` (radius + center, degenerate → null)
 * - `angleDeg` / `angleBetweenVectors` (90°, 180°, zero-length)
 * - `pushProbe` click-stream reduction → residual points + result
 * - `formatMeasure` human readout (locale-independent, no trailing zeros)
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "viewport", "measure-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("distance3: Euclidean distance in 3D", async () => {
  const { distance3 } = await corePromise;
  assert.equal(distance3({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
  assert.equal(distance3({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }), 0);
  const d = distance3({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
  assert.ok(Math.abs(d - Math.sqrt(3)) < 1e-9, `diagonal ≈ ${d}`);
});

test("circumRadius: radius + center of a right triangle", async () => {
  const { circumRadius } = await corePromise;
  // Right triangle (0,0)-(6,0)-(0,8) → hypotenuse 10 → circumradius 5,
  // center at the midpoint (3,4) (Thales: center of hypotenuse).
  const r = circumRadius({ x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, { x: 0, y: 8, z: 0 });
  assert.ok(r, "returns {radius, center}");
  assert.ok(Math.abs(r.radius - 5) < 1e-9, `radius ≈ ${r.radius}`);
  assert.ok(Math.abs(r.center.x - 3) < 1e-6);
  assert.ok(Math.abs(r.center.y - 4) < 1e-6);
  assert.ok(Math.abs(r.center.z - 0) < 1e-6);
});

test("circumRadius: degenerate (collinear) → null, never NaN", async () => {
  const { circumRadius } = await corePromise;
  assert.equal(
    circumRadius({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }),
    null,
  );
  // Duplicate points.
  assert.equal(
    circumRadius({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 0, z: 0 }),
    null,
  );
});

test("angleDeg: right angle, flat angle, zero-length ray guards", async () => {
  const { angleDeg, angleBetweenVectors } = await corePromise;
  // Apex at origin, rays along +X and +Y → 90°.
  assert.ok(
    Math.abs(angleDeg({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }) - 90) <
      1e-9,
  );
  // Apex at origin, rays along +X and -X → 180°.
  assert.ok(
    Math.abs(angleDeg({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }) - 180) <
      1e-9,
  );
  // Degenerate ray → 0, no NaN.
  assert.equal(angleBetweenVectors({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), 0);
});

test("pushProbe: distance = 2 clicks, residual keeps last point", async () => {
  const { pushProbe } = await corePromise;
  const p0 = { x: 0, y: 0, z: 0 };
  const p1 = { x: 3, y: 4, z: 0 };
  const first = pushProbe("distance", [], p0);
  assert.equal(first.result, null);
  assert.deepEqual(first.points, [p0]);
  const second = pushProbe("distance", first.points, p1);
  assert.ok(second.result, "has result");
  assert.equal(second.result.kind, "distance");
  assert.ok(Math.abs(second.result.value - 5) < 1e-9);
  // Residual: only the LAST point stays so the next measure starts fresh.
  assert.deepEqual(second.points, [p1]);
});

test("pushProbe: radius = 3 clicks on a circular edge → R", async () => {
  const { pushProbe } = await corePromise;
  const pts = [
    { x: 0, y: 0, z: 0 },
    { x: 6, y: 0, z: 0 },
    { x: 0, y: 8, z: 0 },
  ];
  let state = { points: [] };
  let final;
  for (const p of pts) {
    state = pushProbe("radius", state.points, p);
    final = state;
  }
  assert.ok(final.result, "radius resolves after 3 clicks");
  assert.equal(final.result.kind, "radius");
  assert.ok(Math.abs(final.result.value - 5) < 1e-9, `R ≈ ${final.result.value}`);
  assert.ok("centerX" in final.result && "centerY" in final.result, "center exposed");
});

test("pushProbe: angle = 3 clicks (apex first) → degrees", async () => {
  const { pushProbe } = await corePromise;
  const pts = [
    { x: 0, y: 0, z: 0 }, // apex
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
  ];
  let state = { points: [] };
  let final;
  for (const p of pts) {
    state = pushProbe("angle", state.points, p);
    final = state;
  }
  assert.ok(final.result, "angle resolves after 3 clicks");
  assert.equal(final.result.kind, "angle");
  assert.ok(Math.abs(final.result.value - 90) < 1e-9, `angle ≈ ${final.result.value}`);
});

test("pushProbe: radius degenerate third click → null result, last point kept", async () => {
  const { pushProbe } = await corePromise;
  const before = pushProbe("radius", [], { x: 0, y: 0, z: 0 });
  const mid = pushProbe("radius", before.points, { x: 2, y: 0, z: 0 });
  const degenerate = pushProbe("radius", mid.points, { x: 5, y: 0, z: 0 }); // collinear
  assert.equal(degenerate.result, null);
  assert.deepEqual(degenerate.points, [{ x: 5, y: 0, z: 0 }]);
});

test("formatMeasure: readout strings, locale-independent", async () => {
  const { formatMeasure } = await corePromise;
  assert.equal(formatMeasure({ kind: "distance", value: 10 }), "10.0 mm");
  assert.equal(formatMeasure({ kind: "distance", value: 10.5 }), "10.5 mm");
  assert.equal(formatMeasure({ kind: "radius", value: 12.345 }), "R 12.35 mm");
  assert.equal(formatMeasure({ kind: "angle", value: 90 }), "90.0°");
  assert.equal(formatMeasure({ kind: "angle", value: 45.678 }), "45.68°");
});
