// S9.6-008 — broker chat-transport selector, pure helpers (headless).
// Proves:
//   1. `brokerLaneConfiguredFrom` gates the lane on a VALID loopback http(s)
//      env value (S9.18-001: a malformed/external value is "configured but
//      invalid" → unavailable, NOT a lane).
//   2. `brokerChatUrlFrom` derives the endpoint: base URL → `<base>/chat`,
//      trailing slash → `<base>/chat`, explicit `/chat` URL → as-is, blank or
//      INVALID → empty (no magic default; env is authority — zero provider
//      URLs here; the webview never reaches external hosts directly).
//   3. `brokerProviderStatusUrlFrom` derives the public-safe status URI,
//      "" for unset/invalid lanes.
//   4. The module imports cleanly under Node (no `import.meta.env` at
//      top-level and the mock core chain is headless).

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transportUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "bridge", "chat-transport.ts"),
);

const transport = await import(`${transportUrl.href}?key=${Date.now()}`);
const {
  brokerLaneConfiguredFrom,
  brokerChatUrlFrom,
  brokerProviderStatusUrlFrom,
  brokerLaneModeFrom,
} = transport;

// ---------------------------------------------------------------------------
// S9.18-001 hardening — counter-evidence (AI-01): a PRESENT but INVALID
// broker URL must never silently fall back to the offline demo mock (that
// would be "fake model output" on a configured-but-invalid lane) and must
// never fire any outgoing request. The lane mode is centralized in
// `brokerLaneModeFrom` (demo | configured | unavailable) and the
// "unavailable" transport is exported headless so Node can assert the
// rejection WITHOUT importing `ai`.
// ---------------------------------------------------------------------------

test("brokerLaneModeFrom: blank/undefined => demo, valid loopback => configured", () => {
  assert.equal(brokerLaneModeFrom(undefined), "demo");
  assert.equal(brokerLaneModeFrom(""), "demo");
  assert.equal(brokerLaneModeFrom("   "), "demo");
  assert.equal(brokerLaneModeFrom("http://127.0.0.1:18181"), "configured");
  assert.equal(brokerLaneModeFrom("  http://127.0.0.1:18181/chat  "), "configured");
});

test("brokerLaneModeFrom: PRESENT but INVALID value => unavailable (NEVER demo)", () => {
  // AI-01 pitfall: a configured-but-invalid env value must not degrade to
  // the offline demo lane (which fakes a reply).
  assert.equal(brokerLaneModeFrom("https://provider.example.com"), "unavailable");
  assert.equal(brokerLaneModeFrom("http://192.168.3.50:18181"), "unavailable");
  assert.equal(brokerLaneModeFrom("ws://127.0.0.1:18181"), "unavailable");
  assert.equal(brokerLaneModeFrom("file:///C:/secret"), "unavailable");
  assert.equal(brokerLaneModeFrom("http://user:pass@127.0.0.1:18181"), "unavailable");
  assert.equal(brokerLaneModeFrom("http://127.0.0.1:18181?debug=1"), "unavailable");
  assert.equal(brokerLaneModeFrom("not-a-url"), "unavailable");
});

test("invalid broker URL: transport send REJECTS with typed error (never demo reply)", async () => {
  const transportInstance = transport.createInvalidBrokerTransport();
  // The rejection must surface the stable public reason — the UI shows the
  // chat error, NOT an assistant message.
  await assert.rejects(
    () =>
      transportInstance.sendMessages({
        trigger: "submit-message",
        chatId: "c1",
        messageId: undefined,
        messages: [{ id: "m0", role: "user", parts: [{ type: "text", text: "x" }] }],
        abortSignal: undefined,
      }),
    /invalid-broker-url/,
  );
  // No resumable stream exists on an invalid lane → reconnect resolves null.
  assert.equal(await transportInstance.reconnectToStream({ chatId: "c1" }), null);
});

test("unavailable lane: status URL resolves empty => ZERO outgoing status requests", () => {
  // The webview must not fetch /provider/status (or anything else) when the
  // broker URL is invalid — the status URI derivation already yields "".
  assert.equal(brokerProviderStatusUrlFrom("http://192.168.3.50:18181"), "");
  assert.equal(brokerProviderStatusUrlFrom("https://provider.example.com"), "");
  assert.equal(brokerChatUrlFrom("http://192.168.3.50:18181"), "");
});

test("module exports the hardened transport surface", () => {
  assert.equal(typeof transport.brokerLaneModeFrom, "function");
  assert.equal(typeof transport.createInvalidBrokerTransport, "function");
});

