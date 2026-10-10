/**
 * S9.17-004 — Workbench Live core (pure, headless, dependency-free).
 *
 * Three SEMANTIC live views owned by Workbench:
 *   1. telemetry — observed state only (origin, capture time, freshness);
 *   2. camera    — availability state only; a typed injectable provider,
 *                  production has NO adapter so activation never issues an
 *                  order or fakes a loading frame;
 *   3. artifact  — an explicit backend job/printer binding is REQUIRED to
 *                  link a parsed IR artifact to the live job. Nothing is
 *                  inferred from filenames, texts or the selected profile.
 *
 * Importable directly under Node 24 native type-stripping (`node --test`).
 * No zustand/react/three imports. `.ts` extensions on relative imports.
 */
import type { PrinterSnapshot } from "../bridge/types.ts";

// ---------------------------------------------------------------------------
// 1. Telemetry — observed origin / freshness / capture time.
// ---------------------------------------------------------------------------

export type TelemetryOrigin = "cloud" | "demo" | "none";
export type TelemetryFreshness = "fresh" | "stale" | "offline" | "unknown";

/** A snapshot this young is treated as live data. */
export const TELEMETRY_FRESH_MS = 60_000;
/** Beyond this age the last observation is treated as offline. */
export const TELEMETRY_OFFLINE_MS = 120_000;

export interface TelemetryView {
  readonly origin: TelemetryOrigin;
  readonly freshness: TelemetryFreshness;
  readonly capturedAt: number | null;
  /** Signed age in ms (null when capturedAt unknown). */
  readonly ageMs: number | null;
  /** Display-only: the printer-reported filename. NEVER a job identity. */
  readonly printFilename: string | null;
  /**
   * The PrinterSnapshot schema deliberately does NOT publish a physical task
   * id; a filename, layer counter or selected profile is never treated as
   * job identity. This stays `false` until a backend publishes the id.
   */
  readonly reportsTaskId: false;
}

/** Origin is derived from the selected printer id ONLY (prefix convention). */
export function telemetryOrigin(printerId: string | null): TelemetryOrigin {
  if (!printerId) return "none";
  return printerId.startsWith("cloud-") ? "cloud" : "demo";
}

export function telemetryAgeMs(capturedAt: number | null, now: number): number | null {
  if (capturedAt === null || !Number.isFinite(now) || !Number.isFinite(capturedAt)) return null;
  const age = now - capturedAt;
  if (!Number.isFinite(age)) return null;
  // A capture timestamp in the FUTURE is a clock/observation error — it is
  // NEVER clamped to age 0 (which would claim a fresh read that never
  // happened). Unknown, not assumed fresh.
  return age < 0 ? null : age;
}

/** Freshness of the LAST observation. Unknown when there was never one. */
export function telemetryFreshness(
  capturedAt: number | null,
  now: number,
  pollingStatus: "idle" | "polling" | "stale" | "offline" = "polling",
): TelemetryFreshness {
  if (capturedAt === null || !Number.isFinite(now)) return "unknown";
  const age = telemetryAgeMs(capturedAt, now);
  if (age === null) return "unknown";
  if (age <= TELEMETRY_FRESH_MS) {
    if (pollingStatus === "offline") return "offline";
    // The poller reports the lane as stale — a young capture timestamp does
    // NOT override that: freshness reflects the OBSERVED lane, not just age.
    if (pollingStatus === "stale") return "stale";
    return "fresh";
  }
  if (age <= TELEMETRY_OFFLINE_MS) return pollingStatus === "offline" ? "offline" : "stale";
  return "offline";
}

export function buildTelemetryView(input: {
  readonly printerId: string | null;
  /** Printer that actually produced the snapshot (may equal printerId). */
  readonly snapPrinterId: string | null;
  readonly capturedAt: number | null;
  readonly now: number;
  readonly printFilename: string | null;
  readonly pollingStatus: "idle" | "polling" | "stale" | "offline";
}): TelemetryView {
  // A snapshot observed for a DIFFERENT printer must never masquerade as the
  // current selection's live data — no stale-printer file/job bridging.
  const snapMatchesSelection =
    input.snapPrinterId === null ||
    input.printerId === null ||
    input.snapPrinterId === input.printerId;
  if (!snapMatchesSelection) {
    return {
      origin: "none",
      freshness: "unknown",
      capturedAt: null,
      ageMs: null,
      printFilename: null,
      reportsTaskId: false,
    };
  }
  return {
    origin: telemetryOrigin(input.printerId),
    freshness: telemetryFreshness(input.capturedAt, input.now, input.pollingStatus),
    capturedAt: input.capturedAt,
    ageMs: telemetryAgeMs(input.capturedAt, input.now),
    printFilename: input.printFilename,
    reportsTaskId: false,
  };
}

