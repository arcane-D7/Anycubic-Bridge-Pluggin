// S9.18-001 — shared reversible FRONTEND operation registry — pure core
// (catalog, closed validation, eligibility, idempotency) + registry factory
// over injected fake store access (two-origin parity, denied zero-effects).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "state", "operation-registry-core.ts"),
);

// `?key=` busts the ESM module cache so each test run imports a fresh core
// instance (fresh registry + caches per file).
const core = await import(`${coreUrl.href}?key=${Date.now()}`);

const {
  OPERATION_CATALOG_VERSION,
  OPERATIONS,
  OPERATION_IDS,
  WORKSPACE_VIEWS,
  isWorkspaceViewId,
  parseWorkspaceView,
  validateArgs,
  checkSceneSelectEligibility,
  argsFingerprint,
  InvocationCache,
  createOperationRegistry,
} = core;

const DEFAULT_PLATE = "plate-1";

/** In-memory store access shaped like the wiring's projection (live state). */
function fakeAccess() {
  const state = {
    view: "home",
    objects: [
      { name: "cone", visible: true, plateId: "plate-1", watertight: true },
      { name: "cube", visible: true, watertight: true },
      { name: "ghost", visible: false, plateId: "plate-1", watertight: true },
      { name: "away", visible: true, plateId: "plate-2", watertight: false },
    ],
    selectedNames: [],
    activePlateId: "plate-1",
    projectScopeId: null,
    conversationId: null,
    setViewCalls: 0,
    selectCalls: [],
  };
  const access = {
    workspace: {
      view: () => state.view,
      setView: (view) => {
        if (!isWorkspaceViewId(view)) return false;
        state.view = view;
        state.setViewCalls += 1;
        return true;
      },
    },
    scene: {
      objects: () => state.objects,
      selectedNames: () => state.selectedNames,
      select: (name, watertight) => {
        state.selectCalls.push([name, watertight]);
        state.selectedNames = [name];
      },
    },
    plates: {
      activePlateId: () => state.activePlateId,
      defaultPlateId: () => DEFAULT_PLATE,
    },
    chat: {
      currentProjectId: () => state.projectScopeId,
      activeConversationId: () => state.conversationId,
    },
  };
  return { state, access };
}

function makeRegistry(view) {
  const fixture = fakeAccess();
  if (view) fixture.state.view = view;
  const registry = createOperationRegistry(fixture.access, {
    defaultPlateId: DEFAULT_PLATE,
  });
  return { fixture: fixture.state, registry };
}

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

test("catalog: version 1, both operations explicitly frontend + reversible", () => {
  assert.equal(OPERATION_CATALOG_VERSION, 1);
  assert.deepEqual(OPERATION_IDS, ["workspace.navigate", "scene.select"]);
  assert.deepEqual([...WORKSPACE_VIEWS], ["home", "prepare", "preview", "workbench"]);
  for (const op of OPERATIONS) {
    assert.equal(op.reversible, true, op.id);
    assert.equal(op.executionLocation, "frontend", op.id);
    assert.equal(op.schemaVersion, OPERATION_CATALOG_VERSION, op.id);
    assert.equal(op.inputSchema.additionalProperties, false, op.id);
  }
  const catalog = makeRegistry().registry.catalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.executionLocation, "frontend");
  assert.equal(catalog.operations.length, 2);
});

test("catalog: registry factory catalogue exposes the same closed schemas", () => {
  const { registry } = makeRegistry();
  const navigate = registry.catalog().operations.find((op) => op.id === "workspace.navigate");
  assert.ok(navigate);
  assert.deepEqual(navigate.inputSchema.properties.view.enum, [...WORKSPACE_VIEWS]);
});

// ---------------------------------------------------------------------------
// Closed argument validation
// ---------------------------------------------------------------------------

