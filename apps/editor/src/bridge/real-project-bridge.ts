import type {
  ProjectCommitReply,
  ProjectDocument,
  ProjectOperation,
  ProjectSnapshot,
} from "./project-authority-types.ts";
import { StaleCommitError, type BridgeHandle, type CommitSinkPayload } from "./mock.ts";
import type {
  BooleanRequest,
  BooleanResult,
  ObjectGeometry,
  ObjectMutation,
  RepairRequest,
  RepairResult,
  SceneObjectSnapshot,
} from "./types.ts";

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

export function sceneObjectsFromProjectSnapshot(
  projectId: string,
  values: readonly unknown[],
): SceneObjectSnapshot[] {
  return values.map((value) => {
    if (typeof value !== "object" || value === null || !("name" in value)) {
      throw new Error("project_object_snapshot_invalid");
    }
    const object = value as Record<string, unknown>;
    if (typeof object.name !== "string") throw new Error("project_object_snapshot_invalid");
    const rawGeometry = object.geometry;
    const geometry =
      typeof rawGeometry === "object" &&
      rawGeometry !== null &&
      "positions" in rawGeometry &&
      "normals" in rawGeometry &&
      "indices" in rawGeometry
        ? {
            positions: Float32Array.from(rawGeometry.positions as ArrayLike<number>),
            normals: Float32Array.from(rawGeometry.normals as ArrayLike<number>),
            indices: Uint32Array.from(rawGeometry.indices as ArrayLike<number>),
          }
        : undefined;
    const sceneObject = {
      ...object,
      name: object.name,
      vertices: typeof object.vertices === "number" ? object.vertices : 0,
      triangles: typeof object.triangles === "number" ? object.triangles : 0,
      bounds: object.bounds as SceneObjectSnapshot["bounds"],
      sizeMm: object.sizeMm as SceneObjectSnapshot["sizeMm"],
      volumeMm3: typeof object.volumeMm3 === "number" ? object.volumeMm3 : 0,
      surfaceAreaMm2: typeof object.surfaceAreaMm2 === "number" ? object.surfaceAreaMm2 : 0,
      watertight: object.watertight === true,
      visible: object.visible !== false,
      locked: object.locked === true,
      ...(geometry ? { geometry } : {}),
      objectId:
        typeof object.objectId === "string"
          ? object.objectId
          : typeof object.id === "string"
            ? object.id
            : stableLegacyId(projectId, object.name),
    } as SceneObjectSnapshot;
    return sceneObject;
  });
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

function transformArray(object: SceneObjectSnapshot): number[] {
  const transform = object.transform;
  return [
    transform?.x ?? 0,
    transform?.y ?? 0,
    transform?.z ?? 0,
    transform?.rx ?? 0,
    transform?.ry ?? 0,
    transform?.rz ?? 0,
    transform?.sx ?? 1,
    transform?.sy ?? 1,
    transform?.sz ?? 1,
  ];
}

function geometryFromWorker(output: {
  positions: number[];
  triangles: number[][];
}): ObjectGeometry {
  const positions = Float32Array.from(output.positions);
  const indices = Uint32Array.from(output.triangles.flat());
  const normals = new Float32Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset] ?? 0;
    const b = indices[offset + 1] ?? 0;
    const c = indices[offset + 2] ?? 0;
    const ax = positions[a * 3] ?? 0;
    const ay = positions[a * 3 + 1] ?? 0;
    const az = positions[a * 3 + 2] ?? 0;
    const abx = (positions[b * 3] ?? 0) - ax;
    const aby = (positions[b * 3 + 1] ?? 0) - ay;
    const abz = (positions[b * 3 + 2] ?? 0) - az;
    const acx = (positions[c * 3] ?? 0) - ax;
    const acy = (positions[c * 3 + 1] ?? 0) - ay;
    const acz = (positions[c * 3 + 2] ?? 0) - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const index of [a, b, c]) {
      normals[index * 3] = (normals[index * 3] ?? 0) + nx;
      normals[index * 3 + 1] = (normals[index * 3 + 1] ?? 0) + ny;
      normals[index * 3 + 2] = (normals[index * 3 + 2] ?? 0) + nz;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(
      normals[offset] ?? 0,
      normals[offset + 1] ?? 0,
      normals[offset + 2] ?? 0,
    );
    if (length > 0) {
      normals[offset] = (normals[offset] ?? 0) / length;
      normals[offset + 1] = (normals[offset + 1] ?? 0) / length;
      normals[offset + 2] = (normals[offset + 2] ?? 0) / length;
    }
  }
  return { positions, normals, indices };
}

