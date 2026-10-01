import { VIEW_CUBE_EVENT } from "./ViewportCamera";
import type { ViewCubeCell } from "../state/camera-core";
import { useI18n } from "../state/i18n";
import type { MsgKey } from "../state/i18n-core";

/**
 * S9.4-002 view cube (AC-1/AC-2) — DOM glass tile, bottom-right of the
 * viewport frame.
 *
 * 3×3 grid of clickable cells: the six faces (F/R/B/L/T/D), four top
 * corners and the center "home" (isometric = top-front-right corner). Edges
 * are intentionally omitted in 9.4 (cell map is extensible — camera-core has
 * all 26 cells; the DOM tile exposes the face/corner/home subset that a
 * slicer needs).
 *
 * Click dispatches `VIEW_CUBE_EVENT` with `{cell}` (null for home);
 * `ViewportCamera` (inside the Canvas) eases the camera to that direction
 * (damped tween, OrbitControls target preserved).
 *
 * Plate axes convention: front = -Z in three.js (viewer side), so cells
 * approach from +Z.
 */

const FACE_LABEL: Record<string, string> = {
  faceFront: "F",
  faceBack: "R",
  faceLeft: "L",
  faceRight: "B",
  faceTop: "T",
  faceBottom: "D",
};

/** Top row: back corners + top face. */
const TOP: readonly (ViewCubeCell | null)[] = [
  "cornerTopBackLeft",
  "faceTop",
  "cornerTopBackRight",
];

/** Middle row: left face, home (iso), right face. */
const MID: readonly (ViewCubeCell | null)[] = ["faceLeft", null, "faceRight"];

/** Bottom row: front corners + front face. */
const BOTTOM: readonly (ViewCubeCell | null)[] = [
  "cornerTopFrontLeft",
  "faceFront",
  "cornerTopFrontRight",
];

const ROWS: readonly (readonly (ViewCubeCell | null)[])[] = [TOP, MID, BOTTOM];

function cellLabel(cell: ViewCubeCell | null): string {
  if (!cell) return "⌂"; // center home = isometric
  return FACE_LABEL[cell] ?? "⤢"; // corners show the "rotate iso" glyph
}

function cellTitleKey(cell: ViewCubeCell | null): MsgKey {
  if (!cell) return "viewCube.home";
  return FACE_LABEL[cell] ? "viewCube.face" : "viewCube.corner";
}

function cellFace(cell: ViewCubeCell | null): string {
  if (!cell) return "";
  return FACE_LABEL[cell] ?? "";
}

export function ViewCube() {
  const t = useI18n((s) => s.t);
  const title = (cell: ViewCubeCell | null) =>
    cell
      ? t(cellTitleKey(cell), cellFace(cell) ? { face: cellFace(cell) } : undefined)
      : t("viewCube.home");
  return (
    <div className="view-cube" data-testid="view-cube" role="group" aria-label={t("viewCube.aria")}>
      {ROWS.map((row, r) => (
        <div className="view-cube-row" key={r}>
          {row.map((cell, c) => (
            <button
              type="button"
              key={`${r}-${c}`}
              className={`view-cube-cell${!cell ? " is-home" : ""}`}
              aria-label={title(cell)}
              title={title(cell)}
              data-testid={cell ? `viewcell-${cell}` : "viewcell-home"}
              onClick={() => {
                window.dispatchEvent(new CustomEvent(VIEW_CUBE_EVENT, { detail: { cell } }));
              }}
            >
              {cellLabel(cell)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
