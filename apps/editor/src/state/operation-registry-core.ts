/**
 * S9.18-001 — shared reversible FRONTEND operation registry core.
 *
 * Pure, dependency-light core (no React/zustand runtime imports; type-only
 * imports at most) so it is directly importable by Node tests with the
 * repo's `?key=` cache-buster pattern. It owns the versioned catalog and the
 * closed runtime validation for the first two reversible operations —
 * `workspace.navigate` and `scene.select` — which are executed by BOTH the
 * existing editor UI and the future AI-tool frontend callback entry
 * (S9.18-002 tool loop, NOT started — tool calls still return
 * `unsupported-tools`; this file only fronts window-local UI concerns).
 *
 * `executionLocation` is explicitly `"frontend"`: nothing in this registry
 * ever contacts the broker, printer, slicer or cloud. The backend catalog
 * (crates/broker action_registry.rs, OPERATION_SCHEMA_VERSION=1) truthfully
 * EXCLUDES these UI-only navigation/geometry actions — see
 * docs/operations-catalog-s9-18-001.md §6 — so the frontend catalog stays a
 * separate, documented federation until the S9.18-002 worker ties the loop.
 *
 * Exclusion contract (both operations):
 *  - never mutates project scope or conversation identity (nav is view-only);
 *  - never starts slicing/builds or any printer/broker/cloud traffic;
 *  - selection only touches the shared scene store select() — no duplicated
 *    mutation, no geometry rewrite.
 *
 * Idempotency: tool-origin invocations MUST carry an explicit non-empty
 * callId AND explicit `projectScopeId`/`conversationId` pins (each
 * `string | null`, strict equality INCLUDING null). Omitted pins are a typed
 * static denial — they can never be a UI-style bypass for the future tool
 * API; UI-origin calls (no callId) legitimately skip the pins and the cache.
 * The bounded per-scope cache stores full result receipts keyed by
 * (scope, operation id, callId): a duplicate returns the CACHED receipt with
 * zero effects no matter what the user changed in between; the same callId
 * with different args is refused (`call-id-reused`); the same callId across
 * DIFFERENT operations is a distinct entry (never a false replay/reuse).
 * The cache is NEVER cleared from untrusted request pins — an authoritative
 * scope generation rotates ONLY when the live stores actually observe a
 * project/conversation change, so a request pinned to a scope that rotated
 * (A→B→A) is a typed context-changed denial instead of a re-execution.
 * Capacity is fail-closed per scope (new ids are refused with `cache-full`,
 * never a silent eviction that would allow re-execution).
 */

export const OPERATION_CATALOG_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// workspace.navigate
// ---------------------------------------------------------------------------

export const WORKSPACE_VIEWS = ["home", "prepare", "preview", "workbench"] as const;
export type WorkspaceViewId = (typeof WORKSPACE_VIEWS)[number];

export function isWorkspaceViewId(value: unknown): value is WorkspaceViewId {
  return typeof value === "string" && (WORKSPACE_VIEWS as readonly string[]).includes(value);
}

/** Defense-in-depth parser reused by the store action. Unknown → null. */
export function parseWorkspaceView(value: unknown): WorkspaceViewId | null {
  return isWorkspaceViewId(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Minimal context shape — projected by the wiring from LIVE stores every
// invocation (never a stale UI closure).
// ---------------------------------------------------------------------------

/** Projection of the scene snapshot the registry needs for eligibility. */
export interface SceneObjectLike {
  readonly name: string;
  readonly visible: boolean;
  /** Absent = the default plate (normalized with the wiring defaultPlateId). */
  readonly plateId?: string;
  readonly watertight: boolean;
}

export interface OperationContext {
  readonly view: WorkspaceViewId;
  readonly objects: readonly SceneObjectLike[];
  readonly activePlateId: string | null;
  readonly projectScopeId: string | null;
  readonly conversationId: string | null;
}

// ---------------------------------------------------------------------------
// Versioned closed input schema
// ---------------------------------------------------------------------------

export interface OperationFieldSpec {
  readonly type: "enum" | "string";
  /** Required when type === "enum". */
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly required: boolean;
  readonly description?: string;
}

export interface OperationInputShape {
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, OperationFieldSpec>>;
}

export type ExecutionLocation = "frontend";

export interface OperationEntry {
  readonly id: string;
  readonly kind: "workspace" | "scene";
  readonly schemaVersion: number;
  readonly reversible: true;
  readonly executionLocation: ExecutionLocation;
  readonly description: string;
  readonly inputSchema: OperationInputShape;
  readonly eligibility: readonly string[];
  readonly exclusions: readonly string[];
}

export const WORKSPACE_NAVIGATE_SCHEMA: OperationInputShape = {
  additionalProperties: false,
  required: ["view"],
  properties: {
    view: {
      type: "enum",
      enum: [...WORKSPACE_VIEWS],
      required: true,
      description: "Target workspace view (home/prepare/preview/workbench).",
    },
  },
};

export const SCENE_SELECT_SCHEMA: OperationInputShape = {
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      required: true,
      description:
        "Object name that must exist in the active scene, be visible and belong to the active plate.",
    },
  },
};