function meshSnapshot(
  source: SceneObjectSnapshot,
  name: string,
  output: { positions: number[]; triangles: number[][]; volume_mm3: number },
  provenance: string,
): SceneObjectSnapshot {
  const geometry = geometryFromWorker(output);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < output.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = output.positions[offset + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? Infinity, value);
      max[axis] = Math.max(max[axis] ?? -Infinity, value);
    }
  }
  let surfaceAreaMm2 = 0;
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    const a = geometry.indices[offset] ?? 0;
    const b = geometry.indices[offset + 1] ?? 0;
    const c = geometry.indices[offset + 2] ?? 0;
    const ab = [0, 1, 2].map(
      (axis) => (geometry.positions[b * 3 + axis] ?? 0) - (geometry.positions[a * 3 + axis] ?? 0),
    );
    const ac = [0, 1, 2].map(
      (axis) => (geometry.positions[c * 3 + axis] ?? 0) - (geometry.positions[a * 3 + axis] ?? 0),
    );
    const cross = [
      (ab[1] ?? 0) * (ac[2] ?? 0) - (ab[2] ?? 0) * (ac[1] ?? 0),
      (ab[2] ?? 0) * (ac[0] ?? 0) - (ab[0] ?? 0) * (ac[2] ?? 0),
      (ab[0] ?? 0) * (ac[1] ?? 0) - (ab[1] ?? 0) * (ac[0] ?? 0),
    ];
    surfaceAreaMm2 += Math.hypot(...cross) / 2;
  }
  return {
    ...source,
    name,
    vertices: output.positions.length / 3,
    triangles: output.triangles.length,
    bounds: { min, max },
    sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    volumeMm3: output.volume_mm3,
    surfaceAreaMm2,
    watertight: true,
    geometry,
    provenance,
  };
}

