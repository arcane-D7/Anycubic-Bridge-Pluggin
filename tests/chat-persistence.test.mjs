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

// S9.17-004 NAV-05: scoped-bucket persistence tests. chat-persistence.ts
// only falls back to LocalFallback when a window-like global exists (it
// never touches Tauri here); provide an inert one BEFORE the dynamic import.
globalThis.window = {};
const persistenceUrl = pathToFileURL(
  path.join(root, "apps", "editor", "src", "state", "chat-persistence.ts"),
);
const persistence = await import(`${persistenceUrl.href}?key=${Date.now()}`);
const { resolvePersistence, chatBucketKeyFor } = persistence;

/** In-memory ChatStoreStorage shim (Map-backed, exact Storage contract). */
function memStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

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

// --- S9.17-004 NAV-05: project-scoped buckets in the LocalFallback lane ---

test("chatBucketKeyFor routes null scope to the legacy key and projects to buckets", () => {
  assert.equal(chatBucketKeyFor(null), "anycubic:chat-store:v1");
  assert.equal(chatBucketKeyFor(undefined), "anycubic:chat-store:v1");
  const key = chatBucketKeyFor("p1");
  assert.ok(key.startsWith("anycubic:chat-store:project:"));
  assert.ok(key.endsWith("p1"));
});

test("LocalFallback stores workspace and project conversations in separate buckets", async () => {
  const storage = memStorage();
  const p = resolvePersistence(storage);
  assert.equal(p.available, true);

  await p.put("conversation-1", convo("conversation-1")); // legacy (projectId missing → null)
  await p.put("conversation-2", convo("conversation-2", { projectId: "pA" }));
  await p.put("conversation-3", convo("conversation-3", { projectId: "pB" }));

  // Each convo is readable from its own bucket key; get/list merge all.
  assert.equal((await p.get("conversation-1")).projectId ?? null, null);
  assert.equal((await p.get("conversation-2")).projectId, "pA");
  assert.equal((await p.get("conversation-3")).projectId, "pB");
  assert.deepEqual((await p.list()).sort(), ["conversation-1", "conversation-2", "conversation-3"]);

  const legacyRaw = storage.getItem("anycubic:chat-store:v1");
  assert.ok(legacyRaw.includes("conversation-1"));
  assert.ok(!legacyRaw.includes("conversation-2"));
  assert.ok(storage.getItem(chatBucketKeyFor("pA")).includes("conversation-2"));
  assert.ok(storage.getItem(chatBucketKeyFor("pB")).includes("conversation-3"));
});

test("LocalFallback delete drops the project bucket only when it becomes empty", async () => {
  const storage = memStorage();
  const p = resolvePersistence(storage);
  await p.put("conversation-1", convo("conversation-1"));
  await p.put("conversation-2", convo("conversation-2", { projectId: "pA" }));
  await p.put("conversation-9", convo("conversation-9", { projectId: "pA" }));

  await p.delete("conversation-2");
  assert.equal(await p.get("conversation-2"), null);
  // bucket pA still has conversation-9 → bucket stays and is re-written
  assert.ok(storage.getItem(chatBucketKeyFor("pA")).includes("conversation-9"));
  assert.ok(!storage.getItem(chatBucketKeyFor("pA")).includes("conversation-2"));

  await p.delete("conversation-9");
  assert.equal(storage.getItem(chatBucketKeyFor("pA")), null); // empty project bucket dropped
  assert.ok(storage.getItem("anycubic:chat-store:v1").includes("conversation-1")); // legacy kept

  // deleting an unknown id is a silent no-op
  const before = storage.length;
  await p.delete("conversation-999");
  assert.equal(storage.length, before);
});

test("migration: legacy unscoped conversations keep the v1 key and merge with new buckets", async () => {
  const storage = memStorage();
  // Pre-populate the LEGACY v1 map with an unscoped conversation (exactly
  // what any pre-NAV-05 install has on disk).
  const legacy = { "conversation-1": convo("conversation-1") };
  storage.setItem("anycubic:chat-store:v1", JSON.stringify(legacy));
  // And a NEW project bucket (written by NAV-05 code).
  const p = resolvePersistence(storage);

  // read merges legacy + project buckets → hydrate sees ALL scopes (no drop).
  assert.equal((await p.get("conversation-1")).id, "conversation-1");
  assert.equal((await p.list()).sort()[0], "conversation-1");
  const listed = (await p.list()).map((id) => p.get(id));
  const hydrated = await Promise.all(listed);
  const { state, restored } = hydrateFromPersisted(hydrated.filter(Boolean));
  assert.equal(restored, true);
  assert.equal(Object.keys(state.conversations).length, 1);

  // Putting an unscoped conversation again routes to the SAME v1 key (never a
  // fresh bucket — the legacy map is owned by workspace scope forever).
  await p.put("conversation-1", convo("conversation-1", { title: "Legacy kept" }));
  const raw = JSON.parse(storage.getItem("anycubic:chat-store:v1"));
  assert.equal(raw["conversation-1"].title, "Legacy kept");
  assert.equal(storage.getItem(chatBucketKeyFor("pA")), null); // no stray bucket
});

