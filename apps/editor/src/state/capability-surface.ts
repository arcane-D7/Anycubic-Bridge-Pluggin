/**
 * S9.10-001 — capability surface: user vs Agent policy (pure, headless).
 *
 * Declarative policy shared by the UI control surface and the Agent tool
 * surface (S9.12 parity). Every printer WRITE the editor can do lives in
 * `WRITE_ACTIONS` with a `requiresApproval` classification:
 *
 *   - reads          → direct for everyone (`capabilityKey` read-only)
 *   - user writes    → direct from the UI (safety gates still apply:
 *                      `confirm:true`, motion/job need the `EXECUTE` word)
 *   - Agent writes   → MUST pass the S9-006 approval card first
 *   - raw hidden     → DevTools + explicit confirm only; Agent BLOCKED
 *
 * No zustand/React/three imports — importable from `.mjs` unit tests and
 * importable from the MCP-facing module. Single source of truth: the UI
 * and the Agent tool never re-declare their own rules.
 */

export type ActorKind = "user" | "agent";
export type ApprovalKind = "never" | "user" | "agent";
export type ActionKind = "read" | "write" | "raw";

/**
 * A single capability entry. `action` is the stable editor action name
 * (also used as the bridge command key); `capabilityKey` mirrors the
 * printer capability key the action drives (same keys as the snapshot
 * `capabilities` map where applicable); `kind` tells read vs write vs raw.
 */
export interface CapabilityEntry {
  readonly action: string;
  readonly capabilityKey: string;
  readonly kind: ActionKind;
  readonly requiresApproval: ApprovalKind;
  /** When true the Agent can never invoke this action (raw hidden paths). */
  readonly agentBlocked?: boolean;
  /** Human label key (i18n) — UI only, Agent never needs it. */
  readonly labelKey?: string;
}

/** Read actions — direct for user AND agent, no gates. */
export const READ_ACTIONS: readonly CapabilityEntry[] = [
  { action: "snapshot.get", capabilityKey: "snapshot", kind: "read", requiresApproval: "never" },
  {
    action: "printer.identity",
    capabilityKey: "identity",
    kind: "read",
    requiresApproval: "never",
  },
  { action: "printer.temps", capabilityKey: "tempature", kind: "read", requiresApproval: "never" },
  { action: "printer.fans", capabilityKey: "fans", kind: "read", requiresApproval: "never" },
  { action: "printer.print", capabilityKey: "print", kind: "read", requiresApproval: "never" },
  {
    action: "printer.ace",
    capabilityKey: "multiColorBox",
    kind: "read",
    requiresApproval: "never",
  },
  { action: "printer.motion", capabilityKey: "axis", kind: "read", requiresApproval: "never" },
  { action: "printer.ai", capabilityKey: "ai", kind: "read", requiresApproval: "never" },
  { action: "printer.lights", capabilityKey: "light", kind: "read", requiresApproval: "never" },
  {
    action: "printer.peripherals",
    capabilityKey: "peripherie",
    kind: "read",
    requiresApproval: "never",
  },
  { action: "printer.storage", capabilityKey: "storage", kind: "read", requiresApproval: "never" },
] as const;

/**
 * Write actions. The classification rule:
 *
 *   - user      → the EDITOR's direct control, still through
 *                 `printer_command_send` with `confirm:true` (and the
 *                 `EXECUTE` word for motion/job).
 *   - agent     → the Agent REQUIRES the S9-006 approval card; the
 *                 approval carries the exact command envelope hash.
 *   - raw       → hidden command path; DevTools + explicit confirm only,
 *                 `agentBlocked: true` (structural policy).
 */
