import { create } from "zustand";
import {
  activeConversationOf,
  createConversation as coreCreate,
  deleteConversation as coreDelete,
  defaultChatConversations,
  renameConversation as coreRename,
  setConversationPayload as coreSetPayload,
  switchConversation as coreSwitch,
  upsertConversationMessages as coreUpsert,
  type ChatConversationsState,
  type Conversation,
  type ConversationPayload,
  type UIMessageLike,
} from "./chat-conversations-core";

/**
 * S9.6-005 multi-conversation chat store — thin zustand wrapper over the
 * dependency-free core (`state/chat-conversations-core.ts`).
 *
 * Mandate C: cada conversa tem histórico ISOLADO. This store is the SOURCE
 * OF TRUTH for conversations — the AI SDK `useChat` hooks mount per active
 * conversation (`<ChatThread key={activeId}/>`) and hydrate/snapshot through
 * `upsertMessages`; the SDK's own id-keyed localStorage persistence is never
 * used.
 */

interface ChatConversationsStore {
  readonly conversations: Readonly<Record<string, Conversation>>;
  readonly activeId: string | null;
  readonly nextSeq: number;
  readonly create: (title?: string, payload?: Partial<ConversationPayload>) => void;
  readonly switchTo: (id: string) => void;
  readonly rename: (id: string, title: string) => void;
  readonly remove: (id: string) => void;
  /** Snapshot-back the full transcript of a conversation. */
  readonly upsertMessages: (id: string, messages: readonly UIMessageLike[]) => void;
  readonly setPayload: (id: string, payload: Partial<ConversationPayload>) => void;
}

export const useChatConversations = create<ChatConversationsStore>()((set) => ({
  ...defaultChatConversations(),
  create: (title, payload) => set((s) => coreCreate(s, title, payload)),
  switchTo: (id) => set((s) => coreSwitch(s, id)),
  rename: (id, title) => set((s) => coreRename(s, id, title)),
  remove: (id) => set((s) => coreDelete(s, id)),
  upsertMessages: (id, messages) => set((s) => coreUpsert(s, id, messages)),
  setPayload: (id, payload) => set((s) => coreSetPayload(s, id, payload)),
}));

/** Selector-safe: returns the active Conversation object (stable ref) or null. */
export function useActiveConversation(): Conversation | null {
  // Selector returns a stable reference from state — never a new object per
  // snapshot (zustand + useSyncExternalStore infinite-loop trap, S9.6-001).
  return useChatConversations((s) => activeConversationOf(s));
}

export type { ChatConversationsState, Conversation, ConversationPayload, UIMessageLike };
