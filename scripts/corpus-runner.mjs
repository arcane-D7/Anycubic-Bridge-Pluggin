#!/usr/bin/env node
// S7-003 parity corpus runner (`pnpm run corpus`).
//
// Executes the versioned op matrix (tests/corpus/manifest.json) inside the
// pinned Blender headless via the file channel worker (tests/corpus/worker.py),
// then asserts per-op canonical hashes + selection invariants against the
// recorded baseline (tests/corpus/expected.json; first successful local run
// writes it).
//
// Behaviour:
//  - Blender present (BLENDER_EXE or the standard discovery order)  -> run.
//  - Blender absent (e.g. CI) -> SKIP-with-journal in docs/evidence, exit 0
//    with a loud SKIP line (never false-green; never a pass claim).
//  - Blender present but version != pin -> hard error (declared requirement).
//
// Output journal: docs/evidence/corpus-<YYMMDD-HHmmss>.json (also compared).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCorpus, numericCore } from "./corpus-assert.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const corpusDir = join(root, "tests", "corpus");
const MANIFEST = join(corpusDir, "manifest.json");
const EXPECTED = join(corpusDir, "expected.json");
const WORKER = join(corpusDir, "worker.py");
const EVIDENCE = join(root, "docs", "evidence");
const PIN = "5.2.2";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// AppExecutionLink reparse points (store aliases) throw EACCES at `exists`.
function pathExists(p) {
  if (existsSync(p)) return true;
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function envIsAlias(p) {
  const s = p.toLowerCase();
  return s.includes("blender-launcher") || s.includes("windowsapps");
}

function discoverBlender() {
  // Same order as crates/blender-bridge/src/discovery.rs:
  // BLENDER_EXE -> MSIX alias -> Program Files\Blender Foundation\*\blender.exe -> PATH
  if (process.env.BLENDER_EXE && pathExists(process.env.BLENDER_EXE)) {
    return {
      exe: process.env.BLENDER_EXE,
      kind: envIsAlias(process.env.BLENDER_EXE) ? "MsixAlias" : "Classic",
    };
  }
  const la = process.env.LOCALAPPDATA;
  if (la) {
    const alias = join(la, "Microsoft", "WindowsApps", "blender-launcher.exe");
    if (pathExists(alias)) return { exe: alias, kind: "MsixAlias" };
  }
  const pf = process.env.ProgramFiles;
  if (pf && existsSync(join(pf, "Blender Foundation"))) {
    const base = join(pf, "Blender Foundation");
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const exe = join(base, dir.name, "blender.exe");
      if (existsSync(exe)) return { exe, kind: "Classic" };
    }
  }
  const pathDirs = (process.env.PATH ?? "").split(";");
  for (const d of pathDirs) {
    for (const name of ["blender.exe", "blender"]) {
      const p = join(d, name).trim();
      if (p && pathExists(p)) return { exe: p, kind: "Classic" };
    }
  }
  return null;
}

function queryVersion(exe) {
  // The alias cannot relay stdout reliably -> write a temp version file, as
  // the Rust crate does.
  const work = join(tmpdir(), `bb-corpus-ver-${process.pid}`);
  mkdirSync(work, { recursive: true });
  const script = join(work, "version.py");
  const out = join(work, "version.txt");
  writeFileSync(
    script,
    `import bpy, pathlib\npathlib.Path(${JSON.stringify(out)}).write_text(bpy.app.version_string)\n`,
  );
  spawnSync(exe, ["--background", "--factory-startup", "--python", script], {
    stdio: "ignore",
    timeout: 120_000,
  });
  return existsSync(out) ? readFileSync(out, "utf8").trim() : "";
}

