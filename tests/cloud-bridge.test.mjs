import assert from "node:assert/strict";
import { after, test } from "node:test";
import { startCloudBridge } from "../scripts/cloud-bridge.mjs";

let calls = 0;
let nextReply;
let nextError;
const client = {
  async callTool(request) {
    calls += 1;
    if (nextError) {
      const error = nextError;
      nextError = null;
      throw error;
    }
    if (nextReply) {
      const reply = nextReply;
      nextReply = null;
      return reply;
    }
    if (request.name === "account_login") {
      assert.deepEqual(request.arguments, { region: "en", timeout_ms: 15_000 });
      return {
        structuredContent: {
          ok: true,
          region: "en",
          token: "session-secret",
          access_token: "access-secret",
          user_email: "private@example.invalid",
          nested: { key: "private-key" },
        },
      };
    }
    return { structuredContent: { ok: true, diagnostic: { response: { data: {} } } } };
  },
};

const bridge = await startCloudBridge({ port: 0, client });
after(async () => bridge.close());

async function postLogin(body) {
  return fetch(`${bridge.url}/printer/cloud/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("login accepts only region and bounded timeout, and returns a safe projection", async () => {
  const response = await postLogin(JSON.stringify({}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, region: "en" });
});

test("login rejects non-object JSON and credential or unknown fields before MCP", async () => {
  for (const body of [
    "null",
    "[]",
    '"text"',
    '{"access_token":"secret"}',
    '{"password":"secret"}',
    '{"other":true}',
  ]) {
    const before = calls;
    const response = await postLogin(body);
    assert.equal(response.status, 400);
    assert.equal(calls, before);
  }
});

test("login validates region and finite bounded timeout", async () => {
  for (const body of [
    { region: "xx" },
    { timeout_ms: 499 },
    { timeout_ms: 30_001 },
    { timeout_ms: 1000.5 },
    { timeout_ms: "1000" },
  ]) {
    const before = calls;
    const response = await postLogin(JSON.stringify(body));
    assert.equal(response.status, 400);
    assert.equal(calls, before);
  }
});

test("unsupported writer routes and rejected origins stop before MCP", async () => {
  const before = calls;
  const writer = await fetch(`${bridge.url}/printer/cloud/control/print`, { method: "POST" });
  assert.equal(writer.status, 404);
  assert.deepEqual(await writer.json(), { ok: false, error: "not found" });

  const denied = await fetch(`${bridge.url}/printer/cloud/login`, {
    method: "POST",
    headers: { Origin: "https://untrusted.invalid", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { ok: false, error: "origin not allowed" });
  assert.equal(calls, before);
});

test("upstream login tool failures never expose credential text", async () => {
  nextReply = {
    isError: true,
    content: [{ type: "text", text: "access_token=access-secret password=session-secret" }],
  };
  const toolFailure = await postLogin("{}");
  assert.equal(toolFailure.status, 502);
  assert.deepEqual(await toolFailure.json(), { ok: false, error: "cloud login failed" });
});

test("snapshot accepts only valid positive ids and known read-only diagnostic kinds", async () => {
  const valid = await fetch(
    `${bridge.url}/printer/cloud/snapshot?printerId=42&kind=printer_info&region=en`,
  );
  assert.equal(valid.status, 200);
  for (const query of [
    "printerId=0",
    "printerId=-1",
    "printerId=1.5",
    "printerId=9007199254740992",
    "printerId=42&kind=printer_print_start",
    "printerId=42&kind=printer_info&extra=secret",
  ]) {
    const before = calls;
    const response = await fetch(`${bridge.url}/printer/cloud/snapshot?${query}`);
    assert.equal(response.status, 400);
    assert.equal(calls, before);
  }
});

test("snapshot diagnostics redact nested credentials and URL values", async () => {
  nextReply = {
    structuredContent: {
      ok: true,
      diagnostic: {
        access_token: "access-secret",
        nested: { password: "session-secret", download_url: "https://private.invalid/file" },
      },
    },
  };
  const response = await fetch(`${bridge.url}/printer/cloud/snapshot?printerId=42`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    diagnostic: {
      access_token: "[redacted]",
      nested: { password: "[redacted]", download_url: "[redacted]" },
    },
  });
});

test("login exceptions never expose upstream exception text", async () => {
  nextError = new Error("request failed with access_token=access-secret");
  const exception = await postLogin("{}");
  assert.equal(exception.status, 502);
  assert.deepEqual(await exception.json(), { ok: false, error: "cloud login failed" });
});
