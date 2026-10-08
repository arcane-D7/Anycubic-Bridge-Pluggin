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
