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
