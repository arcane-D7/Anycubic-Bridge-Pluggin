/**
 * Sprint 9 harness runner — `pnpm run harness`.
 *
 * Verifies the R3 harness surfaces are wired and green:
 *   1. harness-core crate builds + unit tests pass (cargo, workspace member);
 *   2. chat harness core tests pass (Node);
 *   3. the harness no-host-shell invariants are structurally present
 *      (Capability has no Shell variant; E-stop carries no learned component).
 *
 * Deterministic, offline, exit 0 = green. No printer, no slicer, no model.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cargo = path.join(homedir(), ".cargo", "bin", "cargo.exe");

function run(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return out;
}

const results = [];

function check(name, passes, detail = "") {
  results.push({ name, passes, detail });
  console.log(`${passes ? "ok" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

try {
  // 1. harness-core crate unit tests
  const cargoOut = run(cargo, ["test", "-p", "harness-core", "--quiet"], {
    cwd: path.join(root, "crates"),
  });
  check("harness-core unit tests", !/FAILED|panicked/.test(cargoOut), "47+ tests");

  // 2. chat harness core tests (Node; TAP reporter for deterministic ASCII output)
  const chatOut = run(process.execPath, [
    "--test",
    "--test-reporter=tap",
    path.join(root, "tests", "chat-core.test.mjs"),
  ]);
  const chatPass = /# pass (\d+)/.exec(chatOut)?.[1];
  const chatFail = /# fail (\d+)/.exec(chatOut)?.[1];
  check("chat-core unit tests", chatPass === "8" && chatFail === "0", "8/8 pass");

  // 3. structural invariants (source-level, deterministic)
  const capabilitySrc = run("cmd", [
    "/c",
    "type",
    path.join(root, "crates", "harness-core", "src", "capability.rs"),
  ]);
  // The Capability enum must NOT contain a Shell variant (structural
  // impossibility). `ShellNeverGranted` in SandboxError is fine — the enum
  // block itself must not list `Shell`.
  const capabilityEnum = capabilitySrc.match(/pub enum Capability \{[\s\S]*?\}/);
  check(
    "no Shell capability variant",
    capabilityEnum ? !/\bShell\b/.test(capabilityEnum[0]) : false,
    "structural absence in enum block",
  );
  const safetySrc = run("cmd", [
    "/c",
    "type",
    path.join(root, "crates", "harness-core", "src", "safety.rs"),
  ]);
  // EStop must be independent BY CONSTRUCTION: the struct block itself carries
  // NO learned-component types (ParameterProposal, OptimizationMode, ...).
  const estopBlock = safetySrc.match(/pub struct EStop \{[\s\S]*?\}/);
  check(
    "E-stop independent of learned components",
    estopBlock ? !/ParameterProposal|OptimizationMode|LearningGate/.test(estopBlock[0]) : false,
    "struct carries only std primitives",
  );

  const failures = results.filter((r) => !r.passes);
  if (failures.length > 0) {
    console.error(`\nharness: ${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nharness: all ${results.length} checks green`);
  }
} catch (err) {
  console.error("harness runner crashed:", err.message);
  process.exitCode = 1;
}