// ---------------------------------------------------------------------------
// 2. Camera — provider availability only. No provider ⇒ no activation.
// ---------------------------------------------------------------------------

export type CameraUnavailableReason =
  | "no-supported-provider" // no camera adapter exists in the app
  | "no-printer-check"; // placeholder reserved — never auto-resolved by profile

export interface CameraProvider {
  readonly kind: "none" | "synthetic" | "lan" | "cloud";
  readonly available: boolean;
  /** Stable machine reason key; null when available. */
  readonly unavailableReason: CameraUnavailableReason | null;
  readonly requiresPermission: boolean;
  /**
   * Typed start. Implementations must reject without transport/authorization.
   * The production default NEVER starts (no adapter) so no order is issued.
   */
  start(): Promise<CameraStartResult>;
}

export type CameraStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "permission-denied" | "start-failure";
      readonly message: string;
    };

/** Production: no camera adapter exists — the UI must keep the button disabled. */
export const NO_CAMERA_PROVIDER: CameraProvider = {
  kind: "none",
  available: false,
  unavailableReason: "no-supported-provider" as const,
  requiresPermission: true,
  async start() {
    return { ok: false, code: "start-failure", message: "no-supported-provider" };
  },
};

/**
 * Resolve the camera provider for the current UI state. This NEVER upgrades
 * a profile/snapshot into an available camera — a `capabilities.camera` flag
 * is only a hardware advertisement, not a transport. The production provider
 * is always the unavailable one.
 */
export function cameraProviderFor(
  snap: Pick<PrinterSnapshot, "peripherals" | "capabilities"> | null,
): CameraProvider {
  if (!snap) return { ...NO_CAMERA_PROVIDER, unavailableReason: "no-supported-provider" };
  const advertisesCamera =
    snap.peripherals?.hasCamera === true && snap.capabilities?.camera === true;
  if (advertisesCamera) {
    // Hardware advertises a camera, but NO camera adapter/transport is
    // installed in this build. Reason stays stable — the button stays off.
    return { ...NO_CAMERA_PROVIDER };
  }
  return { ...NO_CAMERA_PROVIDER };
}

export function cameraActivationAllowed(provider: CameraProvider): boolean {
  return provider.available;
}

export function cameraUnavailableReasonKey(
  provider: CameraProvider,
): CameraUnavailableReason | null {
  return provider.available ? null : (provider.unavailableReason ?? "no-supported-provider");
}

export type CameraPanelStatus =
  "idle" | "off" | "requested" | "permission-denied" | "start-failure" | "unavailable";

export interface CameraPanelState {
  readonly status: CameraPanelStatus;
  /** Copied debug message (never a raw token). */
  readonly message: string | null;
}

export const CAMERA_IDLE_STATE: CameraPanelState = { status: "idle", message: null };

export type CameraRequestEvent =
  | { readonly type: "user-request" }
  | { readonly type: "permission-denied"; readonly message: string }
  | { readonly type: "start-failure"; readonly message: string }
  | { readonly type: "stop" };

/**
 * Camera request reducer. Controlled TEST transitions only — the UI never
 * dispatches `user-request` because the production provider is unavailable
 * (button disabled). Permission/start outcomes only ever come from an
 * injected provider's result after an explicit user authorization.
 */
export function reduceCameraRequest(
  state: CameraPanelState,
  provider: CameraProvider,
  event: CameraRequestEvent,
): CameraPanelState {
  // Keep prior message for error states that carry their own text.
  const prior = state.message;
  switch (event.type) {
    case "user-request":
      if (!provider.available) {
        return {
          status: "unavailable",
          message: cameraUnavailableReasonKey(provider) ?? "no-supported-provider",
        };
      }
      return { status: "requested", message: null };
    case "permission-denied":
      return { status: "permission-denied", message: event.message };
    case "start-failure":
      return { status: "start-failure", message: event.message };
    case "stop":
      return { status: "off", message: prior && prior !== "no-supported-provider" ? prior : null };
  }
}

// ---------------------------------------------------------------------------
// 3. Artifact — explicit backend binding only. No inference, no invention.
// ---------------------------------------------------------------------------