export const OPERATIONS: readonly OperationEntry[] = [
  {
    id: "workspace.navigate",
    kind: "workspace",
    schemaVersion: OPERATION_CATALOG_VERSION,
    reversible: true,
    executionLocation: "frontend",
    description:
      "Switch the active workspace view (home/prepare/preview/workbench). Pure view state — project scope, conversation identity and slicing state are never touched.",
    inputSchema: WORKSPACE_NAVIGATE_SCHEMA,
    eligibility: [
      "The target view must be one of home/prepare/preview/workbench (closed enum).",
      "When the request pins a project/conversation scope, it must equal the currently active scope, else a typed context-changed denial.",
      "Same callId + same args replays as a no-op; same callId + different args is refused.",
    ],
    exclusions: [
      "Never mutates project scope, the active conversation or the scene.",
      "Never starts slicing/builds or sends any printer/broker/cloud traffic.",
    ],
  },
  {
    id: "scene.select",
    kind: "scene",
    schemaVersion: OPERATION_CATALOG_VERSION,
    reversible: true,
    executionLocation: "frontend",
    description:
      "Select an existing, visible object on the active plate through the shared scene store select(). Read-only preview is preserved: selection is only eligible on the prepare surface.",
    inputSchema: SCENE_SELECT_SCHEMA,
    eligibility: [
      "The scene store must be hydrated (objects non-empty).",
      "The name must exist, be visible (visible !== false) and belong to the active plate.",
      "Only available on the prepare surface — preview stays read-only, home/workbench deny selection.",
    ],
    exclusions: [
      "No geometry mutation, no print/re-print, no printer/upload/control traffic.",
      "Unknown names, hidden objects, cross-plate objects and non-prepare views are typed denials with zero state effects.",
    ],
  },
];

export const OPERATION_IDS: readonly string[] = OPERATIONS.map((op) => op.id);

export function findOperation(id: unknown): OperationEntry | undefined {
  return typeof id === "string" ? OPERATIONS.find((op) => op.id === id) : undefined;
}

// ---------------------------------------------------------------------------
// Closed runtime validation (prototype-pollution safe)
// ---------------------------------------------------------------------------

/** Keys that must never be accepted from a caller-shaped args object. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Prototype-level check: only Object.prototype (or null, from
  // Object.create(null)) shaped args are accepted — class instances, Date,
  // Map/Set and other engine-builtins are NOT plain records.
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateArgs(
  schema: OperationInputShape,
  args: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; details: string } {
  if (!isPlainRecord(args)) return { ok: false, details: "args must be a plain object" };
  const ownKeys = Object.keys(args);
  for (const key of ownKeys) {
    if (FORBIDDEN_KEYS.has(key)) return { ok: false, details: `forbidden key "${key}"` };
  }
  for (const key of ownKeys) {
    if (!Object.hasOwn(schema.properties, key)) {
      return { ok: false, details: `unknown key "${key}"` };
    }
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(args, key)) return { ok: false, details: `missing required "${key}"` };
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (spec.type === "enum") {
      const allowed = spec.enum as readonly string[] | undefined;
      if (typeof value !== "string" || (allowed !== undefined && !allowed.includes(value))) {
        return {
          ok: false,
          details: `"${key}" must be one of ${(allowed ?? []).join("/")}`,
        };
      }
    } else if (spec.type === "string") {
      if (typeof value !== "string") {
        return { ok: false, details: `"${key}" must be a string` };
      }
      if (spec.minLength !== undefined && value.length < spec.minLength) {
        return { ok: false, details: `"${key}" is too short` };
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        return { ok: false, details: `"${key}" is too long` };
      }
    }
    if (value === null || typeof value === "undefined") {
      return { ok: false, details: `"${key}" must not be null/undefined` };
    }
  }
  return { ok: true, value: args as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Typed results
// ---------------------------------------------------------------------------

export type OperationErrorCode =
  | "operation-not-found"
  | "invalid-arguments"
  | "invalid-invocation"
  | "context-changed"
  | "unavailable"
  | "call-id-reused"
  | "cache-full"
  | "canceled";

export interface OperationError {
  readonly code: OperationErrorCode;
  readonly message: string;
  /** Structured reason for `unavailable` denials (eligibility) or context. */
  readonly reason?: string;
  readonly details?: string;
}