test("resolvePersistence is Unavailable when no window global exists", async () => {
  const saved = globalThis.window;
  delete globalThis.window;
  try {
    const p = resolvePersistence(memStorage());
    assert.equal(p.available, false); // headless fallback never fabricates a store
  } finally {
    globalThis.window = saved;
  }
});

// ---- NAV-05 scope-key SECURITY: hostile persisted payloads ----

test("LocalFallback never pollutes Object.prototype from hostile JSON", async () => {
  const storage = memStorage();
  // A hostile writer smuggled a `"__proto__"` entry and a `"constructor"`
  // conversation id into the stored maps. JSON.parse creates them as OWN
  // data properties — the danger is only in how they are merged back out.
  // (The payload must arrive as raw JSON text: an object LITERAL whose key
  // is `__proto__` would set the prototype instead of creating an own key.)
  storage.setItem(
    "anycubic:chat-store:v1",
    `{"__proto__":${JSON.stringify({ polluted: true })},${JSON.stringify("conversation-1")}:${JSON.stringify(convo("conversation-1"))}}`,
  );
  storage.setItem(
    chatBucketKeyFor("pX"),
    JSON.stringify({
      constructor: convo("constructor", { projectId: "pX" }),
      "conversation-2": convo("conversation-2", { projectId: "pX" }),
    }),
  );
  const p = resolvePersistence(storage);

  // read() merges with own-key writes onto a null-prototype map (no [[Set]]):
  // the hostile "__proto__" entry stays an inert own property, never a
  // prototype write.
  assert.equal({}.polluted, undefined);
  const hostile = await p.get("__proto__");
  assert.notEqual(hostile, null);
  assert.equal(hostile.polluted, true);
  // the "constructor" conversation id round-trips as a plain own record
  assert.equal((await p.get("constructor")).id, "constructor");
  assert.equal((await p.get("constructor")).projectId, "pX");
  assert.deepEqual((await p.list()).sort(), [
    "__proto__",
    "constructor",
    "conversation-1",
    "conversation-2",
  ]);
  assert.equal({}.polluted, undefined); // still clean after every read
});

test("LocalFallback put round-trips hostile project ids in their own buckets", async () => {
  const storage = memStorage();
  const p = resolvePersistence(storage);
  const hostileScopes = ["workspace", "", "__proto__", "constructor", "a/b\\c ü"];
  for (const projectId of hostileScopes) {
    await p.put(`convo-${projectId}`, convo(`convo-${projectId}`, { projectId }));
  }
  // each scope lives in its OWN bucket key (the raw id in the key is fine —
  // keys are string-distinct and never used for prototype lookups)
  for (const projectId of hostileScopes) {
    const key = chatBucketKeyFor(projectId);
    const bucketRaw = storage.getItem(key);
    // compare against the JSON-encoded form (backslashes etc. are escaped)
    assert.ok(
      bucketRaw?.includes(`"projectId":${JSON.stringify(projectId)}`),
      `bucket for ${JSON.stringify(projectId)}`,
    );
    assert.equal((await p.get(`convo-${projectId}`)).projectId, projectId);
  }
  // full round-trip through hydrate preserves the exact ids
  const listed = (await p.list()).sort();
  const hydrated = await Promise.all(listed.map((id) => p.get(id)));
  const { state } = hydrateFromPersisted(hydrated.filter(Boolean));
  assert.equal(Object.keys(state.conversations).length, hostileScopes.length);
  assert.equal(state.conversations["convo-workspace"].projectId, "workspace");
  assert.equal(state.conversations["convo-"].projectId, "");
  assert.equal(state.conversations["convo-__proto__"].projectId, "__proto__");
  assert.equal(state.conversations["convo-constructor"].projectId, "constructor");
  assert.equal({}.polluted, undefined);
});
