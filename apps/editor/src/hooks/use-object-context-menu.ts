import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BridgeHandle } from "../bridge/mock";
import type { SceneObjectSnapshot } from "../bridge/types";
import { openContextMenuAt } from "../components/context-menu-core";
import { buildObjectMenuItems } from "../components/context-menu-items";
import type { ContextSurface } from "../state/context-action-core";
import {
  createObjectActionContext,
  resolveObjectActionContext,
} from "../state/context-action-core";
import { useContextMenuStore } from "../state/context-menu";
import { centerOnPlateTransform, dropOnPlateTransform } from "../state/arrange-core";
import { useScene } from "../state/scene";
import { useUi } from "../state/ui";
import { useViewport } from "../state/viewport";

type ContextPointer = {
  readonly clientX: number;
  readonly clientY: number;
  readonly detail?: number;
  readonly currentTarget?: {
    getBoundingClientRect(): { readonly left: number; readonly bottom: number };
    focus?: () => void;
    readonly isConnected?: boolean;
  };
};

export type ObjectContextMenuOpener = ReturnType<typeof useObjectContextMenu>;

export function useObjectContextMenu(scene: BridgeHandle | undefined) {
  const queryClient = useQueryClient();
  const openMenu = useContextMenuStore((state) => state.open);
  const pushToast = useUi((state) => state.pushToast);

  const dispatch = useCallback(
    async (
      action:
        | "duplicate"
        | "toggleVisible"
        | "centerOnPlate"
        | "dropOnPlate"
        | "repairReplace"
        | "repairCopy"
        | "remove",
      context: ReturnType<typeof createObjectActionContext>,
    ) => {
      const latest = queryClient.getQueryData<BridgeHandle>(["bridge", "scene"]) ?? scene;
      const resolution = resolveObjectActionContext(
        context,
        useScene.getState().objects,
        useViewport.getState().revision,
      );
      if (!resolution.ok) {
        pushToast({
          kind: "warning",
          title: "Context action unavailable",
          message: `The target could not be revalidated (${resolution.reason}).`,
        });
        return;
      }
      if (!latest) {
        pushToast({
          kind: "warning",
          title: "Context action unavailable",
          message: "Scene provider unavailable.",
        });
        return;
      }

      for (const target of resolution.targets) {
        if (action === "duplicate") {
          if (useScene.getState().duplicate(target.name) !== null) {
            const result = await latest.mutateObject({ kind: "duplicate", name: target.name });
            if (!result.ok) throw new Error(result.error);
          }
        } else if (action === "toggleVisible") {
          useScene.getState().toggleVisible(target.name);
          const result = await latest.mutateObject({ kind: "toggleVisible", name: target.name });
          if (!result.ok) throw new Error(result.error);
        } else if (action === "centerOnPlate" || action === "dropOnPlate") {
          const transform =
            action === "centerOnPlate"
              ? centerOnPlateTransform(target)
              : dropOnPlateTransform(target);
          useScene.getState().setTransform(target.name, transform);
          const result = await latest.mutateObject({
            kind: "setTransform",
            name: target.name,
            transform,
          });
          if (!result.ok) throw new Error(result.error);
        } else if (action === "repairReplace" || action === "repairCopy") {
          const result = await latest.repair({
            name: target.name,
            mode: action === "repairReplace" ? "replace" : "copy",
          });
          if (!result.ok) {
            pushToast({ kind: "error", title: "Auto-repair", message: result.error });
            return;
          }
        } else {
          useScene.getState().remove(target.name);
          const result = await latest.mutateObject({ kind: "remove", name: target.name });
          if (!result.ok) throw new Error(result.error);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
    },
    [queryClient, pushToast, scene],
  );

  return useCallback(
    (
      surface: ContextSurface,
      target: SceneObjectSnapshot,
      event: ContextPointer,
      treeActions?: { readonly onRename: () => void; readonly onMoreInfo: () => void },
    ) => {
      const graph = useScene.getState();
      if (!graph.selectedNames.includes(target.name)) graph.select(target.name, target.watertight);
      const context = createObjectActionContext({
        surface,
        targetName: target.name,
        selectionNames: graph.selectedNames.includes(target.name)
          ? graph.selectedNames
          : [target.name],
        projectRevision: useViewport.getState().revision,
      });
      const run = (action: Parameters<typeof dispatch>[0]) => () =>
        void dispatch(action, context).catch((error: unknown) => {
          void queryClient.invalidateQueries({ queryKey: ["bridge", "scene"] });
          pushToast({
            kind: "error",
            title: "Context action failed",
            message: error instanceof Error ? error.message : "Scene action failed.",
          });
        });
      const items = buildObjectMenuItems(
        { name: target.name, visible: target.visible, watertight: target.watertight },
        {
          onDuplicate: run("duplicate"),
          ...(treeActions ? { onRename: treeActions.onRename } : {}),
          onToggleVisible: run("toggleVisible"),
          onCenterOnPlate: run("centerOnPlate"),
          onDropToPlate: run("dropOnPlate"),
          onRepair: (mode) => run(mode === "replace" ? "repairReplace" : "repairCopy")(),
          onRemove: run("remove"),
          ...(treeActions ? { onMoreInfo: treeActions.onMoreInfo } : {}),
        },
      );
      openMenu(openContextMenuAt(event, items));
    },
    [dispatch, openMenu, pushToast, queryClient, scene],
  );
}
