// S9.17-004 NAV-05 unit tests for the project-scoped chat core — scope keys,
// enterProjectScope (restore vs fresh create), conversationsForScope,
// coerceConversation legacy-null handling and hydrateFromPersisted per-scope
// normalization. Pure functions — no React, no zustand, no AI SDK.

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

// `?key=` busts the ESM module cache so each run imports a fresh core instance.
const core = await import(`${coreUrl.href}?key=${Date.now()}`);
const {
  defaultChatConversations,
  createConversation,
  deleteConversation,
  switchConversation,
  renameConversation,
  upsertConversationMessages,
  setConversationPayload,
  activeConversationOf,
  enterProjectScope,
  scopeKeyFor,
  projectIdFromScopeKey,
  conversationsForScope,
  coerceConversation,
  hydrateFromPersisted,
  WORKSPACE_SCOPE_KEY,
} = core;

/** Minimal structural message satisfying UIMessageLike. */
function msg(id, role, text) {
  return { id, role, parts: [{ type: "text", text }], metadata: undefined };
}

/** Persisted-shaped conversation fixture (projectId optional = legacy). */
function convo(id, over = {}) {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [],
    payload: { contextSources: [], tokenBudget: 4000, approvals: [] },
    createdAt: 1000,
    updatedAt: 2000,
    revision: 1,
    ...over,
  };
}

test("scopeKeyFor works both ways (workspace + namespaced project)", () => {
  assert.equal(scopeKeyFor(null), WORKSPACE_SCOPE_KEY);
  assert.equal(scopeKeyFor(undefined), WORKSPACE_SCOPE_KEY);
  // Namespaced scheme: project keys are "project:" + URI-encoded id — a
  // project literally named "workspace" can never equal the global key.
  assert.equal(scopeKeyFor("p1"), "project:p1");
  assert.equal(projectIdFromScopeKey(WORKSPACE_SCOPE_KEY), null);
  assert.equal(projectIdFromScopeKey(scopeKeyFor("p1")), "p1");
  // "" is a REAL project key (non-nullish) — never folded into workspace,
  // and it round-trips exactly through the key.
  assert.notEqual(scopeKeyFor(""), WORKSPACE_SCOPE_KEY);
  assert.equal(scopeKeyFor(""), "project:");
  assert.equal(projectIdFromScopeKey(scopeKeyFor("")), "");
});

test("default state is workspace-scoped with activeByProject seeded", () => {
  const s = defaultChatConversations();
  assert.equal(s.currentProjectId, null);
  assert.equal(s.lastUsedProjectId, null);
  assert.deepEqual(s.activeByProject, { [WORKSPACE_SCOPE_KEY]: "conversation-1" });
  assert.equal(s.conversations["conversation-1"].projectId, null);
});

test("createConversation defaults to the current scope and wires activeByProject", () => {
  let s = defaultChatConversations();
  s = createConversation(s, "Ws chat");
  assert.equal(s.conversations["conversation-2"].projectId, null); // workspace scope
  assert.equal(s.activeByProject[WORKSPACE_SCOPE_KEY], "conversation-2");
  // explicit project override (4th param) — never inferred from object ids
  s = createConversation(s, "P1 chat", undefined, "p1");
  assert.equal(s.conversations["conversation-3"].projectId, "p1");
  assert.equal(s.activeByProject[scopeKeyFor("p1")], "conversation-3");
  assert.equal(s.currentProjectId, null); // creating in another scope doesn't switch UI scope
});

test("enterProjectScope creates a fresh scoped conversation when the scope is new", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1");
  assert.equal(s.currentProjectId, "p1");
  assert.equal(s.lastUsedProjectId, "p1");
  assert.equal(s.activeId, "conversation-2");
  assert.equal(s.conversations["conversation-2"].projectId, "p1");
  assert.equal(s.activeByProject[scopeKeyFor("p1")], "conversation-2");
  // workspace conversation is untouched (never auto-injected into p1)
  assert.equal(s.conversations["conversation-1"].projectId, null);
  // bounded id sequence (no collision with persisted ids)
  s = enterProjectScope(s, "p2");
  assert.equal(s.activeId, "conversation-3");
  assert.equal(s.nextSeq, 4);
});

