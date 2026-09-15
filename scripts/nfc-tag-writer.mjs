/**
 * NFC tag writer prep (Opção B — preparado; sem hardware ainda).
 *
 * Gera o plano de escrita de uma NTAG213 (formato Anycubic) a partir de um
 * registro de spool. Quando o utilizador tiver tags virgens + leitor/escritor
 * NFC (telemóvel Android, ACR122U/PCSC), o output deste módulo é o payload
 * bruto a gravar — o ACE lê a tag como `edit_status: 0` e decrementa
 * nativamente o consumibles_percent.
 *
 * ⚠ Regra do projeto (docs/expansion-research.md §4): nunca tags de fábrica
 * Anycubic; apenas NTAG virgens escritas pel(a/o) utilizador(a). O formato
 * aqui é reproduzido a partir do decoder N13 + padrão observado no report do
 * ACE (SKU 17 chars, tipo material, cor RGB). O byte layout exato de fábrica
 * deve ser validado com ReSpool numa tag física antes de uso em produção.
 */
import { randomUUID } from "node:crypto";

/** Build the raw block plan for a NTAG213 (135 blocks; user area 4..129).
 *  Returns a human + machine-readable plan; the exact NFC APDU/writer bytes
 *  are provided once a physical writer is wired in (Seeed/PN532/ACR122U). */
export function planAnycubicTagWrite(spool) {
  const sku = String(spool?.sku ?? "").trim();
  if (!sku) {
    return {
      ok: false,
      error: "spool.sku is required to build an Anycubic-format tag plan",
    };
  }
  // color hex "#RRGGBB" -> [R,G,B]
  const hex = (spool?.color_hex ?? "#FFFFFF").replace("#", "");
  const color = [
    parseInt(hex.slice(0, 2), 16) || 255,
    parseInt(hex.slice(2, 4), 16) || 255,
    parseInt(hex.slice(4, 6), 16) || 255,
  ];
  const material = String(spool?.material ?? "PLA").toUpperCase();
  const weightG = Number(spool?.weight_g ?? 1000);
  const diameter = Number(spool?.diameter ?? 1.75);

  // Text blocks (ASCII 16 bytes each, left-started): SKU in block 0 visible
  // area, material + weight encoded next. The Anycubic NFC layout is NOT fully
  // public; the plan below is our documented assumption to validate on HW.
  const skuPadded = sku.padEnd(16, "\0").slice(0, 16);
  const materialPadded = material.padEnd(8, "\0").slice(0, 8);
  const headerBlob = [
    ..."A1N0".split("").map((c) => c.charCodeAt(0)), // magic prefix (assumption)
    ...skuPadded.split("").map((c) => c.charCodeAt(0)),
    ...materialPadded.split("").map((c) => c.charCodeAt(0)),
    ...color,
  ];
  const blocks = [];
  for (let i = 0; i < headerBlob.length; i += 4) {
    blocks.push(headerBlob.slice(i, i + 4));
  }
  // pad to an even number of blocks
  while (blocks.length < 2) blocks.push([0, 0, 0, 0]);

  return {
    ok: true,
    format: "anycubic",
    tag_type: "ntag213",
    estimated_blocks: 135,
    payload_blocks: blocks,
    fields: {
      sku,
      material,
      color,
      color_hex: spool?.color_hex ?? "#FFFFFF",
      weight_g: weightG,
      diameter,
    },
    // machine record to write alongside the tag in our registry
    registry_record: {
      spool_id: spool?.spool_id ?? randomUUID(),
      vendor: spool?.vendor ?? "unknown",
      material,
      color_hex: spool?.color_hex ?? "#FFFFFF",
      weight_g: weightG,
      diameter,
      sku,
      tag_uid: null,
      box_id: spool?.box_id ?? 0,
      slot_index: spool?.slot_index ?? null,
    },
    writer_hint:
      "Not yet wired: bring an NFC writer (Android NDEF, PN532, ACR122U) and validate block layout with ReSpool before writing production tags.",
  };
}

/** Read-side complement: given a decoded record from decodeTagRecord, build
 *  the spool registry fields (used by spool_resolve + spool_bind). */
export function planSpoolFromDecoded(decoded, { boxId, slotIndex } = {}) {
  if (!decoded?.ok) return { ok: false, error: decoded?.error ?? "undecoded record" };
  const fields = {
    vendor: decoded.vendor ?? "unknown",
    material: decoded.material ?? decoded.type ?? null,
    color_hex: decoded.color ?? null,
    sku: decoded.sku ?? null,
    weight_g: decoded.weight ?? null,
    box_id: boxId ?? 0,
    slot_index: slotIndex ?? null,
  };
  return { ok: true, fields, decoded };
}
