import { useState } from "react";
import { conversationsSorted, conversationStats } from "../state/chat-conversations-core";
import { useChatConversations } from "../state/chat-conversations";

/**
 * ConversationList (S9.6-006) — the conversation list UI reused in the docked
 * sidebar slice and the floating panel header Popover. Each row: title, dirty
 * dot (unsaved transcript — messages exist in the store but are not yet on
 * the broker FS lane; S9.6-007 makes "saved" meaningful), mono token-budget
 * bar and "uses context: N sources · M approvals". Inline create/rename
 * (Enter commits, Esc cancels) + row actions (switch on click, delete on ✕).
 *
 * Pure view over `useChatConversations` — no harness logic lives here.
 */

function TokenBar({ ratio }: { readonly ratio: number }) {
  const pct = Math.round(ratio * 100);
  return (
    <span className="conversation-tokenbar" title={`${pct}% of budget used`}>
      <span className="conversation-tokenbar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function ConversationList() {
  const conversations = useChatConversations((s) => s.conversations);
  const activeId = useChatConversations((s) => s.activeId);
  const create = useChatConversations((s) => s.create);
  const switchTo = useChatConversations((s) => s.switchTo);
  const rename = useChatConversations((s) => s.rename);
  const remove = useChatConversations((s) => s.remove);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const rows = conversationsSorted(conversations);

  function commitRename(id: string) {
    const title = editingValue.trim();
    if (title) rename(id, title);
    setEditingId(null);
    setEditingValue("");
  }

  return (
    <div className="conversation-list" data-testid="conversation-list">
      {rows.length === 0 ? (
        <p className="panel-hint">No conversations yet.</p>
      ) : (
        rows.map((convo) => {
          const stats = conversationStats(convo);
          const active = convo.id === activeId;
          return (
            <div
              key={convo.id}
              className={"conversation-row" + (active ? " active" : "")}
              data-testid="conversation-row"
              data-active={active ? "true" : "false"}
              onClick={() => switchTo(convo.id)}
            >
              <span
                className="conversation-dirty"
                data-testid="conversation-dirty"
                title={stats.dirty ? "Unsaved transcript (persistence lands in S9.6-007)" : "Clean"}
                data-dirty={stats.dirty ? "true" : "false"}
              />
              {editingId === convo.id ? (
                <input
                  autoFocus
                  className="conversation-rename-input"
                  data-testid="conversation-rename-input"
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(convo.id);
                    if (e.key === "Escape") {
                      setEditingId(null);
                      setEditingValue("");
                    }
                  }}
                  onBlur={() => commitRename(convo.id)}
                />
              ) : (
                <button
                  type="button"
                  className="conversation-title"
                  title="Switch · double-click to rename"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingId(convo.id);
                    setEditingValue(convo.title);
                  }}
                >
                  {convo.title}
                </button>
              )}
              <span className="conversation-meta">
                <TokenBar ratio={stats.ratio} />
                <span className="conversation-sources" data-testid="conversation-sources">
                  {stats.sourceCount} src · {stats.approvalCount} apv
                </span>
              </span>
              <button
                type="button"
                className="conversation-delete"
                data-testid="conversation-delete"
                title="Delete conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(convo.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })
      )}
      <button
        type="button"
        className="conversation-add"
        data-testid="conversation-add"
        onClick={() => create()}
      >
        + New conversation
      </button>
    </div>
  );
}
