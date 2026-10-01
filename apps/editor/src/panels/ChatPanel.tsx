import { useChatConversations } from "../state/chat-conversations";
import { ChatThread } from "./ChatThread";

/**
 * Right panel — chat container (S9.6-005, Mandate C). The multi-conversation
 * store (`state/chat-conversations`) owns per-conversation messages,
 * context sources, token budget and approvals; this panel renders the
 * conversation switcher + create button and mounts the per-conversation
 * AI SDK thread (`ChatThread`, keyed remount per active conversation).
 *
 * The legacy harness store (`state/chat.ts`, S9-006) and the harness core
 * (`state/chat-core.ts`) remain UNTOUCHED — this tick only wraps them. The
 * model outputs PROPOSALS only (broker-gated); it has no direct printer
 * capability. `.panel-chat` is the e2e-reload contract — keep it.
 */

export function ChatPanel() {
  const conversations = useChatConversations((s) => s.conversations);
  const activeId = useChatConversations((s) => s.activeId);
  const create = useChatConversations((s) => s.create);
  const switchTo = useChatConversations((s) => s.switchTo);

  return (
    <section className="panel-chat" aria-label="Chat panel">
      <header className="panel-title">Chat</header>
      <div className="conversation-bar" data-testid="conversation-bar">
        <select
          className="conversation-picker"
          data-testid="conversation-picker"
          aria-label="Conversation"
          value={activeId ?? ""}
          onChange={(e) => switchTo(e.target.value)}
        >
          {Object.values(conversations).map((convo) => (
            <option key={convo.id} value={convo.id}>
              {convo.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="conversation-new"
          data-testid="conversation-new"
          title="New conversation"
          onClick={() => create()}
        >
          +
        </button>
      </div>
      {activeId !== null ? (
        <ChatThread
          key={activeId}
          conversationId={activeId}
          initialMessages={conversations[activeId]?.messages ?? []}
        />
      ) : null}
    </section>
  );
}