test("validateArgs: rejects non-objects, arrays and null args", () => {
  const schema = OPERATIONS[0].inputSchema;
  assert.equal(validateArgs(schema, "home").ok, false);
  assert.equal(validateArgs(schema, ["prepare"]).ok, false);
  assert.equal(validateArgs(schema, null).ok, false);
  assert.equal(validateArgs(schema, undefined).ok, false);
});

test("validateArgs: class instances and engine builtins are NOT plain records", () => {
  const schema = OPERATIONS[1].inputSchema;
  assert.equal(validateArgs(schema, new Date()).ok, false);
  assert.equal(validateArgs(schema, new Map()).ok, false);
  assert.equal(validateArgs(schema, /cone/).ok, false);
  class Args {
    name = "cone";
  }
  assert.equal(validateArgs(schema, new Args()).ok, false);
  // Object.create(null) shaped records ARE plain (prototype === null).
  const nullProto = Object.create(null);
  nullProto.name = "cone";
  assert.equal(validateArgs(schema, nullProto).ok, true);
});

test("validateArgs: rejects prototype-ish keys even when own properties", () => {
  const schema = OPERATIONS[1].inputSchema;
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const args = JSON.parse(`{"name":"cone","${key}":{}}`);
    const out = validateArgs(schema, args);
    assert.equal(out.ok, false, key);
    assert.match(out.details, /forbidden key/);
  }
});

test("validateArgs: rejects missing, unknown, wrong-typed and oversized args", () => {
  const navSchema = OPERATIONS[0].inputSchema;
  assert.equal(validateArgs(navSchema, {}).ok, false);
  const unknown = validateArgs(navSchema, { view: "prepare", extra: 1 });
  assert.equal(unknown.ok, false);
  assert.match(unknown.details, /unknown key/);
  assert.equal(validateArgs(navSchema, { view: "about" }).ok, false);
  assert.equal(validateArgs(navSchema, { view: 7 }).ok, false);
  assert.equal(validateArgs(navSchema, { view: null }).ok, false);

  const selectSchema = OPERATIONS[1].inputSchema;
  assert.equal(validateArgs(selectSchema, { name: "" }).ok, false);
  assert.equal(validateArgs(selectSchema, { name: 42 }).ok, false);
  const longName = validateArgs(selectSchema, { name: "x".repeat(300) });
  assert.equal(longName.ok, false);
  assert.match(longName.details, /too long/);
});

test("parseWorkspaceView / isWorkspaceViewId: strict enum", () => {
  for (const view of WORKSPACE_VIEWS) assert.ok(isWorkspaceViewId(view));
  assert.equal(isWorkspaceViewId("about"), false);
  assert.equal(isWorkspaceViewId(undefined), false);
  assert.equal(parseWorkspaceView("workbench"), "workbench");
  assert.equal(parseWorkspaceView("about"), null);
});

// ---------------------------------------------------------------------------
// Eligibility matrix (scene.select)
// ---------------------------------------------------------------------------

test("eligibility: accepted only for visible objects on the active plate", () => {
  const { fixture } = makeRegistry();
  const ctx = {
    view: "prepare",
    objects: fixture.objects,
    activePlateId: "plate-1",
    projectScopeId: null,
    conversationId: null,
  };
  assert.deepEqual(checkSceneSelectEligibility("cone", ctx, DEFAULT_PLATE).ok, true);
  const cube = checkSceneSelectEligibility("cube", ctx, DEFAULT_PLATE); // no plateId → default
  assert.deepEqual(cube.ok, true);
  assert.equal(cube.watertight, true);
  const away = checkSceneSelectEligibility("away", ctx, DEFAULT_PLATE); // plate-2
  assert.deepEqual(away.ok, false);
  assert.equal(away.reason, "object-not-on-active-plate");
});

