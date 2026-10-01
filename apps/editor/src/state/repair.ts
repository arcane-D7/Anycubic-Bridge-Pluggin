/**
 * S9.7-003/004 — watertight repair core (pure, headless).
 *
 * G46. Non-watertight objects (existing `#b36a5e` tint + dashed edge) become
 * actionable: "Auto-repair" runs a watertight closure over the manifold-3d
 * backend semantics and either REPLACES the mesh (default, keeps identity +
 * placement) or REPLACES-AS-COPY (new object, keeps source untouched).
 *
 * This module owns the deterministic, dependency-free parts:
 * - `RepairMode` — "replace" | "copy" (the two AC choices).
 * - `REPAIR_MODES` + `repairModeLabel`.
 * - `repairResultNote` — provenance note stamped on the repaired/copy object
 *   (`+repair <mode>`), same convention family as `+bool <op> A∩B`.
 * - `isRepairable` — an object is repairable when it exists and is NOT
 *   watertight (repairing a closed mesh is a no-op; the UI disables it).
 * - `copyNameFor` — deterministic dedupe for replace-as-copy (`-repair`,
 *   `-repair-2`, …), the same helper the bridge lane uses.
 *
 * The bridge `repair` lane (S9.7-004) applies these over the authoritative
 * snapshot: replace mutates vertices/triangles/watertight/volume in place;
 * copy adds a new object. Slice preflight (9.5) stays the only gate — a
 * repaired object re-flagged watertight passes it.
 */

export type RepairMode = "replace" | "copy";

export const REPAIR_MODES: readonly RepairMode[] = ["replace", "copy"] as const;

export function repairModeLabel(mode: RepairMode): string {
  return mode === "replace" ? "Replace" : "Replace-as-copy";
}

/** Provenance note stamped on the repaired object (lineage AC). */
export function repairResultNote(mode: RepairMode): string {
  return `+repair ${mode}`;
}

/** True when the object is a candidate for repair (exists + not watertight). */
export function isRepairable(o: { readonly watertight: boolean } | undefined): boolean {
  return o !== undefined && !o.watertight;
}

/** Deterministic name for a replace-as-copy (not in use → base; else -2, -3…). */
export function copyNameFor(base: string, inUse: (name: string) => boolean): string {
  let candidate = `${base}-repair`;
  let n = 2;
  while (inUse(candidate)) {
    candidate = `${base}-repair-${n}`;
    n += 1;
  }
  return candidate;
}
