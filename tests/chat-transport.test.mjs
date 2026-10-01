// S9.6-008 — broker chat-transport selector, pure helpers (headless).
// Proves:
//   1. `brokerLaneConfiguredFrom` gates the lane on a non-blank env value.
//   2. `brokerChatUrlFrom` derives the endpoint: base URL → `<base>/chat`,
//      trailing slash → `<base>/chat`, explicit `/chat` URL → as-is, blank →
//      empty (no magic default; env is authority — zero provider URLs here).
//   3. The module imports cleanly under Node (no `import.meta.env` at
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
const { brokerLaneConfiguredFrom, brokerChatUrlFrom } = transport;

test("broker lane gate: blank/undefined env stays offline", () => {
  assert.equal(brokerLaneConfiguredFrom(undefined), false);
  assert.equal(brokerLaneConfiguredFrom(""), false);
  assert.equal(brokerLaneConfiguredFrom("   "), false);
});

test("broker lane gate: non-blank env enables the lane", () => {
  assert.equal(brokerLaneConfiguredFrom("http://127.0.0.1:18181"), true);
  assert.equal(brokerLaneConfiguredFrom("  http://127.0.0.1:18181/chat  "), true);
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

test("brokerChatUrlFrom blank env resolves empty (no magic default)", () => {
  assert.equal(brokerChatUrlFrom(""), "");
  assert.equal(brokerChatUrlFrom("   "), "");
});

test("module exports the expected transport surface", () => {
  assert.equal(typeof transport.createChatTransport, "function");
  assert.equal(typeof transport.brokerLaneConfigured, "function");
  assert.equal(typeof transport.brokerChatUrl, "function");
});