export type OperationOutcome =
  | {
      readonly code: "navigated" | "already-on-view";
      readonly view: WorkspaceViewId;
      readonly previousView: WorkspaceViewId;
      readonly executionLocation: ExecutionLocation;
    }
  | {
      readonly code: "selected";
      readonly name: string;
      readonly watertight: boolean;
      /** Readback from the scene store mirror after select() — always true
       * for an eligible object; kept so callers see observable truth. */
      readonly applied: boolean;
      readonly executionLocation: ExecutionLocation;
    };

export type OperationResult =
  | { readonly ok: true; readonly operation: string; readonly outcome: OperationOutcome }
  | { readonly ok: false; readonly operation: string; readonly error: OperationError };

// ---------------------------------------------------------------------------
// Selection eligibility — pure over the projected context
// ---------------------------------------------------------------------------

export type SelectionDenialReason =
  | "no-active-scene"
  | "no-such-object"
  | "object-hidden"
  | "object-not-on-active-plate"
  | "selection-only-in-prepare";

export const SELECTION_DENIAL_MESSAGES: Record<SelectionDenialReason, string> = {
  "no-active-scene": "no scene objects are loaded — nothing to select",
  "no-such-object": "no object with that name exists in the active scene",
  "object-hidden": "the object is hidden — unhide it before selecting",
  "object-not-on-active-plate": "the object does not belong to the active plate",
  "selection-only-in-prepare":
    "selection is only available on the prepare surface (preview stays read-only)",
};

export function checkSceneSelectEligibility(
  name: string,
  ctx: OperationContext,
  defaultPlateId: string,
): { ok: true; watertight: boolean } | { ok: false; reason: SelectionDenialReason } {
  if (ctx.view !== "prepare") return { ok: false, reason: "selection-only-in-prepare" };
  if (ctx.objects.length === 0) return { ok: false, reason: "no-active-scene" };
  const object = ctx.objects.find((obj) => obj.name === name);
  if (!object) return { ok: false, reason: "no-such-object" };
  if (object.visible !== true) return { ok: false, reason: "object-hidden" };
  if (ctx.activePlateId === null) return { ok: false, reason: "object-not-on-active-plate" };
  const plateOf = object.plateId ?? defaultPlateId;
  if (plateOf !== ctx.activePlateId) return { ok: false, reason: "object-not-on-active-plate" };
  return { ok: true, watertight: object.watertight };
}

// ---------------------------------------------------------------------------
// Idempotency invocation cache (bounded; per project/conversation scope)
// ---------------------------------------------------------------------------

export interface InvocationKey {
  readonly projectScopeId: string | null;
  readonly conversationId: string | null;
  readonly callId: string;
}

/**
 * Deterministic fingerprint of CLOSED-validated args (sorted keys), BOUND to
 * the operation id. A `workspace.navigate` call and a `scene.select` call
 * with structurally equal args never share a fingerprint, so a receipt can
 * never be mis-attributed across operations even if an entry key were ever
 * derived from the callId alone.
 */
export function argsFingerprint(operationId: string, args: Record<string, unknown>): string {
  return JSON.stringify([operationId, JSON.stringify(args, Object.keys(args).sort())]);
}

/** Full result receipt stored for a successful/failed tool-origin call. */
export interface InvocationCacheEntry {
  readonly argsKey: string;
  /** Authoritative scope generation at registration (rotation time). */
  readonly generation: number;
  readonly result: OperationResult;
}

