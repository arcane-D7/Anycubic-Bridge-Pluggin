import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.3-003 shortcuts — pure core behavior (`state/shortcuts-core.ts`) +
 * the registry surface (`state/shortcuts.ts`) + `constrainToAxis`
 * (`viewport/transform-core.ts`). All headless under Node 24.
 *
 * AC-1: "All listed shortcuts fire and update the scene; no-op in text
 * inputs" — parse decisions + editable-target gating asserted here; the
 * browser e2e (e2e:ui) covers live firing.
 * AC-2: registry + help list asserted here (labels/keys present).
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "shortcuts-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}
async function loadRegistry() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "shortcuts.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}
async function loadTransformCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "viewport", "transform-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();
const registryPromise = loadRegistry();
const transformPromise = loadTransformCore();

const editable = {
  input: (key, mods = {}) => ({ key, targetTag: "INPUT", isContentEditable: false, ...mods }),
  textarea: (key, mods = {}) => ({ key, targetTag: "TEXTAREA", isContentEditable: false, ...mods }),
  contenteditable: (key, mods = {}) => ({
    key,
    targetTag: "DIV",
    isContentEditable: true,
    ...mods,
  }),
  select: (key, mods = {}) => ({ key, targetTag: "SELECT", isContentEditable: false, ...mods }),
  plain: (key, mods = {}) => ({ key, targetTag: "BODY", isContentEditable: false, ...mods }),
};

test("registry: G/R/S grabs + Enter/Esc + X/Y/Z list wired ids", async () => {
  const { SHORTCUTS, shortcutFor, shortcutLabel } = await registryPromise;
  for (const id of [
    "object.grabMove",
    "object.grabRotate",
    "object.grabScale",
    "object.constrain.axis",
    "object.grabConfirm",
    "object.grabCancel",
  ]) {
    const e = shortcutFor(id);
    assert.ok(e, `registry has ${id}`);
    assert.ok(e.keys.length > 0);
    assert.ok(shortcutLabel(e).length > 0);
  }
  // Tool switch entries stay intact.
  assert.deepEqual(shortcutFor("tool.move")?.keys, ["w"]);
  assert.equal(typeof SHORTCUTS.length, "number");
});

test("registry: shortcut help surfaces every binding (AC-2)", async () => {
  const { SHORTCUT_HELP } = await registryPromise;
  const ids = SHORTCUT_HELP.map((s) => s.id);
  for (const id of [
    "grab-move",
    "grab-rotate",
    "grab-scale",
    "constrain",
    "confirm",
    "cancel",
    "frame",
    "duplicate",
    "delete",
    "undo",
    "redo",
    "tool-switch",
  ]) {
    assert.ok(ids.includes(id), `help lists ${id}`);
  }
});

test("parse: editable targets never fire (AC no-op in text inputs)", async () => {
  const { parseShortcutEvent } = await corePromise;
  const ctx = { gestureActive: false, hasSelection: true };
  for (const key of ["g", "r", "s", "q", "w", "e", "f", "x", "y", "z", "Delete", "Backspace"]) {
    assert.equal(parseShortcutEvent(editable.input(key), ctx), null, `input ${key} is a no-op`);
    assert.equal(parseShortcutEvent(editable.textarea(key), ctx), null);
    assert.equal(parseShortcutEvent(editable.contenteditable(key), ctx), null);
    assert.equal(parseShortcutEvent(editable.select(key), ctx), null);
  }
});

test("parse: G/R/S grab with selection; R without selection = scale tool", async () => {
  const { parseShortcutEvent } = await corePromise;
  const sel = { gestureActive: false, hasSelection: true };
  const noSel = { gestureActive: false, hasSelection: false };
  assert.deepEqual(parseShortcutEvent(editable.plain("g"), sel), {
    kind: "grab",
    gesture: "move",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("r"), sel), {
    kind: "grab",
    gesture: "rotate",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("s"), sel), {
    kind: "grab",
    gesture: "scale",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("r"), noSel), {
    kind: "tool",
    tool: "tool.scale",
  });
});

test("parse: Q/W/E tool switch (no grab active)", async () => {
  const { parseShortcutEvent } = await corePromise;
  const ctx = { gestureActive: false, hasSelection: true };
  assert.deepEqual(parseShortcutEvent(editable.plain("q"), ctx), {
    kind: "tool",
    tool: "tool.select",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("w"), ctx), {
    kind: "tool",
    tool: "tool.move",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("e"), ctx), {
    kind: "tool",
    tool: "tool.rotate",
  });
});

test("parse: M toggles measure tool (G42)", async () => {
  const { parseShortcutEvent } = await corePromise;
  const ctx = { gestureActive: false, hasSelection: true };
  const active = { gestureActive: true, hasSelection: true };
  assert.deepEqual(parseShortcutEvent(editable.plain("m"), ctx), {
    kind: "tool",
    tool: "tool.measure",
  });
  // Fires even during a grab — like F, unfazed by the modal.
  assert.deepEqual(parseShortcutEvent(editable.plain("m"), active), {
    kind: "tool",
    tool: "tool.measure",
  });
  // But never inside text inputs (AC: no-op while typing).
  assert.equal(parseShortcutEvent(editable.input("m"), ctx), null);
});

