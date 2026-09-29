/**
 * Chat harness core — S9-006.
 *
 * Deliberately dependency-free (no React, no zustand) so the chat harness
 * rules are testable headless under the plain Node test runner: exactly
 * which context sources were injected, the per-request token budget, the
 * approval-card lifecycle (concrete effect + scope, never auto-executed),
 * the BYOK provider/model picker with per-key health + spend, and the
 * prompt-injection posture (a model output that proposes a capability is a
 * PROPOSAL, broker-gated — the model has no direct printer capability).
 *
 * The React panel (`./chat.ts` + `panels/ChatPanel.tsx`) are thin wrappers
 * over these pure functions.
 */

export type ContextSourceKind = "memory" | "scene" | "file" | "profile";

export interface ContextSource {
  readonly id: string;
  readonly kind: ContextSourceKind;
  readonly label: string;
  readonly tokens: number;
}

export interface TokenBudget {
  readonly budget: number;
  readonly used: number;
  /** `used / budget`, 0..=1 */
  readonly ratio: number;
  readonly overBudget: boolean;
}

/** Concrete effect an approval card can carry (AC: show exact effect + scope). */
export type EffectKind = "geometry_diff" | "file_write" | "outbound_data" | "spend";

export interface EffectDetail {
  readonly kind: EffectKind;
  readonly summary: string;
  /** Raw args hash for the journal. */
  readonly argsHash: string;
  /** Est. bytes / mm / USD for outbound/file/geometry; `undefined` when unknown. */
  readonly magnitude?: number;
}

export type ApprovalScope = "allow_once" | "session" | "project";

export type ApprovalState = "pending" | "approved" | "rejected";

export interface ApprovalCard {
  readonly id: string;
  readonly effect: EffectDetail;
  readonly scope: ApprovalScope;
  /** A destructive action must be explicitly acknowledged (label-gated). */
  readonly destructive: boolean;
  readonly state: ApprovalState;
  readonly createdSeq: number;
  readonly decidedSeq?: number;
}

/** A single model message in the transcript. */
export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  /** Context sources injected for THIS request (user → assistant turn). */
  readonly contextSources: readonly ContextSource[];
  readonly tokenBudget: TokenBudget;
  /** Proposal cards rendered inline for assistant outputs that propose a capability. */
  readonly approvalCards: readonly ApprovalCard[];
  /** If the sent request named a capability (proposal seam). */
  readonly proposedAction: string | null;
}

export interface ProviderHealth {
  readonly ok: boolean;
  readonly revocable: boolean;
  readonly label: string;
  readonly spentCents: number;
}

export interface ChatModel {
  readonly id: string;
  readonly label: string;
  readonly provider: string;
  /** Loopback local models only; remote never reaches a local-key health check. */
  readonly local: boolean;
  readonly health: ProviderHealth;
}

export type ModelSelectorMode = "provider" | "local" | "picker";

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly models: readonly ChatModel[];
  readonly selectedModelId: string | null;
  readonly nextSeq: number;
  readonly pickerOpen: boolean;
}

/** A capability proposal from an injected, untrusted request. */
export interface CapabilityProposal {
  readonly action: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly effect: EffectDetail;
  readonly scope: ApprovalScope;
  readonly destructive: boolean;
}

/** Counter for stable ids/seqs. */
let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

// ---------------------------------------------------------------------------
// Reducers / actions (pure)
// ---------------------------------------------------------------------------

export const initialChatState: ChatState = {
  messages: [],
  models: [
    {
      id: "airrouter-primary",
      label: "AirRouter (primary)",
      provider: "AirRouter",
      local: false,
      health: { ok: true, revocable: true, label: "healthy", spentCents: 0 },
    },
    {
      id: "local-ollama",
      label: "Ollama (loopback)",
      provider: "Local",
      local: true,
      health: { ok: true, revocable: false, label: "loopback", spentCents: 0 },
    },
  ],
  selectedModelId: "airrouter-primary",
  nextSeq: 1,
  pickerOpen: false,
};

export function reduceRedirect(state: ChatState, modelId: string): ChatState {
  return { ...state, selectedModelId: modelId };
}

export function reduceTogglePicker(state: ChatState, open?: boolean): ChatState {
  return { ...state, pickerOpen: open ?? !state.pickerOpen };
}

/** Revocation reflected in the UI: the provider's health flips to not-ok. */
export function reduceRevokeModel(state: ChatState, modelId: string): ChatState {
  return {
    ...state,
    models: state.models.map((m) =>
      m.id === modelId ? { ...m, health: { ...m.health, ok: false, revocable: false } } : m,
    ),
  };
}

