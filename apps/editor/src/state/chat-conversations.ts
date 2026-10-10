import { create } from "zustand";
import {
  activeConversationOf,
  createConversation as coreCreate,
  deleteConversation as coreDelete,
  defaultChatConversations,
  enterProjectScope as coreEnterScope,
  renameConversation as coreRename,
  setConversationPayload as coreSetPayload,
  switchConversation as coreSwitch,
  upsertConversationMessages as coreUpsert,
  WORKSPACE_SCOPE_KEY,
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
 *
 * S9.17-004 NAV-05 (project-scoped chat context): the store owns the current
 * project scope (`currentProjectId`) + per-scope last-active mapping
 * (`activeByProject`). `enterProjectScope` is called by the App when a
 * project is activated (create/open/continue/recover) — switching pages
 * never changes the scope, so the active conversation persists across all
 * four pages without leaking another project's context.
 */

interface ChatConversationsStore {
  readonly conversations: Readonly<Record<string, Conversation>>;
  readonly activeId: string | null;
  readonly nextSeq: number;
  readonly currentProjectId: string | null;
  readonly activeByProject: Readonly<Record<string, string>>;
  readonly lastUsedProjectId: string | null;
  readonly create: (title?: string, payload?: Partial<ConversationPayload>) => void;
  readonly switchTo: (id: string) => void;
  readonly rename: (id: string, title: string) => void;
  readonly remove: (id: string) => void;
  /** Snapshot-back the full transcript of a conversation. */
  readonly upsertMessages: (id: string, messages: readonly UIMessageLike[]) => void;
  readonly setPayload: (id: string, payload: Partial<ConversationPayload>) => void;
  /**
   * S9.6-007 — replace the whole state from persistence (boot hydrate).
   * Scope-preserving: never overwrites an already-active project scope when
   * the hydration resolves later; the current scope's last-active from the
   * restored data is re-applied (bring scope requested current).
   */
  readonly hydrate: (state: ChatConversationsState) => void;
  /**
   * S9.17-004 NAV-05 — activate a project scope (restore its last-active
   * conversation or create a fresh one). Null switches to the workspace
   * scope. Never called by page navigation.
   */
  readonly enterProjectScope: (projectId: string | null) => void;
}

export const useChatConversations = create<ChatConversationsStore>()((set) => ({
  ...defaultChatConversations(),
  create: (title, payload) => set((s) => coreCreate(s, title, payload)),
  switchTo: (id) => set((s) => coreSwitch(s, id)),
  rename: (id, title) => set((s) => coreRename(s, id, title)),
  remove: (id) => set((s) => coreDelete(s, id)),
  upsertMessages: (id, messages) => set((s) => coreUpsert(s, id, messages)),
  setPayload: (id, payload) => set((s) => coreSetPayload(s, id, payload)),
  enterProjectScope: (projectId) => set((s) => coreEnterScope(s, projectId)),
  hydrate: (state) =>
    set((current) => {
      // Never overwrite the current active PROJECT scope when hydration lands
      // later; keep currentProjectId and re-apply the hydrated state's
      // last-active for that scope.
      const next = {
        ...state,
        currentProjectId: current.currentProjectId,
        lastUsedProjectId: current.lastUsedProjectId,
      };
      const scopeKey = current.currentProjectId ?? WORKSPACE_SCOPE_KEY;
      const scopedId = state.activeByProject[scopeKey];
      let activeId: string | null;
      if (scopedId !== undefined && Object.hasOwn(state.conversations, scopedId)) {
        activeId = scopedId;
      } else if (
        current.activeId !== null &&
        Object.hasOwn(state.conversations, current.activeId) &&
        state.conversations[current.activeId]!.projectId === current.currentProjectId
      ) {
        activeId = current.activeId;
      } else {
        activeId = null;
      }
      return { ...next, activeId };
    }),
}));

/** Selector-safe: returns the active Conversation object (stable ref) or null. */
export function useActiveConversation(): Conversation | null {
  // Selector returns a stable reference from state — never a new object per
  // snapshot (zustand + useSyncExternalStore infinite-loop trap, S9.6-001).
  return useChatConversations((s) => activeConversationOf(s));
}

export type { ChatConversationsState, Conversation, ConversationPayload, UIMessageLike };
