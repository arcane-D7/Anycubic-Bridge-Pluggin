/**
 * S9.12-002 — DevTools data model — dependency-free pure core.
 *
 * Same pattern as printer-files-core: no React/zustand so Node 24 runs it
 * headless under `node --test`. The DevTools pane in `panels/DevicePanel.tsx`
 * and the mock lane (`bridge/mock.ts` `devtoolsReadModel`) are thin wrappers
 * over these pure functions.
 *
 * Fixture mirrors (AGENTS.md §6): the entries below are a SMALL deterministic
 * subset of the real `printer_property_catalog` / `printer_hidden_command_map`
 * shapes (same field names, fixture-only values) — NEVER real device ids,
 * account ids or endpoints. The real MCP tools remain the authoritative
 * source; this model exists so the DevTools UI is headless-testable.
 */

import type {
  DevtoolsCommandEntry,
  DevtoolsPropertyEntry,
  DevtoolsReadModel,
} from "../bridge/types";

export type { DevtoolsCommandEntry, DevtoolsPropertyEntry, DevtoolsReadModel };

/** Deterministic fixture subset of the property catalog (S9.12-002). */
export const DEVTOOLS_CATALOG_FIXTURE: readonly DevtoolsPropertyEntry[] = [
  {
    source: "info",
    path: "printerName",
    type: "string",
    unit: null,
    group: "identity",
    note: "device name",
  },
  {
    source: "info",
    path: "model",
    type: "string",
    unit: null,
    group: "identity",
    note: "machine model id",
  },
  {
    source: "info",
    path: "version",
    type: "string",
    unit: null,
    group: "identity",
    note: "firmware version",
  },
  {
    source: "info",
    path: "state",
    type: "string",
    unit: null,
    group: "state",
    note: "free = idle",
  },
  {
    source: "info",
    path: "print_speed_mode",
    type: "number",
    unit: null,
    group: "print",
    note: null,
  },
  {
    source: "info",
    path: "fan_speed_pct",
    type: "number",
    unit: "percent",
    group: "cooling",
    note: null,
  },
  {
    source: "tempature",
    path: "curr_nozzle_temp",
    type: "number",
    unit: "celsius",
    group: "temperature",
    note: null,
  },
  {
    source: "tempature",
    path: "curr_hotbed_temp",
    type: "number",
    unit: "celsius",
    group: "temperature",
    note: null,
  },
  {
    source: "tempature",
    path: "target_nozzle_temp",
    type: "number",
    unit: "celsius",
    group: "temperature",
    note: null,
  },
  {
    source: "tempature",
    path: "target_hotbed_temp",
    type: "number",
    unit: "celsius",
    group: "temperature",
    note: null,
  },
  {
    source: "fan",
    path: "fan_speed_pct",
    type: "number",
    unit: "percent",
    group: "cooling",
    note: "part cooling fan",
  },
  {
    source: "fan",
    path: "aux_fan_speed_pct",
    type: "number",
    unit: "percent",
    group: "cooling",
    note: "auxiliary fan",
  },
  {
    source: "fan",
    path: "box_fan_level",
    type: "number",
    unit: "level",
    group: "cooling",
    note: "ACE/chamber fan",
  },
  {
    source: "light",
    path: "lights[].status",
    type: "number",
    unit: null,
    group: "lighting",
    note: null,
  },
  {
    source: "light",
    path: "lights[].brightness",
    type: "number",
    unit: "percent",
    group: "lighting",
    note: null,
  },
  {
    source: "peripherie",
    path: "camera",
    type: "number",
    unit: null,
    group: "peripheral",
    note: "1 = camera present",
  },
  {
    source: "peripherie",
    path: "multiColorBox",
    type: "number",
    unit: null,
    group: "peripheral",
    note: "1 = ACE present",
  },
  {
    source: "peripherie",
    path: "udisk",
    type: "number",
    unit: null,
    group: "peripheral",
    note: "1 = USB present",
  },
  {
    source: "axis",
    path: "coordinates.x",
    type: "number",
    unit: "millimeter",
    group: "motion",
    note: null,
  },
  {
    source: "axis",
    path: "coordinates.y",
    type: "number",
    unit: "millimeter",
    group: "motion",
    note: null,
  },
  {
    source: "axis",
    path: "coordinates.z",
    type: "number",
    unit: "millimeter",
    group: "motion",
    note: null,
  },
  {
    source: "multiColorBox",
    path: "multi_color_box[].status",
    type: "number",
    unit: null,
    group: "ace",
    note: null,
  },
  {
    source: "multiColorBox",
    path: "multi_color_box[].loaded_slot",
    type: "number",
    unit: null,
    group: "ace",
    note: "-1 = none",
  },
  {
    source: "multiColorBox",
    path: "multi_color_box[].temp",
    type: "number",
    unit: "celsius",
    group: "ace",
    note: null,
  },
  {
    source: "multiColorBox",
    path: "multi_color_box[].slots[].consumables_percent",
    type: "number",
    unit: "percent",
    group: "material",
    note: null,
  },
  {
    source: "file",
    path: "records[].filename",
    type: "string",
    unit: null,
    group: "storage",
    note: null,
  },
  {
    source: "file",
    path: "records[].is_dir",
    type: "boolean",
    unit: null,
    group: "storage",
    note: null,
  },
  {
    source: "file",
    path: "records[].size",
    type: "number",
    unit: "byte",
    group: "storage",
    note: null,
  },
] as const;

