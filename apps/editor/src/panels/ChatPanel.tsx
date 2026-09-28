/**
 * Right panel — chat (R0 shell placeholder). Per §7.3 the chat will show
 * context sources, the token budget meter, approval cards and a BYOK
 * provider/model picker (Sprint 9 harness). R0 renders the empty state only;
 * there is no model capability wired here yet.
 */

export function ChatPanel() {
  return (
    <section className="panel-chat" aria-label="Chat panel">
      <header className="panel-title">Chat</header>
      <div className="chat-empty">
        <p>No assistant connected yet (Sprint 9 harness).</p>
        <p className="panel-hint">
          Approval cards, context sources and token budget land here when the harness ships.
        </p>
      </div>
    </section>
  );
}
