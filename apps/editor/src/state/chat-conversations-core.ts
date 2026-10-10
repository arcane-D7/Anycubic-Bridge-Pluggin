/**
 * S9.6-005 conversation store core — dependency-free pure core.
 *
 * Mandate C: cada conversa tem histórico ISOLADO. This core owns the
 * conversation CRUD + per-conversation payload (messages / context sources /
 * token budget / approvals) so the multi-conversation store can wrap the
 * S9-006 chat harness (`state/chat-core.ts`) WITHOUT touching it (wrap-only).
 *
 * No React / zustand / ai imports — Node 24 runs it headless via the `node
 * --test` harness (same pattern as plates-core / toolbar-core). The zustand
 * store (`state/chat-conversations.ts`) and the React UI
 * (`panels/ChatThread.tsx`) are thin wrappers over these pure functions.
 *
 * Messages are structural `UIMessageLike` (id, role, parts, ...) so the core
 * stays framework-agnostic; the AI SDK `UIMessage` type satisfies it (it has
 * id + role + parts). The store is the SOURCE OF TRUTH — the AI SDK chat
 * never persists on its own (no reliance on useChat's id-keyed localStorage).
 */

/** Structural message shape (superset of the AI SDK UIMessage parts). */
export interface UIMessageLike {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly parts: readonly unknown[];
  readonly metadata?: unknown;
}

/** Structural context-source entry (harness `ContextSource` satisfies it). */
export interface ConversationSource {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly tokens: number;
}

/** Structural approval-card entry (harness `ApprovalCard` satisfies it). */
export interface ConversationApproval {
  readonly id: string;
  readonly state: string;
  readonly effect: {
    readonly kind: string;
    readonly summary: string;
  };
}

/**
 * Per-conversation immutable payload carried intact from the chat harness
 * (context sources / token budget / approvals) — AC1: isolated per
 * conversation, never shared.
 */
export interface ConversationPayload {
  readonly contextSources: readonly ConversationSource[];
  readonly tokenBudget: number;
  readonly approvals: readonly ConversationApproval[];
}

/** One isolated conversation (Mandate C). */
export interface Conversation {
  readonly id: string;
  /**
   * Owning project scope (S9.17-004 NAV-05): `null` = workspace-global
   * conversation (the LEGACY default — persisted unscoped conversations keep
   * `null` forever and are never auto-injected into a project). A non-null
   * value is the explicit project id this conversation belongs to. The id is
   * explicit metadata, NEVER inferred from object ids.
   */
  readonly projectId: string | null;
  /** User-facing title (defaults to "Conversation N"). */
  readonly title: string;
  /** Full transcript of this conversation (AI SDK UIMessage shapes). */
  readonly messages: readonly UIMessageLike[];
  /** Per-conversation chat harness payload (context/token/approvals). */
  readonly payload: ConversationPayload;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Monotonic per-conversation revision — bumped on every message upsert. */
  readonly revision: number;
}

/**
 * Immutable multi-conversation state snapshot. S9.17-004 NAV-05 adds the
 * project scope: `currentProjectId` is the scope the UI shows, and
 * `activeByProject` records each scope's last-active conversation id so
 * project switches restore the previous chat instead of leaking the active
 * conversation context across projects. A scope-keyed map key
 * (`WORKSPACE_SCOPE_KEY` for workspace-global, else
 * `PROJECT_SCOPE_PREFIX + encodeURIComponent(projectId)` — see `scopeKeyFor`;
 * namespaced + encoded, so a project named "workspace" never collides with
 * the workspace scope).
 * `lastUsedProjectId` is the normalized last-used scope (persisted to local
 * store; never a fresh object — see `hydrateFromPersisted`).
 */
export interface ChatConversationsState {
  readonly conversations: Readonly<Record<string, Conversation>>;
  readonly activeId: string | null;
  /** Creation sequence — drives default titles and stable ordering. */
  readonly nextSeq: number;
  /** The project scope currently shown by the chat UI (null = workspace). */
  readonly currentProjectId: string | null;
  /** scopeKey → last-active conversation id in that scope (S9.17-004). */
  readonly activeByProject: Readonly<Record<string, string>>;
  /** Normalized last-used scope key (persisted; not a fresh object). */
  readonly lastUsedProjectId: string | null;
}

