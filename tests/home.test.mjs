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
  resolveSliceArtifactStatus,
} = await import(homeUrl.href);

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
