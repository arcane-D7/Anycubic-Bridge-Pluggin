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

test("real geometry lanes persist worker meshes and preserve boolean source policy", async () => {
  const { createRealProjectBridge } = await import(
    pathToFileURL(path.join(root, "apps/editor/src/bridge/real-project-bridge.ts")).href
  );
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const indices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ];
  const object = (name, x, watertight) => ({
    name,
    objectId: `id-${name}`,
    vertices: 8,
    triangles: watertight ? 12 : 10,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    sizeMm: [1, 1, 1],
    volumeMm3: 1,
    surfaceAreaMm2: 6,
    watertight,
    geometry: {
      positions,
      normals: Array(24).fill(0),
      indices: watertight ? indices : indices.slice(0, 30),
    },
    visible: true,
    locked: false,
    transform: { x, y: 0, z: 0 },
  });
  let revision = 0;
  let project = {
    id: "p",
    name: "P",
    objects: [object("a", 0, true), object("b", 0.5, true), object("open", 2, false)],
  };
  const calls = [];
  const workerOutput = {
    positions,
    triangles: Array.from({ length: 12 }, (_, index) => indices.slice(index * 3, index * 3 + 3)),
    watertight: true,
    volume_mm3: 1,
  };
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "project_geometry_execute") {
      return { output: workerOutput, blender_version: "5.2.2 LTS", transport: "filechannel" };
    }
    if (command !== "project_authority_commit") throw new Error(`unexpected ${command}`);
    if (args.expectedRevision !== revision) {
      return {
        status: "conflict",
        actual_revision: revision,
        snapshot: { project, revision },
        diagnostics: ["conflict"],
      };
    }
    project = args.project;
    revision += 1;
    return {
      status: "committed",
      actual_revision: revision,
      snapshot: { project, revision },
      diagnostics: [],
    };
  };
  const bridge = await createRealProjectBridge(invoke, { project, revision });

  const boolean = await bridge.boolean({ name_a: "a", name_b: "b", op: "add", hide_sources: true });
  assert.equal(boolean.ok, true);
  assert.equal(boolean.revision, 1);
  assert.equal(calls[0].args.operation, "boolean_union");
  assert.equal(project.objects.find((entry) => entry.name === "a").visible, false);
  assert.equal(project.objects.find((entry) => entry.name === "b").visible, false);
  assert.deepEqual(
    project.objects.find((entry) => entry.name === "a-bool").geometry.indices,
    indices,
  );
  assert.match(
    project.objects.find((entry) => entry.name === "a-bool").provenance,
    /worker=blender-bridge\.geometry\.v1; Blender 5\.2\.2 LTS; geometry\.boolean\.union; filechannel/,
  );
  assert.equal(calls[1].args.operation.kind, "boolean");

  const copied = await bridge.repair({ name: "open", mode: "copy" });
  assert.equal(copied.ok, true);
  assert.equal(copied.revision, 2);
  assert.equal(copied.objectSnapshot.name, "open-repair");
  assert.equal(project.objects.find((entry) => entry.name === "open").watertight, false);
  assert.equal(project.objects.find((entry) => entry.name === "open").visible, true);
  assert.equal(project.objects.find((entry) => entry.name === "open-repair").watertight, true);
  assert.match(
    project.objects.find((entry) => entry.name === "open-repair").provenance,
    /worker=blender-bridge\.geometry\.v1; Blender 5\.2\.2 LTS; geometry\.repair; filechannel/,
  );
  assert.equal(calls.at(-1).args.operation.kind, "repair");

  const repaired = await bridge.repair({ name: "open", mode: "replace" });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.revision, 3);
  assert.equal(repaired.objectSnapshot.name, "open");
  assert.equal(project.objects.find((entry) => entry.name === "open").watertight, true);
  assert.equal(calls.at(-1).args.operation.kind, "repair");
});

test("real geometry failures and stale worker results never commit partial state", async () => {
  const { createRealProjectBridge } = await import(
    pathToFileURL(path.join(root, "apps/editor/src/bridge/real-project-bridge.ts")).href
  );
  const geometry = { positions: [0, 0, 0], normals: [0, 0, 0], indices: [0, 0, 0] };
  const part = {
    name: "part",
    objectId: "part-id",
    vertices: 1,
    triangles: 1,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    sizeMm: [1, 1, 1],
    volumeMm3: 1,
    surfaceAreaMm2: 1,
    watertight: false,
    geometry,
    visible: true,
    locked: false,
  };
  let revision = 4;
  const project = { id: "p", name: "P", objects: [part] };
  let commits = 0;
  const invoke = async (command, args) => {
    if (command === "project_geometry_execute") {
      return {
        output: { positions: [0, 0, 0], triangles: [[0, 0, 0]], watertight: true, volume_mm3: 1 },
        blender_version: "5.2.2 LTS",
      };
    }
    if (command === "project_authority_commit") {
      commits += 1;
      assert.equal(args.expectedRevision, 4);
      revision = 5;
      return {
        status: "conflict",
        actual_revision: 5,
        snapshot: { project, revision },
        diagnostics: ["conflict"],
      };
    }
    throw new Error(`unexpected ${command}`);
  };
  const bridge = await createRealProjectBridge(invoke, { project, revision: 4 });
  const result = await bridge.repair({ name: "part", mode: "replace" });
  assert.equal(result.ok, false);
  assert.match(result.error, /stale commit: expected 4, actual 5/);
  assert.equal(commits, 1);
  assert.equal(bridge.objects[0].watertight, false);

  const refusing = await createRealProjectBridge(
    async (command) => {
      if (command === "project_geometry_execute") throw new Error("worker timed out");
      throw new Error("commit must not be called");
    },
    { project, revision: 4 },
  );
  const failed = await refusing.repair({ name: "part", mode: "copy" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /worker timed out/);
  assert.equal(refusing.objects.length, 1);
});