/** Scope-map key for workspace-global conversations (projectId null). */
export const WORKSPACE_SCOPE_KEY = "workspace";

/**
 * Namespace prefix for project scope keys (see `scopeKeyFor`). The prefix
 * itself can never collide with an encoded project id because
 * `encodeURIComponent(":")` emits `%3A` — every key this module produces is
 * either exactly `workspace` or starts with `project:`.
 */
export const PROJECT_SCOPE_PREFIX = "project:";

/**
 * Stable, injective scope-map key for a project scope (nullish → workspace
 * key). Project ids are URI-encoded so the key round-trips EXACTLY —
 * including the empty string (a valid project id that must stay distinct
 * from the workspace) and hostile ids like `"workspace"`, `"__proto__"`,
 * `"constructor"`, `"toString"` or any unicode/slash id. Two different
 * project ids ALWAYS produce two different keys, so a project literally
 * named "workspace" can never merge into the global scope.
 */
export function scopeKeyFor(projectId: string | null): string {
  return projectId == null
    ? WORKSPACE_SCOPE_KEY
    : `${PROJECT_SCOPE_PREFIX}${encodeURIComponent(projectId)}`;
}

/**
 * Inverse of `scopeKeyFor`. The workspace key resolves to the null project
 * scope; a `project:`-prefixed key decodes back to the exact project id
 * (lossless — no normalization). Fail-closed: malformed %-escapes and
 * unknown namespaces resolve to null (never to a guessed project id).
 */
export function projectIdFromScopeKey(key: string): string | null {
  if (key === WORKSPACE_SCOPE_KEY) return null;
  if (key.startsWith(PROJECT_SCOPE_PREFIX)) {
    try {
      return decodeURIComponent(key.slice(PROJECT_SCOPE_PREFIX.length));
    } catch {
      return null; // malformed %-escape — not a key this module produced
    }
  }
  return null; // unknown namespace — fail closed (never a project id)
}

/** Fallback when no active conversation matches (defensive). */
export const NO_ACTIVE_CONVERSATION: string | null = null;

/** Maximum user-named conversation title length (UI enforces; core guards). */
export const CONVERSATION_TITLE_MAX = 64;

/** Default per-conversation token budget (harness precedent: 4000). */
export const DEFAULT_CONVERSATION_BUDGET = 4000;

/** Empty per-conversation payload (no harness sources on a fresh call). */
export const EMPTY_CONVERSATION_PAYLOAD: Readonly<ConversationPayload> = {
  contextSources: [],
  tokenBudget: DEFAULT_CONVERSATION_BUDGET,
  approvals: [],
};

