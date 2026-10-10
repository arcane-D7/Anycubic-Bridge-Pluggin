// Backend availability descriptor (optional local-Tauri fetch, S9.18-003):
// the Tauri backend exposes the public-safe `device_control_availability`
// reply (booleans + fixed reasons only — no user id, no session bearer). The
// core below NEVER auto-enables a writer from a demo profile; `canWrite`
// stays `false` by construction until backend capability states are ready.
// The runtime import is LAZY + relative so Node's native type-stripping
// (unit tests) never forces the alias-resolver onto this module.
import type { DeviceAvailabilityDescriptor } from "../bridge/device-control";
export type { DeviceAvailabilityDescriptor } from "../bridge/device-control";

export type DeviceDataOrigin = "cloud" | "demo";

export interface DeviceAvailability {
  readonly origin: DeviceDataOrigin;
  readonly readOnly: boolean;
  readonly canWrite: false;
  readonly canStartCamera: false;
}

export function deviceAvailability(printerId: string | null): DeviceAvailability {
  const origin: DeviceDataOrigin = printerId?.startsWith("cloud-") ? "cloud" : "demo";
  return {
    origin,
    readOnly: true,
    canWrite: false,
    canStartCamera: false,
  };
}

/** Is the Tauri backend reachable AND reporting a defined, usable bootstrap? */
export function backendControlBootstrapUsable(desc: DeviceAvailabilityDescriptor): boolean {
  return (
    Boolean(desc) &&
    desc.session?.established === true &&
    desc.capability?.defined === true &&
    desc.writer?.available === true
  );
}

/**
 * Optional local-Tauri availability bootstrap; defaults to `BLOCKED_DEVICE_CONTROL`
 * on any failure (no throw — this is a status fetch, never a gate).
 */
export async function fetchBackendDeviceControlStatus(): Promise<DeviceAvailabilityDescriptor> {
  try {
    const { BLOCKED_DEVICE_CONTROL, fetchDeviceControlAvailability } =
      await import("../bridge/device-control");
    const descriptor = await fetchDeviceControlAvailability();
    return descriptor ?? BLOCKED_DEVICE_CONTROL;
  } catch {
    return {
      session: { established: false, reason: "blocked-runtime" },
      capability: { defined: false, reason: "resolver-unavailable" },
      writer: { available: false, reason: "session-unestablished" },
    };
  }
}

export interface ControlTargetContext {
  readonly printerId: string;
  readonly source: "cloud" | "lan" | "profile" | "demo";
  readonly snapshotCapturedAt: number;
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly revision?: number;
}

export type ControlTargetCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "unavailable" | "invalid"; readonly reason: string };

export const MAX_CONTROL_SNAPSHOT_AGE_MS = 60_000;

export function validateControlTarget(
  target: ControlTargetContext | null,
  selectedPrinterId: string | null,
  currentCapturedAt: number | null,
  capabilityKey: string,
  now = Date.now(),
): ControlTargetCheck {
  if (!target || !selectedPrinterId || target.printerId !== selectedPrinterId) {
    return { ok: false, kind: "invalid", reason: "control target does not match selection" };
  }
  if (target.source === "demo" || target.source === "profile") {
    return { ok: false, kind: "invalid", reason: "synthetic targets cannot receive controls" };
  }
  if (
    !Number.isSafeInteger(target.snapshotCapturedAt) ||
    target.snapshotCapturedAt <= 0 ||
    currentCapturedAt === null ||
    !Number.isSafeInteger(currentCapturedAt) ||
    currentCapturedAt <= 0 ||
    target.snapshotCapturedAt !== currentCapturedAt ||
    !Number.isSafeInteger(now) ||
    now < currentCapturedAt ||
    now - currentCapturedAt > MAX_CONTROL_SNAPSHOT_AGE_MS
  ) {
    return { ok: false, kind: "invalid", reason: "control snapshot is missing or stale" };
  }
  if (target.capabilities[capabilityKey] !== true) {
    return { ok: false, kind: "unavailable", reason: `missing capability: ${capabilityKey}` };
  }
  return { ok: true };
}