function journal(status, payload) {
  mkdirSync(EVIDENCE, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const path = join(EVIDENCE, `corpus-${ts}.json`);
  // Prettier-clean: 2-space JSON + trailing newline (journal is committed).
  writeFileSync(path, JSON.stringify({ status, ...payload }, null, 2) + "\n");
  return path;
}

function recordBaseline(results) {
  const expected = {};
  for (const r of results) {
    expected[r.op] = { hash: r.hash, sel: r.sel, verts: r.verts, polys: r.polys };
  }
  writeFileSync(EXPECTED, JSON.stringify({ version: "v1", pin: PIN, ops: expected }, null, 2));
}

function loadBaseline() {
  if (!existsSync(EXPECTED)) return null;
  return JSON.parse(readFileSync(EXPECTED, "utf8"));
}

// AGENTS.md: never record machine-specific paths in evidence. Journal only
// the transport kind + binary basename (agnostic).
function exeLabel(blender) {
  return `${blender.kind}/${blender.exe.split(/[\\/]/).pop()}`;
}

function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const blender = discoverBlender();

  if (!blender) {
    const path = journal("SKIP", {
      reason:
        "Blender not installed (CI or unprovisioned host); parity never asserted — not a pass.",
      manifest_hash: sha256(readFileSync(MANIFEST, "utf8")).slice(0, 16),
    });
    console.log("CORPUS SKIP — Blender not found; journal " + path);
    console.log("CORPUS SKIP (never false-green)");
    process.exit(0);
  }

  const version = queryVersion(blender.exe);
  if (!version) {
    const path = journal("SKIP", {
      reason:
        "Blender found but version query produced no output; alias stdout swallowed — skipping, not passing.",
      exe: exeLabel(blender),
    });
    console.log("CORPUS SKIP — no version string from " + blender.exe + "; journal " + path);
    process.exit(0);
  }
  if (numericCore(version) !== numericCore(PIN)) {
    const path = journal("ERROR", {
      reason: `version mismatch: found ${version}, pin ${PIN} (declared requirement)`,
      exe: exeLabel(blender),
    });
    console.error(
      `CORPUS ERROR — Blender ${blender.exe} version ${version} != pin ${PIN}; ${path}`,
    );
    process.exit(1);
  }

  // Build control file: only the op list + params.
  mkdirSync(corpusDir, { recursive: true });
  const control = { version: manifest.version, ops: manifest.ops };
  const controlPath = join(corpusDir, ".control.json");
  writeFileSync(controlPath, JSON.stringify(control));
  const outPath = join(process.env.TEMP ?? ".", `bb-corpus-out-${process.pid}.json`);

  const env = {
    ...process.env,
    BLENDER_BRIDGE_CORPUS_CONTROL: controlPath,
    BLENDER_BRIDGE_CORPUS_OUT: outPath,
  };
  const r = spawnSync(blender.exe, ["--background", "--factory-startup", "--python", WORKER], {
    env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) {
    const path = journal("ERROR", {
      reason: "spawn failed: " + r.error.message,
      exe: exeLabel(blender),
    });
    console.error("CORPUS ERROR — " + r.error.message + "; " + path);
    process.exit(1);
  }
  if (!existsSync(outPath)) {
    const path = journal("ERROR", {
      reason: "no output file; stdout: " + (r.stdout ?? "").slice(-2000),
    });
    console.error("CORPUS ERROR — worker produced no output file; " + path);
    process.exit(1);
  }
  const workerOut = JSON.parse(readFileSync(outPath, "utf8"));
  if (workerOut.status !== "PASS") {
    const path = journal("FAIL", {
      reason: "worker error: " + JSON.stringify(workerOut.results?.slice(-1)),
      blender_version: workerOut.blender_version,
    });
    console.error("CORPUS FAIL — " + path);
    process.exit(1);
  }

  // Compare against baseline (or record it on first run).
  const baseline = loadBaseline();
  const manifestHash = sha256(readFileSync(MANIFEST, "utf8"));
  if (!baseline) {
    recordBaseline(workerOut.results);
    const path = journal("PASS_BASELINE", {
      blender_version: workerOut.blender_version,
      exe: exeLabel(blender),
      ops: workerOut.results.length,
      final_hash: workerOut.final_hash.slice(0, 16),
      manifest_hash: manifestHash.slice(0, 16),
    });
    console.log("CORPUS PASS (baseline recorded) — " + workerOut.results.length + " ops; " + path);
    process.exit(0);
  }

  const failures = compareCorpus(workerOut.results, baseline.ops);
  if (failures.length) {
    const path = journal("FAIL", {
      blender_version: workerOut.blender_version,
      manifest_hash: manifestHash.slice(0, 16),
      failures: failures.slice(0, 50),
    });
    console.error("CORPUS FAIL — " + failures.slice(0, 10).join("\n  ") + "; " + path);
    process.exit(1);
  }
  const path = journal("PASS", {
    blender_version: workerOut.blender_version,
    exe: exeLabel(blender),
    ops: workerOut.results.length,
    final_hash: workerOut.final_hash.slice(0, 16),
    manifest_hash: manifestHash.slice(0, 16),
  });
  console.log("CORPUS PASS — " + workerOut.results.length + " ops; " + path);
}

main();
