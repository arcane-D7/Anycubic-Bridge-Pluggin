import { createMockChatTransport, type ChatTransportLike } from "../bridge/mock.ts";

/**
 * S9.6-008 — broker AI-egress loopback selection.
 *
 * Dev default: the offline mock transport (works without any backend).
 * When `ANYCUBIC_BROKER_URL` is set (webview env), the chat lane pins to the
 * broker's `DefaultChatTransport` — the same AI SDK v7 UI stream protocol
 * served by the Rust `broker-server` crate (`POST /chat`, SSE). The endpoint
 * URL comes ONLY from the environment: this file never contains a provider
 * URL (check:architecture invariant — zero provider URLs/egress in webview).
 *
 * The `ai` package is imported lazily (dynamic) so Node 24 unit tests that
 * reach this module (through `bridge/mock.ts`) never resolve the browser
 * bundle; the mock path uses only the structural `ChatTransportLike` type.
 */

let cached: ChatTransportLike | null = null;
let cachedMode: BrokerLaneMode | null = null;

/** S9.18-001 — broker lane tri-state, centralized. A PRESENT but INVALID env
 * value is `unavailable` (NEVER the offline demo: faking a reply on a
 * configured-but-broken lane would be AI-01). */
export type BrokerLaneMode = "demo" | "configured" | "unavailable";

/** Loopback hosts only — the webview must never reach external hosts directly
 * (check:architecture: the ONLY provider lane is the Rust broker loopback). */
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "[0:0:0:0:0:0:0:1]",
]);

/** Pure base-URL validator: http(s) scheme AND loopback host AND no
 * userinfo/credentials/query/fragment (pinned broker base only). */
export function isBrokerBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "" || url.hash !== "") return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** Pure env-value gate (headless/testable): the lane is configured ONLY when
 * the env value is a VALID broker base URL (a malformed/external value is
 * "configured but invalid" → unavailable, NOT a lane). */
export function brokerLaneConfiguredFrom(raw: string | undefined): boolean {
  return brokerChatUrlFrom(raw ?? "") !== "";
}

/** Pure lane mode (headless/testable), the SINGLE source of truth for what
 * the UI must render and which transport to select: blank → offline demo,
 * present+valid → configured broker, present+invalid → UNAVAILABLE (typed
 * reject, never a mock reply, never an outgoing request). */
export function brokerLaneModeFrom(raw: string | undefined): BrokerLaneMode {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "demo";
  if (brokerChatUrlFrom(trimmed) === "") return "unavailable";
  return "configured";
}

/** Pure URL derivation (headless/testable); env is authority — no literal.
 * S9.18-001: invalid (non-loopback / non-http(s) / credentialed) values yield
 * "" — the UI stays on the offline Demo lane rather than talking to an
 * arbitrary external host from the webview. */
export function brokerChatUrlFrom(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !isBrokerBaseUrl(trimmed)) return "";
  if (trimmed.endsWith("/chat")) return trimmed;
  if (trimmed.endsWith("/")) return `${trimmed}chat`;
  return `${trimmed}/chat`;
}

/** Pure provider-status URL (headless/testable); "" when the lane is invalid
 * or unset. The status URI is public-safe (mode/configured/reason only). */
export function brokerProviderStatusUrlFrom(raw: string): string {
  const chatUrl = brokerChatUrlFrom(raw);
  if (!chatUrl) return "";
  const base = chatUrl.endsWith("/chat") ? chatUrl.slice(0, -"/chat".length) : chatUrl;
  return `${base}/provider/status`;
}

/** True when the broker lane is enabled by env. Reads `import.meta.env` ONLY
 * here (React layer owns `import.meta.env`; pure cores stay headless). */
export function brokerLaneConfigured(): boolean {
  return brokerLaneConfiguredFrom(import.meta.env.ANYCUBIC_BROKER_URL as string | undefined);
}

/** S9.18-001 — env-bound lane mode (never called in Node tests). */
export function brokerLaneMode(): BrokerLaneMode {
  return brokerLaneModeFrom(import.meta.env.ANYCUBIC_BROKER_URL as string | undefined);
}

/** Resolve the broker chat URL from env (env is authority — no literal). */
export function brokerChatUrl(): string {
  return brokerChatUrlFrom((import.meta.env.ANYCUBIC_BROKER_URL as string | undefined) ?? "");
}

/** Resolve the broker provider-status URL from env; "" when lane unset. */
export function brokerProviderStatusUrl(): string {
  return brokerProviderStatusUrlFrom(
    (import.meta.env.ANYCUBIC_BROKER_URL as string | undefined) ?? "",
  );
}

/** S9.18-001 — transport for a PRESENT-but-INVALID broker lane. `sendMessages`
 * rejects with a stable typed reason ("invalid-broker-url") so the AI SDK
 * surfaces `chat.error` + the error UI — NOT an assistant message, and no
 * outgoing request can exist (the URL itself was invalid). No resumable
 * stream: `reconnectToStream` resolves null (nothing to resume). Never falls
 * back to the offline mock on this lane. */
export function createInvalidBrokerTransport(): ChatTransportLike {
  return {
    async sendMessages() {
      throw new Error(
        "chat-lane unavailable: invalid-broker-url (ANYCUBIC_BROKER_URL is present but invalid; check the app settings)",
      );
    },
    async reconnectToStream() {
      return null;
    },
  };
}

/**
 * Stable chat transport singleton. The AI SDK memoizes the Chat on id +
 * transport identity, so this function MUST return the same object across
 * renders (per broker-lane MODE). S9.18-001: the cache key is the raw
 * tri-state MODE (demo|configured|unavailable), not a bool — mode changes
 * rebuild the transport; a valid→invalid env change must NOT reuse the
 * configured brokered transport, and an invalid mode must NEVER pick the
 * offline mock (typed reject instead).
 */
export function createChatTransport(): ChatTransportLike {
  const mode = brokerLaneMode();
  if (cached !== null && cachedMode === mode) return cached;

  if (mode === "configured") {
    cached = {
      async sendMessages(options) {
        const { DefaultChatTransport } = await import("ai");
        // The structural adapter's `readonly unknown[]` is wider than the
        // SDK's `UIMessage[]` — the payload is serialized as JSON by the
        // transport, so the messages are only read, never mutated.
        const opts = options as Parameters<typeof DefaultChatTransport.prototype.sendMessages>[0];
        return new DefaultChatTransport({ api: brokerChatUrl() }).sendMessages(opts);
      },
      async reconnectToStream(options) {
        const { DefaultChatTransport } = await import("ai");
        const opts = options as Parameters<
          typeof DefaultChatTransport.prototype.reconnectToStream
        >[0];
        return new DefaultChatTransport({ api: brokerChatUrl() }).reconnectToStream(opts);
      },
    } satisfies ChatTransportLike;
  } else if (mode === "unavailable") {
    // AI-01 guard: configured-but-invalid MUST reject, never fake a reply.
    cached = createInvalidBrokerTransport();
  } else {
    cached = createMockChatTransport();
  }
  cachedMode = mode;
  return cached;
}