test("eligibility: typed denials for hidden, unknown and empty scenes", () => {
  const { fixture } = makeRegistry();
  const base = {
    view: "prepare",
    objects: fixture.objects,
    activePlateId: "plate-1",
    projectScopeId: null,
    conversationId: null,
  };
  const hidden = checkSceneSelectEligibility("ghost", base, DEFAULT_PLATE);
  assert.equal(hidden.ok, false);
  assert.equal(hidden.reason, "object-hidden");
  const unknown = checkSceneSelectEligibility("nope", base, DEFAULT_PLATE);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "no-such-object");
  const empty = checkSceneSelectEligibility("cone", { ...base, objects: [] }, DEFAULT_PLATE);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "no-active-scene");
});

test("eligibility: selection is a prepare-only surface (preview stays read-only)", () => {
  const { fixture } = makeRegistry();
  for (const view of ["home", "preview", "workbench"]) {
    const out = checkSceneSelectEligibility(
      "cone",
      {
        view,
        objects: fixture.objects,
        activePlateId: "plate-1",
        projectScopeId: null,
        conversationId: null,
      },
      DEFAULT_PLATE,
    );
    assert.equal(out.ok, false, view);
    assert.equal(out.reason, "selection-only-in-prepare", view);
  }
});

// ---------------------------------------------------------------------------
// Registry factory — execution + typed denials (zero effects)
// ---------------------------------------------------------------------------

test("workspace.navigate: valid call delegates to setView once with outcome", () => {
  const { fixture, registry } = makeRegistry();
  const out = registry.execute({ id: "workspace.navigate", args: { view: "prepare" } });
  assert.equal(out.ok, true);
  assert.equal(fixture.view, "prepare");
  assert.equal(fixture.setViewCalls, 1);
  assert.equal(out.outcome.code, "navigated");
  assert.equal(out.outcome.previousView, "home");
  assert.equal(out.outcome.executionLocation, "frontend");
});

test("workspace.navigate: navigate to the SAME view is a no-op already-on-view", () => {
  const { fixture, registry } = makeRegistry("preview");
  const out = registry.execute({ id: "workspace.navigate", args: { view: "preview" } });
  assert.equal(out.ok, true);
  assert.equal(out.outcome.code, "already-on-view");
  assert.equal(fixture.setViewCalls, 1);
  assert.equal(fixture.view, "preview");
});

test("workspace.navigate: invalid view is a typed invalid-arguments denial with zero effects", () => {
  const { fixture, registry } = makeRegistry();
  const out = registry.execute({ id: "workspace.navigate", args: { view: "about" } });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid-arguments");
  assert.equal(fixture.setViewCalls, 0);
  assert.equal(fixture.view, "home");
});

test("scene.select: valid call uses the shared store select (no duplicated mutation)", () => {
  const { fixture, registry } = makeRegistry("prepare");
  const out = registry.execute({ id: "scene.select", args: { name: "cone" } });
  assert.equal(out.ok, true);
  assert.deepEqual(fixture.selectCalls, [["cone", true]]);
  assert.deepEqual(fixture.selectedNames, ["cone"]);
  assert.equal(out.outcome.code, "selected");
  assert.equal(out.outcome.applied, true);
});

test("scene.select: typed denials never touch the store", () => {
  const cases = [
    ["queue-x", "no-such-object"],
    ["ghost", "object-hidden"],
    ["away", "object-not-on-active-plate"],
  ];
  for (const [name, reason] of cases) {
    const { fixture, registry } = makeRegistry("prepare");
    const out = registry.execute({ id: "scene.select", args: { name } });
    assert.equal(out.ok, false, name);
    assert.equal(out.error.code, "unavailable", name);
    assert.equal(out.error.reason, reason, name);
    assert.deepEqual(fixture.selectCalls, [], name);
    assert.deepEqual(fixture.selectedNames, [], name);
  }
});

test("scene.select: preview read-only — denial in preview view with zero effects", () => {
  const { fixture, registry } = makeRegistry("preview");
  const out = registry.execute({ id: "scene.select", args: { name: "cone" } });
  assert.equal(out.ok, false);
  assert.equal(out.error.reason, "selection-only-in-prepare");
  assert.deepEqual(fixture.selectCalls, []);
});

