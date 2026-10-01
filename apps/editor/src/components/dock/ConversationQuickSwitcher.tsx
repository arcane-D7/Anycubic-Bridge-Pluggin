import { useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { conversationsSorted, conversationStats } from "../../state/chat-conversations-core";
import { useChatConversations } from "../../state/chat-conversations";
import { useI18n } from "../../state/i18n";

/**
 * ConversationQuickSwitcher (S9.6-006) — compact Popover on the floating
 * panel header (9.1a) for quick switch/create. Reuses the full
 * ConversationList content (dirty dot, token bar, source count, rename) in a
 * non-modal Radix Popover; the row sits beside the title so the header drag
 * handle (`data-drag`) is not obstructed. Docked mode uses the sidebar list
 * (ConversationList in ChatPanel) — this Popover targets floating mode.
 */
export function ConversationQuickSwitcher() {
  const t = useI18n((s) => s.t);
  const [open, setOpen] = useState(false);
  const activeId = useChatConversations((s) => s.activeId);
  const conversations = useChatConversations((s) => s.conversations);

  const active = activeId !== null ? conversations[activeId] : undefined;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="floating-icon-btn conversation-quick-switch"
          data-testid="conversation-quick-switch"
          title={t("chat.switchConversation.title", {
            title: active?.title ?? t("conversation.none"),
          })}
        >
          ☰
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="conversation-popover"
          data-testid="conversation-popover"
          sideOffset={6}
          align="end"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <ConversationQuickList onPick={() => setOpen(false)} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * Minimal quick list (no inline rename — the sidebar list handles editing);
 * rows switch + a New button; Esc/browse closes.
 */
function ConversationQuickList({ onPick }: { readonly onPick: () => void }) {
  const t = useI18n((s) => s.t);
  const conversations = useChatConversations((s) => s.conversations);
  const activeId = useChatConversations((s) => s.activeId);
  const switchTo = useChatConversations((s) => s.switchTo);
  const create = useChatConversations((s) => s.create);

  const rows = conversationsSorted(conversations);

  return (
    <div className="conversation-popover-inner" data-testid="conversation-list">
      {rows.length === 0 ? (
        <p className="panel-hint">{t("conversation.empty")}</p>
      ) : (
        rows.map((convo) => {
          const stats = conversationStats(convo);
          const active = convo.id === activeId;
          return (
            <button
              type="button"
              key={convo.id}
              className={"conversation-popover-row" + (active ? " active" : "")}
              data-active={active ? "true" : "false"}
              onClick={() => {
                switchTo(convo.id);
                onPick();
              }}
            >
              <span className="conversation-row-title">{convo.title}</span>
              <span className="conversation-row-meta">
                {stats.dirty ? <span className="conversation-dirty" data-dirty="true" /> : null}
                {t("conversation.meta", {
                  n: String(stats.sourceCount),
                  m: String(stats.approvalCount),
                })}
              </span>
            </button>
          );
        })
      )}
      <button
        type="button"
        className="conversation-add"
        data-testid="conversation-add"
        onClick={() => {
          create();
          onPick();
        }}
      >
        {t("conversation.new")}
      </button>
    </div>
  );
}