test("enterProjectScope restores the last-active conversation per scope", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1"); // conv-2 (p1)
  const scopedId = s.activeId;
  // a message lands in the scoped conversation (transcript preserved on switch)
  s = upsertConversationMessages(s, scopedId, [
    msg("m-1", "user", "slice this"),
    msg("m-2", "assistant", "proposal ready"),
  ]);
  s = enterProjectScope(s, null); // back to workspace → restores conv-1
  assert.equal(s.currentProjectId, null);
  assert.equal(s.activeId, "conversation-1");
  s = enterProjectScope(s, "p1"); // back to p1 → restores conv-2 WITH its messages
  assert.equal(s.activeId, scopedId);
  assert.equal(s.conversations[scopedId].messages.length, 2);
  // activeByProject never cleared by switching scopes
  assert.equal(s.activeByProject[scopeKeyFor("p1")], scopedId);
  assert.equal(s.activeByProject[WORKSPACE_SCOPE_KEY], "conversation-1");
});

test("enterProjectScope is a no-op for the same scope + matching active", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1");
  const before = s;
  const after = enterProjectScope(s, "p1");
  assert.equal(after, before); // same immutable reference — untouched
  assert.equal(after.activeId, s.activeId);
});

test("legacy workspace conversations survive scope switching (no AllHistories drop)", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1");
  s = createConversation(s, "p1 second"); // conv-3 (p1)
  s = enterProjectScope(s, null);
  assert.equal(Object.keys(s.conversations).length, 3);
  assert.equal(conversationsForScope(s.conversations, null)["conversation-1"].id, "conversation-1");
  assert.equal(conversationsForScope(s.conversations, "p1")["conversation-2"].id, "conversation-2");
  // legacy conversation ids stay in the workspace scope only
  const ws = conversationsForScope(s.conversations, null);
  const p1 = conversationsForScope(s.conversations, "p1");
  assert.deepEqual(Object.keys(ws), ["conversation-1"]);
  assert.deepEqual(Object.keys(p1), ["conversation-2", "conversation-3"]);
});

test("switchConversation never changes the project scope", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1");
  assert.equal(s.currentProjectId, "p1");
  const after = switchConversation(s, "conversation-1");
  assert.equal(after.currentProjectId, "p1");
  assert.equal(after.activeId, "conversation-1");
});

test("conversationsForScope never surfaces another project's chats", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1");
  s = enterProjectScope(s, "p2");
  const p2 = conversationsForScope(s.conversations, "p2");
  assert.equal(Object.keys(p2).length, 1);
  assert.equal(p2[s.activeId].projectId, "p2");
  assert.equal(p2[s.activeId].title, "Conversation 3");
});

test("coerceConversation maps legacy (no projectId) to null and keeps explicit ids", () => {
  const legacy = convo("conversation-9"); // persisted before NAV-05
  assert.equal(coerceConversation(legacy).projectId, null);
  const scoped = { ...convo("conversation-9"), projectId: "pX" };
  assert.equal(coerceConversation(scoped).projectId, "pX");
});

test("enterProjectScope guards against a stale activeByProject id", () => {
  // activeByProject pointing at a deleted conversation must NOT be restored;
  // entering the scope falls through to a fresh create.
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1"); // conv-2 (p1)
  s = deleteConversation(s, "conversation-2"); // removes conv-2 + p1 entry
  // p1 entry is gone → entering p1 creates a brand-new conversation
  assert.equal(s.activeByProject[scopeKeyFor("p1")], undefined);
  s = enterProjectScope(s, "p1");
  assert.equal(s.activeId, "conversation-3");
  assert.equal(s.conversations["conversation-3"].projectId, "p1");
});

test("deleteConversation prefers same-scope fallback and cleans activeByProject", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1"); // conv-2 (p1) active
  s = createConversation(s, "p1 second"); // conv-3 (p1) active, now last-active
  // Delete the older p1 conversation (NOT the scope's last-active) → the
  // p1 last-active entry must survive.
  s = deleteConversation(s, "conversation-2");
  assert.equal("conversation-2" in s.conversations, false);
  assert.equal(s.activeByProject[scopeKeyFor("p1")], "conversation-3");
  // Delete the scope's last-active scoped conversation → entry is cleared
  // (stale-id guard) and active falls to the workspace remaining convo.
  s = deleteConversation(s, "conversation-3");
  assert.equal(s.activeId, "conversation-1");
  assert.equal(s.activeByProject[scopeKeyFor("p1")], undefined);
  // workspace legacy remains intact
  assert.equal(s.conversations["conversation-1"].projectId, null);
  assert.equal(s.activeByProject[WORKSPACE_SCOPE_KEY], "conversation-1");
});

test("deleteConversation drops the scope entry when the last scoped chat goes", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1"); // conv-2 (p1)
  s = deleteConversation(s, "conversation-2");
  assert.equal(s.activeByProject[scopeKeyFor("p1")], undefined);
  assert.equal(s.activeId, "conversation-1"); // workspace fallback (key-ordered)
  assert.equal(s.currentProjectId, "p1"); // UI scope stays put after a delete
});