test("scene.select: prototype-keyed args are invalid-arguments before any effect", () => {
  const { fixture, registry } = makeRegistry();
  const out = registry.execute({
    id: "scene.select",
    args: JSON.parse('{"name":"cone","__proto__":{}}'),
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid-arguments");
  assert.deepEqual(fixture.selectCalls, []);
});

test("unknown operation id → operation-not-found (never a crash)", () => {
  const { fixture, registry } = makeRegistry();
  const out = registry.execute({ id: "printer.turn_on", args: {} });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "operation-not-found");
  assert.equal(fixture.setViewCalls, 0);
  assert.deepEqual(fixture.selectCalls, []);
});

test("readContext reads LIVE values from the store access (never a stale closure)", () => {
  const { fixture, registry } = makeRegistry();
  fixture.view = "workbench";
  fixture.projectScopeId = "proj-1";
  fixture.conversationId = "conv-1";
  const ctx = registry.readContext();
  assert.equal(ctx.view, "workbench");
  assert.equal(ctx.projectScopeId, "proj-1");
  assert.equal(ctx.conversationId, "conv-1");
  assert.equal(ctx.activePlateId, "plate-1");
});

// ---------------------------------------------------------------------------
// Idempotency + context liveness (tool-origin, callId-pinned)
// ---------------------------------------------------------------------------

test("idempotency: same callId+args replays the CACHED receipt (no re-apply)", () => {
  const { fixture, registry } = makeRegistry();
  const first = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "e2e-call-1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(first.ok, true);
  const second = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "e2e-call-1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(second.ok, true);
  // Duplicate returns the FIRST receipt verbatim — no re-execution, no
  // live-state recomputation (a user drift in between is never overridden).
  assert.equal(second.outcome.code, "navigated");
  assert.equal(second.outcome.view, "prepare");
  assert.equal(fixture.setViewCalls, 1);
  assert.equal(registry.cacheSize(), 1);
});

test("idempotency: same callId with DIFFERENT args is refused before any effect", () => {
  const { fixture, registry } = makeRegistry();
  registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "c1",
    projectScopeId: null,
    conversationId: null,
  });
  const beforeCalls = fixture.setViewCalls;
  const out = registry.execute({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "c1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "call-id-reused");
  assert.equal(fixture.setViewCalls, beforeCalls); // zero new effects
  assert.equal(fixture.view, "prepare");
});

test("context-alive: pinned project/conversation must equal the active scope", () => {
  const { fixture, registry } = makeRegistry();
  fixture.projectScopeId = "proj-A";
  fixture.conversationId = "conv-A";
  const wrongProject = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "cA",
    projectScopeId: "proj-B",
    conversationId: "conv-A",
  });
  assert.equal(wrongProject.ok, false);
  assert.equal(wrongProject.error.code, "context-changed");
  assert.equal(wrongProject.error.reason, "project");
  const wrongConversation = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "cB",
    projectScopeId: "proj-A",
    conversationId: "conv-B",
  });
  assert.equal(wrongConversation.ok, false);
  assert.equal(wrongConversation.error.reason, "conversation");
  assert.equal(fixture.setViewCalls, 0);
});

test("idempotency: scope rotation stops stale replays without flushing receipts", () => {
  const { fixture, registry } = makeRegistry();
  const call = (callId, projectScopeId) =>
    registry.execute({
      id: "workspace.navigate",
      args: { view: "prepare" },
      callId,
      projectScopeId,
      conversationId: null,
    });

  // Project scope P1 alive: navigate applied once.
  fixture.projectScopeId = "P1";
  assert.equal(call("boundary-1", "P1").ok, true);
  assert.equal(fixture.setViewCalls, 1);

  // Active scope moved to P2: the SAME callId pinned to the OLD scope is a
  // typed context-changed denial BEFORE any effect — no stale operation ever
  // fires after a project/conversation switch.
  fixture.projectScopeId = "P2";
  const stale = call("boundary-1", "P1");
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "context-changed");
  assert.equal(fixture.setViewCalls, 1);

  // Same callId in the NEW scope: a fresh entry re-executes (calls=2). The
  // old scope keeps its receipt — the denial never flushed anything.
  const fresh = call("boundary-1", "P2");
  assert.equal(fresh.ok, true);
  assert.equal(fresh.outcome.code, "already-on-view"); // view already prepare
  assert.equal(fixture.setViewCalls, 2);

  // Pin-stable within the new scope: replay returns the cached receipt with
  // zero effects.
  const replay = call("boundary-1", "P2");
  assert.equal(replay.ok, true);
  assert.equal(replay.outcome.code, "already-on-view"); // cached fresh receipt
  assert.equal(fixture.setViewCalls, 2);
  assert.equal(registry.cacheSize(), 2); // receipts on BOTH scopes intact
});

