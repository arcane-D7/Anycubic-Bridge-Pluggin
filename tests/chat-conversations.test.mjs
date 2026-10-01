// S9.6-005 unit tests for the multi-conversation chat store core — Mandate C:
// per-conversation isolated messages / context sources / token budget /
// approvals. Pure functions — no React, no zustand, no AI SDK; the core only
// references structural types that Node 24 strips away at runtime.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { pathToFileURL } = require("node:url");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `?key=` busts the ESM module cache so each run imports a fresh core instance
// (same isolation pattern as plates-core tests).
const coreUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "state", "chat-conversations-core.ts"),
);

const core = await import(`${coreUrl.href}?key=${Date.now()}`);
const {
  defaultChatConversations,
  nextConversationTitle,
  createConversation,
  switchConversation,
  renameConversation,
  deleteConversation,
  upsertConversationMessages,
  setConversationPayload,
  activeConversationOf,
  conversationsSorted,
  conversationStats,
  EMPTY_CONVERSATION_PAYLOAD,
} = core;

/** Minimal structural message satisfying UIMessageLike. */
function msg(id, role, text) {
  return { id, role, parts: [{ type: "text", text }], metadata: undefined };
}

const SOURCES = [{ id: "mem-1", kind: "memory", label: "Memory: last-job", tokens: 240 }];
const APPROVALS = [
  { id: "a-1", state: "pending", effect: { kind: "spend", summary: "geometry.boolean" } },
];

test("default state starts with one empty conversation active", () => {
  const s = defaultChatConversations();
  assert.equal(s.activeId, "conversation-1");
  assert.equal(Object.keys(s.conversations).length, 1);
  assert.equal(s.nextSeq, 2);
  const c = activeConversationOf(s);
  assert.equal(c.id, "conversation-1");
  assert.equal(c.title, "Conversation 1");
  assert.deepEqual(c.messages, []);
  assert.equal(c.revision, 0);
  assert.deepEqual(c.payload, EMPTY_CONVERSATION_PAYLOAD);
});

test("create adds an isolated conversation and switches to it", () => {
  let s = defaultChatConversations();
  s = createConversation(s, "Batch analysis");
  assert.equal(s.activeId, "conversation-2");
  assert.equal(s.nextSeq, 3);
  assert.equal(s.conversations["conversation-2"].title, "Batch analysis");
  assert.equal(s.conversations["conversation-2"].revision, 0);
  // first conversation survives untouched
  assert.deepEqual(s.conversations["conversation-1"].messages, []);
});

test("create without a title derives a unique default name", () => {
  let s = defaultChatConversations();
  s = createConversation(s);
  s = createConversation(s);
  s = createConversation(s);
  assert.equal(s.conversations["conversation-3"].title, "Conversation 3");
});

test("nextConversationTitle skips taken names", () => {
  let s = defaultChatConversations("Conversation 1");
  s = createConversation(s, "Conversation 2");
  const title = nextConversationTitle(s.conversations, 2);
  assert.equal(title, "Conversation 3");
});

test("switch is a no-op for an unknown id", () => {
  const s = defaultChatConversations();
  const next = switchConversation(s, "nope");
  assert.equal(next, s);
});

test("rename trims whitespace, rejects empty and unchanged titles", () => {
  let s = defaultChatConversations();
  s = renameConversation(s, "conversation-1", "  First job  ");
  assert.equal(s.conversations["conversation-1"].title, "First job");
  // unchanged → no-op
  const same = renameConversation(s, "conversation-1", "First job");
  assert.equal(same, s);
  // empty → no-op
  const empty = renameConversation(s, "conversation-1", "   ");
  assert.equal(empty, s);
  // unknown → no-op
  const unknown = renameConversation(s, "nope", "X");
  assert.equal(unknown, s);
});

test("delete removes only the target and falls back to the next remaining", () => {
  let s = defaultChatConversations();
  s = createConversation(s, "Job B");
  const idC = s.activeId; // "conversation-2" active
  s = deleteConversation(s, idC);
  assert.equal(s.activeId, "conversation-1");
  assert.equal(Object.keys(s.conversations).length, 1);
  // unknown id → no-op
  const unchanged = deleteConversation(s, "nope");
  assert.equal(unchanged, s);
});

test("delete of the last conversation leaves no active", () => {
  let s = defaultChatConversations();
  s = deleteConversation(s, "conversation-1");
  assert.equal(s.activeId, null);
  assert.equal(Object.keys(s.conversations).length, 0);
});

