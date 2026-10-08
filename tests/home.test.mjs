import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeUrl = pathToFileURL(path.join(root, "apps/editor/src/bridge/home.ts"));
const {
  continueLocalProject,
  createLocalProject,
  listLocalSliceJobs,
  openLocalProject,
  recoverLocalProject,
  buildReprintProposal,
  resolveSliceArtifactStatus,
} = await import(homeUrl.href);

const eligibleReprintCandidate = () => ({
  sourceJobId: "historical-job",
  artifactStatus: "present",
  artifactId: "artifact-current",
  artifactDigest: "sha256:fixture-current",
  expectedArtifactDigest: "sha256:fixture-current",
  profileFingerprint: "profile-fixture-v1",
  expectedProfileFingerprint: "profile-fixture-v1",
  mode: "standard",
  expectedMode: "standard",
  toolBinding: "tool-fixture-v1",
  expectedToolBinding: "tool-fixture-v1",
  sourceRevision: 7,
  currentSourceRevision: 7,
  currentPrinterId: "printer-current",
  targetPrinterId: "printer-current",
  printerReachable: true,
  compatibility: "qualified",
  printQualified: true,
});

test("local slice history propagates read failures", async () => {
  const failure = new Error("history unavailable");
  const invoke = async (command, args) => {
    assert.equal(command, "project_slice_history");
    assert.deepEqual(args, { projectId: "project-1", limit: 20 });
    throw failure;
  };

  await assert.rejects(listLocalSliceJobs(invoke, "project-1"), (error) => error === failure);
});

test("local slice history preserves empty results", async () => {
  const jobs = await listLocalSliceJobs(async () => [], "project-1");

  assert.deepEqual(jobs, []);
});

test("local slice history preserves populated results", async () => {
  const expectedJobs = [
    { job_id: "job-1", status: "completed", source_revision: 4 },
    { job_id: "job-2", status: "queued", source_revision: 5 },
  ];
  const jobs = await listLocalSliceJobs(async () => expectedJobs, "project-1", 2);

  assert.equal(jobs, expectedJobs);
});

test("create and open target the requested local project commands", async () => {
  const snapshot = { project: { id: "project-1", objects: [] }, revision: 0 };
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    return snapshot;
  };

  assert.equal(await createLocalProject(invoke, "project-1", "Local project"), snapshot);
  assert.equal(await openLocalProject(invoke, "project-1"), snapshot);
  assert.deepEqual(calls, [
    { command: "project_create", args: { projectId: "project-1", name: "Local project" } },
    { command: "project_open", args: { projectId: "project-1" } },
  ]);
});

test("create and open preserve local authority failures", async () => {
  const failure = new Error("local authority unavailable");
  const invoke = async () => {
    throw failure;
  };

  await assert.rejects(
    createLocalProject(invoke, "project-1", "Local project"),
    (error) => error === failure,
  );
  await assert.rejects(openLocalProject(invoke, "project-1"), (error) => error === failure);
});

test("recover invokes the selected project authority command, not the current authority read", async () => {
  const snapshot = { project: { id: "project-7", objects: [] }, revision: 12 };
  const calls = [];
  const result = await recoverLocalProject(async (command, args) => {
    calls.push({ command, args });
    return snapshot;
  }, "project-7");

  assert.deepEqual(calls, [
    { command: "project_authority_recover", args: { projectId: "project-7" } },
  ]);
  assert.equal(result, snapshot);
});

test("continue refuses to hydrate a different current project", async () => {
  await assert.rejects(
    continueLocalProject(async (command, args) => {
      assert.equal(command, "project_authority_read");
      assert.deepEqual(args, {});
      return { project: { id: "project-other", objects: [] }, revision: 3 };
    }, "project-selected"),
    /does not match the selected project/,
  );
});

test("slice artifact availability follows backend status rather than artifact id", () => {
  assert.equal(
    resolveSliceArtifactStatus({ artifact_status: "present", artifact_id: null }),
    "present",
  );
  assert.equal(
    resolveSliceArtifactStatus({ artifact_status: "missing", artifact_id: "artifact-1" }),
    "missing",
  );
  assert.equal(
    resolveSliceArtifactStatus({ artifact_status: "unavailable", artifact_id: "artifact-2" }),
    "unavailable",
  );
  assert.equal(
    resolveSliceArtifactStatus({ artifact_status: "future-status", artifact_id: "artifact-3" }),
    "unavailable",
  );
  assert.equal(
    resolveSliceArtifactStatus({ artifact_status: "unsupported", artifact_id: "artifact-4" }),
    "unavailable",
  );
  assert.equal(resolveSliceArtifactStatus({ artifact_id: "artifact-4" }), "unavailable");
});

test("reprint proposal blocks absent, stale, mismatched, offline, and unqualified inputs", () => {
  const cases = [
    [{ artifactStatus: "missing" }, "artifact-missing"],
    [{ artifactStatus: "present", artifactId: null }, "artifact-unavailable"],
    [{ artifactDigest: "sha256:old" }, "artifact-digest-mismatch"],
    [{ sourceRevision: 6 }, "source-revision-stale"],
    [{ profileFingerprint: "other-profile" }, "profile-mismatch"],
    [{ mode: "nonplanar" }, "mode-mismatch"],
    [{ toolBinding: "other-tool" }, "tool-binding-mismatch"],
    [{ currentPrinterId: "printer-other" }, "printer-mismatch"],
    [{ printerReachable: false }, "printer-offline"],
    [{ compatibility: "preview-only" }, "preview-only"],
    [{ compatibility: "unqualified", printQualified: false }, "qualification-missing"],
  ];

  for (const [changes, reason] of cases) {
    const result = buildReprintProposal({ ...eligibleReprintCandidate(), ...changes });
    assert.deepEqual(result, { status: "blocked", reason, sourceJobId: "historical-job" });
  }
});

test("qualified current artifact produces a new proposal only, never a print order", () => {
  const result = buildReprintProposal(eligibleReprintCandidate());

  assert.equal(result.status, "proposed");
  assert.notEqual(result.proposalId, "historical-job");
  assert.match(result.proposalId, /^reprint-proposal-/);
  assert.equal(result.sourceJobId, "historical-job");
  assert.equal(result.artifactId, "artifact-current");
  assert.equal(result.artifactDigest, "sha256:fixture-current");
  assert.equal(result.printerId, "printer-current");
  assert.equal("command" in result, false);
  assert.equal("confirm" in result, false);
  assert.equal("upload" in result, false);
});
