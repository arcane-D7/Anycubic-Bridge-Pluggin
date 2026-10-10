import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Dynamic import with cache-busting, matching the repo test convention.
async function loadLiveJob() {
  const url = pathToFileURL(path.join(ROOT, "apps", "editor", "src", "bridge", "live-job.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const liveJobPromise = loadLiveJob();

const validBinding = {
  physicalTaskId: "physical-task-77",
  printerId: "cloud-abc-1",
  projectId: "project-9",
  artifactId: "bracket-ir-42",
  sourceRev: 7,
  currentRev: 7,
  compatibility: "qualified",
};

const validArtifact = {
  artifactId: "bracket-ir-42",
  sourceRev: 7,
  currentRev: 7,
  compatibility: "qualified",
  irParsed: true,
};

/** A MINIMAL but fully valid IR 1.1 document for the artifact-read lane. */
const validIr = {
  version: "1.1",
  mode: "standard",
  dialect: "anycubic",
  coordinate_frame: "slice-ir",
  units: "mm",
  source_revision: 7,
  job_id: "synthetic-job-7",
  target_ids: ["object-b"],
  segments: [
    {
      mode: "standard",
      kind: "WALL",
      layer: 0,
      pose: { from: { x: 0, y: 0, z: 0.2 }, to: { x: 10, y: 0, z: 0.2 } },
      orientation: [1, 0, 0],
      segment_id: "seg-b-l0",
      execution_order: 0,
      object_id: "object-b",
      provenance: { layer: 0 },
      gcode_line_start: 1,
      gcode_line_end: 2,
    },
  ],
};

function tauriProvider(liveJob) {
  return liveJob.liveJobProviderFor(true);
}

test("live-job exports the S9.17-004 provider surface", async () => {
  const liveJob = await liveJobPromise;
  assert.equal(typeof liveJob.liveJobProviderFor, "function");
  assert.equal(typeof liveJob.defaultLiveJobBindingProvider, "object");
  assert.equal(liveJob.EMPTY_LIVE_JOB_VIEW.available, false);
  assert.equal(liveJob.EMPTY_LIVE_JOB_VIEW.observedPrinterId, null);
});

test("typed-unavailable: a REGISTERED command reply is explicit, never swallowed", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const view = await provider.fetchView({ projectId: "project-9" }, async (command, args) => {
    assert.equal(command, "live_job_binding");
    // The project-scoped request is sent as-is on the wire (camelCase).
    assert.deepEqual(args, { projectId: "project-9" });
    return {
      source: "tauri",
      available: false,
      unavailableReason: "no-physical-job-source",
      observedJobId: null,
      observedPrinterId: null,
      jobBinding: null,
      artifact: null,
    };
  });
  assert.equal(view.source, "tauri");
  assert.equal(view.available, false);
  assert.equal(view.unavailableReason, "no-physical-job-source");
  assert.equal(view.observedJobId, null);
  assert.equal(view.observedPrinterId, null);
  assert.equal(view.jobBinding, null);
  assert.equal(view.artifact, null);
});

test("silent backend (null reply) becomes an explicit unavailable, not a guessed printer", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  // The selected printer id must NEVER be invented as the observed id when
  // the backend publishes nothing (no fallback inference).
  const view = await provider.fetchView({ projectId: "project-9" }, async () => null);
  assert.equal(view.available, false);
  assert.equal(view.unavailableReason, "no-physical-job-source");
  assert.equal(view.observedPrinterId, null);
  assert.equal(view.observedJobId, null);
});

test("backend failure surfaces backend-error with no invented identity", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const view = await provider.fetchView({ projectId: "project-9" }, async () => {
    throw new Error("transport down");
  });
  assert.equal(view.source, "tauri");
  assert.equal(view.available, false);
  assert.equal(view.unavailableReason, "backend-error");
  assert.equal(view.observedPrinterId, null);
});

