import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";
import {
  brokerLaneMode,
  brokerProviderStatusUrl,
  createChatTransport,
  type BrokerLaneMode,
} from "../bridge/chat-transport";
import { useChatConversations, type UIMessageLike } from "../state/chat-conversations";
import { scopeKeyFor } from "../state/chat-conversations-core";
import { useI18n } from "../state/i18n";
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
 * S9.17-004 NAV-05 (project-scoped chat context):
 *   - the panel mounts this thread under `key={scopeKey:conversationId}`, so
 *     switching projects REMOUNTS the thread; the cleanup aborts any
 *     in-flight partial stream (`chat.stop()`) — an old finishing stream can
 *     never leak AI context into a scope it did not start in;
 *   - `onFinish` appends ONLY to the ORIGINAL conversation this thread was
 *     mounted for (conversation ids are unique across scopes, so the guard
 *     is explicit by id — never the current active scope); if the scope was
 *     switched mid-stream the thread is already unmounted/aborted, and any
 *     finish that did land persists to the original conversation ([okay per
 *     spec: persist original if scope changed]; no append to a mismatched
 *     new scope);
 *   - the project scope travels as message `metadata` (human-inspectable;
 *     the offline mock ignores it; the future broker chat request can read
 *     it — metadata is NEVER an authorization source).
 *
 * S9.18-001 (provider bootstrap): the source-status banner reflects the
 * broker's `/provider/status` (public-safe: demo/configured/unavailable —
 * "configured" means valid egress env, never connectivity). The status fetch
 * is a minimal READ of the loopback broker; it never carries keys and it
 * never contacts the provider itself.
 *
 * The model output proposes capabilities only — it has NO direct printer
 * capability (harness posture); the broker gates every proposal.
 */

/** Stable transport singleton (module-level, per broker-lane MODE). */
export const CHAT_TRANSPORT = createChatTransport();

/** S9.18-001 — the lane tri-state, captured ONCE at module scope: the webview
 * env decides demo | configured | unavailable. A PRESENT-but-INVALID value is
 * `unavailable`, NOT demo (AI-01: never fake a reply on a broken lane). */
const LANE_MODE: BrokerLaneMode = brokerLaneMode();
const CHAT_USES_BROKER = LANE_MODE === "configured";

/** Minimal provider-mode for the source banner (public-safe status read). */
type ProviderBannerMode = "configured" | "unavailable" | "unknown";

export function ChatThread({
  conversationId,
  initialMessages,
}: {
  readonly conversationId: string;
  readonly initialMessages: readonly UIMessageLike[];
}) {
  const t = useI18n((s) => s.t);
  const upsertMessages = useChatConversations((s) => s.upsertMessages);
  const [draft, setDraft] = useState("");

  // S9.18-001 — provider-mode for the banner. Frontend-invalid lane is
  // UNAVAILABLE immediately (never polls: the status URI is "" anyway); the
  // configured lane fetches ONE real status read and parses it STRICTLY —
  // only an explicit "configured" maps to configured; "demo", malformed and
  // any fetch failure fall back to "unknown" (never "configured" without
  // proof; "unavailable" from the broker is honored).
  const [providerMode, setProviderMode] = useState<ProviderBannerMode>(
    LANE_MODE === "unavailable" ? "unavailable" : "unknown",
  );

  // S9.18-001: ONE read of the broker status URI ONLY on the CONFIGURED lane.
  const statusUrlRef = useRef(CHAT_USES_BROKER ? brokerProviderStatusUrl() : "");
  useEffect(() => {
    const statusUrl = statusUrlRef.current;
    if (!statusUrl) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(statusUrl, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error(`provider status ${response.status}`);
        const status: { mode?: string } = await response.json();
        if (cancelled) return;
        // Strict parse: ONLY an explicit "configured" is configured; an
        // explicit "unavailable" is honored; anything else ("demo", malformed
        // payload, missing mode) falls back to "unknown" — never configured
        // without proof.
        setProviderMode(
          status.mode === "configured"
            ? "configured"
            : status.mode === "unavailable"
              ? "unavailable"
              : "unknown",
        );
      } catch {
        if (!cancelled) setProviderMode("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Capture the ORIGINAL conversation + project scope this thread mounted
  // for (S9.17-004): the onFinish guard + abort-on-unmount both key off
  // these refs so a late finish can never append to a mismatched scope.
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const scopeAtMountRef = useRef(useChatConversations.getState().currentProjectId);

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
      const cid = conversationIdRef.current;
      // Guard (S9.17-004): append ONLY to the ORIGINAL conversation id this
      // thread mounted for; never to the (possibly switched) current scope.
      const store = useChatConversations.getState();
      if (!Object.hasOwn(store.conversations, cid)) return; // deleted mid-stream
      upsertMessages(cid, final);
    },
  });

  // Abort any partial in-flight stream when the thread WRAPPER unmounts
  // (scope or conversation switch) — an old stream finishing into a different
  // scope's UI would be an AI context leak. stop() is a safe no-op when idle.
  // The stop handle rides a ref so the cleanup runs ONCE at unmount —
  // re-running it on every effect tick (the `chat` object identity is not
  // guaranteed stable across streaming renders) would cancel legit streams.
  const stopRef = useRef<() => Promise<void>>(() => Promise.resolve());
  stopRef.current = chat.stop;
  useEffect(() => {
    return () => {
      void stopRef.current();
    };
  }, []);

  const { messages, sendMessage, status, error } = chat;
  const busy = status === "submitted" || status === "streaming";

  function handleSend() {
    const text = draft.trim();
    if (!text || busy) return;
    // A request that names a capability is a PROPOSAL (harness posture);
    // the transport/broker gates it — never auto-executed here. The project
    // scope rides as message metadata (human-inspectable, never auth).
    void sendMessage({
      text,
      metadata: { projectScope: scopeKeyFor(scopeAtMountRef.current) },
    });
    setDraft("");
  }

  return (
    <div
      className="chat-thread"
      data-provider={
        LANE_MODE === "configured"
          ? "broker"
          : LANE_MODE === "unavailable"
            ? "broker-invalid"
            : "offline-mock"
      }
      data-provider-mode={providerMode}
      data-testid="chat-thread"
    >
      <div className="chat-source-status" data-testid="chat-source-status" role="status">
        {LANE_MODE === "demo"
          ? t("chat.source.demo")
          : LANE_MODE === "unavailable"
            ? t("chat.source.unavailable")
            : providerMode === "configured"
              ? t("chat.source.configured")
              : providerMode === "unavailable"
                ? t("chat.source.unavailable")
                : t("chat.source.broker")}
      </div>
      <div className="chat-transcript" data-testid="chat-transcript">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>{t("chat.thread.empty.title")}</p>
            {LANE_MODE === "demo" && <p className="panel-hint">{t("chat.thread.empty.hint")}</p>}
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={"chat-message " + msg.role} data-testid="chat-message">
              <span className="chat-role">
                {msg.role === "assistant" ? t("chat.role.assistant") : t("chat.role.user")}
              </span>
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
            {t("chat.thinking")}
          </div>
        ) : null}
        {error ? <p role="alert">{t("chat.error")}</p> : null}
      </div>
      <div className="chat-input-row">
        <input
          type="text"
          className="chat-input"
          data-testid="chat-input"
          aria-label={t("chat.input.placeholder")}
          value={draft}
          placeholder={t("chat.input.placeholder")}
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
          disabled={busy || !draft.trim()}
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}
