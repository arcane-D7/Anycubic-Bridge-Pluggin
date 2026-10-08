/**
 * S9.11-002 — slicer-style material assignment (pure, headless).
 *
 * Mapper `object/extruder → ACE slot → color` with a strict fallback chain,
 * never guessing:
 *
 *   1. ACE slot color (real, from the live snapshot): when the object owns
 *      a `filamentId` that matches a loaded ACE slot's material OR the
 *      slot index maps 1:1 to the object's filament (following the
 *      print-flow loading convention), its RGB/hex color wins.
 *   2. Local `FILAMENT_PRESETS` entry for the object's filament id, when
 *      no ACE slot exists for it (idle viewport, no printer / no ACE).
 *   3. Neutral placeholder (never guessed): the object's own filament
 *      material label is unknown → the canonical "unassigned" gray.
 *
 * Rules (matching the sprint AC):
 *  - color source priority: ACE slot → preset → neutral placeholder.
 *  - no image/channel assets: procedural materials only (bump/roughness by
 *    material class, built in `filament-material.ts`).
 *  - pure + deterministic: same inputs → same output, unit-testable under
 *    Node (no React/zustand/three imports).
 */

import type { AceBox, AceSlot, SceneObjectSnapshot } from "../bridge/types.ts";

/** Neutral placeholder hex for an object with no resolvable filament. */
export const NEUTRAL_FILAMENT_HEX = "#bdbdbd";

/** Material classes for procedural roughness (no assets — a live choice). */
export type MaterialClass = "smooth" | "matte" | "textured" | "flex";

/** Max slots an ACE exposes per box — bounds the mapping range. */
export const ACE_BOX_SLOTS_WINDOW = 10;

export interface FilamentMatch {
  readonly color: string;
  /** Which source won: explicit project binding, preset, or neutral. */
  readonly source: "binding" | "preset" | "neutral";
  readonly bindingStatus: "available" | "offline" | "stale" | "unassigned";
  /** Material label when known (preset or ACE slot) — null for neutral. */
  readonly material: string | null;
  /** ACE slot that won (when source === "ace"). */
  readonly slot?: AceSlot;
}

export interface FilamentPresetLike {
  readonly id: string;
  readonly material: string;
  readonly color: string;
}

export interface PhysicalMaterialBinding {
  readonly printerId: string;
  readonly toolId: string;
  readonly boxId: number;
  readonly slotIndex: number;
  readonly revision: number;
}

/** A slot is visible/loaded enough to drive color only when filled + known. */
export function slotIsColorUsable(slot: AceSlot): boolean {
  if (slot.state === "empty" || slot.state === "identifying") return false;
  return !!slot.color || !!slot.material;
}

/**
 * Find the strongest ACE slot for an object:
 * - exact material match first (filament id or material label),
 * - then the box's loaded slot (loadedSlotIndex),
 * - never a slot that is empty/identifying (color unknown).
 */
export function matchAceSlot(
  boxes: readonly AceBox[],
  filamentId: string | undefined,
  materialLabel: string | undefined,
): AceSlot | null {
  for (const box of boxes) {
    for (const slot of box.slots) {
      if (!slotIsColorUsable(slot)) continue;
      const slotMaterial = slot.material?.toLowerCase() ?? "";
      const wantMaterial = materialLabel?.toLowerCase() ?? filamentId?.toLowerCase() ?? "";
      if (wantMaterial && slotMaterial === wantMaterial) return slot;
    }
  }
  // Fallback: the box's loaded slot (default filament when the object
  // didn't name one) — the print-flow loading convention maps the first
  // toolhead to the ACE's loaded slot.
  for (const box of boxes) {
    if (box.loadedSlotIndex === null) continue;
    const slot = box.slots[box.loadedSlotIndex];
    if (slot && slotIsColorUsable(slot)) return slot;
  }
  return null;
}

/**
 * Resolve the color for one object from:
 *  - `objectFilamentId` — per-object assignment (S9.6-002, optional)
 *  - `objectMaterialLabel` — material name (e.g. "PLA", optional)
 *  - `boxes` — live ACE snapshot (may be empty when idle/no printer)
 *  - `presets` — local FILAMENT_PRESETS fallback
 *
 * Returns the winning color + source + material. Neutral never guesses.
 */
