/**
 * S9.8-003 (G42) — Measure tool: pure headless core.
 *
 * Deterministic measurement math (distance / radius / angle) that runs under
 * `node --test` with no DOM or three.js runtime. The in-canvas `MeasureTool`
 * raycasts clicks against REAL object geometry (S9.2 buffers) to collect
 * probe points; this module reduces those points to a measurement.
 *
 * ## Probe kinds
 *
 * - **distance** — two points (P0, P1) → Euclidean distance (mm).
 * - **radius** — three points on a circular edge (P0..P2) → circumradius of
 *   their triangle (mm). The 3-point circumcenter formula also gives the
 *   center, useful for a guide marker.
 * - **angle** — three clicks: apex then two rays (P0 = apex) → angle between
 *   the two vectors in degrees (0..180), 15°-snap NOT applied (raw probe).
 *
 * Determinism: all math is pure (no Math.random), floats only. A measurement
 * is only emitted when its point count is satisfied.
 */

export type MeasureKind = "distance" | "radius" | "angle";

export type MeasureResult =
  | {
      readonly kind: "distance";
      readonly value: number;
    }
  | {
      readonly kind: "radius";
      readonly value: number;
      readonly centerX: number;
      readonly centerY: number;
      readonly centerZ: number;
    }
  | {
      readonly kind: "angle";
      readonly value: number;
    };

export type MeasurePoint = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

/** Euclidean distance between two points (mm). */
export function distance3(p0: MeasurePoint, p1: MeasurePoint): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dz = p1.z - p0.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Circumradius of the triangle formed by three points — the radius of the
 * circle through them (an arc/edge probe). Also returns the circumcenter.
 * Degenerate (collinear / zero-area) triangles return null (not NaN).
 */
export function circumRadius(
  a: MeasurePoint,
  b: MeasurePoint,
  c: MeasurePoint,
): { readonly radius: number; readonly center: MeasurePoint } | null {
  // Work in the triangle's plane: translate to A, basis U (B-A), V (C-A)
  // projected orthogonal to U. Rodrigues-free plane math.
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;

  const lenU2 = ux * ux + uy * uy + uz * uz;
  if (lenU2 <= 0) return null;

  // V component parallel to U (for the 2D circumcenter in (U, W) coords).
  const up = (ux * vx + uy * vy + uz * vz) / lenU2;
  const wx = vx - up * ux;
  const wy = vy - up * uy;
  const wz = vz - up * uz;
  const lenW2 = wx * wx + wy * wy + wz * wz;
  if (lenW2 <= 1e-9) return null; // collinear

  const bLen = Math.sqrt(lenU2);
  const cU = up * bLen; // C's U-coordinate (B is at (bLen,0))
  const cW = Math.sqrt(lenW2); // C's W-coordinate (positive)

  // 2D circumcenter of triangle (0,0), (bLen,0), (cU, cW):
  //   x = bLen / 2
  //   y = (cU^2 + cW^2 - cU*bLen) / (2 * cW)
  const ccx = bLen / 2;
  const ccy = (cU * cU + cW * cW - cU * bLen) / (2 * cW);
  const radius = Math.sqrt(ccx * ccx + ccy * ccy);

  // Back to 3D: center = A + ccx * U_hat + ccy * W_hat.
  const wHatLen = Math.sqrt(lenW2);
  const center = {
    x: a.x + (ccx * ux) / bLen + (ccy * wx) / wHatLen,
    y: a.y + (ccx * uy) / bLen + (ccy * wy) / wHatLen,
    z: a.z + (ccx * uz) / bLen + (ccy * wz) / wHatLen,
  };
  return { radius, center };
}

/** Angle (degrees, 0..180) between two vectors sharing the apex. */
export function angleDeg(p0: MeasurePoint, p1: MeasurePoint, p2: MeasurePoint): number {
  return angleBetweenVectors(
    { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z },
    { x: p2.x - p0.x, y: p2.y - p0.y, z: p2.z - p0.z },
  );
}

/** Angle (degrees, 0..180) between two direction vectors. */
export function angleBetweenVectors(
  a: { readonly x: number; readonly y: number; readonly z: number },
  b: { readonly x: number; readonly y: number; readonly z: number },
): number {
  const la = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  const lb = Math.sqrt(b.x * b.x + b.y * b.y + b.z * b.z);
  if (la <= 0 || lb <= 0) return 0;
  const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
  const clamped = Math.min(1, Math.max(-1, dot));
  return (Math.acos(clamped) * 180) / Math.PI;
}

/**
 * Reduce a click stream to a measurement. Returns:
 *   - `{ state, result }` — `state.points` is the RESIDUAL points after
 *     emitting (the last point stays for the next measure), or the full list
 *     when not enough points yet.
 */
export function pushProbe(
  kind: MeasureKind,
  points: readonly MeasurePoint[],
  p: MeasurePoint,
): { readonly points: readonly MeasurePoint[]; readonly result: MeasureResult | null } {
  const next: MeasurePoint[] = [...points, p];
  switch (kind) {
    case "distance":
      if (next.length >= 2) {
        return {
          points: [next[next.length - 1]!],
          result: { kind: "distance", value: distance3(next[0]!, next[1]!) },
        };
      }
      return { points: next, result: null };
    case "radius":
      if (next.length >= 3) {
        const cc = circumRadius(next[0]!, next[1]!, next[2]!);
        if (cc) {
          return {
            points: [next[next.length - 1]!],
            result: {
              kind: "radius",
              value: cc.radius,
              centerX: cc.center.x,
              centerY: cc.center.y,
              centerZ: cc.center.z,
            },
          };
        }
        // Degenerate — keep the last point, clear the rest.
        return { points: [next[next.length - 1]!], result: null };
      }
      return { points: next, result: null };
    case "angle":
      if (next.length >= 3) {
        const v = angleDeg(next[0]!, next[1]!, next[2]!);
        return { points: [next[next.length - 1]!], result: { kind: "angle", value: v } };
      }
      return { points: next, result: null };
  }
}

/** Human readable readout (mono bottom-left): "kind value  unit". */
export function formatMeasure(r: MeasureResult): string {
  switch (r.kind) {
    case "distance":
      return `${fmt(r.value)} mm`;
    case "radius":
      return `R ${fmt(r.value)} mm`;
    case "angle":
      return `${fmt(r.value)}°`;
  }
}

function fmt(n: number): string {
  // Two decimals, no trailing zeros, locale-independent (deterministic dumps).
  const s = (Math.round(n * 100) / 100).toString();
  return s.includes(".") ? s : `${s}.0`;
}
