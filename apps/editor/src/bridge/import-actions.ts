/**
 * S9.2-005 — Import commit hook (shared by dialog entry + drag-drop entry).
 *
 * Single code path for "file → buffers → normalized payload → store add →
 * bridge CRUD lane → query invalidation → toast". Pure React-side glue; the
 * actual math lives in `bridge/import.ts` + `bridge/import-core.ts` (both
 * headless-testable).
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { BridgeHandle } from "./mock";
import { isTrianglesError, parseStl, parseThreemf, type TriangleBuffers } from "./import";
import {
  classifyFile,
  prepareImportedObject,
  toSceneObject,
  type ImportOptions,
} from "./import-core";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";

export interface ImportCommitResult {
  readonly ok: boolean;
  readonly name?: string;
  readonly error?: string;
}

export function useImportCommit(scene: BridgeHandle | undefined) {
  const queryClient = useQueryClient();
  const objects = useScene((s) => s.objects);
  const add = useScene((s) => s.add);
  const pushToast = useUi((s) => s.pushToast);

  /** Parse + normalize + commit a single file into the scene graph. */
  const commitFile = useCallback(
    async (file: File, opts: ImportOptions = {}): Promise<ImportCommitResult> => {
      try {
        const kind = classifyFile(file.name);
        if (!kind)
          return {
            ok: false,
            error: `Unsupported file type — expected .stl or .3mf (got "${file.name}").`,
          };
        const buffer = await file.arrayBuffer();
        const parsed: TriangleBuffers =
          kind === "stl" ? parseStl(buffer, file.name) : parseThreemf(buffer, file.name);
        const prepared = prepareImportedObject(parsed, opts);
        // unique name against the LIVE graph (avoid "cube" colliding with the demo cone/cube/sphere)
        const taken = new Set(objects.map((o) => o.name));
        let name = prepared.name.replace(/\.(stl|3mf)$/i, "");
        let i = 1;
        const base = name;
        while (taken.has(name)) {
          name = `${base}-${i}`;
          i += 1;
        }
        const payload = toSceneObject({ ...prepared, name });
        // 1) store graph first (UI reacts immediately), 2) persist authoritative copy.
        add(payload);
        if (scene) {
          const res = await scene.mutateObject({ kind: "add", object: payload });
          if (!res.ok) return { ok: false, error: res.error };
          await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
        } else {
          return { ok: false, error: "Bridge not connected — cannot persist the import." };
        }
        pushToast({
          kind: "success",
          title: `Imported ${name}`,
          message: `${payload.triangles.toLocaleString()} tris · ${payload.vertices.toLocaleString()} verts · ${
            payload.watertight ? "watertight" : "non-watertight"
          }`,
        });
        return { ok: true, name };
      } catch (err) {
        const message = isTrianglesError(err)
          ? `Import failed: ${err.message}`
          : `Import failed: ${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, error: message };
      }
    },
    [add, objects, pushToast, queryClient, scene],
  );

  return { commitFile };
}
