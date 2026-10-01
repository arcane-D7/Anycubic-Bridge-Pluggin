import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

/**
 * S9.8-001 shared context menu — headless core + item builders.
 *
 * The React component (ContextMenu.tsx) is a thin portal shell; the
 * deterministic logic lives in context-menu-core / context-menu-items so it
 * runs under `node --test` without mounting DOM:
 *
 *   - openContextMenuAt clamps pointer coords into the window viewport,
 *     keeping the whole estimated menu visible (AC: keyboard operable).
 *   - buildObjectMenuItems covers every object-tree action and only offers
 *     repair when the object is non-watertight.
 *   - buildPlateMenuItems offers duplicate/rename + move targets.
 *   - journalMenuItems seeks the revision / resets to head.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "components", "context-menu-core.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

async function loadItems() {
  const url = pathToFileURL(
    path.join(root, "apps", "editor", "src", "components", "context-menu-items.ts"),
  );
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();
const itemsPromise = loadItems();

test("openContextMenuAt: clamps near the right/bottom edge", async () => {
  const core = await corePromise;
  // Menu ≈8 items × 32px + margin = 264px tall, 220px wide; viewport 400×300.
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: `i${i}`,
    label: `I${i}`,
    onSelect: () => {},
  }));
  const vp = { width: 400, height: 300 };
  const s = core.openContextMenuAt({ clientX: 390, clientY: 295 }, items, vp);
  assert.ok(s.x <= vp.width - core.CONTEXT_MENU_EST_WIDTH - core.CONTEXT_MENU_MARGIN + 0.001);
  assert.ok(s.y <= vp.height - 8 * core.CONTEXT_MENU_EST_HEIGHT - core.CONTEXT_MENU_MARGIN + 0.001);
  assert.equal(s.items.length, items.length);
});

test("openContextMenuAt: stays inside a small viewport (no negative coords)", async () => {
  const core = await corePromise;
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: `i${i}`,
    label: `I${i}`,
    onSelect: () => {},
  }));
  const s = core.openContextMenuAt({ clientX: 1000, clientY: 1000 }, items, {
    width: 200,
    height: 150,
  });
  assert.ok(s.x >= core.CONTEXT_MENU_MARGIN);
  assert.ok(s.y >= core.CONTEXT_MENU_MARGIN);
  assert.ok(s.x <= 200 - core.CONTEXT_MENU_MARGIN);
});

test("openContextMenuAt: center clicks stay put", async () => {
  const core = await corePromise;
  const items = [{ id: "a", label: "A", onSelect: () => {} }];
  const s = core.openContextMenuAt({ clientX: 640, clientY: 360 }, items, {
    width: 1280,
    height: 720,
  });
  assert.equal(s.x, 640);
  assert.equal(s.y, 360);
});

test("buildObjectMenuItems: full action set + repair only when non-watertight", async () => {
  const items = await itemsPromise;
  const calls = { dup: 0, ren: 0, vis: 0, place: 0, rep: [], rem: 0 };
  const menu = items.buildObjectMenuItems(
    { name: "cone", visible: true, watertight: false },
    {
      onDuplicate: () => calls.dup++,
      onRename: () => calls.ren++,
      onToggleVisible: () => calls.vis++,
      onPlaceOnPlate: () => calls.place++,
      onRepair: (m) => calls.rep.push(m),
      onRemove: () => calls.rem++,
    },
  );
  const ids = menu.map((i) => i.id);
  assert.deepEqual(ids, [
    "duplicate",
    "rename",
    "toggle-visible",
    "place-on-plate",
    "repair-replace",
    "repair-copy",
    "delete",
  ]);
  assert.equal(menu.find((i) => i.id === "delete")?.danger, true);
  assert.equal(menu.find((i) => i.id === "repair-replace")?.separatorBefore, true);

  // Trigger the repair + delete handlers.
  menu.find((i) => i.id === "repair-copy")?.onSelect();
  menu.find((i) => i.id === "delete")?.onSelect();
  assert.deepEqual(calls.rep, ["copy"]);
  assert.equal(calls.rem, 1);
});

test("buildObjectMenuItems: watertight objects get no repair entries", async () => {
  const items = await itemsPromise;
  const menu = items.buildObjectMenuItems(
    { name: "cube", visible: false, watertight: true },
    {
      onDuplicate: () => {},
      onRename: () => {},
      onToggleVisible: () => {},
      onPlaceOnPlate: () => {},
      onRepair: () => {},
      onRemove: () => {},
    },
  );
  const ids = menu.map((i) => i.id);
  assert.ok(!ids.includes("repair-replace"));
  assert.ok(!ids.includes("repair-copy"));
  assert.equal(menu.find((i) => i.id === "toggle-visible")?.label, "Show");
});

test("buildPlateMenuItems: duplicate/rename + move targets", async () => {
  const items = await itemsPromise;
  const menu = items.buildPlateMenuItems(
    [
      { id: "p2", name: "Plate 2", disabled: true },
      { id: "p3", name: "Support", disabled: false },
    ],
    { onDuplicate: () => {}, onRename: () => {}, onMoveTo: () => {} },
  );
  const ids = menu.map((i) => i.id);
  assert.deepEqual(ids, [
    "plate-dup",
    "plate-rename",
    "plate-move-header",
    "plate-move-p2",
    "plate-move-p3",
  ]);
  assert.equal(menu.find((i) => i.id === "plate-move-p2")?.disabled, true);
  assert.equal(menu.find((i) => i.id === "plate-move-p3")?.disabled, false);
  assert.equal(menu.find((i) => i.id === "plate-move-header")?.separatorBefore, true);
});

test("buildPlateMenuItems: no move targets → no move section", async () => {
  const items = await itemsPromise;
  const menu = items.buildPlateMenuItems([], {
    onDuplicate: () => {},
    onRename: () => {},
    onMoveTo: () => {},
  });
  assert.deepEqual(
    menu.map((i) => i.id),
    ["plate-dup", "plate-rename"],
  );
});

test("journalMenuItems: seek + reset disabled at head", async () => {
  const core = await corePromise;
  const calls = { seek: [], reset: 0 };
  const menu = core.journalMenuItems({
    revision: 3,
    atHead: true,
    onSeek: (r) => calls.seek.push(r),
    onReset: () => calls.reset++,
  });
  assert.deepEqual(
    menu.map((i) => i.id),
    ["seek-3", "journal-reset"],
  );
  assert.equal(menu[0]?.disabled, true);
  assert.equal(menu[1]?.disabled, true);
});

test("journalMenuItems: while at an older revision both stay enabled", async () => {
  const core = await corePromise;
  const calls = { seek: [], reset: 0 };
  const menu = core.journalMenuItems({
    revision: 2,
    atHead: false,
    onSeek: (r) => calls.seek.push(r),
    onReset: () => calls.reset++,
  });
  assert.equal(menu[0]?.disabled, false);
  menu[0]?.onSelect();
  menu[1]?.onSelect();
  assert.deepEqual(calls.seek, [2]);
  assert.equal(calls.reset, 1);
});