/** Build a fresh default multi-conversation state (one empty conversation). */
export function defaultChatConversations(title = "Conversation 1"): ChatConversationsState {
  const now = Date.now();
  const first: Conversation = {
    id: "conversation-1",
    projectId: null, // workspace-global (legacy default)
    title,
    messages: [],
    payload: { ...EMPTY_CONVERSATION_PAYLOAD },
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
  return {
    conversations: { [first.id]: first },
    activeId: first.id,
    nextSeq: 2,
    currentProjectId: null,
    activeByProject: { [WORKSPACE_SCOPE_KEY]: first.id },
    lastUsedProjectId: null,
  };
}

/** A unique "Conversation N" title that does not collide with existing names. */
export function nextConversationTitle(
  conversations: Readonly<Record<string, Conversation>>,
  startSeq: number,
): string {
  const taken = new Set(Object.values(conversations).map((c) => c.title));
  let n = startSeq;
  while (taken.has(`Conversation ${n}`)) n += 1;
  return `Conversation ${n}`;
}

/** Create a conversation; returns a NEW state (never mutates input). */
export function createConversation(
  state: ChatConversationsState,
  title?: string,
  payload?: Partial<ConversationPayload>,
  projectId: string | null = state.currentProjectId,
): ChatConversationsState {
  const id = `conversation-${state.nextSeq}`;
  const name =
    title && title.trim().length > 0
      ? title.trim().slice(0, CONVERSATION_TITLE_MAX)
      : nextConversationTitle(state.conversations, state.nextSeq);
  const now = Date.now();
  const conversation: Conversation = {
    id,
    projectId: projectId ?? null,
    title: name,
    messages: [],
    payload: {
      contextSources: payload?.contextSources ?? EMPTY_CONVERSATION_PAYLOAD.contextSources,
      tokenBudget: payload?.tokenBudget ?? EMPTY_CONVERSATION_PAYLOAD.tokenBudget,
      approvals: payload?.approvals ?? EMPTY_CONVERSATION_PAYLOAD.approvals,
    },
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
  const scopeKey = scopeKeyFor(conversation.projectId);
  return {
    conversations: { ...state.conversations, [id]: conversation },
    activeId: id,
    nextSeq: state.nextSeq + 1,
    currentProjectId: state.currentProjectId,
    activeByProject: { ...state.activeByProject, [scopeKey]: id },
    lastUsedProjectId: state.lastUsedProjectId,
  };
}

/** Switch the active conversation; returns the same state when unknown. */
export function switchConversation(
  state: ChatConversationsState,
  id: string,
): ChatConversationsState {
  // own-property check only — inherited names ("constructor") must never
  // become the active conversation
  if (!Object.hasOwn(state.conversations, id)) return state;
  return { ...state, activeId: id };
}

/** Rename a conversation; strips whitespace; rejects empty/unchanged. */
export function renameConversation(
  state: ChatConversationsState,
  id: string,
  title: string,
): ChatConversationsState {
  if (!Object.hasOwn(state.conversations, id)) return state;
  const current = state.conversations[id];
  if (!current) return state;
  const trimmed = title.trim().slice(0, CONVERSATION_TITLE_MAX);
  if (trimmed.length === 0 || trimmed === current.title) return state;
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [id]: { ...current, title: trimmed, updatedAt: Date.now() },
    },
  };
}

/**
 * Delete a conversation; when the active one is removed the next remaining
 * conversation (same scope preferred, then key order) becomes active, or
 * NO_ACTIVE when empty. The deleted conversation's scope entry is dropped
 * from `activeByProject` so a stale last-active id is never restored.
 */
export function deleteConversation(
  state: ChatConversationsState,
  id: string,
): ChatConversationsState {
  if (!Object.hasOwn(state.conversations, id)) return state;
  const { [id]: _removed, ...rest } = state.conversations;
  void _removed;
  // null-prototype source so hostile copied keys can never hit the
  // `__proto__` setter
  const activeByProject: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, cid] of Object.entries(state.activeByProject)) {
    if (cid !== id) activeByProject[key] = cid;
  }
  let activeId = state.activeId;
  if (activeId === id) {
    // Prefer the next remaining conversation in the SAME scope so the active
    // chat never jumps to another project's context.
    const sameScope = Object.values(rest).filter(
      (convo) => convo.projectId === state.currentProjectId,
    );
    const ordered =
      sameScope.length > 0
        ? sameScope
        : Object.values(rest).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    activeId =
      ordered.length > 0 ? (ordered[0]?.id ?? NO_ACTIVE_CONVERSATION) : NO_ACTIVE_CONVERSATION;
  }
  return { ...state, conversations: rest, activeId, activeByProject };
}

/**
 * Upsert the full transcript of a conversation (snapshot-back). No-ops when
 * the conversation is unknown or the new message list is identical to the
 * stored one.
 */
