import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "state", "device-availability-core.ts"),
);
const { deviceAvailability, validateControlTarget } = await import(
  `${moduleUrl.href}?key=${Date.now()}`
);

test("cloud snapshots are identified as cloud but remain read-only by default", () => {
  assert.deepEqual(deviceAvailability("cloud-printer"), {
    origin: "cloud",
    readOnly: true,
    canWrite: false,
    canStartCamera: false,
  });
});

test("LAN/mock and unselected states are explicitly demo and read-only", () => {
  for (const printerId of ["printer-1", null]) {
    assert.deepEqual(deviceAvailability(printerId), {
      origin: "demo",
      readOnly: true,
      canWrite: false,
      canStartCamera: false,
    });
  }
});

test("all origins remain read-only because no real write transport exists", () => {
  assert.equal(deviceAvailability("printer-1").canWrite, false);
  assert.equal(deviceAvailability("cloud-printer").canWrite, false);
  assert.equal(deviceAvailability("cloud-printer").readOnly, true);
});

test("control target rejects absent, synthetic, mismatched, stale and capability-limited contexts", () => {
  const target = {
    printerId: "printer-test",
    source: "lan",
    snapshotCapturedAt: 42,
    capabilities: { tempature: true },
  };
  const now = 42;
  assert.equal(validateControlTarget(null, "printer-test", 42, "tempature", now).ok, false);
  assert.equal(
    validateControlTarget({ ...target, source: "demo" }, "printer-test", 42, "tempature", now).ok,
    false,
  );
  assert.equal(validateControlTarget(target, "printer-other", 42, "tempature", now).ok, false);
  assert.equal(validateControlTarget(target, "printer-test", 41, "tempature", now).ok, false);
  assert.equal(
    validateControlTarget({ ...target, snapshotCapturedAt: 0 }, "printer-test", 0, "tempature", now)
      .ok,
    false,
  );
  assert.equal(
    validateControlTarget(
      { ...target, snapshotCapturedAt: -1 },
      "printer-test",
      -1,
      "tempature",
      now,
    ).ok,
    false,
  );
  assert.equal(
    validateControlTarget(
      { ...target, snapshotCapturedAt: Number.NaN },
      "printer-test",
      42,
      "tempature",
      now,
    ).ok,
    false,
  );
  assert.equal(validateControlTarget(target, "printer-test", 42, "light", now).ok, false);
  assert.equal(validateControlTarget(target, "printer-test", 42, "tempature", now).ok, true);
  assert.equal(validateControlTarget(target, "printer-test", 42, "tempature", 41).ok, false);
  assert.equal(validateControlTarget(target, "printer-test", 42, "tempature", 60_043).ok, false);
  assert.equal(
    validateControlTarget(
      { ...target, snapshotCapturedAt: 42.5 },
      "printer-test",
      42.5,
      "tempature",
      43,
    ).ok,
    false,
  );
});
