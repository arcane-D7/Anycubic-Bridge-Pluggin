// check-rust.mjs — S6-002.
// Runs `cargo check` + `cargo test` on the crates workspace without assuming
// cargo is on PATH. Resolves cargo via CARGO env, ~/.cargo/bin, or PATH.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const manifest = join(root, "crates", "Cargo.toml");

function findCargo() {
  if (process.env.CARGO) return process.env.CARGO;
  const homeBin = join(
    homedir(),
    ".cargo",
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  if (existsSync(homeBin)) return homeBin;
  return "cargo"; // trust PATH (CI images install rustup)
}

const cargo = findCargo();
if (!existsSync(manifest)) {
  console.error(`[check-rust] manifest not found: ${manifest}`);
  process.exit(2);
}

const run = (args) => {
  const r = spawnSync(cargo, args, { stdio: "inherit", shell: false });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
};

console.log(`[check-rust] using cargo: ${cargo}`);
run(["check", "--workspace", "--manifest-path", manifest]);
run(["test", "--workspace", "--manifest-path", manifest]);
console.log("[check-rust] OK — cargo check + test passed");
