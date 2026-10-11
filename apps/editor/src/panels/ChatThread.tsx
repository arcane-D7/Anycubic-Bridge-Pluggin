import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";
import {
  brokerLaneMode,
  brokerProviderStatusUrl,
  createChatTransport,
  type BrokerLaneMode,
} from "../bridge/chat-transport";
import { executeChatTool, MAX_TOOL_ROUNDS_PER_TURN } from "../bridge/chat-tool-executor";
import { useChatConversations, type UIMessageLike } from "../state/chat-conversations";
import { scopeKeyFor } from "../state/chat-conversations-core";
import { readRegistryContext } from "../state/operation-registry";
import { useScene } from "../state/scene";
import { useI18n } from "../state/i18n";
import type { UIMessage, UIMessagePart, UITools, UIDataTypes } from "ai";

/**
 * S9.6-005 (Mandate C): per-conversation AI chat thread. Mounted with
 * `key={activeId}` in the panel so switching conversations force-remounts a
 * FRESH `useChat` (the SDK memoizes the Chat by id; the remount guarantees a
 * new Chat instance) and hydrates from the store via the `messages` prop.
 * The store is the source of truth: the transcript returns to
 * `upsertMessages` on `onFinish` (single reliable snapshot point, INCLUDING
 * abort/error from S9.18-002) AND on unmount (partial structured parts are
 * persisted BEFORE the in-flight stream is stopped, so aborting mid-loop
 * never loses the tool execution record and a reload never re-runs tools —
 * the provider is not re-contacted for persisted parts). The AI SDK's own
 * id-keyed localStorage persistence is never used. The offline mock transport
 * is the dev default; setting `ANYCUBIC_BROKER_URL` (S9.6-008) pins the lane
 * to the Rust broker loopback (`POST /chat` SSE) — stored history +
 * persistence stay identical either way.
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
 *     the offline mock ignores it; the broker chat request reads it — but
 *     metadata is NEVER an authorization source).
 *
 * S9.18-001 (provider bootstrap): the source-status banner reflects the
 * broker's `/provider/status` (public-safe: demo/configured/unavailable —
 * "configured" means valid egress env, never connectivity). The status fetch
 * is a minimal READ of the loopback broker; it never carries keys and it
 * never contacts the provider itself.
 *
 * S9.18-002 (tool loop): a REAL provider proposal (`tool-input-available`
 * chunk, no `providerExecuted`) is executed ONCE through
 * [`executeChatTool`] — the same frontend operation registry the UI uses —
 * pinned to the conversation's own scope + callId; the structured outcome is
 * pushed back via `chat.addToolOutput` and the thread RESUBMITS automatically
 * (`sendAutomaticallyWhen`) so the provider conversation CONTINUES, bounded
 * by [`MAX_TOOL_ROUNDS_PER_TURN`]. Unknown tool names, registry denials,
 * invalid args and the round limit all become structured `output-error`
 * parts — never a silent effect and never a resubmission after the limit.
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

  // S9.18-002 — tool-loop budget for THIS turn: counts executed rounds and
  // latches when the provider is stuck in a tool loop. Once latched,
  // `sendAutomaticallyWhen` declines every resubmission (the broker ALSO
  // bounds pairs/calls per request; the client cap is the second, local
  // gate). `messagesRef` carries the latest transcript so the unmount
  // cleanup can persist partial structured parts BEFORE stopping the stream.
  const toolRoundsRef = useRef(0);
  const budgetExceededRef = useRef(false);
  const messagesRef = useRef<readonly UIMessageLike[]>(initialMessages);

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
    onToolCall: async ({ toolCall }) => {
      // toolCall is the validated `tool-input-available` chunk from the
      // broker — NO providerExecuted, so execution is OURS, exactly once.
      const cid = conversationIdRef.current;
      const round = toolRoundsRef.current + 1;
      if (round > MAX_TOOL_ROUNDS_PER_TURN) {
        budgetExceededRef.current = true;
        toolRoundsRef.current = round;
        await chat.addToolOutput({
          state: "output-error",
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: t("chat.tool.limit"),
        });
        return;
      }
      toolRoundsRef.current = round;
      const outcome = executeChatTool({
        toolName: toolCall.toolName,
        inputArgs: toolCall.input,
        callId: toolCall.toolCallId,
        conversationId: cid,
        round,
      });
      if (outcome.ok) {
        await chat.addToolOutput({
          state: "output-available",
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          output: outcome.payload,
        });
      } else {
        // Unknown names, registry denials and invalid args are structured
        // output-error parts — never a silent no-op and never a re-call.
        await chat.addToolOutput({
          state: "output-error",
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          errorText: outcome.error.text,
        });
      }
    },
    // Resubmit ONLY when the LAST part of the last assistant message is a
    // COMPLETED tool part (output available or error) — this is what lets the
    // provider conversation CONTINUE with the tool result. The final text
    // reply arrives as a CONTINUATION of the same assistant message (the
    // broker streams text with the same message id), so the LAST-part check
    // is what stops the loop exactly once the provider answered: once the
    // final text part is appended, the last part is text and resubmission
    // halts. Never after the budget latch; never on a still-running part.
    // (Verified against ai@7.0.122: this callback is the ONLY resubmit gate —
    // the SDK calls it after every completed request, including on
    // continuations, so a per-message "any tool part" check would loop.)
    sendAutomaticallyWhen: ({ messages: latest }) => {
      if (budgetExceededRef.current) return false;
      const last = latest[latest.length - 1];
      if (!last || last.role !== "assistant") return false;
      return lastPartIsCompletedTool(last.parts);
    },
    onFinish: ({ messages: final }) => {
      const cid = conversationIdRef.current;
      // Guard (S9.17-004): persist ONLY to the ORIGINAL conversation id this
      // thread mounted for; never to the (possibly switched) current scope.
      // S9.18-002: persist ALWAYS (abort/error included) — a partial tool
      // transcript is still real evidence; it is never redacted away.
      const store = useChatConversations.getState();
      if (!Object.hasOwn(store.conversations, cid)) return; // deleted mid-stream
      store.upsertMessages(cid, final as UIMessageLike[]);
    },
  });

  // Abort any partial in-flight stream when the thread WRAPPER unmounts
  // (scope or conversation switch) — an old stream finishing into a different
  // scope's UI would be an AI context leak. S9.18-002: FIRST persist the
  // current (possibly partial) transcript — structured tool parts survive an
  // abort and a reload NEVER re-runs executed tools (they are persisted parts
  // with output, and the top of the message array is resubmitted unchanged,
  // not re-executed). stop() is a safe no-op when idle. The stop handle rides
  // a ref so the cleanup runs ONCE at unmount.
  const stopRef = useRef<() => Promise<void>>(() => Promise.resolve());
  stopRef.current = chat.stop;
  useEffect(() => {
    return () => {
      const cid = conversationIdRef.current;
      const store = useChatConversations.getState();
      if (Object.hasOwn(store.conversations, cid) && messagesRef.current.length > 0) {
        store.upsertMessages(cid, messagesRef.current);
      }
      void stopRef.current();
    };
  }, []);

  const { messages, sendMessage, status, error } = chat;
  const busy = status === "submitted" || status === "streaming";

  /**
   * S9.18-002 — shape of the structured tool part the SDK carries under the
   * `tool-<name>` part type. `UIMessagePart` is a discriminated union whose
   * tool member is a TEMPLATE type (`tool-${string}`), so we narrow with an
   * explicit guard instead of runtime `startsWith` (which TS cannot narrow).
   */
  interface ChatToolPartLike {
    readonly type: string;
    readonly toolCallId?: string;
    readonly state?: string;
    readonly output?: unknown;
    readonly errorText?: string;
    readonly input?: unknown;
  }

  function asToolPart(part: UIMessagePart<UIDataTypes, UITools>): ChatToolPartLike | null {
    return typeof part.type === "string" && part.type.startsWith("tool-")
      ? (part as unknown as ChatToolPartLike)
      : null;
  }

  // S9.18-002: resubmit ONLY when the LAST part of the last assistant
  // message is a COMPLETED tool part (output available or error). A tool part
  // earlier in the message (already answered by the provider's final text)
  // must NOT trigger a resubmission — a per-message "any tool part" check
  // would loop forever once the final text continuation lands.
  function lastPartIsCompletedTool(parts: readonly UIMessagePart<UIDataTypes, UITools>[]): boolean {
    if (parts.length === 0) return false;
    const tool = asToolPart(parts[parts.length - 1]!);
    return tool !== null && (tool.state === "output-available" || tool.state === "output-error");
  }

  // Keep a data-testid-visible CURRENT transcript in a ref at EVERY render:
  // the unmount cleanup snapshots it so partial structured tool parts are
  // persisted BEFORE the in-flight stream is stopped. Without this, unmount
  // could persist a stale array from the mount moment.
  messagesRef.current = messages;

  // AI-08 (S9.18-002): a bounded, human-inspectable snapshot of the CURRENT
  // UI state (view + selected names) the provider may need when proposing a
  // tool call — metadata ONLY, never an authorization source.
  function uiContextSnippet(): string {
    const ctx = readRegistryContext();
    const selected = useScene.getState().selectedNames;
    return `view:${ctx.view};selected:${selected.join(",")}`;
  }

  /** Localized compact summary of a structured tool part — never raw JSON. */
  function toolPartSummary(part: ChatToolPartLike): string {
    const toolKey =
      part.type === "tool-workspace_navigate"
        ? "chat.tool.name.workspaceNavigate"
        : part.type === "tool-scene_select"
          ? "chat.tool.name.sceneSelect"
          : null;
    const toolLabel = toolKey ? t(toolKey) : part.type.replace(/^tool-/, "");
    if (part.state === "output-available") {
      const output = part.output as
        | {
            readonly code?: string;
            readonly view?: string;
            readonly name?: string;
            readonly watertight?: boolean;
          }
        | undefined;
      if (part.type === "tool-workspace_navigate" && output?.view) {
        const summary =
          output.code === "already-on-view"
            ? t("chat.tool.result.alreadyOnView", { view: output.view })
            : t("chat.tool.result.navigated", { view: output.view });
        return `${toolLabel}: ${summary}`;
      }
      if (part.type === "tool-scene_select" && output?.name) {
        return `${toolLabel}: ${t("chat.tool.result.selected", {
          name: output.name,
          watertight: String(output.watertight === true),
        })}`;
      }
      return `${toolLabel}: ok`;
    }
    if (part.state === "output-error" && part.errorText) {
      return `${toolLabel}: ${t("chat.tool.denied", { reason: part.errorText })}`;
    }
    return t("chat.tool.running", { tool: toolLabel });
  }

  function handleSend() {
    const text = draft.trim();
    if (!text || busy) return;
    // A request that names a capability is a PROPOSAL (harness posture);
    // the transport/broker gates it — never auto-executed here. The project
    // scope + current view/selection ride as message metadata (human-
    // inspectable, never auth).
    void sendMessage({
      text,
      metadata: {
        projectScope: scopeKeyFor(scopeAtMountRef.current),
        uiContext: uiContextSnippet(),
      },
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
              {msg.parts.map((part, i) => {
                const tool = asToolPart(part);
                return part.type === "text" ? (
                  <p key={i} className="chat-text">
                    {part.text}
                  </p>
                ) : tool ? (
                  <p
                    key={i}
                    className={
                      "chat-tool-part" +
                      (tool.state === "output-error" ? " chat-tool-part-error" : "")
                    }
                    data-testid={"chat-tool-part-" + tool.type.replace(/^tool-/, "")}
                    data-tool-state={tool.state ?? "input-available"}
                    title={JSON.stringify(tool.output ?? tool.errorText ?? "")}
                  >
                    {toolPartSummary(tool)}
                  </p>
                ) : null;
              })}
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
        {busy ? (
          <button
            type="button"
            className="stop-btn"
            data-testid="chat-stop"
            aria-label={t("chat.stop")}
            onClick={() => {
              void chat.stop();
            }}
          >
            {t("chat.stop")}
          </button>
        ) : null}
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
