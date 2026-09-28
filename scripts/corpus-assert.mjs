// S7-003 parity corpus assertions — shared between the live runner
// (scripts/corpus-runner.mjs) and the unit test (tests/corpus-assert.test.mjs).
// Pure functions, no I/O: a CI node test covers the invariant logic without
// needing Blender, while `pnpm run corpus` executes it against the pinned
// install (SKIP-with-journal when absent — never false-green).

/**
 * Compare worker results against the recorded baseline (expected.json -> baseline.ops).
 * @param {Array<{op: string, hash: string, sel: object, verts: number, polys: number}>} results
 * @param {Record<string, {hash: string, sel: object, verts: number, polys: number}>} expectedOps
 * @returns {string[]} human-readable failures (empty == parity)
 */
export function compareCorpus(results, expectedOps) {
  const failures = [];
  for (const res of results) {
    const exp = expectedOps[res.op];
    if (!exp) {
      failures.push(`${res.op}: no baseline`);
      continue;
    }
    if (res.hash !== exp.hash) {
      failures.push(`${res.op}: hash mismatch\n  expected ${exp.hash}\n  got      ${res.hash}`);
    }
    if (res.sel?.mode !== exp.sel?.mode) {
      failures.push(`${res.op}: selection mode mismatch`);
    }
    if (res.verts !== exp.verts || res.polys !== exp.polys) {
      failures.push(
        `${res.op}: mesh size mismatch (${res.verts}v/${res.polys}p vs ${exp.verts}v/${exp.polys}p)`,
      );
    }
    // Selection invariant: after a topology op (esp. delete) the recorded
    // selection must not reference deleted/absent elements — stale indices
    // (>= current vert count) fail here.
    if (res.sel?.mode === "edit") {
      const stale = (res.sel.verts ?? []).filter((i) => i >= res.verts);
      if (stale.length) {
        failures.push(`${res.op}: stale selection references deleted verts ${stale.slice(0, 10)}`);
      }
    }
  }
  return failures;
}

/**
 * Extract the numeric core of a Blender version ("5.2.2 LTS" -> "5.2.2").
 * Mirrors crates/blender-bridge/src/discovery.rs numeric_core.
 */
export function numericCore(v) {
  return v
    .split(/[^0-9.]+/)
    .filter((s) => s !== "")
    .slice(0, 3)
    .join(".");
}