/**
 * Bounded idempotency cache.
 *
 * - Scope keys are an INJECTIVE JSON tuple — a project literally named
 *   `a::conversation:b` can never collide with a different (project,
 *   conversation) split under the old template-string delimiter.
 * - Entry keys bind the OPERATION id + callId: never a false replay/reuse
 *   for the same callId across different operations.
 * - `lookup` is read-only: it never creates an empty bucket ("new" leaves no
 *   map behind — no unbounded empty-scope maps).
 * - Capacity is bounded PER SCOPE and fails closed: a new callId is refused
 *   (`cache-full` upstream) instead of silently evicting taken entries, so a
 *   previously registered id can never become silently re-executable.
 * - The cache is only mutated by `register` (operator `flush()` exists for
 *   explicit teardown and tests) — never from untrusted request pins.
 */
export class InvocationCache {
  readonly maxEntries: number;
  private readonly scopes = new Map<string, Map<string, InvocationCacheEntry>>();

  constructor(maxEntries = 64) {
    this.maxEntries = maxEntries;
  }

  scopeKeyOf(projectScopeId: string | null, conversationId: string | null): string {
    return JSON.stringify([projectScopeId, conversationId]);
  }

  entryKeyOf(operationId: string, callId: string): string {
    return JSON.stringify([operationId, callId]);
  }

  /** Read-only — never creates a bucket. */
  lookup(scopeKey: string, entryKey: string): InvocationCacheEntry | undefined {
    return this.scopes.get(scopeKey)?.get(entryKey);
  }

  /** Pre-flight capacity check for a NEW entry in a scope (fail closed). */
  canRegister(scopeKey: string, entryKey: string): boolean {
    const bucket = this.scopes.get(scopeKey);
    if (!bucket) return true;
    return bucket.has(entryKey) || bucket.size < this.maxEntries;
  }

  /** Registers a receipt; returns false if the scope is at capacity. */
  register(
    scopeKey: string,
    entryKey: string,
    argsKey: string,
    generation: number,
    result: OperationResult,
  ): boolean {
    if (!this.canRegister(scopeKey, entryKey)) return false;
    let bucket = this.scopes.get(scopeKey);
    if (!bucket) {
      bucket = new Map();
      this.scopes.set(scopeKey, bucket);
    }
    bucket.set(entryKey, { argsKey, generation, result });
    return true;
  }

  flushScopeKey(scopeKey: string): void {
    this.scopes.delete(scopeKey);
  }

  flush(): void {
    this.scopes.clear();
  }

  get size(): number {
    let total = 0;
    for (const entries of this.scopes.values()) total += entries.size;
    return total;
  }
}

// ---------------------------------------------------------------------------
// Registry factory — injected store access so the SAME pipeline runs in the
// browser (real zustand stores) and in Node unit tests (fake access).
// ---------------------------------------------------------------------------

export interface OperationStoreAccess {
  readonly workspace: {
    readonly view: () => WorkspaceViewId;
    readonly setView: (view: WorkspaceViewId) => boolean;
  };
  readonly scene: {
    readonly objects: () => readonly SceneObjectLike[];
    readonly selectedNames: () => readonly string[];
    readonly select: (name: string, watertight: boolean) => void;
  };
  readonly plates: {
    readonly activePlateId: () => string | null;
    readonly defaultPlateId: () => string;
  };
  readonly chat: {
    readonly currentProjectId: () => string | null;
    readonly activeConversationId: () => string | null;
  };
}

export interface RegistryInvocation {
  readonly id: string;
  readonly args: unknown;
  /**
   * Present ONLY for tool-origin callbacks: pins the call to the named
   * project/conversation scope (strict equality including null against the
   * ACTIVE context, else a typed context-changed denial) and enables the
   * idempotency receipts. A tool invocation MUST ALSO carry explicit
   * `projectScopeId` and `conversationId` (each `string | null`) — omitted
   * pins are a typed static denial, never a UI-style bypass. UI-origin
   * calls omit `callId` (and must omit the pins too): no pin, no receipt,
   * no scope requirement.
   */
  readonly callId?: string;
  readonly projectScopeId?: string | null;
  readonly conversationId?: string | null;
}

/**
 * EXPLICIT strict tool-origin envelope. The callId and both scope pins are
 * MANDATORY at the type level (each `string | null`), so a tool caller
 * cannot omit a pin the way a UI-origin `RegistryInvocation` legitimately
 * does. Use `executeTool` for this shape (`execute` keeps the defensive
 * runtime guards for loose JS callers). `canceled` lets a caller abort the
 * call BEFORE any side effect: a boolean at submission time or a predicate
 * re-evaluated when the call reaches the effect boundary (after the
 * scope-alive gate and the replay fast-path, so an ALREADY-APPLIED receipt
 * still replays idempotently).
 */