export function upsertConversationMessages(
  state: ChatConversationsState,
  id: string,
  messages: readonly UIMessageLike[],
): ChatConversationsState {
  if (!Object.hasOwn(state.conversations, id)) return state;
  const current = state.conversations[id];
  if (!current) return state;
  let identical = true;
  if (current.messages.length === messages.length) {
    for (let i = 0; i < messages.length; i += 1) {
      if (current.messages[i] !== messages[i]) {
        identical = false;
        break;
      }
    }
  } else {
    identical = false;
  }
  if (identical) return state;
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [id]: {
        ...current,
        messages,
        updatedAt: Date.now(),
        revision: current.revision + 1,
      },
    },
  };
}

/** Update the per-conversation harness payload (context/token/approvals). */
export function setConversationPayload(
  state: ChatConversationsState,
  id: string,
  payload: Partial<ConversationPayload>,
): ChatConversationsState {
  if (!Object.hasOwn(state.conversations, id)) return state;
  const current = state.conversations[id];
  if (!current) return state;
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [id]: {
        ...current,
        payload: {
          contextSources: payload.contextSources ?? current.payload.contextSources,
          tokenBudget: payload.tokenBudget ?? current.payload.tokenBudget,
          approvals: payload.approvals ?? current.payload.approvals,
        },
        updatedAt: Date.now(),
      },
    },
  };
}

/** The active conversation (fallback null when none). */
export function activeConversationOf(state: ChatConversationsState): Conversation | null {
  if (state.activeId === null) return null;
  // own-property only — an inherited name must never resolve to an object
  // that was never a real conversation
  return Object.hasOwn(state.conversations, state.activeId)
    ? (state.conversations[state.activeId] as Conversation)
    : null;
}

/** Per-conversation list stats (S9.6-006 list row: token bar + counts). */
export interface ConversationListStats {
  readonly usedTokens: number;
  readonly budget: number;
  readonly sourceCount: number;
  readonly approvalCount: number;
  readonly dirty: boolean;
  /** Ratio 0..1 for the token bar (clamped). */
  readonly ratio: number;
}

/** Stats for the conversation list rows (deterministic, pure). */
export function conversationStats(convo: Conversation): ConversationListStats {
  const usedTokens = convo.payload.contextSources.reduce((acc, s) => acc + s.tokens, 0);
  const budget = convo.payload.tokenBudget;
  const ratio = budget > 0 ? Math.min(1, usedTokens / budget) : 0;
  return {
    usedTokens,
    budget,
    sourceCount: convo.payload.contextSources.length,
    approvalCount: convo.payload.approvals.length,
    dirty: convo.revision > 0,
    ratio,
  };
}

/**
 * Deterministic list order for the conversation UI (S9.6-006): most recently
 * updated first; ties broken by creation time (older first).
 */
export function conversationsSorted(
  conversations: Readonly<Record<string, Conversation>>,
): Conversation[] {
  return Object.values(conversations).sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return a.createdAt - b.createdAt;
  });
}

/** Round-trip a persisted conversation, defensively filling any missing field. */
export function coerceConversation(raw: Conversation): Conversation {
  const payload: ConversationPayload = {
    contextSources: raw.payload?.contextSources ?? EMPTY_CONVERSATION_PAYLOAD.contextSources,
    tokenBudget: raw.payload?.tokenBudget ?? EMPTY_CONVERSATION_PAYLOAD.tokenBudget,
    approvals: raw.payload?.approvals ?? EMPTY_CONVERSATION_PAYLOAD.approvals,
  };
  return {
    id: raw.id,
    // Legacy persisted conversations have NO projectId → null (workspace),
    // which stays null forever — never auto-injected into a project.
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    title: raw.title?.trim() ? raw.title.slice(0, CONVERSATION_TITLE_MAX) : "Conversation",
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    payload,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
    revision: raw.revision ?? 0,
  };
}

export interface HydratedChatState {
  readonly state: ChatConversationsState;
  /** True when at least one persisted conversation was loaded. */
  readonly restored: boolean;
}