test("parse: X/Y/Z/Enter/Esc only inside an active grab", async () => {
  const { parseShortcutEvent } = await corePromise;
  const idle = { gestureActive: false, hasSelection: true };
  const active = { gestureActive: true, hasSelection: true };
  assert.equal(parseShortcutEvent(editable.plain("x"), idle), null);
  assert.equal(parseShortcutEvent(editable.plain("y"), idle), null);
  assert.equal(parseShortcutEvent(editable.plain("z"), idle), null);
  assert.deepEqual(parseShortcutEvent(editable.plain("x"), active), {
    kind: "constrain",
    axis: "x",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("y"), active), {
    kind: "constrain",
    axis: "y",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("z"), active), {
    kind: "constrain",
    axis: "z",
  });
  assert.deepEqual(parseShortcutEvent(editable.plain("Enter"), active), { kind: "confirm" });
  assert.deepEqual(parseShortcutEvent(editable.plain("Escape"), active), { kind: "cancel" });
});

test("parse: F frames; Delete/Backspace delete with selection, no-op without", async () => {
  const { parseShortcutEvent } = await corePromise;
  const sel = { gestureActive: false, hasSelection: true };
  const noSel = { gestureActive: false, hasSelection: false };
  assert.deepEqual(parseShortcutEvent(editable.plain("f"), sel), { kind: "frame" });
  assert.deepEqual(parseShortcutEvent(editable.plain("Delete"), sel), { kind: "delete" });
  assert.deepEqual(parseShortcutEvent(editable.plain("Backspace"), sel), { kind: "delete" });
  assert.equal(parseShortcutEvent(editable.plain("Delete"), noSel), null);
});

test("parse: Ctrl combos — Z undo, Shift+Z redo, Y redo, D duplicate, others no-op", async () => {
  const { parseShortcutEvent } = await corePromise;
  const ctx = { gestureActive: false, hasSelection: true };
  const ctrl = (key, shift = false) => editable.plain(key, { ctrlKey: true, shiftKey: shift });
  assert.deepEqual(parseShortcutEvent(ctrl("z"), ctx), { kind: "undo" });
  assert.deepEqual(parseShortcutEvent(ctrl("z", true), ctx), { kind: "redo" });
  assert.deepEqual(parseShortcutEvent(ctrl("y"), ctx), { kind: "redo" });
  assert.deepEqual(parseShortcutEvent(ctrl("d"), ctx), { kind: "duplicate" });
  assert.equal(parseShortcutEvent(ctrl("c"), ctx), null);
  assert.equal(parseShortcutEvent(ctrl("a"), ctx), null);
});

test("parse: F fires even during a grab (~frame); Enter/Esc don't leak", async () => {
  const { parseShortcutEvent } = await corePromise;
  const active = { gestureActive: true, hasSelection: true };
  assert.deepEqual(parseShortcutEvent(editable.plain("f"), active), { kind: "frame" });
  assert.deepEqual(parseShortcutEvent(editable.plain("Enter"), active), { kind: "confirm" });
  assert.deepEqual(parseShortcutEvent(editable.plain("Escape"), active), { kind: "cancel" });
});

test("grab machine: start/toggle confirm/cancel + tool mapping", async () => {
  const { grabStart, grabToggleAxis, grabConfirm, grabCancel, grabToTool, grabLabel } =
    await corePromise;
  const g = grabStart("move", "tool.select");
  assert.deepEqual(g, { kind: "move", axis: null, prevTool: "tool.select" });
  const on = grabToggleAxis(g, "x");
  assert.equal(on.axis, "x");
  const off = grabToggleAxis(on, "x"); // toggle-off
  assert.equal(off.axis, null);
  assert.deepEqual(grabToggleAxis(g, "y").axis, "y");
  assert.equal(grabConfirm(g), null);
  assert.equal(grabCancel(g), null);
  assert.equal(grabToTool(grabStart("move", "tool.select")), "tool.move");
  assert.equal(grabToTool(grabStart("rotate", "tool.select")), "tool.rotate");
  assert.equal(grabToTool(grabStart("scale", "tool.select")), "tool.scale");
  assert.equal(grabLabel("move"), "move");
  assert.equal(grabLabel("rotate"), "rotate");
  assert.equal(grabLabel("scale"), "scale");
});

test("constrainToAxis: move/rotate/scale semantics", async () => {
  const { constrainToAxis } = await transformPromise;
  const t = { x: 10, y: 20, z: 30, rx: 5, ry: 10, rz: 15, sx: 2, sy: 3, sz: 4 };
  // move X → only x survives
  assert.deepEqual(constrainToAxis(t, "x", "move"), { ...t, y: 0, z: 0 });
  // move Z → only z survives
  assert.deepEqual(constrainToAxis(t, "z", "move"), { ...t, x: 0, y: 0 });
  // rotate Y → only ry survives
  assert.deepEqual(constrainToAxis(t, "y", "rotate"), { ...t, rx: 0, rz: 0 });
  // scale Z → only sz survives, others unit
  assert.deepEqual(constrainToAxis(t, "z", "scale"), { ...t, sx: 1, sy: 1 });
  // free → passthrough
  assert.deepEqual(constrainToAxis(t, null, "move"), t);
});
