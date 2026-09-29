import { create } from "zustand";
import {
  initialChatState,
  type ApprovalCard,
  type CapabilityProposal,
  type ChatMessage,
  type ChatModel,
  type ContextSource,
  decideCard,
  journalDecision,
  reduceRedirect,
  reduceRevokeModel,
  reduceTogglePicker,
  userRequest,
} from "./chat-core";

/**
 * Chat harness panel store — S9-006. Thin zustand wrapper over the dependency-
 * free core (`state/chat-core.ts`); the panel renders messages, context
 * sources, token budgets, approval cards and the BYOK model picker. The model
 * has NO direct printer capability — assistant outputs that propose a
 * capability are proposals, broker-gated.
 */

interface ChatStore {
  readonly messages: readonly ChatMessage[];
  readonly models: readonly ChatModel[];
  readonly selectedModelId: string | null;
  readonly pickerOpen: boolean;
  /** Shared sequence counter; advanced by core reducers (decideCard journals on it). */
  readonly nextSeq: number;
  readonly selectModel: (modelId: string) => void;
  readonly togglePicker: () => void;
  readonly revokeModel: (modelId: string) => void;
  /** Inject a user request; if a capability is proposed it is NEVER auto-executed. */
  readonly send: (
    text: string,
    sources: readonly ContextSource[],
    budget: number,
    proposal: CapabilityProposal | null,
  ) => void;
  readonly decide: (cardId: string, approved: boolean) => void;
  /** Model picker helper: the primary provider is always listed first. */
  readonly pickerModels: () => readonly ChatModel[];
}

export const useChat = create<ChatStore>()((set, get) => ({
  ...initialChatState,
  pickerOpen: false,
  selectModel: (modelId) => set((s) => reduceRedirect(s, modelId)),
  togglePicker: () => set((s) => reduceTogglePicker(s)),
  revokeModel: (modelId) => set((s) => reduceRevokeModel(s, modelId)),
  send: (text, sources, budget, proposal) =>
    set((s) => userRequest(s, text, sources, budget, proposal)),
  decide: (cardId, approved) => set((s) => decideCard(s, cardId, approved)),
  pickerModels: () => get().models,
}));

/** Journaling hook consumers attach to the ledger (kept pure for tests). */
export { journalDecision };
export type { ApprovalCard, ChatMessage, ContextSource };