/** Deterministic fixture subset of the hidden command map (S9.12-002). */
export const DEVTOOLS_COMMANDS_FIXTURE: readonly DevtoolsCommandEntry[] = [
  {
    type: "print",
    action: "pause",
    data: "taskid",
    safety: "job",
    evidence: "mapping",
    note: null,
  },
  {
    type: "print",
    action: "resume",
    data: "taskid",
    safety: "job",
    evidence: "mapping",
    note: null,
  },
  {
    type: "print",
    action: "stop",
    data: "taskid = -1",
    safety: "job",
    evidence: "mapping",
    note: "stop current job",
  },
  { type: "print", action: "query", data: null, safety: "read", evidence: "reference", note: null },
  {
    type: "tempature",
    action: "set",
    data: "type+target temps",
    safety: "thermal",
    evidence: "mapping",
    note: null,
  },
  { type: "tempature", action: "query", data: null, safety: "read", evidence: "live", note: null },
  {
    type: "fan",
    action: "setSpeed",
    data: "fan_speed_pct",
    safety: "state",
    evidence: "mapping",
    note: "one key per call",
  },
  { type: "fan", action: "query", data: null, safety: "read", evidence: "live", note: null },
  {
    type: "light",
    action: "control",
    data: "type+status+brightness",
    safety: "state",
    evidence: "live",
    note: null,
  },
  { type: "light", action: "query", data: null, safety: "read", evidence: "live", note: null },
  { type: "axis", action: "query", data: null, safety: "read", evidence: "live", note: null },
  {
    type: "axis",
    action: "move",
    data: "axis+move_type+distance",
    safety: "motion",
    evidence: "mapping",
    note: "homexy executed during validation",
  },
  {
    type: "axis",
    action: "turnOff",
    data: null,
    safety: "motion",
    evidence: "mapping",
    note: "disables stepper torque",
  },
  { type: "peripherie", action: "query", data: null, safety: "read", evidence: "live", note: null },
  { type: "aiSettings", action: "query", data: null, safety: "read", evidence: "live", note: null },
  {
    type: "multiColorBox",
    action: "getInfo",
    data: null,
    safety: "read",
    evidence: "live",
    note: "activity-gated",
  },
] as const;

/** Build the DevTools read model (fixture). */
export function devtoolsReadModel(): DevtoolsReadModel {
  return { catalog: [...DEVTOOLS_CATALOG_FIXTURE], commands: [...DEVTOOLS_COMMANDS_FIXTURE] };
}

/**
 * Client-side search over the catalog/command rows. Case-insensitive;
 * `query` is matched against path/source/group (catalog) or type/action/
 * safety (commands). Empty query returns everything (deterministic).
 */
export function searchCatalog(
  rows: readonly DevtoolsPropertyEntry[],
  query: string,
): readonly DevtoolsPropertyEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r.path, r.source, r.group, r.type, r.note ?? ""].some((f) => f.toLowerCase().includes(q)),
  );
}

export function searchCommands(
  rows: readonly DevtoolsCommandEntry[],
  query: string,
): readonly DevtoolsCommandEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) =>
    [r.type, r.action, r.safety, r.evidence, r.data ?? "", r.note ?? ""].some((f) =>
      f.toLowerCase().includes(q),
    ),
  );
}

/** Validate a raw command before sending: non-empty command key + safe arg
 * values (numbers/booleans/strings only, length-bounded). Returns a reason
 * string when invalid, null when OK. */
export function validateRawCommand(
  command: string,
  args: Readonly<Record<string, string | number | boolean>>,
): string | null {
  const cmd = command.trim().toLowerCase();
  if (!cmd) return "command is empty";
  if (cmd.length > 64) return "command too long";
  const keys = Object.keys(args);
  if (keys.length > 16) return "too many args";
  for (const [key, value] of Object.entries(args)) {
    if (!key.trim()) return "arg key is empty";
    if (key.length > 64) return "arg key too long";
    if (typeof value === "string") {
      if (!value.trim()) return "arg value is empty";
      if (value.length > 256) return "arg value too long";
    }
    if (typeof value === "number" && !Number.isFinite(value)) return "arg value not a number";
  }
  return null;
}

/** Deterministic token hash for the journal (32-bit FNV-1a, no-loss
 * precision — the repo-wide rule for hashes in tests/editor). */
export function fnv32hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).padStart(8, "0")}`;
}