function uniqueObjectName(base: string, current: readonly SceneObjectSnapshot[]): string {
  const used = new Set(current.map((object) => object.name));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
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
    case "setMaterialBinding":
      return "set_material";
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
              ...(mutation.materialBinding !== undefined
                ? {
                    materialBinding: mutation.materialBinding
                      ? { ...mutation.materialBinding }
                      : undefined,
                  }
                : {}),
            };
          case "commitObject":
            return identified;
        }
      });
      return { objects: objectsNext, targetIds: [targetId], operationId };
    }
    case "setMaterialBinding": {
      const target = current.find((item) => item.name === mutation.name);
      if (!target) return null;
      targetId = target.objectId ?? stableLegacyId(projectId, target.name);
      return {
        objects: current.map((item) =>
          item === target
            ? {
                ...item,
                objectId: targetId,
                materialBinding: mutation.binding ? { ...mutation.binding } : undefined,
              }
            : item,
        ),
        targetIds: [targetId],
        operationId,
      };
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
  let objects = sceneObjectsFromProjectSnapshot(projectId, initial.project.objects);
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
        objects = sceneObjectsFromProjectSnapshot(projectId, reply.snapshot.project.objects);
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
    objects = sceneObjectsFromProjectSnapshot(projectId, saved.project.objects);
    return saved;
  };

  const handle = {
    id: "local-project-profile",
    projectId,
    workspaceScope: null,
    bridgeSnapshot: { id: "local-project-profile", projectId, workspaceScope: null },
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
    async boolean(req: BooleanRequest): Promise<BooleanResult | { ok: false; error: string }> {
      const sourceA = objects.find((object) => object.name === req.name_a);
      const sourceB = objects.find((object) => object.name === req.name_b);
      if (!sourceA || !sourceB) {
        return { ok: false, error: `unknown object "${!sourceA ? req.name_a : req.name_b}"` };
      }
      if (sourceA.name === sourceB.name) {
        return { ok: false, error: "boolean needs two distinct source objects" };
      }
      if (!sourceA.watertight || !sourceB.watertight) {
        return { ok: false, error: "boolean requires watertight source objects" };
      }
      if (!sourceA.geometry || !sourceB.geometry) {
        return { ok: false, error: "boolean source geometry is unavailable" };
      }
      const expectedRevision = revision;
      try {
        const reply = (await invoke("project_geometry_execute", {
          operation: `boolean_${req.op === "add" ? "union" : req.op}`,
          inputs: [sourceA, sourceB].map((source) => ({
            positions: Array.from(source.geometry!.positions),
            indices: Array.from(source.geometry!.indices),
            transform: transformArray(source),
          })),
        })) as {
          output: {
            positions: number[];
            triangles: number[][];
            watertight: boolean;
            volume_mm3: number;
          };
          blender_version: string;
          transport: string;
        };
        if (!reply.output.watertight) {
          return {
            ok: false,
            error: "geometry worker result failed its pinned validation contract",
          };
        }
        const baseName = req.result_name?.trim() || `${sourceA.name}-bool`;
        const resultName = uniqueObjectName(baseName, objects);
        const capability = `geometry.boolean.${req.op === "add" ? "union" : req.op}`;
        const provenance = `+bool ${req.op === "add" ? "union" : req.op} ${sourceA.name}∩${sourceB.name}; worker=blender-bridge.geometry.v1; Blender ${reply.blender_version}; ${capability}; ${reply.transport}`;
        const result = {
          ...meshSnapshot(sourceA, resultName, reply.output, provenance),
          geometrySpace: "editor-world",
          objectId: crypto.randomUUID(),
          visible: true,
          locked: false,
          transform: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 },
          plateId: sourceA.plateId ?? sourceB.plateId,
          printSettings: undefined,
          filamentId: undefined,
        } satisfies SceneObjectSnapshot;
        const after = objects.map((object) =>
          req.hide_sources && (object.name === sourceA.name || object.name === sourceB.name)
            ? { ...object, visible: false }
            : object,
        );
        after.push(result);
        const operation: ProjectOperation = {
          operation_id: crypto.randomUUID(),
          kind: "boolean",
          target_ids: [
            sourceA.objectId ?? stableLegacyId(projectId, sourceA.name),
            sourceB.objectId ?? stableLegacyId(projectId, sourceB.name),
            result.objectId!,
          ],
          before: objects,
          after,
        };
        await persist(expectedRevision, after, operation);
        handle.onCommitEvent?.({
          revision,
          selection: { ...EMPTY_SELECTION, objectModeNames: objects.map((object) => object.name) },
        });
        const committed = objects.find((object) => object.objectId === result.objectId) ?? result;
        return {
          ok: true,
          object: resultName,
          revision,
          vertices: committed.vertices,
          triangles: committed.triangles,
          watertight: true,
          op: req.op,
          objectSnapshot: committed,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async repair(req: RepairRequest): Promise<RepairResult | { ok: false; error: string }> {
      const source = objects.find((object) => object.name === req.name);
      if (!source) return { ok: false, error: `unknown object "${req.name}"` };
      if (source.watertight)
        return { ok: false, error: `object "${req.name}" is already watertight` };
      if (!source.geometry) return { ok: false, error: "repair source geometry is unavailable" };
      const expectedRevision = revision;
      try {
        const reply = (await invoke("project_geometry_execute", {
          operation: "repair",
          inputs: [
            {
              positions: Array.from(source.geometry.positions),
              indices: Array.from(source.geometry.indices),
              transform: transformArray(source),
            },
          ],
        })) as {
          output: {
            positions: number[];
            triangles: number[][];
            watertight: boolean;
            volume_mm3: number;
          };
          blender_version: string;
          transport: string;
        };
        if (!reply.output.watertight) {
          return { ok: false, error: "repair did not produce validated pinned-worker geometry" };
        }
        const mode = req.mode === "copy" ? "copy" : "replace";
        const provenance = `+repair ${mode}; worker=blender-bridge.geometry.v1; Blender ${reply.blender_version}; geometry.repair; ${reply.transport}`;
        const name =
          mode === "copy" ? uniqueObjectName(`${source.name}-repair`, objects) : source.name;
        const repaired = {
          ...meshSnapshot(source, name, reply.output, provenance),
          objectId: mode === "copy" ? crypto.randomUUID() : source.objectId,
          visible: mode === "copy" ? true : source.visible,
          locked: mode === "copy" ? false : source.locked,
          transform: source.transform,
        } satisfies SceneObjectSnapshot;
        const after =
          mode === "copy"
            ? [...objects, repaired]
            : objects.map((object) => (object.objectId === source.objectId ? repaired : object));
        const operation: ProjectOperation = {
          operation_id: crypto.randomUUID(),
          kind: "repair",
          target_ids:
            mode === "copy"
              ? [
                  source.objectId ?? stableLegacyId(projectId, source.name),
                  repaired.objectId ?? stableLegacyId(projectId, repaired.name),
                ]
              : [source.objectId ?? stableLegacyId(projectId, source.name)],
          before: objects,
          after,
        };
        await persist(expectedRevision, after, operation);
        handle.onCommitEvent?.({
          revision,
          selection: { ...EMPTY_SELECTION, objectModeNames: objects.map((object) => object.name) },
        });
        const committed = objects.find((object) => object.name === name);
        if (!committed) return { ok: false, error: "committed repair result is missing" };
        return { ok: true, object: name, revision, mode, objectSnapshot: committed };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    printerControl: () => unavailable("printer-control"),
    listFiles: () => unavailable("printer-files"),
    sendFile: () => unavailable("send-file"),
    devtoolsReadModel: () => unavailable("devtools"),
    rawCommand: () => unavailable("raw-command"),
  } as BridgeHandle;
  return handle;
}