test("valid linked view normalizes strictly (binding + artifact + ids)", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const view = await provider.fetchView({ projectId: "project-9" }, async () => ({
    source: "tauri",
    available: true,
    observedJobId: "physical-task-77",
    observedPrinterId: "cloud-abc-1",
    jobBinding: validBinding,
    artifact: validArtifact,
  }));
  assert.equal(view.available, true);
  assert.equal(view.unavailableReason, null);
  assert.equal(view.observedJobId, "physical-task-77");
  assert.equal(view.observedPrinterId, "cloud-abc-1");
  assert.deepEqual(view.jobBinding, validBinding);
  assert.deepEqual(view.artifact, validArtifact);
});

test("malformed binding payload is fail-closed INVALID, never trusted", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const view = await provider.fetchView({ projectId: "project-9" }, async () => ({
    source: "tauri",
    available: true,
    observedJobId: "physical-task-77",
    observedPrinterId: "cloud-abc-1",
    jobBinding: { ...validBinding, compatibility: "weird-compat" },
    artifact: validArtifact,
  }));
  assert.equal(view.available, false);
  assert.equal(view.unavailableReason, "invalid");
  assert.equal(view.observedJobId, null);
  assert.equal(view.observedPrinterId, null);
  assert.equal(view.jobBinding, null);
});

test("malformed artifact ref is fail-closed INVALID, never trusted", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const view = await provider.fetchView({ projectId: "project-9" }, async () => ({
    source: "tauri",
    available: true,
    observedJobId: "physical-task-77",
    observedPrinterId: "cloud-abc-1",
    jobBinding: validBinding,
    artifact: { ...validArtifact, sourceRev: "5" },
  }));
  assert.equal(view.available, false);
  assert.equal(view.unavailableReason, "invalid");
  assert.equal(view.artifact, null);
});

test("absent observedPrinterId stays null even when a printer is selected", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const view = await provider.fetchView({ projectId: "project-9" }, async () => ({
    source: "tauri",
    available: true,
    observedJobId: "physical-task-77",
    observedPrinterId: null,
    jobBinding: validBinding,
    artifact: validArtifact,
  }));
  assert.equal(view.observedPrinterId, null);
});

test("demo (non-Tauri) provider is honest — demo reason, no selected printer", async () => {
  const liveJob = await liveJobPromise;
  const provider = liveJob.liveJobProviderFor(false);
  const view = await provider.fetchView({ projectId: "project-9" });
  assert.equal(view.source, "demo");
  assert.equal(view.available, false);
  assert.equal(view.unavailableReason, "demo");
  assert.equal(view.observedPrinterId, null);
});

// ---- live_artifact_read lane: owned project + CAS read + strict IR parse --

test("artifact read: valid IR 1.1 parses strictly and returns the revision", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const result = await provider.readArtifact(
    { projectId: "project-9", artifactId: "bracket-ir-42" },
    async (command, args) => {
      assert.equal(command, "live_artifact_read");
      assert.deepEqual(args, { projectId: "project-9", artifactId: "bracket-ir-42" });
      return {
        artifactId: "bracket-ir-42",
        sourceRevision: 7,
        currentRevision: 9,
        ir: validIr,
      };
    },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.artifactId, "bracket-ir-42");
    assert.equal(result.sourceRevision, 7);
    assert.equal(result.currentRevision, 9);
    assert.equal(result.ir.version, "1.1");
    assert.equal(result.ir.segments.length, 1);
    assert.equal(result.ir.segments[0].kind, "WALL");
  }
});

test("artifact read: malformed IR is an explicit invalid result with the parse message", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const result = await provider.readArtifact(
    { projectId: "project-9", artifactId: "bracket-ir-42" },
    async () => ({
      artifactId: "bracket-ir-42",
      sourceRevision: 7,
      currentRevision: 9,
      ir: { version: "1.0", mode: "standard", dialect: "anycubic" },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid");
    assert.match(result.message ?? "", /version/i);
  }
});

test("artifact read: non-object reply is invalid (thin or untyped data)", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const result = await provider.readArtifact(
    { projectId: "project-9", artifactId: "bracket-ir-42" },
    async () => "not-a-view",
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid");
});

test("artifact read: backend failure maps to backend-error", async () => {
  const liveJob = await liveJobPromise;
  const provider = tauriProvider(liveJob);
  const result = await provider.readArtifact(
    { projectId: "project-9", artifactId: "bracket-ir-42" },
    async () => {
      throw new Error("artifact missing from CAS");
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "backend-error");
});