export function resolveFilamentColor(args: {
  readonly boxes: readonly AceBox[];
  readonly filamentId: string | undefined;
  readonly materialLabel: string | undefined;
  readonly presets: readonly FilamentPresetLike[];
  readonly binding?: PhysicalMaterialBinding;
  readonly printerId?: string;
  readonly snapshotStatus?: "polling" | "stale" | "offline" | "idle";
}): FilamentMatch {
  const { boxes, filamentId, materialLabel, presets, binding, printerId, snapshotStatus } = args;

  const boundBox =
    binding && binding.printerId === printerId
      ? boxes.find((box) => box.index === binding.boxId)
      : undefined;
  const aceSlot = boundBox?.slots.find((slot) => slot.index === binding?.slotIndex);
  const bindingStatus: FilamentMatch["bindingStatus"] = !binding
    ? "unassigned"
    : snapshotStatus === "offline" || snapshotStatus === "idle"
      ? "offline"
      : snapshotStatus === "stale" || binding.printerId !== printerId
        ? "stale"
        : "available";
  const materialMatches =
    !materialLabel ||
    !aceSlot?.material ||
    aceSlot.material.toLowerCase() === materialLabel.toLowerCase();
  const effectiveBindingStatus =
    bindingStatus === "available" && (!aceSlot || !materialMatches) ? "stale" : bindingStatus;
  if (effectiveBindingStatus === "available" && aceSlot && slotIsColorUsable(aceSlot)) {
    const color = aceSlot.color;
    if (color) {
      return {
        color,
        source: "binding",
        bindingStatus: effectiveBindingStatus,
        material: aceSlot.material ?? materialLabel ?? null,
        slot: aceSlot,
      };
    }
  }

  // 2) local preset by filament id, else by material label.
  const preset = filamentId
    ? presets.find((p) => p.id === filamentId)
    : presets.find(
        (p) =>
          !!materialLabel &&
          p.material.toLowerCase().replace(/[\s_-]+/g, "") ===
            materialLabel.toLowerCase().replace(/[\s_-]+/g, ""),
      );
  if (preset) {
    return {
      color: preset.color,
      source: "preset",
      bindingStatus: effectiveBindingStatus,
      material: preset.material,
    };
  }

  // 3) neutral placeholder (never guessed).
  return {
    color: NEUTRAL_FILAMENT_HEX,
    source: "neutral",
    bindingStatus: effectiveBindingStatus,
    material: materialLabel ?? null,
  };
}

export function materialBindingDiagnostics(args: {
  readonly objects: readonly SceneObjectSnapshot[];
  readonly globalFilamentId: string;
  readonly boxes: readonly AceBox[];
  readonly printerId: string | undefined;
  readonly snapshotStatus: "polling" | "stale" | "offline" | "idle";
  readonly presets: readonly FilamentPresetLike[];
}): readonly { readonly objectId: string; readonly match: FilamentMatch }[] {
  return args.objects.map((object) => {
    const filamentId = object.filamentId ?? args.globalFilamentId;
    const materialLabel = args.presets.find((preset) => preset.id === filamentId)?.material;
    return {
      objectId: object.objectId ?? object.name,
      match: resolveFilamentColor({
        boxes: args.boxes,
        filamentId,
        materialLabel,
        presets: args.presets,
        binding: object.materialBinding,
        printerId: args.printerId,
        snapshotStatus: args.snapshotStatus,
      }),
    };
  });
}

/** Procedural material class for a resolved match (roughness driver). */
export function materialClassFor(match: FilamentMatch): MaterialClass {
  const m = (match.material ?? "").toUpperCase();
  if (m.includes("TPU") || m.includes("FLEX")) return "flex";
  if (m.includes("PETG") || m.includes("ABS") || m.includes("ASA")) return "smooth";
  if (m.includes("PLA")) return "matte";
  if (m.includes("WOOD") || m.includes("MARBLE") || m.includes("CARBON")) return "textured";
  return match.source === "neutral" ? "matte" : "smooth";
}