test("InvocationCache: bounded per scope, fail-closed on capacity, no empty buckets", () => {
  const cache = new InvocationCache(2);
  const scope = cache.scopeKeyOf(null, null);
  const a = cache.entryKeyOf("workspace.navigate", "a");
  const b = cache.entryKeyOf("workspace.navigate", "b");
  const c = cache.entryKeyOf("workspace.navigate", "c");
  const result = {
    ok: true,
    operation: "workspace.navigate",
    outcome: {
      code: "navigated",
      view: "prepare",
      previousView: "home",
      executionLocation: "frontend",
    },
  };
  assert.equal(cache.register(scope, a, "k1", 1, result), true);
  assert.equal(cache.register(scope, b, "k2", 1, result), true);
  assert.equal(cache.size, 2);
  // Capacity: the third NEW id fails closed — nothing is silently evicted.
  assert.equal(cache.register(scope, c, "k3", 1, result), false);
  assert.equal(cache.size, 2);
  // The taken entries stay replayable (never dropped → cannot re-execute).
  const hitA = cache.lookup(scope, a);
  assert.equal(hitA?.argsKey, "k1");
  assert.equal(hitA?.generation, 1);
  assert.deepEqual(hitA?.result, result);
  // A missed lookup never creates an empty bucket.
  const fresh = new InvocationCache(2);
  assert.equal(fresh.lookup(fresh.scopeKeyOf(null, null), c), undefined);
  assert.equal(fresh.size, 0);
  // Scope keys are injective JSON tuples (no delimiter collision).
  assert.equal(
    fresh.scopeKeyOf("a::conversation:b", "c"),
    JSON.stringify(["a::conversation:b", "c"]),
  );
  assert.notEqual(
    fresh.scopeKeyOf("a::conversation:b", "c"),
    fresh.scopeKeyOf("a", "b::conversation:c"),
  );
});

test("argsFingerprint is deterministic, key-ordered and operation-bound", () => {
  assert.equal(
    argsFingerprint("workspace.navigate", { view: "prepare" }),
    argsFingerprint("workspace.navigate", { view: "prepare" }),
  );
  assert.equal(
    argsFingerprint("workspace.navigate", { b: 1, a: 2 }),
    argsFingerprint("workspace.navigate", { a: 2, b: 1 }),
  );
  // Structurally equal args under DIFFERENT operations never share a
  // fingerprint — a receipt can never be mis-attributed across operations.
  assert.notEqual(
    argsFingerprint("workspace.navigate", { view: "prepare" }),
    argsFingerprint("scene.select", { view: "prepare" }),
  );
  assert.notEqual(
    argsFingerprint("scene.select", { name: "cone" }),
    argsFingerprint("workspace.navigate", { name: "cone" }),
  );
});

// ---------------------------------------------------------------------------
// Two-origin parity at the factory level: UI-origin (no callId) and
// tool-origin (pinned callId) drive the EXACT same handler/observable.
// ---------------------------------------------------------------------------

