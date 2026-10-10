/**
 * S9.18-001 — operation registry wiring (browser side).
 *
 * Projections into LIVE zustand stores for the pure registry core, so every
 * invocation reads the current scene/plate/chat/workspace state — never a
 * stale UI closure. This module is intentionally browser/vite-only (the
 * stores use extensionless relative imports); the registry CORE is pure and
 * directly unit-tested in Node, and this wiring is proven end-to-end by
 * `tests/e2e/editor-operations.e2e.mjs` through the DEV test bridge.
 *
 * The DEV-only test bridge (`installOperationTestBridge`) exists ONLY so the
 * e2e can drive the exact same `executeRegistryOperation` entry the future
 * S9.18-002 tool loop will use; it exposes no model/agent token and is never
 * installed in production builds (guarded by import.meta.env.DEV).
 */
import {
  createOperationRegistry,
  type OperationContext,
  type OperationResult,
  type OperationStoreAccess,
  type RegistryInvocation,
  type ToolInvocation,
} from "./operation-registry-core";
import { useWorkspaceView } from "./workspace-view";
import { useScene } from "./scene";
import { usePlates } from "./plates";
import { DEFAULT_PLATE_ID } from "./plates-core";
import { useChatConversations } from "./chat-conversations";

const access: OperationStoreAccess = {
  workspace: {
    view: () => useWorkspaceView.getState().view,
    setView: (view) => useWorkspaceView.getState().setView(view),
  },
  scene: {
    objects: () => useScene.getState().objects,
    selectedNames: () => useScene.getState().selectedNames,
    select: (name, watertight) => {
      useScene.getState().select(name, watertight);
    },
  },
  plates: {
    activePlateId: () => usePlates.getState().activeId,
    defaultPlateId: () => DEFAULT_PLATE_ID,
  },
  chat: {
    currentProjectId: () => useChatConversations.getState().currentProjectId,
    activeConversationId: () => useChatConversations.getState().activeId,
  },
};

/** Singleton registry — the ONE entry shared by UI navigation, UI selection
 * (object tree rows + 3D viewport clicks) and the future AI tool frontend
 * (S9.18-002 tool loop, not started). */
export const operationRegistry = createOperationRegistry(access, {
  defaultPlateId: DEFAULT_PLATE_ID,
});

export function executeRegistryOperation(invocation: RegistryInvocation): OperationResult {
  return operationRegistry.execute(invocation);
}

/** STRICT tool-origin entry (S9.18-002 tool loop): callId + both scope pins
 * are mandatory at the type level; `canceled` aborts before any effect. */
export function executeToolRegistryOperation(invocation: ToolInvocation): OperationResult {
  return operationRegistry.executeTool(invocation);
}

export function readRegistryContext(): OperationContext {
  return operationRegistry.readContext();
}

export interface OperationBridgeState {
  readonly view: string;
  readonly selectedNames: readonly string[];
  readonly activePlateId: string | null;
  /**
   * The LIVE authoritative scope observed by the registry. Tool-origin
   * invocations must pin EXACTLY these values (strict equality, null
   * included) or the call is denied with `context-changed`. UI-origin
   * callers ignore this: they never pin.
   */
  readonly contextScope: {
    readonly projectScopeId: string | null;
    readonly conversationId: string | null;
  };
  readonly objects: readonly {
    readonly name: string;
    readonly visible: boolean;
    readonly plateId?: string;
    readonly watertight: boolean;
  }[];
}

export interface OperationTestBridge {
  /** UI-origin registry entry (identical observable to the UI events). */
  readonly execute: (invocation: RegistryInvocation) => OperationResult;
  /** STRICT tool-origin entry with mandatory pins (S9.18-002 shape). */
  readonly executeTool: (invocation: ToolInvocation) => OperationResult;
  readonly catalog: () => ReturnType<typeof operationRegistry.catalog>;
  readonly getState: () => OperationBridgeState;
  readonly flushCache: () => void;
}

export function createOperationTestBridge(): OperationTestBridge {
  return {
    execute: (invocation) => operationRegistry.execute(invocation),
    executeTool: (invocation) => operationRegistry.executeTool(invocation),
    catalog: () => operationRegistry.catalog(),
    getState: () => {
      const ctx = readRegistryContext();
      return {
        view: ctx.view,
        selectedNames: useScene.getState().selectedNames,
        activePlateId: ctx.activePlateId,
        contextScope: {
          projectScopeId: ctx.projectScopeId,
          conversationId: ctx.conversationId,
        },
        objects: useScene.getState().objects.map((object) => ({
          name: object.name,
          visible: object.visible,
          watertight: object.watertight,
          ...(object.plateId !== undefined ? { plateId: object.plateId } : {}),
        })),
      };
    },
    flushCache: () => operationRegistry.flushCache(),
  };
}

declare global {
  interface Window {
    /** DEV-only test bridge (see main.tsx). Never present in production. */
    __anycubicOperationRegistry?: OperationTestBridge;
  }
}
