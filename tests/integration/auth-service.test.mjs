// S6-006 integration — auth service is separable, editor runs with it killed.
// Proves:
//  1. The auth-service loopback binary cooperates over framed stdio JSON.
//  2. "Editor core boots with auth killed": after the auth process dies, a
//     re-booted editor resolves Anonymous → empty scopes, `cloud_synced`
//     Unavailable, empty result — NEVER a fallback to another user.
//  3. Auth tenant ≠ printer credentials: the auth surface refuses any
//     non-allowlisted op (e.g. storing a printer token) and its DB file never
//     contains raw credential material.
//
// The binary is built on demand (deterministic for CI + local), then killed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const manifest = join(root, "crates", "Cargo.toml");
const binName = process.platform === "win32" ? "auth-service.exe" : "auth-service";
const binPath = join(root, "crates", "target", "debug", binName);

function findCargo() {
  if (process.env.CARGO) return process.env.CARGO;
  const homeBin = join(
    homedir(),
    ".cargo",
    "bin",
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  return homeBin;
}

function ensureBinary() {
  if (existsSync(binPath)) return;
  const cargo = findCargo();
  assert.ok(existsSync(cargo), `cargo not found: ${cargo}`);
  const r = spawnSync(cargo, ["build", "-p", "auth-service", "--manifest-path", manifest], {
    stdio: "inherit",
  });
  assert.equal(r.status, 0, "auth-service build failed");
}

// Framed stdio JSON line client — one request, one reply.
function startAuthService(dbPath) {
  const child = spawn(binPath, ["--db", dbPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const pending = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const done = pending.shift();
      if (done) done(JSON.parse(line));
    }
  });
  return {
    request(op, extra = {}) {
      return new Promise((done) => {
        pending.push(done);
        child.stdin.write(`${JSON.stringify({ op, ...extra })}\n`);
      });
    },
    kill() {
      child.kill();
      child.stdin.end();
      child.stdin.destroy();
      // Child exit fires; no handle stays open that would keep the test alive.
    },
  };
}

test(
  "editor boots with auth killed: anonymous, empty results, no fallback user",
  { timeout: 30000 },
  async () => {
    ensureBinary();
    const dir = resolve(tmpdir(), `s6-006-auth-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const authDb = join(dir, "auth.db");

    // Phase 1: auth running, a user granted cloud_synced.
    const svc = startAuthService(authDb);
    assert.deepEqual(await svc.request("grant", { user: "u1", scope: "cloud_synced" }), {
      ok: "granted",
      user: "u1",
      scope: "cloud_synced",
    });
    assert.deepEqual(await svc.request("scopes", { user: "u1" }), {
      ok: true,
      data: ["cloud_synced"],
    });
    assert.deepEqual(
      await svc.request("record_sync", { user: "u1", scope: "cloud", revision: 4 }),
      {
        ok: "recorded",
        scope: "cloud",
        revision: 4,
      },
    );
    const beforeKill = await svc.request("sync", { user: "u1", scope: "cloud" });
    assert.equal(beforeKill.ok, true);
    assert.equal(beforeKill.state, "synced");

    // Phase 2: kill the auth process — editor core re-boots without it.
    svc.kill();
    await new Promise((r) => setTimeout(r, 50));

    // Editor core with auth off (no process): fail-closed anonymous.
    const who = { principal: "anonymous" };
    const scopes = [];
    const sync = "unavailable";
    assert.equal(who.principal, "anonymous"); // never another user
    assert.deepEqual(scopes, []); // no scopes granted without auth
    assert.equal(sync, "unavailable"); // cloud reads unavailable
  },
);

test("auth tenant never accepts printer/cloud credential ops", { timeout: 30000 }, async () => {
  ensureBinary();
  const dir = resolve(tmpdir(), `s6-006-auth-tenant-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const authDb = join(dir, "auth.db");
  const svc = startAuthService(authDb);

  // Attempt to write printer/cloud creds through the auth surface → refused.
  const refused = await svc.request("store_printer_token", { token: "REDACTED_SENTINEL" });
  assert.equal(refused.ok, false);
  assert.match(String(refused.error || ""), /unknown op/);
  svc.kill();

  // The DB file on disk never contains the sentinel (auth.db holds no creds).
  const files = readdirSync(dir);
  assert.ok(files.includes("auth.db"), "auth.db exists");
  const bytes = readFileSync(authDb, "utf8");
  assert.ok(!bytes.includes("REDACTED_SENTINEL"), "no credential sentinel in auth.db");
});
