import type { OperatorProfile } from "./operatorProfile";

export type CapabilityStatus = "supported" | "unsupported" | "unknown";
export type CapabilitySource = "profile-declared" | "operator-declared" | "unknown";
export type AuthoringState = "qualified" | "pending-qualification" | "blocked";

export interface ContinuousZCapability {
  readonly status: CapabilityStatus;
  readonly source: CapabilitySource;
  readonly explanation: string;
}

export interface NonPlanarEligibility {
  readonly capability: ContinuousZCapability;
  readonly canAuthor: boolean;
  readonly authoringState: AuthoringState;
  readonly printQualified: boolean;
  readonly slopeBudgetDeg: number | null;
  readonly explanation: string;
}

const CONTINUOUS_Z_TOKEN = "continuous_z";
const CONTINUOUS_Z_LEGACY_TOKEN = "continuous-z";
const CONTINUOUS_Z_NEGATIVE_TOKEN = "no-continuous-z";

export function resolveContinuousZCapability(
  profileCapabilities: readonly string[] | null | undefined,
  operator: OperatorProfile | null | undefined,
): ContinuousZCapability {
  if (
    operator !== null &&
    operator !== undefined &&
    operator.provenance === "operator-declared" &&
    operator.continuousZ !== "unknown"
  ) {
    if (operator.continuousZ === "supported") {
      return {
        status: "supported",
        source: "operator-declared",
        explanation:
          "continuous_z is operator-declared as supported on this machine — pending engine qualification.",
      };
    }
    return {
      status: "unsupported",
      source: "operator-declared",
      explanation: "continuous_z is operator-declared as unsupported on this machine.",
    };
  }
  if (profileCapabilities === null || profileCapabilities === undefined) {
    return {
      status: "unknown",
      source: "unknown",
      explanation: "Machine profile not loaded — continuous_z support is unknown.",
    };
  }
  if (
    profileCapabilities.includes(CONTINUOUS_Z_TOKEN) ||
    profileCapabilities.includes(CONTINUOUS_Z_LEGACY_TOKEN)
  ) {
    return {
      status: "supported",
      source: "profile-declared",
      explanation:
        "Machine profile declares continuous_z support (canonical or legacy token) — a declaration only, not print qualification.",
    };
  }
  if (profileCapabilities.includes(CONTINUOUS_Z_NEGATIVE_TOKEN)) {
    return {
      status: "unsupported",
      source: "profile-declared",
      explanation: "Machine profile explicitly declares continuous_z as unsupported.",
    };
  }
  return {
    status: "unknown",
    source: "unknown",
    explanation:
      "Machine profile does not mention continuous_z — treated as unknown, not unsupported.",
  };
}

export function resolveNonPlanarEligibility(
  profileCapabilities: readonly string[] | null | undefined,
  operator: OperatorProfile | null | undefined,
): NonPlanarEligibility {
  const capability = resolveContinuousZCapability(profileCapabilities, operator);
  const canAuthor = capability.status !== "unsupported";
  const printQualified = false;
  const slopeBudgetDeg =
    operator === null || operator === undefined ? null : operator.slopeBudgetDeg;
  const authoringState: AuthoringState = !canAuthor ? "blocked" : "pending-qualification";
  const explanation = !canAuthor
    ? `${capability.explanation} Non-planar authoring is blocked; imported non-planar IR stays inspectable.`
    : `${capability.explanation} Non-planar authoring is enabled; output is not print-qualified because this editor has no validated non-planar generation, slope, joint, or envelope qualification pipeline, and a capability declaration alone never certifies printing.`;
  return {
    capability,
    canAuthor,
    authoringState,
    printQualified,
    slopeBudgetDeg,
    explanation,
  };
}

export function isSlopeWithinBudget(
  slopeDeg: number,
  slopeBudgetDeg: number | null | undefined,
): boolean | null {
  if (!Number.isFinite(slopeDeg)) return null;
  if (slopeBudgetDeg === null || slopeBudgetDeg === undefined || !Number.isFinite(slopeBudgetDeg)) {
    return null;
  }
  return slopeDeg <= slopeBudgetDeg;
}
