// S9.6-007 unit tests for the chat-store persistence core — hydrateFromPersisted
// (boot restore) + coerceConversation (defensive round-trip). Pure functions —
// no React, no zustand, no Tauri; the core only references structural types.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "state", "chat-conversations-core.ts"),
);

const core = await import(`${coreUrl.href}?key=${Date.now()}`);
const { defaultChatConversations, hydrateFromPersisted, coerceConversation } = core;

function convo(id, over = {}) {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [{ id: "m-1", role: "user", parts: [{ type: "text", text: "hi" }] }],
    payload: { contextSources: [], tokenBudget: 4000, approvals: [] },
    createdAt: 1000,
    updatedAt: 2000,
    revision: 1,
    ...over,
  };
}

test("hydrateFromPersisted rebuilds state with all conversations active first", () => {
  const { state, restored } = hydrateFromPersisted([
    convo("conversation-1"),
    convo("conversation-3", { title: "Job B" }),
  ]);
  assert.equal(restored, true);
  assert.deepEqual(Object.keys(state.conversations).sort(), ["conversation-1", "conversation-3"]);
  assert.equal(state.activeId, "conversation-1");
  // nextSeq computed past the max numeric id
  assert.equal(state.nextSeq, 4);
});

test("hydrateFromPersisted with nothing returns default state", () => {
  const { state, restored } = hydrateFromPersisted([]);
  assert.equal(restored, false);
  assert.deepEqual(Object.keys(state.conversations), ["conversation-1"]);
  assert.equal(state.activeId, "conversation-1");
});

test("hydrateFromPersisted is stable for arbitrary ids (uuid chat)", () => {
  const { state, restored } = hydrateFromPersisted([convo("uuid-abc"), convo("uuid-def")]);
  assert.equal(restored, true);
  assert.equal(state.activeId, "uuid-abc");
  // no numeric ids → nextSeq stays conservative (>= 1)
  assert.ok(state.nextSeq >= 1);
});

test("coerceConversation fills missing fields defensively", () => {
  const coerced = coerceConversation({ id: "conversation-9" });
  assert.equal(coerced.id, "conversation-9");
  assert.equal(coerced.title, "Conversation");
  assert.deepEqual(coerced.payload.contextSources, []);
  assert.equal(coerced.payload.tokenBudget, 4000);
  assert.deepEqual(coerced.payload.approvals, []);
  assert.deepEqual(coerced.messages, []);
  assert.ok(coerced.createdAt > 0);
  assert.ok(coerced.updatedAt > 0);
  assert.equal(coerced.revision, 0);
});

test("coerceConversation caps long titles at the store max", () => {
  const coerced = coerceConversation(convo("conversation-1", { title: "x".repeat(200) }));
  assert.equal(coerced.title.length, 64);
});

test("defaultChatConversations produces a persistable snapshot (round-trip)", () => {
  const d = defaultChatConversations();
  const { state, restored } = hydrateFromPersisted([d.conversations["conversation-1"]]);
  assert.equal(restored, true);
  assert.equal(state.conversations["conversation-1"].title, "Conversation 1");
  assert.equal(state.conversations["conversation-1"].payload.tokenBudget, 4000);
});
