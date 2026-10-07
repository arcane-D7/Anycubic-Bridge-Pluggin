import type {
  ProjectCommitReply,
  ProjectDocument,
  ProjectOperation,
  ProjectSnapshot,
} from "./project-authority-types.ts";
import { StaleCommitError, type BridgeHandle, type CommitSinkPayload } from "./mock.ts";
import type { ObjectMutation, SceneObjectSnapshot } from "./types.ts";

export type ProjectInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

const EMPTY_SELECTION: CommitSinkPayload["selection"] = {
  verts: [],
  faces: [],
  edges: [],
  objectModeNames: [],
};

function stableLegacyId(projectId: string, name: string): string {
  return `legacy:${encodeURIComponent(projectId)}:${encodeURIComponent(name)}`;
}

function normaliseObject(projectId: string, object: SceneObjectSnapshot): SceneObjectSnapshot {
  const geometry = object.geometry;
  return {
    ...object,
    objectId: object.objectId ?? stableLegacyId(projectId, object.name),
    ...(geometry
      ? {
          geometry: {
            positions: Float32Array.from(geometry.positions),
            normals: Float32Array.from(geometry.normals),
            indices: Uint32Array.from(geometry.indices),
          },
        }
      : {}),
  };
}

function persistedObject(object: SceneObjectSnapshot): SceneObjectSnapshot {
  const geometry = object.geometry;
  return {
    ...object,
    ...(geometry
      ? {
          geometry: {
            positions: Array.from(geometry.positions),
            normals: Array.from(geometry.normals),
            indices: Array.from(geometry.indices),
          } as unknown as SceneObjectSnapshot["geometry"],
        }
      : {}),
  };
}

function operationKind(mutation: ObjectMutation): ProjectOperation["kind"] {
  switch (mutation.kind) {
    case "add":
      return "add_object";
    case "remove":
      return "remove_object";
    case "rename":
      return "rename_object";
    case "duplicate":
      return "clone_object";
    case "toggleVisible":
      return "set_visibility";
    case "toggleLock":
      return "set_lock";
    case "setTransform":
      return "set_transform";
    case "setPlate":
      return "set_plate";
    case "setObjectSettings":
      return mutation.filamentId !== undefined ? "set_material" : "set_object_settings";
    case "commitObject":
      return "checkpoint";
  }
}

function applyMutation(
  projectId: string,
  objects: readonly SceneObjectSnapshot[],
  mutation: ObjectMutation,
): { objects: SceneObjectSnapshot[]; targetIds: string[]; operationId: string } | null {
  const current = [...objects];
  let targetId = "";
  const operationId = crypto.randomUUID();
  switch (mutation.kind) {
    case "add": {
      const objectId = mutation.object.objectId ?? crypto.randomUUID();
      current.push({ ...mutation.object, objectId });
      targetId = objectId;
      break;
    }
    case "remove": {
      const target = current.find((item) => item.name === mutation.name);
      if (!target) return null;
      targetId = target.objectId ?? stableLegacyId(projectId, target.name);
      return {
        objects: current.filter((item) => item !== target),
        targetIds: [targetId],
        operationId,
      };
    }
    case "rename": {
      const target = current.find((item) => item.name === mutation.from);
      if (!target) return null;
      targetId = target.objectId ?? stableLegacyId(projectId, target.name);
      return {
        objects: current.map((item) =>
          item === target ? { ...item, name: mutation.to, objectId: targetId } : item,
        ),
        targetIds: [targetId],
        operationId,
      };
    }
    case "duplicate": {
      const target = current.find((item) => item.name === mutation.name);
      if (!target) return null;
      targetId = target.objectId ?? stableLegacyId(projectId, target.name);
      const cloneId = crypto.randomUUID();
      current.push({ ...target, name: `${target.name}-copy`, objectId: cloneId });
      return { objects: current, targetIds: [targetId, cloneId], operationId };
    }
    case "toggleVisible":
    case "toggleLock":
    case "setTransform":
    case "setPlate":
    case "setObjectSettings":
    case "commitObject": {
      const target = current.find((item) => item.name === mutation.name);
      if (!target) return null;
      targetId = target.objectId ?? stableLegacyId(projectId, target.name);
      const objectsNext = current.map((item) => {
        if (item !== target) return item;
        const identified = { ...item, objectId: targetId };
        switch (mutation.kind) {
          case "toggleVisible":
            return { ...identified, visible: !item.visible };
          case "toggleLock":
            return { ...identified, locked: !item.locked };
          case "setTransform":
            return { ...identified, transform: mutation.transform };
          case "setPlate":
            return { ...identified, plateId: mutation.plateId };
          case "setObjectSettings":
            return {
              ...identified,
              ...(mutation.settings !== undefined
                ? { printSettings: { ...mutation.settings } }
                : { printSettings: undefined }),
              ...(mutation.settings !== undefined && mutation.filamentId !== undefined
                ? { filamentId: mutation.filamentId }
                : mutation.settings === undefined
                  ? { filamentId: undefined }
                  : {}),
            };
          case "commitObject":
            return identified;
        }
      });
      return { objects: objectsNext, targetIds: [targetId], operationId };
    }
  }
  return { objects: current, targetIds: [targetId], operationId };
}

function unavailable<T>(lane: string): Promise<T> {
  return Promise.reject(new Error(`real-project-operation-unavailable:${lane}`));
}