test("hydrateFromPersisted normalizes per-scope last-active + never drops a scope", () => {
  const persisted = [
    convo("conversation-1", { updatedAt: 500 }), // workspace legacy
    convo("conversation-2", { projectId: "pA", updatedAt: 700 }),
    convo("conversation-3", { projectId: "pB", updatedAt: 900 }),
    convo("conversation-4", { projectId: "pA", updatedAt: 800 }),
  ];
  const { state, restored } = hydrateFromPersisted(persisted);
  assert.equal(restored, true);
  assert.equal(state.currentProjectId, null); // boot scope is workspace
  assert.equal(state.lastUsedProjectId, null);
  assert.equal(state.activeByProject[WORKSPACE_SCOPE_KEY], "conversation-1");
  assert.equal(state.activeByProject[scopeKeyFor("pA")], "conversation-4"); // newest in pA
  assert.equal(state.activeByProject[scopeKeyFor("pB")], "conversation-3");
  assert.equal(state.activeId, "conversation-1"); // ids[0] — deterministic
  assert.equal(state.nextSeq, 5); // bounded past every restored conversation-N
  // no accidental AllHistories drop — all four scopes preserved
  assert.equal(Object.keys(state.conversations).length, 4);
});

test("hydrateFromPersisted legacy-only payload keeps workspace activeByProject", () => {
  const { state, restored } = hydrateFromPersisted([
    convo("conversation-1"),
    convo("conversation-3", { title: "Job B" }),
  ]);
  assert.equal(restored, true);
  assert.equal(state.activeByProject[WORKSPACE_SCOPE_KEY], "conversation-1");
  assert.equal(state.activeId, "conversation-1");
  assert.deepEqual(Object.keys(state.activeByProject), [WORKSPACE_SCOPE_KEY]);
});

// ---- NAV-05 scope-key SECURITY (collision + prototype hardening) ----
// A project id is just a string: it can be "workspace", "", "__proto__",
// "constructor", "toString" or any unicode/slash payload. The namespaced key
// scheme + own-property lookups + null-prototype maps must keep every one of
// those out of the global scope and out of Object.prototype.

test("a project id 'workspace' never collides with the workspace scope", () => {
  // The core of the fix: namespaced, encoded keys are injective.
  assert.notEqual(scopeKeyFor("workspace"), WORKSPACE_SCOPE_KEY);
  assert.equal(scopeKeyFor("workspace"), "project:workspace");
  assert.equal(scopeKeyFor(null), WORKSPACE_SCOPE_KEY);
  // Inverse decodes back to ITSELF (never null / never the workspace).
  assert.equal(projectIdFromScopeKey(scopeKeyFor("workspace")), "workspace");
  assert.equal(projectIdFromScopeKey("workspace"), null); // only the raw global key

  // Full behavioral proof: both scopes coexist, each with its own chat.
  let s = defaultChatConversations();
  s = enterProjectScope(s, "workspace"); // conv-2 scoped to the PROJECT
  const projectConvoId = s.activeId;
  s = enterProjectScope(s, null); // back to workspace-global → conv-1
  const wsConvoId = s.activeId;
  assert.equal(wsConvoId, "conversation-1");
  assert.notEqual(projectConvoId, wsConvoId, "project and workspace chats must stay separate");

  const ws = conversationsForScope(s.conversations, null);
  const project = conversationsForScope(s.conversations, "workspace");
  assert.deepEqual(Object.keys(ws), ["conversation-1"]);
  assert.deepEqual(Object.keys(project), [projectConvoId]);
  assert.equal(ws[wsConvoId].projectId, null);
  assert.equal(project[projectConvoId].projectId, "workspace");

  // Switching back restores the project's OWN chat (never the global one).
  s = enterProjectScope(s, "workspace");
  assert.equal(s.activeId, projectConvoId);
});