/**
 * Backend-published binding for the CURRENT physical job. `physicalTaskId`
 * is the physical telemetry task id — deliberately NOT the native slicer job
 * id: the same slice job can be printed multiple times, so the native job id
 * never identifies a running print.
 */
export interface CapturedJobBinding {
  readonly physicalTaskId: string;
  readonly printerId: string;
  readonly projectId: string;
  readonly artifactId: string;
  readonly sourceRev: number;
  readonly currentRev: number;
  readonly compatibility: "qualified" | "preview-only" | "unqualified";
}

/** Artifact already parsed by the editor (IR available) before any link. */
export interface LiveArtifactRef {
  readonly artifactId: string;
  readonly sourceRev: number;
  readonly currentRev: number;
  readonly compatibility: "qualified" | "preview-only" | "unqualified";
  readonly irParsed: boolean;
}

export type LiveArtifactLinkReason =
  | "no-job" // observed physical task id unknown
  | "no-binding" // backend publishes no binding for the observed job
  | "job-mismatch" // observed task id ≠ binding.physicalTaskId
  | "project-mismatch" // binding owns another project (cross-project bridge)
  | "printer-mismatch" // observed printer ≠ binding.printerId
  | "artifact-unavailable" // binding exists but no artifact is published
  | "artifact-mismatch" // artifact id ≠ binding.artifactId
  | "stale-source-rev" // artifact.sourceRev ≠ binding.sourceRev
  | "artifact-not-parsed"; // IR not parsed yet — never bridge from stale frame

export type LiveArtifactLink =
  | {
      readonly linked: true;
      readonly artifactId: string;
      readonly sourceRev: number;
      readonly currentRev: number;
      readonly compatibility: "qualified" | "preview-only" | "unqualified";
    }
  | { readonly linked: false; readonly reason: LiveArtifactLinkReason };

/**
 * Pure descriptor required by NAV-04/DEV-09: an artifact is ONLY rendered for
 * the live job when every exact identity matches (including project
 * ownership), the source revision is fresh against the binding, and the
 * artifact content is already IR-parsed. With no backend binding the result
 * is `no-binding` → "Current job has no linked artifact". An unknown job is
 * `no-job` → never an invented model.
 */
export function resolveLiveArtifactLink(input: {
  readonly observedJobId: string | null; // physical task id from telemetry
  readonly observedPrinterId: string | null; // identity that reported it
  readonly capturedJobBinding: CapturedJobBinding | null;
  readonly artifact: LiveArtifactRef | null;
  /** Active project scope (null when no project is open). */
  readonly activeProjectId: string | null;
}): LiveArtifactLink {
  const { observedJobId, observedPrinterId, capturedJobBinding, artifact, activeProjectId } = input;
  if (!observedJobId) return { linked: false, reason: "no-job" };
  if (!capturedJobBinding) return { linked: false, reason: "no-binding" };
  if (observedJobId !== capturedJobBinding.physicalTaskId) {
    return { linked: false, reason: "job-mismatch" };
  }
  // Project ownership precedes printer identity: a binding published for
  // ANOTHER project cannot bridge into this project's preview (the CAS read
  // itself is project-scoped). With no active project the ownership cannot
  // be verified, so nothing is claimed either way.
  if (activeProjectId !== null && capturedJobBinding.projectId !== activeProjectId) {
    return { linked: false, reason: "project-mismatch" };
  }
  if (observedPrinterId !== capturedJobBinding.printerId) {
    return { linked: false, reason: "printer-mismatch" };
  }
  if (!artifact) return { linked: false, reason: "artifact-unavailable" };
  if (artifact.artifactId !== capturedJobBinding.artifactId) {
    return { linked: false, reason: "artifact-mismatch" };
  }
  if (artifact.sourceRev !== capturedJobBinding.sourceRev) {
    return { linked: false, reason: "stale-source-rev" };
  }
  if (!artifact.irParsed) return { linked: false, reason: "artifact-not-parsed" };
  return {
    linked: true,
    artifactId: artifact.artifactId,
    sourceRev: artifact.sourceRev,
    currentRev: artifact.currentRev,
    compatibility: artifact.compatibility,
  };
}

/**
 * The current PrinterSnapshot schema does NOT publish a physical task id.
 * Reading it is an explicit signal — never derived from filename/text/profile.
 */
export function observedTaskIdFromSnapshot(_snap: Pick<PrinterSnapshot, "print"> | null): {
  readonly observedJobId: null;
  readonly reportsTaskId: false;
} {
  return { observedJobId: null, reportsTaskId: false };
}
