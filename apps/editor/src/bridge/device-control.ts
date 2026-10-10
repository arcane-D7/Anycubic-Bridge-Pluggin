/**
 * Typed Tauri bridge for the device-control approval surface (S9.18-003 slice).
 *
 * The Tauri backend exposes a fixed, public-safe `device_control_availability`
 * command and a typed `device_control_preflight` draft. Writer operations
 * (`device_control_approve` / `device_control_dispatch`) EXIST in the backend
 * and are exercised by controlled Rust tests with an injected trusted session,
 * resolver and transport — but in production the trusted resolver and
 * transport are absent, so every writer route is typed-Unavailable BEFORE any
 * issue/consume. This bridge deliberately does NOT expose approve/dispatch
 * callers: issuance must not surface until a production resolver exists
 * (future S10 authorized flow).
 *
 * Rules enforced here:
 * - `fetchDeviceControlAvailability` is OPTIONAL local-Tauri: default
 *   "blocked" (null) on any failure or outside the Tauri runtime. It never
 *   auto-enables writer capability from a demo profile.
 * - The backend reply contains booleans + fixed reasons only — no user id,
 *   no session bearer. Read telemetry (cloud/demo snapshots) is NOT part of
 *   it: a read surface never grants a writer channel.
 */
import { isTauriRuntime } from "./project-provider.ts";

/** Mirror of `DeviceSessionState` / `DeviceCapabilityState` / `DeviceWriterState`. */
export interface DeviceSessionBootstrap {
  readonly established: boolean;
  /** `auth-unconfigured` | `auth-unavailable` | `login-required` | null. */
  readonly reason: string | null;
}

export interface DeviceCapabilityBootstrap {
  readonly defined: boolean;
  /** `resolver-unavailable` | null. */
  readonly reason: string | null;
}

export interface DeviceWriterBootstrap {
  readonly available: boolean;
  /** First failing gate: `session-unestablished` | resolver | `transport-unavailable` | null. */
  readonly reason: string | null;
}

/** Public-safe availability bootstrap (mirror of `DeviceAvailabilityReply`). */
export interface DeviceAvailabilityDescriptor {
  readonly session: DeviceSessionBootstrap;
  readonly capability: DeviceCapabilityBootstrap;
  readonly writer: DeviceWriterBootstrap;
}

export type DevicePreflightStatus = "ready" | "invalid" | "unavailable";

/** Trusted normalized effect draft (mirror of `NormalizedEffect`). */
export interface DeviceNormalizedEffect {
  readonly action: string;
  readonly summary: string;
  /** Trusted device id — resolver-provided, never the caller's claim. */
  readonly device: string;
  /** Trusted project id — resolver-provided. */
  readonly project: string;
  /** Strictly-validated projection of the args the transport would receive. */
  readonly args: Record<string, unknown>;
  readonly snapshotCapturedAtMs: number;
}

/** Mirror of `DeviceControlPreflightReply`. */
export interface DevicePreflight {
  readonly status: DevicePreflightStatus;
  readonly action: string | null;
  readonly target: string | null;
  readonly effect: DeviceNormalizedEffect | null;
  readonly reason: string | null;
  /** Echo of the UI's claimed draft context — non-authoritative. */
  readonly draft: DeviceDraftContext | null;
}

/** Mirror of the informational `DeviceDraftContext` (never an authority). */
export interface DeviceDraftContext {
  readonly claimedProjectId: string | null;
  readonly revision: number | null;
  readonly artifact: string | null;
  readonly material: string | null;
}

/** Fixed secret-free command error (mirror of `ControlError`). */
export interface DeviceControlError {
  readonly kind: "invalid" | "unavailable" | "session" | "approval" | "db";
  readonly reason: string;
}

/** Draft-only request (mirror of `DeviceControlPreflightRequest`). */
export interface DevicePreflightInput {
  readonly action: string;
  readonly target: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Informational only — the backend resolver is the identity authority. */
  readonly claimedProjectId?: string | null;
  readonly revision?: number | null;
  readonly artifact?: string | null;
  readonly material?: string | null;
}

/** Fixed descriptor used when the Tauri backend is absent or unreachable. */
export const BLOCKED_DEVICE_CONTROL: DeviceAvailabilityDescriptor = {
  session: { established: false, reason: "blocked-runtime" },
  capability: { defined: false, reason: "resolver-unavailable" },
  writer: { available: false, reason: "session-unestablished" },
};

