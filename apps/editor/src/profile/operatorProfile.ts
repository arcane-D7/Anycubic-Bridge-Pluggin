import type { BuildVolume } from "../bridge/types";

export type ContinuousZDeclaration = "supported" | "unsupported" | "unknown";
export type ProfileProvenance = "operator-declared" | "unknown";
export type JointModel = "cartesian" | "rotary";

export interface OperatorProfile {
  readonly displayName: string;
  readonly buildVolume: BuildVolume | null;
  readonly continuousZ: ContinuousZDeclaration;
  readonly provenance: ProfileProvenance;
  readonly slopeBudgetDeg: number | null;
  readonly jointModel: JointModel | null;
}

export interface CatalogMachine {
  readonly id: string;
  readonly displayName: string;
  readonly buildVolume: BuildVolume;
}

export const CATALOG_MACHINES: readonly CatalogMachine[] = [
  {
    id: "kobra-s1",
    displayName: "Anycubic Kobra S1",
    buildVolume: { widthMm: 250, depthMm: 250, heightMm: 250 },
  },
];

export function catalogMachineById(id: string): CatalogMachine | null {
  const found = CATALOG_MACHINES.find((m) => m.id === id);
  return found ?? null;
}

export function defaultOperatorProfile(): OperatorProfile {
  return {
    displayName: "",
    buildVolume: null,
    continuousZ: "unknown",
    provenance: "unknown",
    slopeBudgetDeg: null,
    jointModel: null,
  };
}

export function withCatalogSelection(profile: OperatorProfile, machineId: string): OperatorProfile {
  const machine = catalogMachineById(machineId);
  if (machine === null) return profile;
  return {
    ...profile,
    displayName: machine.displayName,
    buildVolume: { ...machine.buildVolume },
    continuousZ: "unknown",
    provenance: "unknown",
    slopeBudgetDeg: null,
    jointModel: null,
  };
}

export interface ContinuousZDeclarationOptions {
  readonly slopeBudgetDeg?: number | null;
  readonly jointModel?: JointModel | null;
}

export function withContinuousZDeclaration(
  profile: OperatorProfile,
  continuousZ: ContinuousZDeclaration,
  options: ContinuousZDeclarationOptions = {},
): OperatorProfile {
  if (continuousZ === "unknown") return clearContinuousZDeclaration(profile);
  return {
    ...profile,
    continuousZ,
    provenance: "operator-declared",
    slopeBudgetDeg:
      typeof options.slopeBudgetDeg === "number" && Number.isFinite(options.slopeBudgetDeg)
        ? options.slopeBudgetDeg
        : null,
    jointModel: options.jointModel ?? profile.jointModel,
  };
}

export function clearContinuousZDeclaration(profile: OperatorProfile): OperatorProfile {
  return {
    ...profile,
    continuousZ: "unknown",
    provenance: "unknown",
    slopeBudgetDeg: null,
    jointModel: null,
  };
}

export interface BuildVolumeIssue {
  readonly field: string;
  readonly message: string;
}

const BUILD_VOLUME_FIELDS = ["widthMm", "depthMm", "heightMm"] as const;

export function validateBuildVolume(volume: BuildVolume | null): readonly BuildVolumeIssue[] {
  if (volume === null) {
    return [{ field: "buildVolume", message: "no build volume selected" }];
  }
  const issues: BuildVolumeIssue[] = [];
  for (const field of BUILD_VOLUME_FIELDS) {
    const value = volume[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      issues.push({
        field,
        message: `${field} must be a positive finite number of millimetres`,
      });
    }
  }
  return issues;
}
