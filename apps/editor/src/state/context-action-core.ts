import type { SceneObjectSnapshot } from "../bridge/types";

export type ContextSurface = "canvas" | "tree";
export type ContextTargetKind =
  "object" | "part" | "negative" | "modifier" | "vertex" | "edge" | "face";
export type ContextEditMode = "object" | "vertex" | "edge" | "face";

export interface ObjectActionContext {
  readonly surface: ContextSurface;
  readonly targetKind: ContextTargetKind;
  readonly targetName: string;
  readonly selectionNames: readonly string[];
  readonly projectRevision: number;
  readonly editMode: ContextEditMode;
}

export type ContextActionRejection =
  | "stale-context"
  | "missing-target"
  | "locked-target"
  | "unsupported-role"
  | "unsupported-edit-mode";

export type ContextActionResolution =
  | {
      readonly ok: true;
      readonly targets: readonly SceneObjectSnapshot[];
    }
  | {
      readonly ok: false;
      readonly reason: ContextActionRejection;
    };

/** Capture stable names, preserving a multi-selection when its clicked member is targeted. */
export function createObjectActionContext(input: {
  readonly surface: ContextSurface;
  readonly targetName: string;
  readonly selectionNames: readonly string[];
  readonly projectRevision: number;
  readonly editMode?: ContextEditMode;
}): ObjectActionContext {
  return {
    surface: input.surface,
    targetKind: "object",
    targetName: input.targetName,
    selectionNames: input.selectionNames.includes(input.targetName)
      ? [...input.selectionNames]
      : [input.targetName],
    projectRevision: input.projectRevision,
    editMode: input.editMode ?? "object",
  };
}

/** Re-resolve names and state at invocation; unsupported role/edit contracts fail closed. */
export function resolveObjectActionContext(
  context: ObjectActionContext,
  objects: readonly SceneObjectSnapshot[],
  currentRevision: number,
): ContextActionResolution {
  if (context.projectRevision !== currentRevision) {
    return { ok: false, reason: "stale-context" };
  }
  if (context.targetKind !== "object") {
    return { ok: false, reason: "unsupported-role" };
  }
  if (context.editMode !== "object") {
    return { ok: false, reason: "unsupported-edit-mode" };
  }

  const names = context.selectionNames.includes(context.targetName)
    ? context.selectionNames
    : [context.targetName];
  const targets: SceneObjectSnapshot[] = [];
  for (const name of names) {
    const target = objects.find((object) => object.name === name);
    if (!target) return { ok: false, reason: "missing-target" };
    if (target.locked) return { ok: false, reason: "locked-target" };
    targets.push(target);
  }
  return { ok: true, targets };
}
