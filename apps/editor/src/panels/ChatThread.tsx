import { useChat } from "@ai-sdk/react";
import { useState } from "react";
import { createChatTransport } from "../bridge/chat-transport";
import { useChatConversations, type UIMessageLike } from "../state/chat-conversations";
import type { UIMessage } from "ai";

/**
 * S9.6-005 (Mandate C): per-conversation AI chat thread. Mounted with
 * `key={activeId}` in the panel so switching conversations force-remounts a
 * FRESH `useChat` (the SDK memoizes the Chat by id; the remount guarantees a
 * new Chat instance) and hydrates from the store via the `messages` prop.
 * The store is the source of truth: the transcript returns to
 * `upsertMessages` on `onFinish` ONLY (single reliable snapshot point); the
 * AI SDK's own id-keyed localStorage persistence is never used. The offline
 * mock transport is the dev default; setting `ANYCUBIC_BROKER_URL` (S9.6-008)
 * pins the lane to the Rust broker loopback (`POST /chat` SSE) — stored
 * history + persistence stay identical either way.
 *
 * The model output proposes capabilities only — it has NO direct printer
 * capability (harness posture); the broker gates every proposal.
 */

/** Stable transport singleton (module-level, per broker-lane selection). */
export const CHAT_TRANSPORT = createChatTransport();

export function ChatThread({
  conversationId,
  initialMessages,
}: {
  readonly conversationId: string;
  readonly initialMessages: readonly UIMessageLike[];
}) {
  const upsertMessages = useChatConversations((s) => s.upsertMessages);
  const [draft, setDraft] = useState("");

  // Stable module-level transport (mock dev default OR broker lane when
  // ANYCUBIC_BROKER_URL is set); the SDK memoizes the Chat on id + transport
  // identity. The store stays the source of truth either way.
  const chat = useChat({
    id: conversationId,
    // Hydrate from the store on remount — NOT setMessages in an effect (the
    // Chat state is created in the constructor; a post-mount setMessages
    // would race the useSyncExternalStore snapshot).
    messages: initialMessages as UIMessage[],
    transport: CHAT_TRANSPORT as never,
    onFinish: ({ messages: final, isAbort, isError }) => {
      if (isAbort || isError) return;
      upsertMessages(conversationId, final);
    },
  });

  const { messages, sendMessage, status } = chat;
  const busy = status === "submitted" || status === "streaming";

  function handleSend() {
    const text = draft.trim();
    if (!text || busy) return;
    // A request that names a capability is a PROPOSAL (harness posture);
    // the transport/broker gates it — never auto-executed here.
    void sendMessage({ text });
    setDraft("");
  }

  return (
    <div className="chat-thread" data-testid="chat-thread">
      <div className="chat-transcript" data-testid="chat-transcript">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>No messages yet — offline dev transport (S9.6-005/008).</p>
            <p className="panel-hint">
              Send a message to get a canned mock reply; set ANYCUBIC_BROKER_URL to pin the chat
              lane to the Rust broker loopback.
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={"chat-message " + msg.role} data-testid="chat-message">
              <span className="chat-role">{msg.role}</span>
              {msg.parts.map((part, i) =>
                part.type === "text" ? (
                  <p key={i} className="chat-text">
                    {part.text}
                  </p>
                ) : null,
              )}
            </div>
          ))
        )}
        {busy ? (
          <div className="chat-thinking" data-testid="chat-thinking">
            thinking…
          </div>
        ) : null}
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
            if (e.key === "Escape") setDraft("");
          }}
        />
        <button
          type="button"
          className="send-btn"
          data-testid="chat-send"
          onClick={handleSend}
          disabled={busy}
        >
          Send
        </button>
      </div>
    </div>
  );
}
