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
let cachedBrokerLane = false;

/** Pure env-value gate (headless/testable): a non-blank value enables lane. */
export function brokerLaneConfiguredFrom(raw: string | undefined): boolean {
  return (raw ?? "").trim().length > 0;
}

/** Pure URL derivation (headless/testable); env is authority — no literal. */
export function brokerChatUrlFrom(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("/chat")) return trimmed;
  if (trimmed.endsWith("/")) return `${trimmed}chat`;
  return `${trimmed}/chat`;
}

/** True when the broker lane is enabled by env. Reads `import.meta.env` ONLY
 * here (React layer owns `import.meta.env`; pure cores stay headless). */
export function brokerLaneConfigured(): boolean {
  return brokerLaneConfiguredFrom(import.meta.env.ANYCUBIC_BROKER_URL as string | undefined);
}

/** Resolve the broker chat URL from env (env is authority — no literal). */
export function brokerChatUrl(): string {
  return brokerChatUrlFrom((import.meta.env.ANYCUBIC_BROKER_URL as string | undefined) ?? "");
}

/**
 * Stable chat transport singleton. The AI SDK memoizes the Chat on id +
 * transport identity, so this function MUST return the same object across
 * renders (per broker-lane selection). Choosing the broker lane is dynamic
 * only: importing `DefaultChatTransport` happens lazily inside the methods.
 */
export function createChatTransport(): ChatTransportLike {
  const brokerLane = brokerLaneConfigured();
  if (cached !== null && cachedBrokerLane === brokerLane) return cached;

  if (brokerLane) {
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
  } else {
    cached = createMockChatTransport();
  }
  cachedBrokerLane = brokerLane;
  return cached;
}
