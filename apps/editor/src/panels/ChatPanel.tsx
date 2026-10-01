import { useChatConversations } from "../state/chat-conversations";
import { useI18n } from "../state/i18n";
import { ChatThread } from "./ChatThread";
import { ConversationList } from "./ConversationList";

/**
 * Right panel — chat container (S9.6-005 Mandate C + S9.6-006 list UI). The
 * multi-conversation store (`state/chat-conversations`) owns per-conversation
 * messages, context sources, token budget and approvals; this panel renders
 * the conversation list (ConversationList — create/switch/rename/delete,
 * dirty dot, token bar, source count) and mounts the per-conversation AI SDK
 * thread (`ChatThread`, keyed remount per active conversation).
 *
 * The legacy harness store (`state/chat.ts`, S9-006) and the harness core
 * (`state/chat-core.ts`) remain UNTOUCHED — this tick only wraps them. The
 * model outputs PROPOSALS only (broker-gated); it has no direct printer
 * capability. `.panel-chat` is the e2e-reload contract — keep it.
 */

export function ChatPanel() {
  const t = useI18n((s) => s.t);
  const activeId = useChatConversations((s) => s.activeId);
  const conversations = useChatConversations((s) => s.conversations);

  return (
    <section className="panel-chat" aria-label={t("chat.title")}>
      <header className="panel-title">{t("chat.title")}</header>
      <ConversationList />
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
