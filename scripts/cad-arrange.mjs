/**
 * cad-arrange.mjs — distribuição uniforme de objetos sobre a mesa (plate)
 * sem sobreposição (shelf packing).
 *
 * Lógica pura, sem dependências de bundle: recebe um Map de meshes
 * ({positions: Float32Array, tris: [...]}) e devolve um novo Map com as
 * peças **transladadas** (nunca muta os originais). Cada peça é primeiro
 * normalizada (centro XY na origem, minZ=0) e depois posicionada na grelha
 * calculada — garante "nadar fora da mesa? não" (tudo dentro do plate) e
 * "peças flutuantes? não" (assentadas em Z=0).
 *
 * Usada pelo endpoint /api/arrange do CAD workspace e pelas tools MCP.
 */
import { cloneMesh, computeBoundingBox, translateMesh } from "./cad-arrange-utils.mjs";

/**
 * Distribui os objetos de um Map num layout "shelf" (linhas de altura
 * variável, maiores primeiro) sobre um plate de plateW×plateD, com um gap
 * configurável. Cada peça:
 *   - é clonada e normalizada (center XY -> origem, minZ -> 0);
 *   - recebe um translate({x, y, 0}) absoluto para a sua posição na grelha;
 *   - o bloco inteiro é centrado na origem (0,0) do plate.
 *
 * @param {Map<string, {positions: Float32Array|number[], tris: Array}>} objectsMap
 * @param {{plateW?: number, plateD?: number, gap?: number, center?: boolean}} opts
 * @returns {{ objects: Map<string, object>, placed: Array<{name,x,y,w,h}>, warnings: string[] }}
 */
export function arrangeObjects(objectsMap, opts = {}) {
  const plateW = Number(opts.plateW ?? 220);
  const plateD = Number(opts.plateD ?? 220);
  const gap = Math.max(0, Number(opts.gap ?? 2));
  const warnings = [];

  // 1. Coleta footprints normalizados (w = X, h = Y)
  const items = [];
  for (const [name, mesh] of objectsMap) {
    const clone = applyCenterOnPlate(cloneMesh(mesh));
    const bb = computeBoundingBox(clone);
    const w = bb.max.x - bb.min.x;
    const h = bb.max.y - bb.min.y;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      warnings.push(`object '${name}' skipped (empty footprint)`);
      continue;
    }
    items.push({ name, mesh: clone, w, h, area: w * h });
  }

  // 2. Ordena por área decrescente (maiores primeiro — maior densidade)
  items.sort((a, b) => b.area - a.area);

  // 3. Shelf packing — Y cresce para baixo (mais negativo); topo do bloco = 0
  const placed = [];
  const shelves = [{ top: 0, xCursor: 0, h: 0 }];
  let current = shelves[0];

  for (const item of items) {
    const slotW = item.w + gap;
    const slotH = item.h + gap;
    const fitsX = current.xCursor + slotW <= plateW + 1e-6;
    if (fitsX) {
      item.x = current.xCursor + item.w / 2;
      item.y = current.top - item.h / 2;
      current.xCursor += slotW;
      current.h = Math.max(current.h, slotH);
    } else {
      const newTop = current.top - current.h;
      if (-newTop + slotH > plateD + 1e-6) {
        warnings.push(
          `object '${item.name}' (${item.w.toFixed(1)}×${item.h.toFixed(1)} mm) does not fit ` +
            `plate ${plateW}×${plateD} mm — placed at ` +
            `(${current.xCursor.toFixed(1)}, ${(-current.top).toFixed(1)}) (may overlap)`,
        );
        item.x = current.xCursor + item.w / 2;
        item.y = current.top - item.h / 2;
      } else {
        shelves.push({ top: newTop, xCursor: 0, h: slotH });
        current = shelves[shelves.length - 1];
        item.x = current.xCursor + item.w / 2;
        item.y = current.top - item.h / 2;
        current.xCursor += slotW;
      }
    }
    placed.push(item);
  }

  // 4. Bbox do bloco + centrar em (0,0)
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.w / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
    minY = Math.min(minY, p.y - p.h / 2);
    maxY = Math.max(maxY, p.y + p.h / 2);
  }
  if (opts.center !== false && placed.length > 0) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    for (const p of placed) {
      p.x -= cx;
      p.y -= cy;
    }
    const blockW = maxX - minX;
    const blockH = maxY - minY;
    if (blockW > plateW + 1e-6 || blockH > plateD + 1e-6) {
      warnings.push(
        `arranged block ${blockW.toFixed(0)}×${blockH.toFixed(0)} mm exceeds plate ` +
          `${plateW}×${plateD} mm — scale pieces down or reduce the gap`,
      );
    }
  }

  // 5. Materializa: aplica translate absoluto (Z=0 já garantido pelo normalize)
  const objects = new Map();
  for (const item of placed) {
    const moved = translateMesh(item.mesh, item.x, item.y, 0);
    objects.set(item.name, moved);
  }
  // Objetos que não couberam (overlap) também entram
  for (const item of placed) {
    if (!objects.has(item.name)) {
      objects.set(item.name, item.mesh);
    }
  }

  return {
    objects,
    placed: placed.map((p) => ({ name: p.name, x: p.x, y: p.y, w: p.w, h: p.h })),
    warnings,
  };
}

/** CenterOnPlate: centro XY -> origem, minZ -> 0 (mesmo math do applyTransform). */
function applyCenterOnPlate(mesh) {
  const bb = computeBoundingBox(mesh);
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  return translateMesh(mesh, -cx, -cy, -bb.min.z);
}

/**
 * Testável sem bundle: recebe um Map e devolve um Map.
 * @returns {Map<string, object>}
 */
export function arrangeMap(objectsMap, opts = {}) {
  return arrangeObjects(objectsMap, opts).objects;
}
