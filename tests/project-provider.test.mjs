import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerUrl = () =>
  pathToFileURL(path.join(root, "apps/editor/src/bridge/project-provider.ts")).href;

test("project provider selects explicit Demo in browser and exposes its origin", async () => {
  const provider = await import(providerUrl());
  const result = provider.selectProjectProvider({ isTauri: false });

  assert.equal(result.mode, "demo");
  assert.equal(result.available, true);
  assert.equal(result.origin, "demo-fixture");
  assert.ok(result.capabilities.includes("scene.mutate.demo"));
  const first = await provider.bootstrapProject({ isTauri: false });
  const cubeVisibility = first.scene?.objects.find((object) => object.name === "cube")?.visible;
  const mutation = await first.scene.mutateObject({ kind: "toggleVisible", name: "cube" });
  assert.equal(mutation.ok, true);
  assert.equal(mutation.objects.find((object) => object.name === "cube")?.visible, !cubeVisibility);
  const refreshed = await provider.bootstrapProject({ isTauri: false });
  assert.equal(typeof first.scene?.mutateObject, "function");
  assert.equal(typeof refreshed.scene?.repair, "function");
  assert.equal(first.scene, refreshed.scene);
  const restored = await refreshed.scene.mutateObject({ kind: "toggleVisible", name: "cube" });
  assert.equal(restored.ok, true);
  assert.equal(restored.objects.find((object) => object.name === "cube")?.visible, cubeVisibility);
});

test("real selection never falls back to Demo when the authority is absent", async () => {
  const provider = await import(providerUrl());

  for (const input of [{ isTauri: true }, { isTauri: false, requested: "real" }]) {
    const selected = provider.selectProjectProvider(input);
    const boot = await provider.bootstrapProject(input);

    assert.equal(selected.mode, "real");
    assert.equal(selected.available, false);
    assert.equal(selected.origin, "tauri-project-store");
    assert.equal(selected.reason, "real-project-provider-not-connected");
    assert.deepEqual(selected.capabilities, []);
    assert.equal(boot.provider.mode, "real");
    assert.equal(boot.scene, undefined);
  }
});

test("unknown provider request is unavailable instead of falling back to Demo", async () => {
  const provider = await import(providerUrl());
  const result = provider.selectProjectProvider({ requested: "unknown", isTauri: false });

  assert.equal(result.mode, "unavailable");
  assert.equal(result.origin, "none");
  assert.equal(result.available, false);
  assert.equal(result.reason, "unknown-project-provider");
});

test("provider changes cannot reuse a prior Demo bootstrap", async () => {
  const provider = await import(providerUrl());
  await provider.bootstrapProject({ isTauri: false, requested: "demo" });

  const real = await provider.bootstrapProject({ isTauri: true });
  assert.equal(real.provider.mode, "real");
  assert.equal(real.scene, undefined);
});

test("real provider is available only after the authority responds and persists named mutations", async () => {
  const provider = await import(providerUrl());
  let revision = 0;
  let project = {
    id: "local-project",
    name: "Local Project",
    objects: [
      {
        name: "part",
        vertices: 3,
        triangles: 1,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        sizeMm: [1, 1, 1],
        volumeMm3: 1,
        surfaceAreaMm2: 6,
        watertight: true,
        visible: true,
        locked: false,
        transform: { x: 0, y: 0, z: 0 },
      },
    ],
    legacy_objects: [],
  };
  const calls = [];
  let writes = 0;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "project_authority_read") return { project, revision };
    if (command === "project_authority_commit") {
      if (args.expectedRevision !== revision) {
        return {
          status: "conflict",
          actual_revision: revision,
          snapshot: { project, revision },
          diagnostics: ["project_revision_conflict"],
        };
      }
      writes += 1;
      project = args.project;
      revision += 1;
      return {
        status: "committed",
        actual_revision: revision,
        snapshot: { project, revision },
        diagnostics: [],
      };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const boot = await provider.bootstrapProject({ requested: "real", isTauri: true }, invoke);
  assert.equal(boot.provider.available, true);
  assert.equal(boot.provider.origin, "tauri-project-store");
  const handle = boot.scene;
  const oldId = handle.objects[0].objectId;
  const renamed = await handle.mutateObject({ kind: "rename", from: "part", to: "renamed" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.revision, 1);
  assert.equal(handle.objects[0].objectId, oldId);
  assert.equal(handle.objects[0].name, "renamed");
  assert.equal(calls.at(-1).args.operation.kind, "rename_object");

  const material = await handle.mutateObject({
    kind: "setObjectSettings",
    name: "renamed",
    settings: { layerHeightMm: 0.2 },
    filamentId: "petg-blue",
  });
  assert.equal(material.ok, true);
  assert.equal(material.revision, 2);
  assert.equal(project.objects[0].filamentId, "petg-blue");
  assert.equal(calls.at(-1).args.operation.kind, "set_material");

  const cloned = await handle.mutateObject({ kind: "duplicate", name: "renamed" });
  assert.equal(cloned.ok, true);
  assert.equal(cloned.revision, 3);
  assert.notEqual(handle.objects[1].objectId, oldId);
  assert.equal(calls.at(-1).args.operation.kind, "clone_object");

  const placed = await handle.mutateObject({
    kind: "setTransform",
    name: "renamed",
    transform: { x: 8, y: 0, z: -4 },
  });
  assert.equal(placed.ok, true);
  assert.equal(placed.revision, 4);
  assert.deepEqual(handle.objects[0].transform, { x: 8, y: 0, z: -4 });

  const removed = await handle.mutateObject({ kind: "remove", name: "renamed-copy" });
  assert.equal(removed.ok, true);
  assert.equal(removed.revision, 5);
  assert.equal(calls.at(-1).args.operation.kind, "remove_object");

  const callsBeforeStale = calls.length;
  const stale = await handle.mutateObject({ kind: "remove", name: "renamed" }, 4);
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "project_revision_conflict");
  assert.equal(stale.actualRevision, 5);
  assert.equal(calls.length, callsBeforeStale + 1);
  assert.equal(writes, 5);

  const beforeNoop = calls.length;
  const noOp = await handle.mutateObject({ kind: "commitObject", name: "renamed" });
  assert.equal(noOp.ok, true);
  assert.deepEqual(noOp.diagnostics, ["no_op"]);
  assert.equal(calls.length, beforeNoop);
});