export async function createRealProjectBridge(
  invoke: ProjectInvoke,
  initial: ProjectSnapshot,
): Promise<BridgeHandle> {
  const projectId = initial.project.id;
  let revision = initial.revision;
  let projectName = initial.project.name;
  let objects = initial.project.objects.map((value) =>
    normaliseObject(projectId, value as SceneObjectSnapshot),
  );
  let session:
    { readonly beginRevision: number; readonly startObjects: SceneObjectSnapshot[] } | undefined;
  const legacyObjects = initial.project.legacy_objects ?? [];

  const persist = async (
    expectedRevision: number,
    nextObjects: SceneObjectSnapshot[],
    op: ProjectOperation,
  ) => {
    const project: ProjectDocument = {
      id: projectId,
      name: projectName,
      legacy_objects: legacyObjects,
      objects: nextObjects.map(persistedObject),
    };
    const reply = (await invoke("project_authority_commit", {
      expectedRevision,
      operation: op,
      project,
    })) as ProjectCommitReply;
    if (reply.status === "conflict") {
      revision = reply.actual_revision;
      if (reply.snapshot) {
        projectName = reply.snapshot.project.name;
        objects = reply.snapshot.project.objects.map((value) =>
          normaliseObject(projectId, value as SceneObjectSnapshot),
        );
        handle.onCommitEvent?.({
          revision,
          selection: {
            ...EMPTY_SELECTION,
            objectModeNames: objects.map((object) => object.name),
          },
        });
      }
      throw new StaleCommitError(expectedRevision, revision);
    }
    if (reply.status === "failed" || !reply.snapshot) {
      throw new Error(reply.diagnostics[0] ?? "project_commit_failed");
    }
    const saved = reply.snapshot;
    revision = saved.revision;
    objects = saved.project.objects.map((value) =>
      normaliseObject(projectId, value as SceneObjectSnapshot),
    );
    return saved;
  };

  const handle = {
    id: "local-project-profile",
    machineType: null,
    buildVolume: { widthMm: 0, depthMm: 0, heightMm: 0 },
    capabilities: ["project.persistence", "scene.read", "scene.mutate"],
    ok: true as const,
    get revision() {
      return revision;
    },
    groups: ["default"],
    get objects() {
      return objects;
    },
    journal: [],
    async begin(beginRevision) {
      if (beginRevision !== revision) throw new Error("project-revision-conflict");
      session = { beginRevision, startObjects: objects.map((object) => ({ ...object })) };
      return { ok: true as const, token: crypto.randomUUID() };
    },
    async update() {
      return { ok: true as const };
    },
    async commit(expectedRevision) {
      if (!session) throw new Error("project-session-not-active");
      const prior = session;
      const after = objects;
      const targetIds = after
        .filter(
          (object, index) =>
            JSON.stringify(object.transform) !==
            JSON.stringify(prior.startObjects[index]?.transform),
        )
        .map((object) => object.objectId ?? stableLegacyId(projectId, object.name));
      if (targetIds.length > 0) {
        try {
          await persist(expectedRevision, after, {
            operation_id: crypto.randomUUID(),
            kind: "set_transform",
            target_ids: targetIds,
            before: prior.startObjects,
            after,
          });
        } catch (error) {
          const conflict = error instanceof StaleCommitError;
          if (!conflict) objects = prior.startObjects;
          session = undefined;
          const selection = {
            ...EMPTY_SELECTION,
            objectModeNames: objects.map((object) => object.name),
          };
          handle.onCommitEvent?.({ revision, selection });
          throw error;
        }
      } else if (expectedRevision !== revision) {
        objects = prior.startObjects;
        session = undefined;
        throw new Error(`project-revision-conflict:${expectedRevision}:${revision}`);
      }
      session = undefined;
      const selection = {
        ...EMPTY_SELECTION,
        objectModeNames: objects.map((object) => object.name),
      };
      handle.onCommitEvent?.({ revision, selection });
      return { ok: true as const, newRevision: revision, selection, journalEvents: [] };
    },
    async cancel(beginRevision) {
      if (session?.beginRevision === beginRevision) {
        objects = session.startObjects;
        session = undefined;
      }
      return { ok: true as const };
    },
    async mutateObject(mutation, expectedRevision = revision) {
      const changed = applyMutation(projectId, objects, mutation);
      if (!changed) {
        return {
          ok: false as const,
          error: "unknown object",
          code: "object_not_found",
          actualRevision: revision,
        };
      }
      const provisional = mutation.kind === "setTransform" && session !== undefined;
      if (provisional) {
        objects = changed.objects;
        return { ok: true as const, revision, objects, diagnostics: [] };
      }
      const operation: ProjectOperation = {
        operation_id: changed.operationId,
        kind: operationKind(mutation),
        target_ids: changed.targetIds,
        before: objects,
        after: changed.objects,
      };
      try {
        if (
          JSON.stringify(objects.map(persistedObject)) ===
          JSON.stringify(changed.objects.map(persistedObject))
        ) {
          return { ok: true as const, revision, objects, diagnostics: ["no_op"] };
        }
        await persist(expectedRevision, changed.objects, operation);
        handle.onCommitEvent?.({
          revision,
          selection: { ...EMPTY_SELECTION, objectModeNames: objects.map((object) => object.name) },
        });
        return { ok: true as const, revision, objects, diagnostics: [] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          error: message,
          code:
            error instanceof StaleCommitError || message.includes("conflict")
              ? "project_revision_conflict"
              : "project_commit_failed",
          actualRevision: revision,
        };
      }
    },
    arrange: () => unavailable("arrange"),
    slice: () => unavailable("slice"),
    discoverPrinters: () => unavailable("printer-discovery"),
    sendJob: () => unavailable("send-job"),
    boolean: () => unavailable("boolean"),
    repair: () => unavailable("repair"),
    printerControl: () => unavailable("printer-control"),
    listFiles: () => unavailable("printer-files"),
    sendFile: () => unavailable("send-file"),
    devtoolsReadModel: () => unavailable("devtools"),
    rawCommand: () => unavailable("raw-command"),
  } as BridgeHandle;
  return handle;
}
