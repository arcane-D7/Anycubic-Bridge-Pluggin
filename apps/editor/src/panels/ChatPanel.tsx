import { useEffect, useState } from "react";
import type {
  ContextSource,
  CapabilityProposal,
  ChatModel,
  ApprovalCard,
} from "../state/chat-core";
import { useChat } from "../state/chat";

/**
 * Right panel — chat harness v1 (S9-006). Shows exactly which context sources
 * were injected, the per-request token budget meter, inline approval cards
 * (concrete effect + scope; destructive actions explicit; never auto-
 * executed), and the BYOK provider/model picker with per-key health + spend,
 * with revocation reflected in the UI. The model has NO direct printer
 * capability — a proposed capability renders as a proposal + approval card.
 */

const EXAMPLE_SOURCES: readonly ContextSource[] = [
  { id: "mem-1", kind: "memory", label: "Memory: last-job (similar)", tokens: 240 },
  { id: "scene-1", kind: "scene", label: "Scene: print-bed-block", tokens: 80 },
  { id: "file-1", kind: "file", label: "File: cube-20mm.stl", tokens: 120 },
];

const TOKEN_BUDGET = 4000;

function TokenBudgetMeter({
  budget,
}: {
  readonly budget: {
    readonly used: number;
    readonly budget: number;
    readonly ratio: number;
    readonly overBudget: boolean;
  };
}) {
  const pct = Math.round(budget.ratio * 100);
  return (
    <div className="token-budget" data-testid="token-budget">
      <span className="token-label">Tokens</span>
      <span className="token-used" data-testid="token-used">
        {budget.used}/{budget.budget}
      </span>
      <div className="budget-bar" aria-hidden="true">
        <div
          className={"budget-fill" + (budget.overBudget ? " over" : "")}
          style={{ width: `${pct}%` }}
        />
      </div>
      {budget.overBudget ? (
        <span className="budget-warn" data-testid="budget-warn">
          over budget
        </span>
      ) : null}
    </div>
  );
}

function ApprovalCardView({ card }: { readonly card: ApprovalCard }) {
  return (
    <div className="approval-card" data-testid="approval-card" data-state={card.state}>
      <span className="approval-effect" data-testid="approval-effect">
        {card.effect.kind}: {card.effect.summary}
      </span>
      <span className="approval-scope" data-testid="approval-scope">
        scope: {card.scope}
      </span>
      {card.destructive ? (
        <span className="approval-destructive" data-testid="approval-destructive">
          destructive
        </span>
      ) : null}
      <span className="approval-state" data-testid="approval-state">
        {card.state}
      </span>
    </div>
  );
}

export function ChatPanel() {
  const {
    messages,
    models,
    selectedModelId,
    pickerOpen,
    selectModel,
    togglePicker,
    revokeModel,
    send,
    decide,
  } = useChat();

  const [draft, setDraft] = useState("");

  function handleSend() {
    const text = draft.trim();
    if (!text) return;
    // A request that names a capability is a PROPOSAL, broker-gated; it is
    // never executed by the model directly.
    const proposal: CapabilityProposal | null =
      /request:\s*(geometry\.boolean|geometry\.extrude|mesh\.validate|occt\.convert)/i.test(text)
        ? {
            action: "geometry.boolean on cube-20mm",
            tool: "geometry.boolean",
            args: { boolean: "subtract", target: "cube-20mm" },
            effect: {
              kind: "spend",
              summary: "outbound model call for geometry.boolean",
              argsHash: "prop-1",
              magnitude: 0,
            },
            scope: "allow_once",
            destructive: false,
          }
        : null;
    send(text, EXAMPLE_SOURCES, TOKEN_BUDGET, proposal);
    setDraft("");
  }

  // Esc closes the picker (modal posture).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && pickerOpen) togglePicker();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen, togglePicker]);

  return (
    <section className="panel-chat" aria-label="Chat panel">
      <header className="panel-title">Chat</header>
      <div className="chat-transcript" data-testid="chat-transcript">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>No assistant connected yet (Sprint 9 harness).</p>
            <p className="panel-hint">
              Approval cards, context sources and token budget land here when the harness ships.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={"chat-message " + msg.role} data-testid="chat-message">
              <span className="chat-role">{msg.role}</span>
              <p className="chat-text">{msg.text}</p>
              {msg.contextSources.length > 0 ? (
                <ul className="context-sources" data-testid="context-sources">
                  {msg.contextSources.map((s) => (
                    <li key={s.id}>
                      {s.kind}: {s.label} ({s.tokens} tok)
                    </li>
                  ))}
                </ul>
              ) : null}
              <TokenBudgetMeter budget={msg.tokenBudget} />
              {msg.approvalCards.map((card) => (
                <div key={card.id} className="approval-row">
                  <ApprovalCardView card={card} />
                  {card.state === "pending" ? (
                    <div className="approval-actions">
                      <button
                        type="button"
                        className="approve-btn"
                        data-testid="approve-btn"
                        onClick={() => decide(card.id, true)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="reject-btn"
                        data-testid="reject-btn"
                        onClick={() => decide(card.id, false)}
                      >
                        Reject
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="chat-input-row">
        <input
          type="text"
          className="chat-input"
          data-testid="chat-input"
          value={draft}
          placeholder={'Ask the harness… (try "request: geometry.boolean")'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
        />
        <button type="button" className="send-btn" data-testid="chat-send" onClick={handleSend}>
          Send
        </button>
      </div>
      <div className="model-picker" data-testid="model-picker">
        <button
          type="button"
          className="picker-toggle"
          data-testid="picker-toggle"
          onClick={() => togglePicker()}
        >
          {selectedModelId
            ? (models.find((m) => m.id === selectedModelId)?.label ?? selectedModelId)
            : "No model selected"}
        </button>
        {pickerOpen ? (
          <ul className="picker-list" data-testid="picker-list">
            {models.map((m) => (
              <li key={m.id} className="picker-item">
                <button
                  type="button"
                  className={"picker-option" + (m.id === selectedModelId ? " selected" : "")}
                  data-testid="picker-option"
                  data-model-id={m.id}
                  onClick={() => selectModel(m.id)}
                >
                  {m.label} — {m.provider}
                  {m.local ? " (loopback)" : ""}
                  <span className="health" data-testid="health">
                    {m.health.ok ? "healthy" : "unhealthy"}
                  </span>
                  <span className="spend" data-testid="spend">
                    ${(m.health.spentCents / 100).toFixed(2)}
                  </span>
                  {m.health.revocable ? (
                    <button
                      type="button"
                      className="revoke-link"
                      data-testid="revoke-link"
                      onClick={() => revokeModel(m.id)}
                    >
                      revoke
                    </button>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export type { ChatModel, ContextSource };
