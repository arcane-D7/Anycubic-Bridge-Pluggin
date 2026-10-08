import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const framesUrl = pathToFileURL(path.join(ROOT, "apps/editor/src/state/coordinate-frames.ts"));
const frames = await import(`${framesUrl.href}?key=${Date.now()}`);

test("IR/editor-world landmark conversion round-trips without axis ambiguity", () => {
  const ir = [12, -7, 3];
  assert.deepEqual(frames.sliceIrToEditorWorld(ir), [12, 3, 7]);
  assert.deepEqual(frames.editorWorldToSliceIr(frames.sliceIrToEditorWorld(ir)), ir);
  assert.deepEqual(frames.sliceIrToEditorWorld([0, 0, 0]), [0, 0, 0]);
});

test("machine telemetry uses declared origin and axes", () => {
  const frame = {
    originWorldMm: [100, 0, -50],
    xAxisWorld: [1, 0, 0],
    yAxisWorld: [0, 1, 0],
    zAxisWorld: [0, 0, -1],
    buildVolumeBoundsWorldMm: { min: [-125, 0, -125], max: [125, 250, 125] },
  };
  assert.deepEqual(frames.machineTelemetryToEditorWorld([10, 4, 8], frame), [110, 4, -58]);
  assert.equal(frames.machineTelemetryToEditorWorld([10, 4, 8], null), null);
});

test("invalid coordinates are not silently accepted as non-finite values", () => {
  assert.throws(() => frames.sliceIrToEditorWorld([1, Number.NaN, 3]), /finite millimetre/);
});