export interface ToolInvocation {
  readonly id: string;
  readonly args: unknown;
  /** Mandatory, non-empty for tool-origin calls. */
  readonly callId: string;
  /** Mandatory — `null` pins the root/un-scoped project scope. */
  readonly projectScopeId: string | null;
  /** Mandatory — `null` pins the root/un-scoped conversation. */
  readonly conversationId: string | null;
  /**
   * Cancel before effect. Function form is evaluated fresh at the effect
   * boundary. A canceled call is a typed `canceled` denial with ZERO side
   * effects and is NEVER cached — the caller may retry with a fresh callId.
   */
  readonly canceled?: boolean | (() => boolean);
}

export interface RegistryCatalog {
  readonly schemaVersion: number;
  readonly executionLocation: ExecutionLocation;
  readonly operations: readonly OperationEntry[];
}

export interface OperationRegistry {
  /** UI-origin entry (no callId, no pins) + loose tool-origin calls (runtime
   * guard when callId pins are supplied on a plain `RegistryInvocation`). */
  readonly execute: (invocation: RegistryInvocation) => OperationResult;
  /** STRICT tool-origin entry: the envelope type itself mandates callId +
   * both scope pins, with runtime re-validation for JS callers. */
  readonly executeTool: (invocation: ToolInvocation) => OperationResult;
  readonly catalog: () => RegistryCatalog;
  readonly readContext: () => OperationContext;
  readonly flushCache: () => void;
  readonly cacheSize: () => number;
}

