/**
 * S9.17-004 — Live job view (read-only backend lane).
 *
 * The Workbench live panel reads ONE backend view per refresh: observed
 * job/printer identity + the published binding + the parsed artifact ref.
 * It NEVER writes, never instructs a printer and never invents a binding —
 * with no backend resident the view is EXPLICITLY unavailable.
 *
 * The Tauri `live_job_binding` command IS registered in the Rust backend and
 * always replies with a typed view. When no physical job source exists it
 * returns `available: false` with `unavailableReason: "no-physical-job-source"`.
 * Absence at the command surface is therefore an explicit, typed reply —
 * never a silently swallowed unknown command, never a guessed printer id.
 *
 * The artifact lane (`live_artifact_read`) is a real, project-owned CAS read:
 * the App only routes a preview after a STRICT `parseIrDocument` of the
 * artifact bytes returned for that project + artifact id. `irParsed` flags in
 * the binding reply are never treated as proof of validated content.
 *
 * Dependency-light so the module stays evaluable under `node --test` (no
 * app-wide bridge graph import).
 */
import { parseIrDocument } from "./ir.ts";
import type { IrDocument } from "./ir.ts";
import type { CapturedJobBinding, LiveArtifactRef } from "../state/workbench-live-core.ts";

export type LiveJobUnavailableReason =
  | "no-physical-job-source" // registered backend, but no physical job publisher
  | "invalid" // backend replied, but the payload failed strict validation
  | "backend-error" // the backend lane threw
  | "demo"; // demo runtime — honest demo label, never a real read

export interface LiveJobView {
  /** Physical task id reported for the running print (may be null). */
  readonly observedJobId: string | null;
  /** Printer identity that reported the job (from the backend, never a fallback). */
  readonly observedPrinterId: string | null;
  /** Backend-published explicit binding — null until the backend publishes one. */
  readonly jobBinding: CapturedJobBinding | null;
  /** Already-parsed artifact available for the preview (may be null). */
  readonly artifact: LiveArtifactRef | null;
  readonly source: "tauri" | "demo" | "unavailable";
  readonly available: boolean;
  readonly unavailableReason: LiveJobUnavailableReason | null;
}

export const EMPTY_LIVE_JOB_VIEW: LiveJobView = {
  observedJobId: null,
  observedPrinterId: null,
  jobBinding: null,
  artifact: null,
  source: "unavailable",
  available: false,
  unavailableReason: "no-physical-job-source",
};

export type LiveArtifactReadResult =
  | {
      readonly ok: true;
      readonly artifactId: string;
      readonly sourceRevision: number;
      readonly currentRevision: number;
      readonly ir: IrDocument;
    }
  | {
      readonly ok: false;
      readonly code: "invalid" | "backend-error" | "no-backend";
      readonly message: string | null;
    };

type InvokeFn = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Typed read backend for the Workbench live lane. The production default is
 * computed once from the runtime; tests construct a provider explicitly via
 * `liveJobProviderFor(isTauri)` and inject a fake invoke function.
 */
export interface LiveJobBindingProvider {
  readonly kind: "tauri" | "demo";
  /** Stable machine reason key for why this provider has no live job. */
  readonly unavailableReason: LiveJobUnavailableReason;
  /** Read the typed job view (registered read-only command). */
  fetchView(input: { readonly projectId: string | null }, invokeFn: InvokeFn): Promise<LiveJobView>;
  /** Read + STRICTLY parse the artifact owned by projectId (CAS backend). */
  readArtifact(
    input: { readonly projectId: string; readonly artifactId: string },
    invokeFn: InvokeFn,
  ): Promise<LiveArtifactReadResult>;
}

