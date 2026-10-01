# S9.8-006 implementation notes — Perf + stability pass

Perf pass per spec: memoized scene graph, dpr cap, `THREE.Clock` audit, and
a gl context-loss guard; floating-panel overlay budget respected (no
`will-change` outside drag, blur drops on `prefers-reduced-transparency`) and
the chat panel loaded via a lazy chunk so the AI SDK stays out of the main
scene bundle.

## Design

- **Memoized scene graph**: `SceneObjectModel` was already `memo()`-wrapped
  with stable `useMemo` derivations (geometry, bounds, transform); read-only
  this ticket. `Viewport` still uses `useMemo` to merge store + bridge
  objects and per-plate filtering (S9.4-003).
- **dpr cap**: `<Canvas dpr={[1, 2]}>` — devicePixelRatio is clamped to 2 so
  dense plates on HiDPI screens don't rasterize the WebGL canvas above the
  frame budget.
- **Clock audit**: R3F runs its own loop; no `THREE.Clock` instantiated per
  frame. (Audited earlier in S9.2-006.)
- **gl context-loss guard**: `ContextLossGuard.tsx` mounts INSIDE the Canvas
  (so it can use `useThree()`). On `webglcontextlost` it calls
  `preventDefault()` (required to keep browser auto-recovery) and on
  `webglcontextrestored` it calls `invalidate()` so the next frame re-uploads
  all GPU resources. three 0.186's WebGLRenderer re-initializes the GL
  context internally on restore (`onContextRestore` → `initGLContext`); there
  is no `restoreObjectState()` in this version — recovery is automatic once
  the event is allowed.
- **Chat lazy-load**: `ChatPanelLazy.tsx` wraps `React.lazy(() =>
import("./ChatPanel"))` (ChatPanel is a named export) with its own
  `Suspense` fallback (`.panel-chat-loading` skeleton). Both mount points —
  the sidebar chat tab (`App.tsx`) and the floating dock
  (`dock-panel.tsx`) — now use the lazy wrapper; no direct `ChatPanel`
  imports remain, so Vite emits a separate chunk.
- **Floating-panel overlay budget**: `will-change: transform` removed from
  the permanent `.floating-panel-host` and scoped to `.is-dragging`
  (added/removed by `use-dock.ts` on pointerdown/up-cancel). Idle panels no
  longer hold a GPU layer over the animating WebGL canvas. The
  `prefers-reduced-transparency: reduce` block now also drops
  `.floating-panel-host` blur.

## Files

| File                             | Purpose                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `viewport/ContextLossGuard.tsx`  | GL context-loss guard (new, mounts inside Canvas)                                                               |
| `panels/ChatPanelLazy.tsx`       | `React.lazy` wrapper + Suspense fallback for ChatPanel (new)                                                    |
| `App.tsx`                        | Sidebar chat tab uses `ChatPanelLazy`                                                                           |
| `components/dock/dock-panel.tsx` | Floating dock uses `ChatPanelLazy`                                                                              |
| `components/dock/use-dock.ts`    | Adds/removes `.is-dragging` on drag start/end                                                                   |
| `index.css`                      | will-change scoped to `.is-dragging`; `.panel-chat-loading`; reduced-transparency covers `.floating-panel-host` |
| `viewport/Viewport.tsx`          | Mounts `<ContextLossGuard />` inside `<Canvas>`                                                                 |

## Verification

- `get_errors` clean on all 7 files; prettier applied.
- unit **586 pass / 0 fail** (no new tests needed — behavior-only, no new
  pure cores).
- `pnpm run check` EXIT:0 (gate).
