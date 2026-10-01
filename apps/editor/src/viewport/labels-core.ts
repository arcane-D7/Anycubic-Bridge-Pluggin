/**
 * S9.8-002 (G45) — viewport object label chips: pure headless core.
 *
 * HUD chips float above each visible object: name + status dot
 * (watertight = success, non-watertight = warning, locked = muted). All the
 * deterministic math lives here (pure, three-free) so it runs under
 * `node --test` without DOM or a three.js runtime.
 *
 * ## Coordinate contract
 *
 * The IN-CANVAS projector (LabelsProjector) converts each object's
 * bounding-box top-center into NDC [-1..1] once per frame using the LIVE
 * object3D matrix (so chips follow gizmo drags), and writes the result to a
 * mutable bus (`state/labels.ts`). The OUT-OF-CANVAS overlay (`ObjectLabels`)
 * converts NDC → CSS pixels with `ndcToViewport` and clamps with `clampChip`
 * against its own measured size.
 *
 * ## Status derivation
 *
 * - `watertight` → success dot (theme --sema-success).
 * - `!watertight` → warning dot (theme --sema-warning) + "needs repair".
 * - `locked` → muted dot (theme --text-tertiary) + "locked".
 */

export type LabelStatus = "watertight" | "non-watertight" | "locked";

/** Status resolver — pure, single source for dot color + label. */
export function statusOf(watertight: boolean, locked: boolean): LabelStatus {
  if (locked) return "locked";
  return watertight ? "watertight" : "non-watertight";
}

/** Chip accessible label: "name · status-note". */
export function chipLabel(name: string, status: LabelStatus): string {
  const note =
    status === "non-watertight" ? "needs repair" : status === "locked" ? "locked" : "watertight";
  return `${name} · ${note}`;
}

/** NDC → CSS pixels with y-flip (NDC y=+1 is up; CSS y=0 is top). */
export function ndcToViewport(x: number, y: number, w: number, h: number) {
  return {
    x: (x * 0.5 + 0.5) * w,
    y: (0.5 - y * 0.5) * h,
  };
}

/** Clamp a CSS pixel anchor so the chip stays fully visible (margin px). */
export function clampChip(
  x: number,
  y: number,
  viewport: { readonly width: number; readonly height: number },
  margin: number,
): { readonly x: number; readonly y: number } {
  const m = Math.max(0, margin);
  const maxX = Math.max(m, viewport.width - m);
  const maxY = Math.max(m, viewport.height - m);
  return {
    x: Math.min(Math.max(x, m), maxX),
    y: Math.min(Math.max(y, m), maxY),
  };
}
