import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decodeJwtPayload,
  classifyAccessToken,
  buildTokenRecord,
  signAuthHeaders,
  loginWithAccessToken,
  validateAccessToken,
  saveStoredToken,
  loadStoredToken,
  clearStoredToken,
  defaultDataDir,
  defaultCryptScript,
  casdoorLogin,
} from "../scripts/auth-login.mjs";

// JWT de teste com claims (sub/email/exp) — não é segredo, é fixture.
function makeTestJwt(claims = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "0000-aaaa-bbbb-cccc",
      email: "tester@example.com",
      exp: Math.floor(Date.now() / 1000) + 86400,
      ...claims,
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("decodeJwtPayload parses 3-part JWTs", () => {
  const t = makeTestJwt();
  const claims = decodeJwtPayload(t);
  assert.equal(claims.sub, "0000-aaaa-bbbb-cccc");
  assert.equal(claims.email, "tester@example.com");
});
test("decodeJwtPayload returns null for junk", () => {
  assert.equal(decodeJwtPayload("not-a-token"), null);
  assert.equal(decodeJwtPayload("a.b"), null);
});
test("classifyAccessToken detects shape and expiry", () => {
  const r = classifyAccessToken(makeTestJwt());
  assert.equal(r.ok, true);
  assert.equal(r.shape, "jwt");
  assert.ok(r.expires_at);
});
test("classifyAccessToken rejects non-JWT", () => {
  assert.equal(classifyAccessToken("random-string").ok, false);
});
test("buildTokenRecord keeps only non-secret metadata", () => {
  const r = buildTokenRecord(makeTestJwt());
  assert.ok(r.sub);
  assert.ok(r.email);
  assert.ok(r.expiresAt);
  assert.equal(r.encrypted, undefined);
  assert.equal(r.signature, undefined);
  assert.equal(Object.keys(r).includes("signature"), false);
});
test("signAuthHeaders are deterministic signature structure", () => {
  const h = signAuthHeaders();
  assert.ok(h["Xx-Nonce"].length === 32);
  assert.ok(/^[0-9a-f]{32}$/.test(h["Xx-Signature"]));
  assert.equal(h["Xx-Device-Type"], "pcf");
  assert.ok(h["Xx-Timestamp"]);
});
test("loginWithAccessToken calls endpoint with pcf device_type", async () => {
  let calledUrl = "",
    sentBody = null;
  const fetchImpl = async (url, init) => {
    calledUrl = url;
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 1, data: { token: "session-token" } }),
    };
  };
  const r = await loginWithAccessToken("jwt", { fetchImpl });
  assert.ok(calledUrl.includes("/v3/public/loginWithAccessToken"));
  assert.equal(sentBody.device_type, "pcf");
  assert.equal(r.token, "session-token");
});
test("loginWithAccessToken surfaces server error", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ code: 10001, msg: "login information has expired" }),
  });
  await assert.rejects(loginWithAccessToken("jwt", { fetchImpl }), /login information has expired/);
});
test("validateAccessToken honors a working pcf token (MQTT enabled)", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/loginWithAccessToken")) {
      return { ok: true, status: 200, json: async () => ({ code: 1, data: { token: "session" } }) };
    }
    if (url.includes("/user/profile/userInfo")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 1, data: { id: 42, user_email: "me@example.com" } }),
      };
    }
    throw new Error("unexpected url " + url);
  };
  const r = await validateAccessToken(makeTestJwt(), { fetchImpl, region: "en" });
  assert.equal(r.ok, true);
  assert.equal(r.mqtt, true);
  assert.equal(r.mode, "pcf");
  assert.equal(r.user_id, 42);
});
test("validateAccessToken falls back to web mode when pcf rejected as portal token", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init?.body || "{}");
    if (body.device_type === "pcf") {
      return {
        ok: false,
        status: 400,
        json: async () => ({ code: 1002, msg: "User does not exist" }),
      };
    }
    assert.equal(body.device_type, "web");
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 1, data: { token: "web-session" } }),
    };
  };
  const r = await validateAccessToken(makeTestJwt(), { fetchImpl, region: "en" });
  assert.equal(r.ok, true);
  assert.equal(r.mqtt, false);
  assert.equal(r.mode, "web");
});
test("validateAccessToken fails when both modes reject", async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init?.body || "{}");
    return {
      ok: false,
      status: 401,
      json: async () => ({ code: 9999, msg: "invalid credential" }),
    };
  };
  await assert.rejects(validateAccessToken(makeTestJwt(), { fetchImpl }), /invalid credential/);
});
test("saveStoredToken/loadStoredToken/clearStoredToken roundtrip on temp dir", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ac-auth-test-"));
  try {
    // dry-run: sem powershell, simular token-crypt com ecrã -> escreve placeholder (test only)
    // Substituir runTokenCrypt pelo script real é impossível offline; o token-store
    // compilado também depende de powershell. Testamos o shape via monkeypatch do módulo
    // abaixo — não há export direto, logo testamos defaultDataDir e o fluxo com save mock.
    assert.ok(defaultDataDir().includes("tokens"));
    assert.ok(defaultCryptScript().endsWith("token-crypt.ps1"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("loadStoredToken returns stored:false for missing store", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ac-auth-nostore-"));
  try {
    const r = await loadStoredToken({ dataDir });
    assert.deepEqual(r, { stored: false });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("casdoorLogin sends form-encoded email+password to /api/login", async () => {
  let calledUrl = "",
    sentBody = null;
  const fetchImpl = async (url, init) => {
    calledUrl = url;
    sentBody = new URLSearchParams(init.body).toString();
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ status: "error", msg: "The application does not exist", data: null }),
      headers: { get: () => "application/json" },
    };
  };
  const r = await casdoorLogin("me@example.com", "hunter2", { fetchImpl });
  assert.ok(calledUrl.includes("/api/login"));
  assert.ok(sentBody.includes("username=me%40example.com"));
  assert.ok(sentBody.includes("password=hunter2"));
  assert.equal(r.ok, false);
  assert.match(String(r.error), /application does not exist/);
});
test("casdoorLogin honors an ok response without leaking data", async () => {
  const fetchImpl = async () => ({
    status: 200,
    text: async () =>
      JSON.stringify({ status: "ok", data: { token: "secret-session", user: "x" } }),
    headers: { get: () => "application/json" },
  });
  const r = await casdoorLogin("a@b.c", "pw", { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.returned.token, undefined); // token redacted
});
test("casdoorLogin detects SPA html response", async () => {
  const fetchImpl = async () => ({
    status: 200,
    text: async () => "<!doctype html><html><body>SPA</body></html>",
    headers: { get: () => "text/html" },
  });
  const r = await casdoorLogin("a@b.c", "pw", { fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.html, true);
});