const COMPATIBILITY_VALUES: readonly ("qualified" | "preview-only" | "unqualified")[] = [
  "qualified",
  "preview-only",
  "unqualified",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeCompatibility(
  value: unknown,
): "qualified" | "preview-only" | "unqualified" | null {
  return COMPATIBILITY_VALUES.includes(value as "qualified") ? (value as never) : null;
}

function normalizeCapturedJobBinding(raw: unknown): CapturedJobBinding | null {
  if (!isRecord(raw)) return null;
  const physicalTaskId = nonEmptyText(raw.physicalTaskId);
  const printerId = nonEmptyText(raw.printerId);
  const projectId = nonEmptyText(raw.projectId);
  const artifactId = nonEmptyText(raw.artifactId);
  const sourceRev = safeRevision(raw.sourceRev);
  const currentRev = safeRevision(raw.currentRev);
  const compatibility = normalizeCompatibility(raw.compatibility);
  if (
    physicalTaskId === null ||
    printerId === null ||
    projectId === null ||
    artifactId === null ||
    sourceRev === null ||
    currentRev === null ||
    compatibility === null
  ) {
    return null;
  }
  return {
    physicalTaskId,
    printerId,
    projectId,
    artifactId,
    sourceRev,
    currentRev,
    compatibility,
  };
}

function normalizeLiveArtifactRef(raw: unknown): LiveArtifactRef | null {
  if (!isRecord(raw)) return null;
  const artifactId = nonEmptyText(raw.artifactId);
  const sourceRev = safeRevision(raw.sourceRev);
  const currentRev = safeRevision(raw.currentRev);
  const compatibility = normalizeCompatibility(raw.compatibility);
  if (artifactId === null || sourceRev === null || currentRev === null || compatibility === null) {
    return null;
  }
  return { artifactId, sourceRev, currentRev, compatibility, irParsed: raw.irParsed === true };
}

function unavailableView(reason: LiveJobUnavailableReason): LiveJobView {
  return {
    observedJobId: null,
    observedPrinterId: null,
    jobBinding: null,
    artifact: null,
    source: "tauri",
    available: false,
    unavailableReason: reason,
  };
}

const REASONS: readonly string[] = ["no-physical-job-source", "invalid", "backend-error", "demo"];

function normalizeUnavailableReason(raw: unknown): LiveJobUnavailableReason | null {
  return typeof raw === "string" && REASONS.includes(raw)
    ? (raw as LiveJobUnavailableReason)
    : null;
}

/**
 * Strict normalization of the registered `live_job_binding` reply.
 *
 * FAIL-CLOSED: a malformed binding/artifact payload invalidates the whole
 * view (reason `invalid`) — partial data is never trusted, and the observed
 * printer id is NEVER derived from the selected profile or any fallback.
 */
function normalizeLiveJobView(raw: unknown): LiveJobView {
  if (!isRecord(raw)) {
    // Null/silent reply: the command exists but publishes nothing.
    return { ...EMPTY_LIVE_JOB_VIEW, source: "tauri" };
  }
  if (raw.available === true) {
    const hadJobBinding = raw.jobBinding !== undefined && raw.jobBinding !== null;
    const hadArtifact = raw.artifact !== undefined && raw.artifact !== null;
    const jobBinding = hadJobBinding ? normalizeCapturedJobBinding(raw.jobBinding) : null;
    const artifact = hadArtifact ? normalizeLiveArtifactRef(raw.artifact) : null;
    if ((hadJobBinding && !jobBinding) || (hadArtifact && !artifact)) {
      return unavailableView("invalid");
    }
    return {
      observedJobId: nonEmptyText(raw.observedJobId),
      observedPrinterId: nonEmptyText(raw.observedPrinterId),
      jobBinding,
      artifact,
      source: "tauri",
      available: true,
      unavailableReason: null,
    };
  }
  const reason = normalizeUnavailableReason(raw.unavailableReason);
  return {
    ...EMPTY_LIVE_JOB_VIEW,
    source: "tauri",
    unavailableReason: reason ?? "no-physical-job-source",
  };
}

/** Strict normalization of the `live_artifact_read` reply (parse inside). */
function normalizeArtifactRead(raw: unknown): LiveArtifactReadResult {
  if (!isRecord(raw)) {
    return { ok: false, code: "invalid", message: "live_artifact_read reply must be an object" };
  }
  const artifactId = nonEmptyText(raw.artifactId);
  const sourceRevision = safeRevision(raw.sourceRevision);
  const currentRevision = safeRevision(raw.currentRevision);
  if (artifactId === null || sourceRevision === null || currentRevision === null) {
    return {
      ok: false,
      code: "invalid",
      message: "live_artifact_read reply carries an invalid artifact identity/revision",
    };
  }
  let ir: IrDocument;
  try {
    ir = parseIrDocument(raw.ir);
  } catch (error) {
    return {
      ok: false,
      code: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, artifactId, sourceRevision, currentRevision, ir };
}

const tauriLiveJobProvider: LiveJobBindingProvider = {
  kind: "tauri",
  unavailableReason: "no-physical-job-source",
  async fetchView({ projectId }, invokeFn) {
    try {
      const raw = await invokeFn("live_job_binding", projectId ? { projectId } : {});
      return normalizeLiveJobView(raw);
    } catch {
      return { ...EMPTY_LIVE_JOB_VIEW, source: "tauri", unavailableReason: "backend-error" };
    }
  },
  async readArtifact({ projectId, artifactId }, invokeFn) {
    try {
      const raw = await invokeFn("live_artifact_read", { projectId, artifactId });
      return normalizeArtifactRead(raw);
    } catch (error) {
      return {
        ok: false,
        code: "backend-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

const demoLiveJobProvider: LiveJobBindingProvider = {
  kind: "demo",
  unavailableReason: "demo",
  async fetchView() {
    return { ...EMPTY_LIVE_JOB_VIEW, source: "demo", unavailableReason: "demo" };
  },
  async readArtifact() {
    return { ok: false, code: "no-backend", message: "demo runtime has no artifact CAS" };
  },
};

/** Mirrors `bridge/project-provider.isTauriRuntime` without app bridge imports. */
function isTauriWindow(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Construct the typed provider for a runtime (testable with `isTauri: true`). */
export function liveJobProviderFor(isTauri: boolean): LiveJobBindingProvider {
  return isTauri ? tauriLiveJobProvider : demoLiveJobProvider;
}

/** Production singleton: Tauri when running under the shell, demo otherwise. */
export const defaultLiveJobBindingProvider: LiveJobBindingProvider =
  liveJobProviderFor(isTauriWindow());