test("two-origin parity: UI-origin and tool-origin navigate to the same observable view", () => {
  const ui = makeRegistry();
  const tool = makeRegistry();
  const uiOut = ui.registry.execute({ id: "workspace.navigate", args: { view: "prepare" } });
  const toolOut = tool.registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "tool-nav-1",
    projectScopeId: null,
    conversationId: null,
  });

  assert.equal(uiOut.ok, true);
  assert.equal(toolOut.ok, true);
  assert.equal(uiOut.outcome.code, "navigated");
  assert.equal(toolOut.outcome.code, "navigated");
  assert.equal(ui.fixture.view, "prepare");
  assert.equal(tool.fixture.view, "prepare");
  // Same handler: both delegated to the store's setView (exact same mutation).
  assert.equal(ui.fixture.setViewCalls, 1);
  assert.equal(tool.fixture.setViewCalls, 1);
});

test("two-origin parity: UI-origin and tool-origin selection produce identical observable selection", () => {
  const ui = makeRegistry("prepare");
  const tool = makeRegistry("prepare");

  const uiOut = ui.registry.execute({ id: "scene.select", args: { name: "cube" } });
  const toolOut = tool.registry.execute({
    id: "scene.select",
    args: { name: "cube" },
    callId: "tool-select-1",
    projectScopeId: null,
    conversationId: null,
  });

  assert.equal(uiOut.ok, true);
  assert.equal(toolOut.ok, true);
  assert.deepEqual(ui.fixture.selectedNames, ["cube"]);
  assert.deepEqual(tool.fixture.selectedNames, ["cube"]);
  assert.deepEqual(ui.fixture.selectCalls, [["cube", true]]);
  assert.deepEqual(tool.fixture.selectCalls, [["cube", true]]);
});

// ---------------------------------------------------------------------------
// S9.18-001 hardening — strict tool-origin envelope, authoritative scope
// generation, receipt-based replays, fail-closed capacity.
// ---------------------------------------------------------------------------

test("hardening: tool-origin omitted pins are a typed invalid-invocation (never a UI bypass)", () => {
  const { fixture, registry } = makeRegistry();
  const omitBoth = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "tool-no-pins",
  });
  assert.equal(omitBoth.ok, false);
  assert.equal(omitBoth.error.code, "invalid-invocation");
  assert.equal(fixture.setViewCalls, 0);

  const omitConversion = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "tool-partial",
    projectScopeId: null,
  });
  assert.equal(omitConversion.ok, false);
  assert.equal(omitConversion.error.code, "invalid-invocation");
  assert.equal(fixture.setViewCalls, 0);
});

test("hardening: non-string pins are a typed invalid-invocation", () => {
  const { fixture, registry } = makeRegistry();
  const badProject = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "tp1",
    projectScopeId: 42,
    conversationId: null,
  });
  assert.equal(badProject.ok, false);
  assert.equal(badProject.error.code, "invalid-invocation");
  const badConversation = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "tp2",
    projectScopeId: null,
    conversationId: {},
  });
  assert.equal(badConversation.ok, false);
  assert.equal(badConversation.error.code, "invalid-invocation");
  assert.equal(fixture.setViewCalls, 0);
});

test("hardening: UI-origin calls cannot pin a scope", () => {
  const { fixture, registry } = makeRegistry();
  const out = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    projectScopeId: "proj-A",
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "invalid-invocation");
  assert.equal(fixture.setViewCalls, 0);
});

test("hardening: pins are STRICT equality including null (null pin vs active project)", () => {
  const { fixture, registry } = makeRegistry();
  fixture.projectScopeId = "proj-A";
  const out = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "null-pin",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "context-changed");
  assert.equal(out.error.reason, "project");
  assert.equal(fixture.setViewCalls, 0);
});

