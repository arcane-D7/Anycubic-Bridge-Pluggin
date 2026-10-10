import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Dynamic import with cache-busting, matching the repo test convention.
async function loadCore() {
  const url = pathToFileURL(
    path.join(ROOT, "apps", "editor", "src", "state", "workbench-live-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("workbench-live-core exports the S9.17-004 surface", async () => {
  const core = await corePromise;
  assert.equal(typeof core.resolveLiveArtifactLink, "function");
  assert.equal(typeof core.reduceCameraRequest, "function");
  assert.equal(typeof core.buildTelemetryView, "function");
  assert.equal(core.NO_CAMERA_PROVIDER.available, false);
  assert.equal(core.TELEMETRY_FRESH_MS, 60_000);
  assert.equal(core.TELEMETRY_OFFLINE_MS, 120_000);
});

// ---- telemetry: origin / freshness / age --------------------------------
test("telemetry origin derives from printer id prefix only", async () => {
  const core = await corePromise;
  assert.equal(core.telemetryOrigin("cloud-abc-1"), "cloud");
  assert.equal(core.telemetryOrigin("kobra-s1"), "demo");
  assert.equal(core.telemetryOrigin(null), "none");
});

test("telemetry freshness: never/unknown, fresh, stale, offline", async () => {
  const core = await corePromise;
  const now = Date.now();
  assert.equal(core.telemetryFreshness(null, now), "unknown");
  assert.equal(core.telemetryFreshness(now - 20_000, now), "fresh");
  assert.equal(core.telemetryFreshness(now - 70_000, now), "stale");
  assert.equal(core.telemetryFreshness(now - 200_000, now), "offline");
  // Offline poll state keeps offline even when the last age is tiny.
  assert.equal(core.telemetryFreshness(now - 10_000, now, "offline"), "offline");
});

test("telemetry honesty: future capture is unknown, stale poll overrides young age", async () => {
  const core = await corePromise;
  const now = Date.now();
  // A capture timestamp in the future is a clock/observation error — NEVER
  // clamped to age 0 (which would claim a fresh read that never happened).
  assert.equal(core.telemetryAgeMs(now + 60_000, now), null);
  assert.equal(core.telemetryFreshness(now + 60_000, now), "unknown");
  // The poller says the lane is stale — a young capture timestamp does not
  // override that: freshness must reflect the OBSERVED lane, not just age.
  assert.equal(core.telemetryFreshness(now - 10_000, now, "stale"), "stale");
  assert.equal(core.telemetryFreshness(now - 30_000, now, "stale"), "stale");
});

test("telemetry view: snapshot from a DIFFERENT printer is never shown as live", async () => {
  const core = await corePromise;
  const now = Date.now();
  // selected printer is cloud-x but the observed snapshot belongs to
  // cloud-other-9 — that observation must not masquerade as the current
  // printer's live data (no stale-printer file/job bridging).
  const mismatched = core.buildTelemetryView({
    printerId: "cloud-x",
    snapPrinterId: "cloud-other-9",
    capturedAt: now - 5_000,
    now,
    printFilename: "stale-file.3mf",
    pollingStatus: "polling",
  });
  assert.equal(mismatched.origin, "none");
  assert.equal(mismatched.freshness, "unknown");
  assert.equal(mismatched.capturedAt, null);
  assert.equal(mismatched.ageMs, null);
  assert.equal(mismatched.printFilename, null);
  assert.equal(mismatched.reportsTaskId, false);
  const matched = core.buildTelemetryView({
    printerId: "cloud-x",
    snapPrinterId: "cloud-x",
    capturedAt: now - 5_000,
    now,
    printFilename: "bracket.3mf",
    pollingStatus: "polling",
  });
  assert.equal(matched.origin, "cloud");
  assert.equal(matched.freshness, "fresh");
  assert.equal(matched.capturedAt, now - 5_000);
  assert.equal(matched.printFilename, "bracket.3mf");
});

test("telemetry view reports filename (display-only) and never a task id", async () => {
  const core = await corePromise;
  const now = Date.now();
  const view = core.buildTelemetryView({
    printerId: "cloud-x",
    snapPrinterId: "cloud-x",
    capturedAt: now - 5_000,
    now,
    printFilename: "bracket.3mf",
    pollingStatus: "polling",
  });
  assert.equal(view.origin, "cloud");
  assert.equal(view.freshness, "fresh");
  assert.equal(view.printFilename, "bracket.3mf");
  // Schema has NO physical task id — filename never becomes job identity.
  assert.equal(view.reportsTaskId, false);
  const identity = core.observedTaskIdFromSnapshot({
    print: { filename: "bracket.3mf" },
  });
  assert.deepEqual(identity, { observedJobId: null, reportsTaskId: false });
});

// ---- camera: no adapter ⇒ never activates; typed transitions only -------
test("camera: production provider is unavailable regardless of advertisement", async () => {
  const core = await corePromise;
  const advertises = core.cameraProviderFor({
    peripherals: { hasCamera: true },
    capabilities: { camera: true },
  });
  assert.equal(advertises.available, false);
  assert.equal(advertises.unavailableReason, "no-supported-provider");
  assert.equal(core.cameraActivationAllowed(advertises), false);
  const noneSnap = core.cameraProviderFor(null);
  assert.equal(noneSnap.available, false);
  assert.equal(core.cameraUnavailableReasonKey(noneSnap), "no-supported-provider");
});

test("camera: user-request on the no-adapter provider → unavailable, never requested", async () => {
  const core = await corePromise;
  const next = core.reduceCameraRequest(core.CAMERA_IDLE_STATE, core.NO_CAMERA_PROVIDER, {
    type: "user-request",
  });
  assert.equal(next.status, "unavailable");
  assert.equal(next.message, "no-supported-provider");
  const requested = core.reduceCameraRequest(
    core.CAMERA_IDLE_STATE,
    {
      kind: "lan",
      available: true,
      unavailableReason: null,
      requiresPermission: true,
      start: async () => ({ ok: true }),
    },
    { type: "user-request" },
  );
  assert.equal(requested.status, "requested");
});

test("camera: explicit permission/start outcomes flow through typed events", async () => {
  const core = await corePromise;
  const provider = {
    kind: "lan",
    available: true,
    unavailableReason: null,
    requiresPermission: true,
    start: async () => ({ ok: true }),
  };
  const denied = core.reduceCameraRequest(core.CAMERA_IDLE_STATE, provider, {
    type: "permission-denied",
    message: "blocked by user",
  });
  assert.equal(denied.status, "permission-denied");
  assert.equal(denied.message, "blocked by user");
  const failed = core.reduceCameraRequest(core.CAMERA_IDLE_STATE, provider, {
    type: "start-failure",
    message: "no transport",
  });
  assert.equal(failed.status, "start-failure");
  assert.equal(failed.message, "no transport");
  const stopped = core.reduceCameraRequest({ status: "requested", message: null }, provider, {
    type: "stop",
  });
  assert.equal(stopped.status, "off");
});

// ---- artifact: exact-id binding, freshness, IR-parsed, no invention ------
const bindingFixture = {
  physicalTaskId: "physical-task-77",
  printerId: "cloud-abc-1",
  projectId: "project-9",
  artifactId: "bracket-ir-42",
  sourceRev: 7,
  currentRev: 7,
  compatibility: "qualified",
};

test("artifact: no observed job → no link; no binding → 'no linked artifact'", async () => {
  const core = await corePromise;
  const alwaysFresh = {
    artifactId: "bracket-ir-42",
    sourceRev: 7,
    currentRev: 7,
    compatibility: "qualified",
    irParsed: true,
  };
  assert.equal(
    core.resolveLiveArtifactLink({
      observedJobId: null,
      observedPrinterId: "cloud-abc-1",
      capturedJobBinding: bindingFixture,
      artifact: alwaysFresh,
      activeProjectId: "project-9",
    }).linked,
    false,
  );
  const noBinding = core.resolveLiveArtifactLink({
    observedJobId: "physical-task-77",
    observedPrinterId: "cloud-abc-1",
    capturedJobBinding: null,
    artifact: alwaysFresh,
    activeProjectId: "project-9",
  });
  assert.deepEqual(noBinding, { linked: false, reason: "no-binding" });
});

test("artifact: exact physical task id + printer + artifact + rev match → linked", async () => {
  const core = await corePromise;
  const linked = core.resolveLiveArtifactLink({
    observedJobId: "physical-task-77",
    observedPrinterId: "cloud-abc-1",
    capturedJobBinding: bindingFixture,
    activeProjectId: "project-9",
    artifact: {
      artifactId: "bracket-ir-42",
      sourceRev: 7,
      currentRev: 9,
      compatibility: "qualified",
      irParsed: true,
    },
  });
  assert.deepEqual(linked, {
    linked: true,
    artifactId: "bracket-ir-42",
    sourceRev: 7,
    currentRev: 9,
    compatibility: "qualified",
  });
});

test("artifact: physical task id ≠ native slicer job id is an explicit mismatch", async () => {
  const core = await corePromise;
  // The native slicer job id ("synthetic-job-1") must NEVER satisfy the link —
  // only the physical telemetry task id matches the running print.
  const link = core.resolveLiveArtifactLink({
    observedJobId: "synthetic-job-1",
    observedPrinterId: "cloud-abc-1",
    capturedJobBinding: bindingFixture,
    activeProjectId: "project-9",
    artifact: {
      artifactId: "bracket-ir-42",
      sourceRev: 7,
      currentRev: 7,
      compatibility: "qualified",
      irParsed: true,
    },
  });
  assert.deepEqual(link, { linked: false, reason: "job-mismatch" });
});

test("artifact: printer mismatch, missing artifact, id mismatch, stale rev, unparsed IR", async () => {
  const core = await corePromise;
  const artifact = {
    artifactId: "bracket-ir-42",
    sourceRev: 7,
    currentRev: 7,
    compatibility: "qualified",
    irParsed: true,
  };
  assert.equal(
    core.resolveLiveArtifactLink({
      observedJobId: "physical-task-77",
      observedPrinterId: "cloud-other-9",
      capturedJobBinding: bindingFixture,
      activeProjectId: "project-9",
      artifact,
    }).reason,
    "printer-mismatch",
  );
  assert.equal(
    core.resolveLiveArtifactLink({
      observedJobId: "physical-task-77",
      observedPrinterId: "cloud-abc-1",
      capturedJobBinding: bindingFixture,
      activeProjectId: "project-9",
      artifact: null,
    }).reason,
    "artifact-unavailable",
  );
  assert.equal(
    core.resolveLiveArtifactLink({
      observedJobId: "physical-task-77",
      observedPrinterId: "cloud-abc-1",
      capturedJobBinding: bindingFixture,
      activeProjectId: "project-9",
      artifact: { ...artifact, artifactId: "other-ir" },
    }).reason,
    "artifact-mismatch",
  );
  assert.equal(
    core.resolveLiveArtifactLink({
      observedJobId: "physical-task-77",
      observedPrinterId: "cloud-abc-1",
      capturedJobBinding: bindingFixture,
      activeProjectId: "project-9",
      artifact: { ...artifact, sourceRev: 6 },
    }).reason,
    "stale-source-rev",
  );
  assert.equal(
    core.resolveLiveArtifactLink({
      observedJobId: "physical-task-77",
      observedPrinterId: "cloud-abc-1",
      capturedJobBinding: bindingFixture,
      activeProjectId: "project-9",
      artifact: { ...artifact, irParsed: false },
    }).reason,
    "artifact-not-parsed",
  );
});

test("artifact: binding for ANOTHER project is an explicit project-mismatch", async () => {
  const core = await corePromise;
  // Everything matches except ownership: the binding targets project-other
  // while the active project is project-9. An artifact from another project
  // must never open/link here (no cross-project artifact bridging).
  const link = core.resolveLiveArtifactLink({
    observedJobId: "physical-task-77",
    observedPrinterId: "cloud-abc-1",
    capturedJobBinding: { ...bindingFixture, projectId: "project-other" },
    activeProjectId: "project-9",
    artifact: {
      artifactId: "bracket-ir-42",
      sourceRev: 7,
      currentRev: 7,
      compatibility: "qualified",
      irParsed: true,
    },
  });
  assert.deepEqual(link, { linked: false, reason: "project-mismatch" });
  // A null active project (nothing opened) never claims ownership — the
  // binding is not yet verifiable but also not refused by an empty scope.
  const noActiveProject = core.resolveLiveArtifactLink({
    observedJobId: "physical-task-77",
    observedPrinterId: "cloud-abc-1",
    capturedJobBinding: bindingFixture,
    activeProjectId: null,
    artifact: {
      artifactId: "bracket-ir-42",
      sourceRev: 7,
      currentRev: 7,
      compatibility: "qualified",
      irParsed: true,
    },
  });
  assert.deepEqual(noActiveProject, {
    linked: true,
    artifactId: "bracket-ir-42",
    sourceRev: 7,
    currentRev: 7,
    compatibility: "qualified",
  });
});