/**
 * Invoke seam for the Tauri runtime. Injected in unit tests; the default
 * lazily imports `@tauri-apps/api/core` (never evaluated outside Tauri).
 */
export type DeviceInvoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

async function defaultInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(command, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Strict validation of one availability part (session/capability/writer). A
 * part must be an object carrying a boolean flag AND an explicit `reason`
 * that is `null` or a fixed string; anything else (missing section, wrong
 * flag type, missing/non-string reason, extra secret-bearing shape) fails the
 * whole descriptor. Unknown keys are discarded — never echoed.
 */
function pickBoolSection(
  value: unknown,
  flagKey: "established" | "defined" | "available",
): { readonly flag: boolean; readonly reason: string | null } | null {
  if (!isRecord(value)) return null;
  if (typeof value[flagKey] !== "boolean") return null;
  const reason = value.reason;
  if (!isStringOrNull(reason)) return null;
  return { flag: value[flagKey], reason };
}

/**
 * Strict, secret-free normalizer for the raw Tauri `device_control_availability`
 * reply. ALL three sections must be well-shaped (boolean flag + `reason`
 * string|null) or the descriptor is refused as malformed — a descriptor whose
 * `capability`/`writer` sections are missing or `undefined` can never pass the
 * structural type alone. Returns `null` on any mismatch (callers fall back to
 * a blocked descriptor), and rebuilds a fresh object so unknown keys
 * (e.g. an accidentally-echoed token) are discarded.
 */
export function normalizeDeviceAvailability(value: unknown): DeviceAvailabilityDescriptor | null {
  if (!isRecord(value)) return null;
  const session = pickBoolSection(value.session, "established");
  if (!session) return null;
  const capability = pickBoolSection(value.capability, "defined");
  if (!capability) return null;
  const writer = pickBoolSection(value.writer, "available");
  if (!writer) return null;
  return {
    session: { established: session.flag, reason: session.reason },
    capability: { defined: capability.flag, reason: capability.reason },
    writer: { available: writer.flag, reason: writer.reason },
  };
}

const PREFLIGHT_STATUSES: ReadonlySet<string> = new Set(["ready", "invalid", "unavailable"]);

function readKey(part: Record<string, unknown>, key: string): unknown {
  return part[key];
}

/**
 * Pick a `string|null` field, allowing a snake_case alias to be normalized to
 * the camelCase contract name (both the exact key and the alias must be
 * absent → `undefined`; a non-string non-null value is a malformed reply).
 */
function fieldString(
  part: Record<string, unknown>,
  camel: string,
  snake: string,
): string | null | undefined {
  const exact = readKey(part, camel);
  if (exact !== undefined) return isStringOrNull(exact) ? exact : undefined;
  const alias = readKey(part, snake);
  return alias === undefined ? undefined : isStringOrNull(alias) ? alias : undefined;
}

/**
 * Strict normalizer for the raw Tauri `device_control_preflight` reply. The
 * backend serializes snake_case keys (`snapshot_captured_at_ms`,
 * `claimed_project_id`); consumers read camelCase — without normalization
 * `effect.snapshotCapturedAtMs` / `draft.claimedProjectId` would be
 * `undefined` at runtime. This validates status/reason/action/target and the
 * effect + draft objects exactly, maps snake→camel for every reference, and
 * rebuilds fresh objects (unknown keys — including any echoed secret — are
 * discarded). Returns `null` on any malformed shape.
 */
export function normalizeDevicePreflight(value: unknown): DevicePreflight | null {
  if (!isRecord(value)) return null;
  if (typeof value.status !== "string" || !PREFLIGHT_STATUSES.has(value.status)) return null;
  const status = value.status as DevicePreflightStatus;

  const action = fieldString(value, "action", "action");
  if (action === undefined) return null;
  const target = fieldString(value, "target", "target");
  if (target === undefined) return null;
  const reason = fieldString(value, "reason", "reason");
  if (reason === undefined) return null;

  const rawEffect = readKey(value, "effect");
  const rawDraft = readKey(value, "draft");

  let effect: DeviceNormalizedEffect | null = null;
  if (rawEffect === null) {
    // Null effect is only valid when the status is not `ready`.
    if (status === "ready") return null;
  } else if (isRecord(rawEffect)) {
    const actionText = fieldString(rawEffect, "action", "action");
    const summary = fieldString(rawEffect, "summary", "summary");
    const device = fieldString(rawEffect, "device", "device");
    const project = fieldString(rawEffect, "project", "project");
    const args = readKey(rawEffect, "args");
    const capturedAt = fieldNumber(rawEffect, "snapshotCapturedAtMs", "snapshot_captured_at_ms");
    // An effect describes a REAL device/project: every field must be a
    // non-null string and the capture time a finite number.
    if (
      actionText === null ||
      actionText === undefined ||
      summary === null ||
      summary === undefined ||
      device === null ||
      device === undefined ||
      project === null ||
      project === undefined ||
      capturedAt === null ||
      capturedAt === undefined ||
      !isRecord(args)
    ) {
      return null;
    }
    // Normalize the snake→camel effect projection, dropping unknown keys.
    effect = {
      action: actionText,
      summary,
      device,
      project,
      args,
      snapshotCapturedAtMs: capturedAt,
    };
  } else {
    return null;
  }

  let draft: DeviceDraftContext | null = null;
  if (rawDraft !== null) {
    if (!isRecord(rawDraft)) return null;
    const claimedProjectId = fieldString(rawDraft, "claimedProjectId", "claimed_project_id");
    const artifact = fieldString(rawDraft, "artifact", "artifact");
    const material = fieldString(rawDraft, "material", "material");
    const revision = fieldNumber(rawDraft, "revision", "revision");
    if (claimedProjectId === undefined || revision === undefined) return null;
    if (artifact === undefined || material === undefined) return null;
    draft = { claimedProjectId, revision, artifact, material };
  }

  if (status !== "ready" && effect !== null) return null;

  return { status, action, target, effect, reason, draft };
}

function fieldNumber(
  part: Record<string, unknown>,
  camel: string,
  snake: string,
): number | null | undefined {
  const exact = readKey(part, camel);
  if (exact !== undefined) return isNumberOrNull(exact) ? exact : undefined;
  const alias = readKey(part, snake);
  return alias === undefined ? undefined : isNumberOrNull(alias) ? alias : undefined;
}

function unavailableDraft(reason: string): DevicePreflight {
  return {
    status: "unavailable",
    action: null,
    target: null,
    effect: null,
    reason,
    draft: null,
  };
}

/**
 * Optional local-Tauri bootstrap. Defaults to `BLOCKED_DEVICE_CONTROL`
 * (never auto-enabled) when the runtime is absent or any step fails.
 * Production backend: `session.established === false` (empty auth store,
 * no login endpoint — and never inferred from user rows) and
 * `capability.defined === false` (no resolver) — read telemetry is
 * deliberately a separate, non-writer surface. The reply is strictly
 * normalized: a malformed section in ANY of session/capability/writer is
 * treated as blocked rather than passing a partial structural guard.
 */
export async function fetchDeviceControlAvailability(
  invokeFn: DeviceInvoke = defaultInvoke,
): Promise<DeviceAvailabilityDescriptor> {
  if (!isTauriRuntime()) return BLOCKED_DEVICE_CONTROL;
  try {
    const raw = await invokeFn<unknown>("device_control_availability", {});
    return normalizeDeviceAvailability(raw) ?? BLOCKED_DEVICE_CONTROL;
  } catch {
    return BLOCKED_DEVICE_CONTROL;
  }
}

/**
 * Typed normalized-effect draft. NEVER executes — it describes the effect the
 * backend WOULD issue, only when a trusted resolver exists and its snapshot is
 * current; otherwise the backend returns typed `unavailable` (not simulated).
 * The reply is strictly normalized (snake_case keys from the backend are
 * mapped to the camelCase TS contract), and a malformed reply yields a typed
 * `unavailable("malformed-reply")` — never a partial object. Outside the
 * Tauri runtime this returns a typed unavailable draft.
 */
export async function previewDeviceControlEffect(
  input: DevicePreflightInput,
  invokeFn: DeviceInvoke = defaultInvoke,
): Promise<DevicePreflight> {
  if (!isTauriRuntime()) return unavailableDraft("runtime-unavailable");
  try {
    const raw = await invokeFn<unknown>("device_control_preflight", {
      request: {
        action: input.action,
        target: input.target,
        payload: input.payload,
        claimed_project_id: input.claimedProjectId ?? null,
        revision: input.revision ?? null,
        artifact: input.artifact ?? null,
        material: input.material ?? null,
      },
    });
    return normalizeDevicePreflight(raw) ?? unavailableDraft("malformed-reply");
  } catch {
    return unavailableDraft("invoke-failed");
  }
}