export function createOperationRegistry(
  access: OperationStoreAccess,
  options: { readonly defaultPlateId?: string; readonly cacheMaxEntries?: number } = {},
): OperationRegistry {
  const defaultPlateId = options.defaultPlateId ?? "plate-1";
  const cache = new InvocationCache(options.cacheMaxEntries ?? 64);
  // Authoritative scope generation: rotates ONLY when the LIVE context
  // projections actually observe a project/conversation change. Untrusted
  // request pins never touch it and never flush the cache.
  let observedScopeKey: string | null = null;
  let scopeGeneration = 0;

  function readContext(): OperationContext {
    return {
      view: access.workspace.view(),
      objects: access.scene.objects(),
      activePlateId: access.plates.activePlateId(),
      projectScopeId: access.chat.currentProjectId(),
      conversationId: access.chat.activeConversationId(),
    };
  }

  function contextScopeKey(ctx: OperationContext): string {
    return cache.scopeKeyOf(ctx.projectScopeId, ctx.conversationId);
  }

  function advanceScopeIfChanged(ctx: OperationContext): void {
    const key = contextScopeKey(ctx);
    if (key !== observedScopeKey) {
      observedScopeKey = key;
      scopeGeneration += 1;
    }
  }

  /** Executes the operation against the LIVE context (never a stale UI
   * closure). Replays never reach here: duplicates are short-circuited to
   * their CACHED receipt before any effect. */
  function apply(
    operation: OperationEntry,
    args: Record<string, unknown>,
    ctx: OperationContext,
  ): OperationResult {
    if (operation.id === "workspace.navigate") {
      const view = parseWorkspaceView(args.view);
      if (view === null) {
        // Closed-validated earlier; defensive unreachable branch.
        return {
          ok: false,
          operation: operation.id,
          error: {
            code: "invalid-arguments",
            message: "view must be one of home/prepare/preview/workbench",
          },
        };
      }
      const previousView = access.workspace.view();
      const applied = access.workspace.setView(view);
      if (!applied) {
        return {
          ok: false,
          operation: operation.id,
          error: {
            code: "unavailable",
            reason: "view-store-refused",
            message: "workspace view store refused the transition",
          },
        };
      }
      return {
        ok: true,
        operation: operation.id,
        outcome: {
          code: previousView === view ? "already-on-view" : "navigated",
          view,
          previousView,
          executionLocation: "frontend",
        },
      };
    }
    if (operation.id === "scene.select") {
      const name = String(args.name);
      const eligibility = checkSceneSelectEligibility(name, ctx, defaultPlateId);
      if (!eligibility.ok) {
        return {
          ok: false,
          operation: operation.id,
          error: {
            code: "unavailable",
            reason: eligibility.reason,
            message: SELECTION_DENIAL_MESSAGES[eligibility.reason],
          },
        };
      }
      // The EXACT shared mutation the UI tree uses — never duplicated here.
      access.scene.select(name, eligibility.watertight);
      const applied = access.scene.selectedNames().includes(name);
      return {
        ok: true,
        operation: operation.id,
        outcome: {
          code: "selected",
          name,
          watertight: eligibility.watertight,
          applied,
          executionLocation: "frontend",
        },
      };
    }
    return {
      ok: false,
      operation: operation.id,
      error: {
        code: "unavailable",
        reason: "handler-missing",
        message: "no frontend handler wired for this operation",
      },
    };
  }

  function staticDenial(
    operation: OperationEntry,
    code: "operation-not-found" | "invalid-invocation",
    message: string,
  ) {
    return { ok: false as const, operation: operation.id, error: { code, message } };
  }

  /**
   * Cancellation gate: boolean at submission, or a predicate evaluated HERE
   * (at the effect boundary, after the scope-alive gate and the replay
   * fast-path). A throwing predicate fails CLOSED toward no side effects.
   */
  function isCanceled(flag: boolean | (() => boolean) | undefined): boolean {
    if (flag === undefined) return false;
    if (typeof flag === "boolean") return flag;
    try {
      return flag() === true;
    } catch {
      // A broken predicate must never let a side effect through.
      return true;
    }
  }

  type InvocationOrigin = "auto" | "tool";

  function executeEnvelope(
    invocation: RegistryInvocation,
    origin: InvocationOrigin,
    canceled?: boolean | (() => boolean),
  ): OperationResult {
    const operation = findOperation(invocation.id);
    if (!operation) {
      return {
        ok: false,
        operation: typeof invocation.id === "string" ? invocation.id : "unknown",
        error: {
          code: "operation-not-found",
          message: "unknown operation — no frontend handler wired",
        },
      };
    }

    // `hasCallId` selects the origin. `execute` auto-detects (UI-origin when
    // the id is absent); `executeTool` FORCES the tool branch so a strict
    // envelope can never fall through to a pin-less UI path.
    const hasCallId =
      origin === "tool"
        ? true
        : typeof invocation.callId === "string" && invocation.callId.length > 0;
    if (!hasCallId) {
      // UI-origin: no pins allowed — the UI cannot bypass the scope contract
      // by "forgetting" pins on a call that carries pins.
      if (invocation.projectScopeId !== undefined || invocation.conversationId !== undefined) {
        return staticDenial(
          operation,
          "invalid-invocation",
          "UI-origin calls must not pin a project/conversation scope",
        );
      }
    } else {
      // Tool-origin envelope: callId + EXPLICIT string|null pins. Omitted ids
      // are a typed static denial — never a UI-style bypass for the future
      // tool API.
      if (typeof invocation.callId !== "string" || invocation.callId.length === 0) {
        return staticDenial(
          operation,
          "invalid-invocation",
          "tool invocations must carry a non-empty callId",
        );
      }
      if (
        !Object.hasOwn(invocation, "projectScopeId") ||
        !Object.hasOwn(invocation, "conversationId")
      ) {
        return staticDenial(
          operation,
          "invalid-invocation",
          "tool invocations must pin projectScopeId and conversationId (null allowed)",
        );
      }
      const project = invocation.projectScopeId;
      const conversation = invocation.conversationId;
      if (project !== null && typeof project !== "string") {
        return staticDenial(
          operation,
          "invalid-invocation",
          "projectScopeId must be a string or null",
        );
      }
      if (conversation !== null && typeof conversation !== "string") {
        return staticDenial(
          operation,
          "invalid-invocation",
          "conversationId must be a string or null",
        );
      }
    }

    const validated = validateArgs(operation.inputSchema, invocation.args);
    if (!validated.ok) {
      return {
        ok: false,
        operation: operation.id,
        error: { code: "invalid-arguments", message: validated.details },
      };
    }
    const args = validated.value;
    const ctx = readContext();

    // UI-origin: closed-validate, then apply with the live context. No pin,
    // no receipt, no generation bookkeeping.
    if (!hasCallId) return apply(operation, args, ctx);

    // Tool-origin below. Pins are STRICT (null included). The authoritative
    // scope generation rotates only on an ACTUAL observed scope change, and
    // the scope-alive check ALWAYS runs before any cache read/write — an
    // untrusted request can never flush or pollute the receipts.
    const pinProject = invocation.projectScopeId as string | null;
    const pinConversation = invocation.conversationId as string | null;
    advanceScopeIfChanged(ctx);
    const scopeKey = contextScopeKey(ctx);

    if (pinProject !== ctx.projectScopeId) {
      return {
        ok: false,
        operation: operation.id,
        error: {
          code: "context-changed",
          reason: "project",
          message: "active project scope differs from the pinned one",
        },
      };
    }
    if (pinConversation !== ctx.conversationId) {
      return {
        ok: false,
        operation: operation.id,
        error: {
          code: "context-changed",
          reason: "conversation",
          message: "active conversation differs from the pinned one",
        },
      };
    }

    // Fingerprint bound to the OPERATION id (never a cross-operation
    // false-match) + entry key binding operation id AND callId.
    const argsKey = argsFingerprint(operation.id, args);
    const entryKey = cache.entryKeyOf(operation.id, invocation.callId as string);
    const hit = cache.lookup(scopeKey, entryKey);
    if (hit) {
      if (hit.generation !== scopeGeneration) {
        // The authoritative scope actually rotated during this call's
        // lifetime (A→B→A): neither replay nor re-execution is safe — the
        // caller must re-issue against the fresh epoch.
        return {
          ok: false,
          operation: operation.id,
          error: {
            code: "context-changed",
            reason: "scope-rotated",
            message: "the project/conversation scope rotated since this call started",
          },
        };
      }
      if (hit.argsKey !== argsKey) {
        return {
          ok: false,
          operation: operation.id,
          error: {
            code: "call-id-reused",
            message: "callId already used with different arguments — refuse to re-target",
          },
        };
      }
      // Duplicate: the bounded receipt is returned WITHOUT any effect, even
      // if the user changed the view/selection in between — a reconnect or
      // replay never overrides live user intervention. The cancellation gate
      // sits BELOW this fast-path on purpose: an already-applied receipt
      // replays idempotently even when the retry arrives marked canceled.
      return hit.result;
    }

    // CANCELLATION GATE — the call has a live, scope-alive entry but has not
    // been applied yet. A canceled call is denied BEFORE any side effect and
    // is never cached, so the caller may retry with a fresh callId.
    if (isCanceled(canceled)) {
      return {
        ok: false,
        operation: operation.id,
        error: {
          code: "canceled",
          reason: "call-canceled",
          message: "the call was canceled before any side effect — retry with a fresh callId",
        },
      };
    }

    // New tool-origin call: fail CLOSED on capacity (never silently evict →
    // never make a taken id re-executable). Zero effects on denial.
    if (!cache.canRegister(scopeKey, entryKey)) {
      return {
        ok: false,
        operation: operation.id,
        error: {
          code: "cache-full",
          message:
            "registry idempotency cache is at capacity for this scope — flush or retry in a fresh scope",
        },
      };
    }

    const result = apply(operation, args, ctx);
    // Receipt tombstoning: results reached here (after the scope-alive gate
    // and the cancellation gate) are cached whether ok OR failed, so retrying
    // a same invalid callId returns the same failure instead of re-attempting
    // the side effect. Pre-gate failures (operation-not-found /
    // invalid-arguments / invalid-invocation / context-changed / canceled /
    // cache-full) are deterministic or live-revalidated, so they are never
    // cached.
    cache.register(scopeKey, entryKey, argsKey, scopeGeneration, result);
    return result;
  }

  /** UI-origin + loose (runtime-guarded) tool-origin entry. */
  function execute(invocation: RegistryInvocation): OperationResult {
    return executeEnvelope(invocation, "auto");
  }

  /** STRICT tool-origin entry — the envelope type mandates callId + pins. */
  function executeTool(invocation: ToolInvocation): OperationResult {
    return executeEnvelope(invocation, "tool", invocation.canceled);
  }

  return {
    execute,
    executeTool,
    catalog: () => ({
      schemaVersion: OPERATION_CATALOG_VERSION,
      executionLocation: "frontend",
      operations: OPERATIONS.map((op) => ({ ...op })),
    }),
    readContext,
    flushCache: () => {
      cache.flush();
      observedScopeKey = null;
      scopeGeneration = 0;
    },
    cacheSize: () => cache.size,
  };
}
