export interface ProjectDocument {
  readonly id: string;
  readonly name: string;
  readonly objects: readonly unknown[];
  readonly legacy_objects?: readonly {
    readonly id: string;
    readonly name: string;
    readonly mesh_sha256: string | null;
    readonly migration_status: string;
  }[];
}

export type ProjectOperationKind =
  | "add_object"
  | "remove_object"
  | "rename_object"
  | "clone_object"
  | "set_visibility"
  | "set_lock"
  | "set_material"
  | "set_placement"
  | "set_transform"
  | "set_plate"
  | "set_object_settings"
  | "repair"
  | "boolean"
  | "checkpoint";

export interface ProjectOperation {
  readonly operation_id: string;
  readonly kind: ProjectOperationKind;
  readonly target_ids: readonly string[];
  readonly before: unknown;
  readonly after: unknown;
}

export interface ProjectSnapshot {
  readonly project: ProjectDocument;
  readonly revision: number;
  readonly diagnostics?: readonly {
    readonly code: "ARTIFACT_REFERENCE_MISSING" | "ARTIFACT_FILE_MISSING" | string;
    readonly object_id: string;
    readonly artifact_sha256: string;
  }[];
}

export interface ProjectCommitReply {
  readonly status: "committed" | "no_op" | "conflict" | "failed";
  readonly actual_revision: number;
  readonly snapshot: ProjectSnapshot | null;
  readonly diagnostics: readonly string[];
}
