import type { ProjectSnapshot } from "./project-authority-types.ts";
import type { ProjectInvoke } from "./real-project-bridge.ts";

export interface LocalProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly updated_ms: number;
}

export interface LocalSliceJob {
  readonly job_id?: string;
  readonly status?: string;
  readonly source_revision?: number;
  readonly artifact_id?: string;
  readonly input_digest?: string;
  readonly artifact_status?: "present" | "missing" | "unavailable" | string;
  readonly artifact_origin?: "local" | string;
}

export type SliceArtifactStatus = "present" | "missing" | "unavailable";

export type ReprintBlockReason =
  | "artifact-missing"
  | "artifact-unavailable"
  | "artifact-digest-mismatch"
  | "source-revision-stale"
  | "profile-mismatch"
  | "mode-mismatch"
  | "tool-binding-mismatch"
  | "printer-mismatch"
  | "printer-offline"
  | "qualification-missing"
  | "preview-only";

export interface ReprintCandidate {
  readonly sourceJobId: string;
  readonly artifactStatus: SliceArtifactStatus;
  readonly artifactId: string | null;
  readonly artifactDigest: string | null;
  readonly expectedArtifactDigest: string;
  readonly profileFingerprint: string;
  readonly expectedProfileFingerprint: string;
  readonly mode: "standard" | "nonplanar";
  readonly expectedMode: "standard" | "nonplanar";
  readonly toolBinding: string;
  readonly expectedToolBinding: string;
  readonly sourceRevision: number;
  readonly currentSourceRevision: number;
  readonly currentPrinterId: string | null;
  readonly targetPrinterId: string;
  readonly printerReachable: boolean | null;
  readonly compatibility: "qualified" | "preview-only" | "unqualified";
  readonly printQualified: boolean;
}

export type ReprintProposalResult =
  | {
      readonly status: "proposed";
      readonly proposalId: string;
      readonly sourceJobId: string;
      readonly artifactId: string;
      readonly artifactDigest: string;
      readonly profileFingerprint: string;
      readonly mode: "standard" | "nonplanar";
      readonly toolBinding: string;
      readonly sourceRevision: number;
      readonly printerId: string;
      readonly qualification: "qualified";
    }
  | {
      readonly status: "blocked";
      readonly reason: ReprintBlockReason;
      readonly sourceJobId: string;
    };

export function buildReprintProposal(candidate: ReprintCandidate): ReprintProposalResult {
  const blocked = (reason: ReprintBlockReason): ReprintProposalResult => ({
    status: "blocked",
    reason,
    sourceJobId: candidate.sourceJobId,
  });
  if (candidate.artifactStatus === "missing") return blocked("artifact-missing");
  if (candidate.artifactStatus !== "present" || !candidate.artifactId)
    return blocked("artifact-unavailable");
  if (!candidate.artifactDigest || candidate.artifactDigest !== candidate.expectedArtifactDigest)
    return blocked("artifact-digest-mismatch");
  if (candidate.sourceRevision !== candidate.currentSourceRevision)
    return blocked("source-revision-stale");
  if (candidate.profileFingerprint !== candidate.expectedProfileFingerprint)
    return blocked("profile-mismatch");
  if (candidate.mode !== candidate.expectedMode) return blocked("mode-mismatch");
  if (candidate.toolBinding !== candidate.expectedToolBinding)
    return blocked("tool-binding-mismatch");
  if (!candidate.currentPrinterId || candidate.currentPrinterId !== candidate.targetPrinterId)
    return blocked("printer-mismatch");
  if (candidate.printerReachable !== true) return blocked("printer-offline");
  if (candidate.compatibility === "preview-only") return blocked("preview-only");
  if (candidate.compatibility !== "qualified" || !candidate.printQualified)
    return blocked("qualification-missing");

  return {
    status: "proposed",
    proposalId: `reprint-proposal-${globalThis.crypto.randomUUID()}`,
    sourceJobId: candidate.sourceJobId,
    artifactId: candidate.artifactId,
    artifactDigest: candidate.artifactDigest,
    profileFingerprint: candidate.profileFingerprint,
    mode: candidate.mode,
    toolBinding: candidate.toolBinding,
    sourceRevision: candidate.sourceRevision,
    printerId: candidate.currentPrinterId,
    qualification: "qualified",
  };
}

export interface ReprintIntentRequest {
  readonly sourceJobId: string;
  readonly intentId: string;
}

export type ReprintIntentReply = ReprintProposalResult;

export async function preflightLocalReprintIntent(
  invoke: ProjectInvoke,
  request: ReprintIntentRequest,
): Promise<ReprintIntentReply> {
  return (await invoke("project_reprint_preflight", {
    sourceJobId: request.sourceJobId,
    intentId: request.intentId,
  })) as ReprintIntentReply;
}

export function resolveSliceArtifactStatus(job: LocalSliceJob): SliceArtifactStatus {
  switch (job.artifact_status) {
    case "present":
    case "missing":
    case "unavailable":
      return job.artifact_status;
    default:
      return "unavailable";
  }
}

export async function listLocalProjects(invoke: ProjectInvoke): Promise<LocalProjectSummary[]> {
  return (await invoke("project_list", {})) as LocalProjectSummary[];
}

export async function listLocalSliceJobs(
  invoke: ProjectInvoke,
  projectId: string,
  limit = 20,
): Promise<LocalSliceJob[]> {
  return (await invoke("project_slice_history", { projectId, limit })) as LocalSliceJob[];
}

export async function createLocalProject(
  invoke: ProjectInvoke,
  projectId: string,
  name: string,
): Promise<ProjectSnapshot> {
  return (await invoke("project_create", { projectId, name })) as ProjectSnapshot;
}

export async function openLocalProject(
  invoke: ProjectInvoke,
  projectId: string,
): Promise<ProjectSnapshot> {
  return (await invoke("project_open", { projectId })) as ProjectSnapshot;
}

export async function continueLocalProject(
  invoke: ProjectInvoke,
  projectId: string,
): Promise<ProjectSnapshot> {
  const snapshot = (await invoke("project_authority_read", {})) as ProjectSnapshot;
  if (snapshot.project.id !== projectId) {
    throw new Error("The active project does not match the selected project.");
  }
  return snapshot;
}

export async function recoverLocalProject(
  invoke: ProjectInvoke,
  projectId: string,
): Promise<ProjectSnapshot> {
  return (await invoke("project_authority_recover", { projectId })) as ProjectSnapshot;
}
