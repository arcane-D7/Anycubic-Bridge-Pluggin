import { executeToolRegistryOperation } from "../state/operation-registry";
import { useChatConversations } from "../state/chat-conversations";
import type { ToolInvocation } from "../state/operation-registry-core";

/**
 * S9.18-002 — webview-side tool executor bridging REAL provider tool calls to
 * the SAME frontend operation registry the UI uses. This is the frontend half
 * of the mandate: a provider proposal executes ONLY through the shared
 * registry entry (`workspace.navigate` / `scene.select`), with the callId +
 * explicit scope pins the registry requires from tool origin — never a direct
 * state poke, never a backend writer, never a cloud/Blender/shell call.
 *
 * The name mapping is the ONLY place the provider wire names
 * (`workspace_navigate`, `scene_select` — safe `[A-Za-z0-9_-]` names, see
 * `TOOL_NAMES` in the broker) are translated to registry operation ids; ANY
 * other name is rejected locally before the registry is ever reached.
 */

/** Provider wire name → registry operation id (closed, mirrored from the
 * broker `TOOL_NAMES` + `schemas/frontend-operations.json`). */
export const TOOL_SAFE_TO_OPERATION: Record<string, string> = {
  workspace_navigate: "workspace.navigate",
  scene_select: "scene.select",
};

/**
 * Max tool rounds per provider response chain. The broker bounds the tool
 * pairs per request and the calls per response; the CLIENT additionally caps
 * the CONTINUATION count so a provider stuck in a tool loop cannot resubmit
 * forever. After the cap, `executeChatTool` answers `tool-limit` and the
 * thread stops auto-resubmitting (the transcript still persists the denial).
 */
export const MAX_TOOL_ROUNDS_PER_TURN = 4;

export interface ChatToolOutcomeSuccess {
  readonly ok: true;
  /** Registry operation id that executed. */
  readonly operation: string;
  /** Registry `OperationResult.outcome` (never raw JSON in the UI). */
  readonly payload: unknown;
}

export interface ChatToolOutcomeFailure {
  readonly ok: false;
  readonly operation: string;
  readonly error: {
    /** Stable code — `unsupported-tool`, `tool-limit`, or a registry code. */
    readonly code: string;
    /** Short UI-safe text (registry message or fixed denial). */
    readonly text: string;
  };
}

export type ChatToolOutcome = ChatToolOutcomeSuccess | ChatToolOutcomeFailure;

/**
 * Execute one validated tool call through the shared registry, pinned to the
 * conversation's OWN project scope + conversation id (the strict pins the
 * registry demands from tool origin — a wrong/absent pin is a typed
 * context-changed denial, never a UI-style bypass).
 */
export function executeChatTool(input: {
  readonly toolName: string;
  readonly inputArgs: unknown;
  readonly callId: string;
  readonly conversationId: string;
  readonly round: number;
}): ChatToolOutcome {
  const operation = TOOL_SAFE_TO_OPERATION[input.toolName];
  if (operation === undefined) {
    return {
      ok: false,
      operation: input.toolName,
      error: {
        code: "unsupported-tool",
        text: `Unsupported tool "${input.toolName}" — not part of the closed operation set.`,
      },
    };
  }
  if (input.round > MAX_TOOL_ROUNDS_PER_TURN) {
    return {
      ok: false,
      operation,
      error: {
        code: "tool-limit",
        text: `Tool round limit (${MAX_TOOL_ROUNDS_PER_TURN}) reached — the loop is not resubmitted.`,
      },
    };
  }
  // Pins come from the STORE (source of truth), never from the provider or
  // from a caller-supplied parameter: the conversation's owning projectId
  // (null = workspace scope) + the conversation id itself.
  const conversation = useChatConversations.getState().conversations[input.conversationId];
  const projectScopeId = conversation?.projectId ?? null;
  const invocation: ToolInvocation = {
    id: operation,
    args: input.inputArgs,
    callId: input.callId,
    projectScopeId,
    conversationId: input.conversationId,
  };
  const result = executeToolRegistryOperation(invocation);
  if (result.ok) {
    return { ok: true, operation, payload: result.outcome };
  }
  return {
    ok: false,
    operation,
    error: { code: result.error.code, text: result.error.message },
  };
}