/**
 * S9.6-007 — rebuild a store state from persisted conversations (boot
 * hydrate). When nothing was persisted → returns a default single
 * conversation (the same shape `defaultChatConversations()` produced).
 * `nextSeq` is computed past every numeric `conversation-N` id so future
 * creates never collide with restored ids. `activeByProject` is normalized
 * deterministically (per scope, the most recently updated conversation;
 * ties broken by creation time then id order) — never a fresh empty object,
 * so no scope's last-active id is lost. `activeId` targets the workspace
 * scope (the UI's scope at boot is workspace); entering a project scope via
 * `enterProjectScope` later restores that scope's last-active instead.
 */
export function hydrateFromPersisted(persisted: readonly Conversation[]): HydratedChatState {
  // null-prototype map: hostile persisted ids ("__proto__", "constructor",
  // "toString", "") become inert own data properties — never prototype
  // pollution, never inherited-content resolution
  const conversations = Object.create(null) as Record<string, Conversation>;
  for (const raw of persisted) {
    const convo = coerceConversation(raw);
    conversations[convo.id] = convo;
  }
  const ids = Object.keys(conversations);
  if (ids.length === 0) {
    return { state: defaultChatConversations(), restored: false };
  }
  let maxSeq = 0;
  for (const id of ids) {
    const m = /^conversation-(\d+)$/.exec(id);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  // Deterministic per-scope last-active normalization: for each scope pick
  // the conversation with the newest updatedAt; ties → createdAt, then id.
  const activeByProject = Object.create(null) as Record<string, string>;
  const sortedIds = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of sortedIds) {
    const convo = conversations[id]!;
    const key = scopeKeyFor(convo.projectId);
    const currentId = activeByProject[key];
    if (currentId === undefined) {
      activeByProject[key] = id;
      continue;
    }
    const current = conversations[currentId]!;
    const newer =
      convo.updatedAt > current.updatedAt ||
      (convo.updatedAt === current.updatedAt && convo.createdAt > current.createdAt);
    if (newer) activeByProject[key] = id;
  }
  return {
    state: {
      conversations,
      activeId: ids[0] ?? null,
      nextSeq: maxSeq + 1,
      currentProjectId: null,
      activeByProject,
      lastUsedProjectId: null,
    },
    restored: true,
  };
}

/**
 * S9.17-004 NAV-05 — switch the chat scope to a project. When the requested
 * scope already has a last-active conversation it is restored; otherwise a
 * FRESH conversation is created scoped to that project with the bounded id
 * sequence (never colliding with persisted ids). Re-entering the current
 * scope with a scope-correct active conversation is a no-op. The returned
 * state is immutable (never mutates input).
 */
export function enterProjectScope(
  state: ChatConversationsState,
  projectId: string | null,
): ChatConversationsState {
  const normalized = projectId ?? null;
  if (state.currentProjectId === normalized) {
    const active =
      state.activeId !== null && Object.hasOwn(state.conversations, state.activeId)
        ? state.conversations[state.activeId]
        : null;
    if (active && active.projectId === normalized) return state;
  }
  const key = scopeKeyFor(normalized);
  const lastId = Object.hasOwn(state.activeByProject, key) ? state.activeByProject[key] : undefined;
  if (
    lastId !== undefined &&
    Object.hasOwn(state.conversations, lastId) &&
    state.conversations[lastId]!.projectId === normalized
  ) {
    return {
      ...state,
      currentProjectId: normalized,
      lastUsedProjectId: normalized,
      activeId: lastId,
    };
  }
  // No last-active conversation in this scope → create a fresh scoped one.
  const created = createConversation(state, undefined, undefined, normalized);
  return {
    ...created,
    currentProjectId: normalized,
    lastUsedProjectId: normalized,
  };
}

/**
 * Scope-only conversation map for the UI lists (S9.17-004): every
 * conversation whose projectId equals the given scope (null → workspace
 * global). Never surfaces another project's conversations.
 */
export function conversationsForScope(
  conversations: Readonly<Record<string, Conversation>>,
  scopeProjectId: string | null,
): Record<string, Conversation> {
  const out = Object.create(null) as Record<string, Conversation>;
  for (const [id, convo] of Object.entries(conversations)) {
    if (convo.projectId === (scopeProjectId ?? null)) out[id] = convo;
  }
  return out;
}