test("real backend failure remains unavailable and never bootstraps Demo", async () => {
  const provider = await import(providerUrl());
  const boot = await provider.bootstrapProject({ requested: "real", isTauri: true }, async () => {
    throw new Error("authority offline");
  });

  assert.equal(boot.provider.mode, "real");
  assert.equal(boot.provider.available, false);
  assert.equal(boot.provider.reason, "project-authority-unavailable");
  assert.equal(boot.scene, undefined);
});

test("real transform conflict rebases to the authority snapshot and discards provisional state", async () => {
  const provider = await import(providerUrl());
  let project = {
    id: "local-project",
    name: "Local Project",
    objects: [
      {
        name: "part",
        objectId: "object-stable-1",
        vertices: 3,
        triangles: 1,
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        sizeMm: [1, 1, 1],
        volumeMm3: 1,
        surfaceAreaMm2: 6,
        watertight: true,
        visible: true,
        locked: false,
        transform: { x: 0, y: 0, z: 0 },
      },
    ],
    legacy_objects: [],
  };
  let revision = 4;
  const invoke = async (command) => {
    assert.equal(command, "project_authority_read");
    return { project, revision };
  };
  const boot = await provider.bootstrapProject({ requested: "real", isTauri: true }, invoke);
  const originalCommit = invoke;
  let commitCalls = 0;
  const racingInvoke = async (command, args) => {
    if (command === "project_authority_commit") {
      commitCalls += 1;
      assert.equal(args.expectedRevision, 4);
      project = {
        ...project,
        objects: project.objects.map((object) => ({
          ...object,
          transform: { x: 2, y: 0, z: 0 },
        })),
      };
      revision = 5;
      return {
        status: "conflict",
        actual_revision: revision,
        snapshot: { project, revision },
        diagnostics: ["project_revision_conflict"],
      };
    }
    return originalCommit(command, args);
  };

  const realBridge = await import(
    pathToFileURL(path.join(root, "apps/editor/src/bridge/real-project-bridge.ts")).href
  );
  const racedHandle = await realBridge.createRealProjectBridge(racingInvoke, {
    project: { ...project, objects: [{ ...project.objects[0], transform: { x: 0, y: 0, z: 0 } }] },
    revision: 4,
  });
  await racedHandle.begin(4);
  await racedHandle.mutateObject({
    kind: "setTransform",
    name: "part",
    transform: { x: 99, y: 0, z: 0 },
  });
  await assert.rejects(racedHandle.commit(4), (error) => {
    assert.equal(error.name, "StaleCommitError");
    assert.equal(error.expected, 4);
    assert.equal(error.actual, 5);
    return true;
  });
  assert.equal(commitCalls, 1);
  assert.equal(racedHandle.revision, 5);
  assert.deepEqual(racedHandle.objects[0].transform, { x: 2, y: 0, z: 0 });
});