test("hardening: duplicate returns the CACHED receipt — user view drift is never overridden", () => {
  const { fixture, registry } = makeRegistry();
  const first = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "drift-1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(first.ok, true);
  assert.equal(first.outcome.code, "navigated");
  assert.equal(fixture.setViewCalls, 1);

  // User intervenes: navigates away while the tool call is "in flight".
  fixture.view = "workbench"; // direct store change — NOT a registry call
  const replay = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "drift-1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(replay.ok, true);
  // The FIRST receipt is returned as-is: the user's live view is never
  // re-targeted (no second effect) and the receipt is not recomputed.
  assert.equal(replay.outcome.code, "navigated");
  assert.equal(replay.outcome.view, "prepare");
  assert.equal(fixture.view, "workbench");
  assert.equal(fixture.setViewCalls, 1);
});

test("hardening: same callId across DIFFERENT operations is a distinct entry", () => {
  const { fixture, registry } = makeRegistry();
  const nav = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "shared-call",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(nav.ok, true);
  fixture.view = "prepare"; // the nav effect (real store would have set it)
  const select = registry.execute({
    id: "scene.select",
    args: { name: "cone" },
    callId: "shared-call",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(select.ok, true);
  assert.equal(select.outcome.code, "selected");
  assert.deepEqual(fixture.selectCalls, [["cone", true]]);
});

test("hardening: A→B→A rotates the authoritative generation → context-changed, no re-execution", () => {
  const { fixture, registry } = makeRegistry();
  const call = (callId, projectScopeId) =>
    registry.execute({
      id: "workspace.navigate",
      args: { view: "prepare" },
      callId,
      projectScopeId,
      conversationId: null,
    });

  fixture.projectScopeId = "P1";
  assert.equal(call("aba-1", "P1").ok, true);
  assert.equal(fixture.setViewCalls, 1);

  // The scope really rotates A→B then B→A. The registry only rotates its
  // authoritative generation when it OBSERVES the change — the stale request
  // issued while active=P2 both rotates the generation (B) and is denied as
  // context-changed (pinned to the old scope).
  fixture.projectScopeId = "P2";
  const whileB = call("aba-1", "P1");
  assert.equal(whileB.ok, false);
  assert.equal(whileB.error.code, "context-changed");
  fixture.projectScopeId = "P1"; // back to A

  const replay = call("aba-1", "P1");
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "context-changed");
  assert.equal(replay.error.reason, "scope-rotated");
  assert.equal(fixture.setViewCalls, 1); // never re-executed
  assert.equal(registry.cacheSize(), 1); // receipts never flushed by rotation
});

test("hardening: an untrusted stale-scope request cannot flush the receipts", () => {
  const { fixture, registry } = makeRegistry();
  fixture.projectScopeId = "P1";
  const first = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "safe-1",
    projectScopeId: "P1",
    conversationId: null,
  });
  assert.equal(first.ok, true);
  const sizeBefore = registry.cacheSize();

  fixture.projectScopeId = "P2";
  const stale = registry.execute({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "safe-1",
    projectScopeId: "P1",
    conversationId: null,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "context-changed");
  assert.equal(registry.cacheSize(), sizeBefore); // receipts intact
});

test("hardening: failure receipts tombstone — retrying a denied callId returns the cached failure", () => {
  const { fixture, registry } = makeRegistry("prepare");
  const call = () =>
    registry.execute({
      id: "scene.select",
      args: { name: "ghost" }, // hidden → unavailable denial (executed path)
      callId: "tombstone-1",
      projectScopeId: null,
      conversationId: null,
    });
  const first = call();
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "unavailable");
  assert.equal(first.error.reason, "object-hidden");
  const second = call();
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "unavailable");
  assert.equal(second.error.reason, "object-hidden");
  assert.deepEqual(fixture.selectCalls, []); // zero re-attempts
});

