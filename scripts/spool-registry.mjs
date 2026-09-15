/**
 * Spool registry — persistent local inventory for filament spools (Opção A:
 * tracking client-side de consumo; foundation for NFC tag writing, Opção B).
 *
 * Source of truth = local JSON under %LOCALAPPDATA%\AnycubicSlicerNextControl
 * (same base dir as the token store). The ACE/slicer never sees these fields;
 * we compute remaining = initial_weight_g - Σ used_g (from cloud slice data or
 * manual entry), because the printer has no writable spool-weight field.
 *
 * Schema per spool (aligned with docs/expansion-research.md §4):
 *   { vendor, material, color_hex, weight_g, density, diameter, sku,
 *     tag_uid, spool_id: uuid, box_id, slot_index, notes, events[] }
 *
 * Events document mutations and consumption (print task id, filament used g,
 * timestamp) so the history is auditable and idempotent.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

/** Base dir shared with the token store (see auth-login.mjs defaultDataDir). */
export function defaultDataDir() {
  const local = process.env.LOCALAPPDATA ?? os.homedir();
  const base = process.env.PLUGIN_DATA ?? path.join(local, "AnycubicSlicerNextControl");
  return base;
}

export function defaultRegistryFile() {
  return path.join(defaultDataDir(), "spool-registry.json");
}

/** Load the registry; returns {version, spools: [], updated_at}. */
export function loadRegistry(file = defaultRegistryFile()) {
  if (!existsSync(file)) return { version: 1, spools: [], updated_at: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      version: parsed?.version ?? 1,
      spools: Array.isArray(parsed?.spools) ? parsed.spools : [],
      updated_at: parsed?.updated_at ?? null,
    };
  } catch {
    return {
      version: 1,
      spools: [],
      updated_at: null,
      note: "registry unreadable, re-initialized",
    };
  }
}

export function saveRegistry(registry, file = defaultRegistryFile()) {
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = { ...registry, updated_at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

/** Find spool(s) by any identifier (spool_id, sku, tag_uid or unique spool_id). */
export function findSpools(registry, { spoolId, sku, tagUid } = {}) {
  const list = registry?.spools ?? [];
  if (spoolId) return list.filter((s) => s.spool_id === spoolId);
  const matches = list.filter((s) => (sku && s.sku === sku) || (tagUid && s.tag_uid === tagUid));
  // disambiguate: prefer an active spool if multiple match the same sku
  if (matches.length > 1)
    return matches.filter((s) => !s.archived).concat(matches.filter((s) => s.archived));
  return matches;
}

/** Create or replace a spool record. fields: vendor, material, color_hex,
 *  weight_g, density, diameter, sku, tag_uid, box_id, slot_index, notes.
 *  Returns the stored record. */
export function upsertSpool(registry, fields, file = defaultRegistryFile()) {
  const existing = findSpools(registry, { spoolId: fields.spool_id })[0];
  const now = new Date().toISOString();
  const record = {
    spool_id: fields.spool_id || existing?.spool_id || randomUUID(),
    vendor: fields.vendor ?? existing?.vendor ?? "unknown",
    material: fields.material ?? existing?.material ?? "PLA",
    color_hex: fields.color_hex ?? existing?.color_hex ?? "#FFFFFF",
    weight_g: Number(fields.weight_g ?? existing?.weight_g ?? 1000),
    density: fields.density ?? existing?.density ?? null,
    diameter: Number(fields.diameter ?? existing?.diameter ?? 1.75),
    sku: fields.sku ?? existing?.sku ?? null,
    tag_uid: fields.tag_uid ?? existing?.tag_uid ?? null,
    box_id: fields.box_id ?? existing?.box_id ?? 0,
    slot_index: fields.slot_index ?? existing?.slot_index ?? null,
    notes: fields.notes ?? existing?.notes ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    archived: fields.archived ?? existing?.archived ?? false,
    events: Array.isArray(existing?.events) ? existing.events : [],
  };
  const idx = registry.spools.findIndex((s) => s.spool_id === record.spool_id);
  if (idx >= 0) registry.spools[idx] = record;
  else registry.spools.push(record);
  saveRegistry(registry, file);
  return record;
}

/** Record an event on a spool (consumption, refill, calibration, archive...). */
export function pushSpoolEvent(spool, event) {
  if (!Array.isArray(spool.events)) spool.events = [];
  spool.events.push({ ts: new Date().toISOString(), ...event });
  spool.updated_at = new Date().toISOString();
  return spool;
}

/** Consumption math: remaining_g = weight_g - Σ used_g (manual + task-based). */
export function computeRemaining(spool) {
  const usedEvents = (spool?.events ?? []).filter(
    (e) => typeof e.used_g === "number" && e.used_g >= 0,
  );
  const totalUsed = usedEvents.reduce((acc, e) => acc + e.used_g, 0);
  const remaining = Math.max(0, Number(spool?.weight_g ?? 0) - totalUsed);
  return {
    weight_g: Number(spool?.weight_g ?? 0),
    used_g: round(totalUsed),
    remaining_g: round(remaining),
    remaining_pct:
      Number(spool?.weight_g ?? 0) > 0 ? round((remaining / (spool.weight_g ?? 1)) * 100) : 0,
    last_event_ts: usedEvents.length ? usedEvents[usedEvents.length - 1].ts : null,
    tasks: usedEvents
      .filter((e) => e.task_id)
      .map((e) => ({ task_id: e.task_id, used_g: e.used_g, ts: e.ts })),
  };
}

/** Deduplicate consumption by (task_id, ts) so re-applied jobs don't double count. */
export function applyTaskUsage(spool, taskId, usedGrams, { ts, note } = {}) {
  const events = spool?.events ?? [];
  const already = events.some(
    (e) =>
      e.task_id === taskId &&
      typeof e.used_g === "number" &&
      Math.abs(e.used_g - Number(usedGrams)) < 0.01,
  );
  if (already) return { spool, applied: false, reason: "duplicate" };
  pushSpoolEvent(spool, {
    kind: "task_usage",
    task_id: taskId,
    used_g: Number(usedGrams),
    ts: ts ?? null,
    note: note ?? null,
  });
  return { spool, applied: true, reason: "applied" };
}

function round(v) {
  return Math.round(v * 100) / 100;
}

/** Human summary of the whole registry (for tool output). */
export function summarizeRegistry(registry) {
  return (registry?.spools ?? []).map((s) => {
    const rem = computeRemaining(s);
    return {
      spool_id: s.spool_id,
      vendor: s.vendor,
      material: s.material,
      color_hex: s.color_hex,
      weight_g: s.weight_g,
      remaining_g: rem.remaining_g,
      remaining_pct: rem.remaining_pct,
      used_g: rem.used_g,
      box_id: s.box_id,
      slot_index: s.slot_index,
      sku: s.sku,
      tag_uid: s.tag_uid,
      archived: s.archived,
      created_at: s.created_at,
      events: (s.events ?? []).length,
    };
  });
}
