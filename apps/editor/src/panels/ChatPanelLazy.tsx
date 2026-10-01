import { lazy, Suspense } from "react";

/**
 * S9.8-006 — Chat lazy-load.
 *
 * `ChatPanel` pulls in the AI SDK (`ai` + `@ai-sdk/react` via `ChatThread`) and
 * the conversation list; loading it with `React.lazy` keeps the AI SDK out of
 * the main scene bundle (Vite emits a separate chunk, fetched only when the
 * chat tab or the floating dock mounts it).
 *
 * The wrapper normalizes the named export to a default export for `lazy()`
 * and owns its `Suspense` fallback so callers never need one.
 */
const ChatPanelLazyImpl = lazy(() =>
  import("./ChatPanel").then((mod) => ({ default: mod.ChatPanel })),
);

function ChatPanelFallback() {
  return <div className="panel-chat panel-chat-loading" aria-hidden="true" />;
}

export function ChatPanelLazy() {
  return (
    <Suspense fallback={<ChatPanelFallback />}>
      <ChatPanelLazyImpl />
    </Suspense>
  );
}