test("hostile / empty / unicode / slash project ids stay inert and isolated", () => {
  const projectIds = [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "",
    " ",
    "a/b\\c :?#%&",
    "üñí_тест",
  ];
  const keys = new Set(projectIds.map(scopeKeyFor));
  assert.equal(keys.size, projectIds.length, "every distinct id must map to a distinct key");
  // Keys are namespaced — a hostile id can never sit on the workspace key.
  for (const id of projectIds) {
    assert.notEqual(scopeKeyFor(id), WORKSPACE_SCOPE_KEY);
    assert.equal(projectIdFromScopeKey(scopeKeyFor(id)), id, "lossless round-trip");
  }
  let s = defaultChatConversations();
  const created = new Set();
  for (const id of projectIds) {
    s = enterProjectScope(s, id);
    assert.notEqual(s.activeId, null);
    created.add(s.activeId);
    // each scope ONLY surfaces its own conversation
    const scoped = conversationsForScope(s.conversations, id);
    assert.equal(Object.keys(scoped).length, 1);
    assert.equal(scoped[s.activeId].projectId, id);
  }
  assert.equal(created.size, projectIds.length, "each hostile scope got its OWN conversation");
  // activeByProject carries only namespaced keys — never a raw prototype name
  for (const id of projectIds) {
    assert.ok(Object.hasOwn(s.activeByProject, scopeKeyFor(id)));
    assert.equal(Object.hasOwn(s.activeByProject, id), false, `raw key ${id} must not exist`);
  }
  // Object.prototype stays clean — no pollution via any scope key
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(s.conversations, "__proto__"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(activeConversationOf(s).messages ?? [], "__proto__"),
    false,
  );
  s = enterProjectScope(s, "workspace");
  assert.notEqual(s.conversations[s.activeId].projectId, null);
});

test("corrupted caller conversation ids (prototype names) are refused without throwing", () => {
  const s = defaultChatConversations();
  const hostile = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", ""];
  for (const id of hostile) {
    assert.equal(switchConversation(s, id), s, `switchConversation(${JSON.stringify(id)}) no-op`);
    assert.equal(
      renameConversation(s, id, "Hijacked"),
      s,
      `renameConversation(${JSON.stringify(id)}) no-op`,
    );
    assert.equal(deleteConversation(s, id), s, `deleteConversation(${JSON.stringify(id)}) no-op`);
    assert.equal(
      upsertConversationMessages(s, id, [msg("m-1", "user", "inject")]),
      s,
      `upsertConversationMessages(${JSON.stringify(id)}) no-op`,
    );
    assert.equal(
      setConversationPayload(s, id, { tokenBudget: 1 }),
      s,
      `setPayload(${JSON.stringify(id)}) no-op`,
    );
  }
  // activeId was never hijacked to an inherited name
  assert.equal(s.activeId, "conversation-1");
  assert.equal(activeConversationOf(s)?.id, "conversation-1");
  // A state whose activeId somehow names an inherited property resolves to
  // null — never to Object.prototype members.
  const tampered = { ...s, activeId: "constructor" };
  assert.equal(activeConversationOf(tampered), null);
});

test("delete in one scope never resurrects another scope or a hostile entry", () => {
  let s = defaultChatConversations();
  s = enterProjectScope(s, "p1"); // conv-2
  s = enterProjectScope(s, "workspace"); // conv-3 (project literally named "workspace")
  s = enterProjectScope(s, "__proto__"); // conv-4
  const hostileId = s.activeId;
  s = deleteConversation(s, hostileId);
  assert.equal(activeConversationOf(s)?.id, "conversation-1");
  // other scopes' last-active survive the delete
  assert.equal(s.activeByProject[scopeKeyFor("p1")], "conversation-2");
  assert.equal(s.activeByProject[scopeKeyFor("workspace")], "conversation-3");
  assert.equal(s.activeByProject[WORKSPACE_SCOPE_KEY], "conversation-1");
  // the deleted hostile scope entry is gone and the key namespace is clean
  assert.equal(Object.hasOwn(s.activeByProject, scopeKeyFor("__proto__")), false);
  assert.equal(Object.hasOwn(s.activeByProject, "__proto__"), false);
  assert.equal({}.polluted, undefined);
});

test("hydrate with a project named 'workspace' never attaches the global scope to it", () => {
  const { state, restored } = hydrateFromPersisted([
    convo("conversation-1", { title: "Legacy global" }), // projectId null (legacy)
    convo("conversation-2", { projectId: "workspace", updatedAt: 900 }),
  ]);
  assert.equal(restored, true);
  // The raw "workspace" key IS the legitimate global scope entry (holds the
  // legacy conversation) — the project's own entry lives under the
  // namespaced key, so the two never share a map slot.
  assert.equal(state.activeByProject[WORKSPACE_SCOPE_KEY], "conversation-1");
  assert.equal(state.activeByProject["workspace"], "conversation-1");
  assert.equal(state.activeByProject[scopeKeyFor("workspace")], "conversation-2");
  assert.notEqual(
    state.activeByProject[scopeKeyFor("workspace")],
    state.activeByProject[WORKSPACE_SCOPE_KEY],
    "project and global must never resolve to the same conversation",
  );
  // and the ambiguous legacy id never leaks the global chat into the project
  assert.deepEqual(Object.keys(conversationsForScope(state.conversations, "workspace")), [
    "conversation-2",
  ]);
  assert.deepEqual(Object.keys(conversationsForScope(state.conversations, null)), [
    "conversation-1",
  ]);
});
