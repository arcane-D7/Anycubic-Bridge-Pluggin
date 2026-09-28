// S7-003 parity corpus assertion unit tests — pure logic, no Blender needed.
// The live runner (pnpm run corpus) exercises the same compareCorpus against
// the pinned install; this test proves the invariant logic itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { compareCorpus, numericCore } from "../scripts/corpus-assert.mjs";

const h = "a".repeat(64);

function res(op, { hash = h, verts = 100, polys = 100, sel = { mode: "object", names: [] } } = {}) {
  return { op, hash, verts, polys, sel };
}

test("corpus: identical results → zero failures", () => {
  const results = [res("op1"), res("op2")];
  const expected = {
    op1: { hash: h, verts: 100, polys: 100, sel: { mode: "object", names: [] } },
    op2: { hash: h, verts: 100, polys: 100, sel: { mode: "object", names: [] } },
  };
  assert.deepEqual(compareCorpus(results, expected), []);
});

test("corpus: hash mismatch reported", () => {
  const results = [res("op1", { hash: "b".repeat(64) })];
  const expected = { op1: { hash: h, verts: 100, polys: 100, sel: { mode: "object", names: [] } } };
  const failures = compareCorpus(results, expected);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /hash mismatch/);
});

test("corpus: missing baseline op reported", () => {
  const results = [res("op_new")];
  const failures = compareCorpus(results, {});
  assert.match(failures[0], /no baseline/);
});

test("corpus: stale selection after delete fails (deleted vert referenced)", () => {
  // edit-mode selection references index 99 but the mesh now has only 50 verts
  const results = [
    res("delete_op", {
      verts: 50,
      polys: 40,
      sel: { mode: "edit", object: "Mesh", verts: [1, 25, 99] },
    }),
  ];
  const expected = {
    delete_op: {
      hash: h,
      verts: 50,
      polys: 40,
      sel: { mode: "edit", object: "Mesh", verts: [1, 25, 99] },
    },
  };
  const failures = compareCorpus(results, expected);
  assert.ok(failures.length >= 1, "stale selection must fail");
  assert.match(failures[0], /stale selection references deleted verts/);
});

test("corpus: valid edit selection passes invariant", () => {
  const results = [
    res("sel_op", {
      verts: 50,
      polys: 40,
      sel: { mode: "edit", object: "Mesh", verts: [1, 25, 49] },
    }),
  ];
  const expected = {
    sel_op: {
      hash: h,
      verts: 50,
      polys: 40,
      sel: { mode: "edit", object: "Mesh", verts: [1, 25, 49] },
    },
  };
  assert.deepEqual(compareCorpus(results, expected), []);
});

test("corpus: mesh size mismatch reported", () => {
  const results = [res("op1", { verts: 120 })];
  const expected = { op1: { hash: h, verts: 100, polys: 100, sel: { mode: "object", names: [] } } };
  const failures = compareCorpus(results, expected);
  assert.match(failures[0], /mesh size mismatch/);
});

test("corpus: version numeric core extraction", () => {
  assert.equal(numericCore("5.2.2 LTS"), "5.2.2");
  assert.equal(numericCore("4.3.0 Beta"), "4.3.0");
  assert.equal(numericCore("5.2.2"), "5.2.2");
});
