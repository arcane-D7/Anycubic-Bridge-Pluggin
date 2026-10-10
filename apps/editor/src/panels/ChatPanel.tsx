import { useChatConversations } from "../state/chat-conversations";
import { scopeKeyFor } from "../state/chat-conversations-core";
import { useI18n } from "../state/i18n";
import { useProjectScope, currentScopeName } from "../state/project-scope";
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
 * S9.17-004 NAV-05: the panel is project-scoped. It shows a localized
 * "Project: <name>" context label (safe project name, never a username) and
 * only the CURRENT scope's conversations; the thread mounts under a composite
 * key (`scopeKey:conversationId`) so switching projects force-remounts the
 * thread and aborts any in-flight partial stream (no cross-project AI
 * context leak).
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
  // Primitive selectors (React 19 + zustand loop guard, S9.6-001).
  const scope = useChatConversations((s) => s.currentProjectId);
  const scopeName = useProjectScope((s) => currentScopeName(s, scope));
  const scopeLabel =
    scope === null
      ? t("chat.scope.workspace")
      : t("chat.scope.project", { name: scopeName ?? scope });

  return (
    <section className="panel-chat" aria-label={t("chat.title")}>
      <header className="panel-title">{t("chat.title")}</header>
      <p
        className="chat-scope-label"
        data-testid="chat-scope-label"
        data-project-scope={scopeKeyFor(scope)}
      >
        {scopeLabel}
      </p>
      <ConversationList />
      {activeId !== null ? (
        <ChatThread
          key={`${scopeKeyFor(scope)}:${activeId}`}
          conversationId={activeId}
          initialMessages={conversations[activeId]?.messages ?? []}
        />
      ) : null}
    </section>
  );
}