test("broker lane gate: blank/undefined env stays offline", () => {
  assert.equal(brokerLaneConfiguredFrom(undefined), false);
  assert.equal(brokerLaneConfiguredFrom(""), false);
  assert.equal(brokerLaneConfiguredFrom("   "), false);
});

test("broker lane gate: non-blank VALID loopback env enables the lane", () => {
  assert.equal(brokerLaneConfiguredFrom("http://127.0.0.1:18181"), true);
  assert.equal(brokerLaneConfiguredFrom("  http://127.0.0.1:18181/chat  "), true);
  assert.equal(brokerLaneConfiguredFrom("https://localhost:18443"), true);
});

test("broker lane gate: invalid/external/credentialed values are configured-but-invalid", () => {
  // S9.18-001 — "configured" is only a VALID loopback http(s) base URL. The
  // webview must stay on the offline Demo lane rather than reaching an
  // arbitrary external host (Arch: the ONLY model lane is the broker loopback).
  assert.equal(brokerLaneConfiguredFrom("https://provider.example.com"), false);
  assert.equal(brokerLaneConfiguredFrom("http://provider.example.com"), false);
  assert.equal(brokerLaneConfiguredFrom("http://192.168.3.50:18181"), false);
  assert.equal(brokerLaneConfiguredFrom("ws://127.0.0.1:18181"), false);
  assert.equal(brokerLaneConfiguredFrom("file:///C:/secret"), false);
  assert.equal(brokerLaneConfiguredFrom("http://user:pass@127.0.0.1:18181"), false);
  assert.equal(brokerLaneConfiguredFrom("http://127.0.0.1:18181?debug=1"), false);
  assert.equal(brokerLaneConfiguredFrom("http://127.0.0.1:18181/#frag"), false);
  assert.equal(brokerLaneConfiguredFrom("not-a-url"), false);
});

test("brokerChatUrlFrom derives the endpoint from a base URL", () => {
  assert.equal(brokerChatUrlFrom("http://127.0.0.1:18181"), "http://127.0.0.1:18181/chat");
  assert.equal(brokerChatUrlFrom("http://127.0.0.1:18181/"), "http://127.0.0.1:18181/chat");
  // explicit /chat passthrough and paths preserved
  assert.equal(brokerChatUrlFrom("http://localhost:18100/chat"), "http://localhost:18100/chat");
  assert.equal(
    brokerChatUrlFrom("http://127.0.0.1:18181/broker/chat"),
    "http://127.0.0.1:18181/broker/chat",
  );
});

test("brokerChatUrlFrom blank OR invalid env resolves empty (no magic default)", () => {
  assert.equal(brokerChatUrlFrom(""), "");
  assert.equal(brokerChatUrlFrom("   "), "");
  assert.equal(brokerChatUrlFrom("https://provider.example.com"), "");
  assert.equal(brokerChatUrlFrom("http://192.168.3.50:18181"), "");
  assert.equal(brokerChatUrlFrom("http://user:pass@127.0.0.1:18181"), "");
  assert.equal(brokerChatUrlFrom("ws://127.0.0.1:18181"), "");
});

test("brokerProviderStatusUrlFrom derives the public-safe status URI", () => {
  assert.equal(
    brokerProviderStatusUrlFrom("http://127.0.0.1:18181"),
    "http://127.0.0.1:18181/provider/status",
  );
  assert.equal(
    brokerProviderStatusUrlFrom("http://127.0.0.1:18181/"),
    "http://127.0.0.1:18181/provider/status",
  );
  assert.equal(
    brokerProviderStatusUrlFrom("http://localhost:18100/chat"),
    "http://localhost:18100/provider/status",
  );
  // invalid/unset → "" (no status read from an external host)
  assert.equal(brokerProviderStatusUrlFrom(""), "");
  assert.equal(brokerProviderStatusUrlFrom("https://provider.example.com"), "");
  assert.equal(brokerProviderStatusUrlFrom("http://user:pass@127.0.0.1:18181"), "");
});

test("module exports the expected transport surface", () => {
  assert.equal(typeof transport.createChatTransport, "function");
  assert.equal(typeof transport.brokerLaneConfigured, "function");
  assert.equal(typeof transport.brokerChatUrl, "function");
  assert.equal(typeof transport.brokerProviderStatusUrl, "function");
  assert.equal(typeof transport.isBrokerBaseUrl, "function");
});