export const WRITE_ACTIONS: readonly CapabilityEntry[] = [
  {
    action: "temps.setNozzle",
    capabilityKey: "tempature",
    kind: "write",
    requiresApproval: "user",
  },
  { action: "temps.setBed", capabilityKey: "tempature", kind: "write", requiresApproval: "user" },
  { action: "fans.setPart", capabilityKey: "fans", kind: "write", requiresApproval: "user" },
  { action: "fans.setHotend", capabilityKey: "fans", kind: "write", requiresApproval: "user" },
  { action: "speed.setMode", capabilityKey: "print", kind: "write", requiresApproval: "user" },
  { action: "lights.setEnabled", capabilityKey: "light", kind: "write", requiresApproval: "user" },
  {
    action: "lights.setBrightness",
    capabilityKey: "light",
    kind: "write",
    requiresApproval: "user",
  },
  { action: "ace.dry", capabilityKey: "multiColorBox", kind: "write", requiresApproval: "user" },
  {
    action: "ace.autoFeed",
    capabilityKey: "multiColorBox",
    kind: "write",
    requiresApproval: "user",
  },
  {
    action: "ace.bindSlot",
    capabilityKey: "multiColorBox",
    kind: "write",
    requiresApproval: "user",
  },
  { action: "print.pause", capabilityKey: "print", kind: "write", requiresApproval: "user" },
  { action: "print.resume", capabilityKey: "print", kind: "write", requiresApproval: "user" },
  { action: "print.stop", capabilityKey: "print", kind: "write", requiresApproval: "user" },
  {
    action: "raw.command",
    capabilityKey: "raw",
    kind: "raw",
    requiresApproval: "user",
    agentBlocked: true,
  },
] as const;

export interface SurfaceLookup {
  readonly byAction: Readonly<Record<string, CapabilityEntry>>;
  readonly writes: readonly CapabilityEntry[];
  readonly reads: readonly CapabilityEntry[];
  readonly raw: readonly CapabilityEntry[];
}

/** Build indexed lookup (cheap, module-scope). */
export function buildSurface(
  reads: readonly CapabilityEntry[] = READ_ACTIONS,
  writes: readonly CapabilityEntry[] = WRITE_ACTIONS,
): SurfaceLookup {
  const byAction: Record<string, CapabilityEntry> = {};
  for (const e of [...reads, ...writes]) byAction[e.action] = e;
  return {
    byAction,
    reads: [...reads],
    writes: writes.filter((e) => e.kind === "write"),
    raw: writes.filter((e) => e.kind === "raw"),
  };
}

/** Can `actor` invoke `action`? (policy is the ONLY gate — no bypass.) */
export function allowedFor(actor: ActorKind, entry: CapabilityEntry): boolean {
  if (entry.agentBlocked && actor === "agent") return false;
  if (entry.kind === "read") return true;
  // Raw hidden commands: user (DevTools) only.
  if (entry.kind === "raw") return actor === "user";
  // Every write is available to the user directly; the Agent is also allowed
  // to write, but `needsApproval` forces the S9-006 card first. No bypass.
  return true;
}

/** True when this action needs the approval-card flow for `actor`. */
export function needsApproval(actor: ActorKind, entry: CapabilityEntry): boolean {
  if (entry.kind === "read") return false;
  // A raw hidden action is BLOCKED for the agent — no approval applies.
  if (entry.agentBlocked && actor === "agent") return false;
  return entry.requiresApproval !== "never" && actor === "agent";
}

/** Look an entry up by action name. */
export function entryFor(surface: SurfaceLookup, action: string): CapabilityEntry | undefined {
  return surface.byAction[action];
}

/** Every entry must be uniquely keyed — duplicated action → invalid surface. */
export function surfaceIsValid(
  reads: readonly CapabilityEntry[],
  writes: readonly CapabilityEntry[],
): boolean {
  const seen = new Set<string>();
  for (const e of [...reads, ...writes]) {
    if (seen.has(e.action)) return false;
    seen.add(e.action);
  }
  return true;
}

export const CAPABILITY_SURFACE = buildSurface();

export type { CapabilityEntry as CapabilitySurfaceEntry };