test("upsertMessages bumps revision and updatedAt, keeps payload isolated", async () => {
  let s = defaultChatConversations();
  const created = s.conversations["conversation-1"].createdAt;
  s = createConversation(s, "Job B", {
    contextSources: SOURCES,
    tokenBudget: 2000,
    approvals: APPROVALS,
  });
  const messages = [msg("m-1", "user", "slice this"), msg("m-2", "assistant", "done")];
  s = upsertConversationMessages(s, "conversation-2", messages);
  assert.equal(s.conversations["conversation-2"].messages, messages);
  assert.equal(s.conversations["conversation-2"].revision, 1);
  assert.ok(s.conversations["conversation-2"].updatedAt >= created);

  // AC1: per-conversation payload — conversation 1 untouched
  assert.deepEqual(s.conversations["conversation-1"].messages, []);
  assert.equal(s.conversations["conversation-1"].payload.tokenBudget, 4000);
  // conversation 2 keeps its own payload
  assert.deepEqual(s.conversations["conversation-2"].payload.contextSources, SOURCES);
  assert.equal(s.conversations["conversation-2"].payload.tokenBudget, 2000);
  assert.deepEqual(s.conversations["conversation-2"].payload.approvals, APPROVALS);
});

test("upsert is a no-op for identical message arrays (identity equality)", () => {
  let s = defaultChatConversations();
  const messages = [msg("m-1", "user", "hi")];
  s = upsertConversationMessages(s, "conversation-1", messages);
  const snap = s;
  const again = upsertConversationMessages(s, "conversation-1", messages);
  assert.equal(again, snap); // no revision bump on no-op
  assert.equal(s.conversations["conversation-1"].revision, 1);
});

test("upsert is a no-op for an unknown conversation", () => {
  const s = defaultChatConversations();
  const next = upsertConversationMessages(s, "nope", [msg("m-1", "user", "x")]);
  assert.equal(next, s);
});

test("setConversationPayload updates payload fields independently", () => {
  let s = defaultChatConversations("Job B");
  s = setConversationPayload(s, "conversation-1", { tokenBudget: 8000 });
  assert.equal(s.conversations["conversation-1"].payload.tokenBudget, 8000);
  // untouched fields preserved
  assert.deepEqual(s.conversations["conversation-1"].payload.contextSources, []);
  s = setConversationPayload(s, "conversation-1", {
    contextSources: SOURCES,
    approvals: APPROVALS,
  });
  assert.deepEqual(s.conversations["conversation-1"].payload.contextSources, SOURCES);
  assert.deepEqual(s.conversations["conversation-1"].payload.approvals, APPROVALS);
  // unknown → no-op
  const unknown = setConversationPayload(s, "nope", { tokenBudget: 1 });
  assert.equal(unknown, s);
});

test("conversationStats reports token bar ratio, counts and dirty flag", () => {
  let s = defaultChatConversations();
  s = setConversationPayload(s, "conversation-1", {
    contextSources: SOURCES, // 1 source, tokens 240
    tokenBudget: 2000,
    approvals: APPROVALS, // 1 approval
  });
  const stats = conversationStats(s.conversations["conversation-1"]);
  assert.equal(stats.usedTokens, 240);
  assert.equal(stats.budget, 2000);
  assert.equal(stats.ratio, 240 / 2000);
  assert.equal(stats.sourceCount, 1);
  assert.equal(stats.approvalCount, 1);
  assert.equal(stats.dirty, false);
  // dirty flips with revision > 0
  s = upsertConversationMessages(s, "conversation-1", [msg("m-1", "user", "hi")]);
  assert.equal(conversationStats(s.conversations["conversation-1"]).dirty, true);
});

test("conversationStats clamps ratio and survives zero budget", () => {
  let s = defaultChatConversations();
  s = setConversationPayload(s, "conversation-1", {
    contextSources: [{ id: "big", kind: "mesh", label: "Big", tokens: 999_999 }],
    tokenBudget: 100,
  });
  const stats = conversationStats(s.conversations["conversation-1"]);
  assert.equal(stats.ratio, 1); // clamped
  s = setConversationPayload(s, "conversation-1", { tokenBudget: 0 });
  assert.equal(conversationStats(s.conversations["conversation-1"]).ratio, 0);
});

test("conversationsSorted orders by updatedAt desc, ties by createdAt asc", () => {
  // Deterministic timestamps (Date.now() has ms granularity — explicit values).
  const cv = (id, title, createdAt, updatedAt) => ({
    id,
    title,
    createdAt,
    updatedAt,
    messages: [],
    payload: { ...EMPTY_CONVERSATION_PAYLOAD },
    revision: 0,
  });
  const record = {
    "conversation-2": cv("conversation-2", "Mid", 1000, 1000),
    "conversation-1": cv("conversation-1", "New", 3000, 3000),
    "conversation-3": cv("conversation-3", "Old", 2000, 5000), // most recent update
  };
  const rows = conversationsSorted(record).map((c) => c.title);
  assert.deepEqual(rows, ["Old", "New", "Mid"]);

  // Tie on updatedAt → createdAt asc
  const tie = {
    a: cv("a", "A", 1000, 2000),
    b: cv("b", "B", 1500, 2000),
    c: cv("c", "C", 500, 2000),
  };
  // equal updatedAt (2000) → createdAt asc: C(500) → A(1000) → B(1500)
  const tieRows = conversationsSorted(tie).map((c) => c.title);
  assert.deepEqual(tieRows, ["C", "A", "B"]);
});