test("hardening: registry cache capacity fails closed (cache-full, no eviction)", () => {
  const fixture = fakeAccess();
  const registry = createOperationRegistry(fixture.access, {
    defaultPlateId: DEFAULT_PLATE,
    cacheMaxEntries: 1,
  });
  const first = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "full-1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(first.ok, true);
  assert.equal(fixture.state.setViewCalls, 1);
  assert.equal(registry.cacheSize(), 1);

  const second = registry.execute({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "full-2",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "cache-full");
  assert.equal(fixture.state.setViewCalls, 1); // zero effects

  // The taken receipt is still replayable — nothing was evicted.
  const replay = registry.execute({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "full-1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(replay.ok, true);
  assert.equal(fixture.state.setViewCalls, 1);
});

// ---------------------------------------------------------------------------
// Adversarial: explicit strict tool wrapper (executeTool) + cancellation
// before any side effect.
// ---------------------------------------------------------------------------

test("strict wrapper: executeTool refuses a non-string/empty callId at runtime", () => {
  const { fixture, registry } = makeRegistry();
  const bad = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "invalid-invocation");
  assert.equal(fixture.setViewCalls, 0);
});

test("strict wrapper: executeTool with pins never falls through to the UI path", () => {
  const { fixture, registry } = makeRegistry();
  const out = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "strict-1",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(out.ok, true);
  assert.equal(out.outcome.code, "navigated");
  assert.equal(fixture.view, "prepare");
  assert.equal(fixture.setViewCalls, 1);
  assert.equal(registry.cacheSize(), 1); // tool-origin → receipt registered
});

test("canceled: boolean true denies BEFORE any effect and is never cached", () => {
  const { fixture, registry } = makeRegistry();
  const out = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "cancel-1",
    projectScopeId: null,
    conversationId: null,
    canceled: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "canceled");
  assert.equal(out.error.reason, "call-canceled");
  assert.equal(fixture.setViewCalls, 0); // zero effects
  assert.equal(registry.cacheSize(), 0); // never cached — retryable

  // The SAME callId is retryable after cancellation (no call-id-reused).
  const retry = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "cancel-1",
    projectScopeId: null,
    conversationId: null,
    canceled: false,
  });
  assert.equal(retry.ok, true);
  assert.equal(fixture.setViewCalls, 1);
});

test("canceled: predicate is re-evaluated at the effect boundary", () => {
  const { fixture, registry } = makeRegistry();
  let aborted = false;
  const call = () =>
    registry.executeTool({
      id: "workspace.navigate",
      args: { view: "prepare" },
      callId: "cancel-pred",
      projectScopeId: null,
      conversationId: null,
      canceled: () => aborted,
    });
  assert.equal(call().ok, true); // predicate false → applies
  assert.equal(fixture.setViewCalls, 1);

  // A THROWING predicate fails closed toward no side effects.
  const throwing = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "workbench" },
    callId: "cancel-throw",
    projectScopeId: null,
    conversationId: null,
    canceled: () => {
      throw new Error("broken signal");
    },
  });
  assert.equal(throwing.ok, false);
  assert.equal(throwing.error.code, "canceled");
  assert.equal(fixture.setViewCalls, 1); // no effect from the new call
});

test("canceled: an ALREADY-APPLIED receipt replays even when the retry arrives canceled", () => {
  const { fixture, registry } = makeRegistry();
  const first = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "late-cancel",
    projectScopeId: null,
    conversationId: null,
  });
  assert.equal(first.ok, true);
  assert.equal(fixture.setViewCalls, 1);

  // Caller aborts, but the call already ran: replay returns the CACHED
  // receipt (zero new effects) instead of a spurious cancel denial — the
  // operation did complete before cancellation could arrive.
  const replay = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "late-cancel",
    projectScopeId: null,
    conversationId: null,
    canceled: true,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.outcome.code, "navigated");
  assert.equal(fixture.setViewCalls, 1);
  assert.equal(registry.cacheSize(), 1);
});

test("canceled: stale-scope + canceled resolves to context-changed (scope gate first)", () => {
  const { fixture, registry } = makeRegistry();
  fixture.projectScopeId = "proj-A";
  const out = registry.executeTool({
    id: "workspace.navigate",
    args: { view: "prepare" },
    callId: "cs-1",
    projectScopeId: "proj-B", // stale pin
    conversationId: null,
    canceled: true,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, "context-changed"); // scope-alive gate wins
  assert.equal(fixture.setViewCalls, 0);
});