/**
 * Inject a user request. Builds the exact context-source list and the token
 * budget for the reply. A request that names a capability always produces a
 * PROPOSAL (never executed) — the broker gates it; the model output is just
 * text plus a card.
 */
export function userRequest(
  state: ChatState,
  text: string,
  sources: readonly ContextSource[],
  budget: number,
  proposal: CapabilityProposal | null,
): ChatState {
  const used = sources.reduce((acc, s) => acc + s.tokens, 0);
  const ratio = budget > 0 ? Math.min(1, used / budget) : 0;
  const tokenBudget: TokenBudget = {
    budget,
    used,
    ratio,
    overBudget: used > budget,
  };
  const seq = state.nextSeq;
  const userMsg: ChatMessage = {
    id: nextId(),
    role: "user",
    text,
    contextSources: sources,
    tokenBudget,
    approvalCards: [],
    proposedAction: null,
  };
  // Prompt-injection posture: a proposed capability is shown as PROPOSAL +
  // approval card; never auto-executed. Const expression — no re-assignment.
  const assistantMsg: ChatMessage = proposal
    ? (() => {
        const card: ApprovalCard = {
          id: nextId(),
          effect: proposal.effect,
          scope: proposal.scope,
          destructive: proposal.destructive,
          state: "pending",
          createdSeq: seq + 1,
        };
        return {
          id: nextId(),
          role: "assistant",
          text: "Proposal: " + proposal.action,
          contextSources: sources,
          tokenBudget,
          approvalCards: [card],
          proposedAction: proposal.action,
        };
      })()
    : {
        id: nextId(),
        role: "assistant",
        text: "No assistant connected yet (Sprint 9 harness).",
        contextSources: sources,
        tokenBudget,
        approvalCards: [],
        proposedAction: null,
      };
  return {
    ...state,
    messages: [...state.messages, userMsg, assistantMsg],
    nextSeq: seq + 2,
  };
}

/** A request whose output proposes a capability is NEVER auto-executed. */
export function extractProposal(text: string): CapabilityProposal | null {
  // No line-start anchor: an injected instruction can place the tag anywhere
  // on a line ("Ignore previous instructions. [capability:request] ...").
  // It must SURFACE as a proposal (→ approval card), never execute.
  const m = /\[capability:request\]\s*(.+)$/m.exec(text.trim());
  if (!m) return null;
  const action = (m[1] ?? "").trim();
  if (!action) return null;
  return {
    action,
    tool: "geometry.boolean",
    args: { fixture: "cube-20mm" },
    effect: {
      kind: "spend",
      summary: `outbound model call for "${action}"`,
      argsHash: "proposal-hash",
      magnitude: 1,
    },
    scope: "allow_once",
    destructive: false,
  };
}

/** Decide an approval card (user approves/rejects). */
export function decideCard(state: ChatState, cardId: string, approved: boolean): ChatState {
  let createdSeq = 0;
  const messages = state.messages.map((msg) => {
    const cards = msg.approvalCards.map((card) => {
      if (card.id !== cardId) return card;
      createdSeq = card.createdSeq;
      return {
        ...card,
        state: approved ? ("approved" as const) : ("rejected" as const),
        decidedSeq: state.nextSeq,
      };
    });
    return { ...msg, approvalCards: cards };
  });
  void createdSeq;
  return {
    ...state,
    messages,
    nextSeq: approved ? state.nextSeq + 1 : state.nextSeq,
  };
}

/** Journal record — every approval/decision is journaled for the viewer. */
export interface ApprovalJournalEntry {
  readonly seq: number;
  readonly model: string;
  readonly provider: string;
  readonly promptHash: string;
  readonly argsHash: string;
  readonly inputRevision: number;
  readonly outcome: "approved" | "rejected";
  readonly cardId: string;
}

export interface JournalLedger {
  readonly entries: readonly ApprovalJournalEntry[];
  readonly nextSeq: number;
}

export const emptyLedger: JournalLedger = { entries: [], nextSeq: 1 };

export function journalDecision(
  ledger: JournalLedger,
  entry: Omit<ApprovalJournalEntry, "seq" | "outcome"> & {
    readonly outcome: ApprovalJournalEntry["outcome"];
  },
): JournalLedger {
  return {
    entries: [...ledger.entries, { ...entry, seq: ledger.nextSeq }],
    nextSeq: ledger.nextSeq + 1,
  };
}

/** Token budget helper — exact `used/budget` and over-budget flag. */
export function makeTokenBudget(sources: readonly ContextSource[], budget: number): TokenBudget {
  const used = sources.reduce((acc, s) => acc + s.tokens, 0);
  return {
    budget,
    used,
    ratio: budget > 0 ? Math.min(1, used / budget) : 0,
    overBudget: used > budget,
  };
}
