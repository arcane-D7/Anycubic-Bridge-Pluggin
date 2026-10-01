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

/** Immutable multi-conversation state snapshot. */
export interface ChatConversationsState {
  readonly conversations: Readonly<Record<string, Conversation>>;
  readonly activeId: string | null;
  /** Creation sequence — drives default titles and stable ordering. */
  readonly nextSeq: number;
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
): ChatConversationsState {
  const id = `conversation-${state.nextSeq}`;
  const name =
    title && title.trim().length > 0
      ? title.trim().slice(0, CONVERSATION_TITLE_MAX)
      : nextConversationTitle(state.conversations, state.nextSeq);
  const now = Date.now();
  const conversation: Conversation = {
    id,
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
  return {
    conversations: { ...state.conversations, [id]: conversation },
    activeId: id,
    nextSeq: state.nextSeq + 1,
  };
}

/** Switch the active conversation; returns the same state when unknown. */
export function switchConversation(
  state: ChatConversationsState,
  id: string,
): ChatConversationsState {
  if (!(id in state.conversations)) return state;
  return { ...state, activeId: id };
}

/** Rename a conversation; strips whitespace; rejects empty/unchanged. */
export function renameConversation(
  state: ChatConversationsState,
  id: string,
  title: string,
): ChatConversationsState {
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
 * conversation (order of keys) becomes active, or NO_ACTIVE when empty.
 */
export function deleteConversation(
  state: ChatConversationsState,
  id: string,
): ChatConversationsState {
  if (!(id in state.conversations)) return state;
  const { [id]: _removed, ...rest } = state.conversations;
  void _removed;
  let activeId = state.activeId;
  if (activeId === id) {
    const remaining = Object.keys(rest);
    activeId =
      remaining.length > 0 ? (remaining[0] ?? NO_ACTIVE_CONVERSATION) : NO_ACTIVE_CONVERSATION;
  }
  return { ...state, conversations: rest, activeId };
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
  return state.activeId !== null ? (state.conversations[state.activeId] ?? null) : null;
}
