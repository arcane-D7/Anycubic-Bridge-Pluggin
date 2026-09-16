/**
 * presets-tools.mjs — MCP tools for the custom process-preset catalog.
 *
 * The catalog lives in presets/catalog.json (agnostic, commit-safe): each
 * preset carries the exact role mapping, flush matrix/vector, filament pair,
 * behavior summary and a dated test_history. These tools make the catalog
 * available through the MCP — the slicer_multimaterial tool accepts a
 * `preset` param resolved from it, so the proven CLI slice path is reused
 * (never duplicated).
 *
 *   marble_presets_list  (read)  list catalog presets: behavior + test history
 *
 * Edit presets/catalog.json to add variants (e.g. beige-exterior marble-core);
 * they become immediately available to slicer_multimaterial preset="...".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = path.join(root, "presets", "catalog.json");

/** Load the catalog object (agnostic). */
export function loadCatalog() {
  if (!existsSync(CATALOG_PATH)) {
    return { ok: false, error: `catalog not found at ${CATALOG_PATH}` };
  }
  try {
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
    return { ok: true, catalog };
  } catch (error) {
    return { ok: false, error: `catalog unreadable: ${error.message}` };
  }
}

/** Resolve a preset by id, name or alias (case-insensitive substring on alias). */
export function findPreset(catalog, idOrAlias) {
  const q = String(idOrAlias ?? "").trim().toLowerCase();
  if (!q) return null;
  return (
    catalog.presets.find((p) => p.id.toLowerCase() === q) ??
    catalog.presets.find((p) => p.name.toLowerCase() === q) ??
    catalog.presets.find((p) => (p.alias ?? []).some((a) => a.toLowerCase() === q)) ??
    catalog.presets.find((p) => (p.alias ?? []).some((a) => q.includes(a.toLowerCase()))) ??
    null
  );
}

export function registerPresetTools(server, z) {
  const out = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  });
  const fail = (error) => ({
    isError: true,
    content: [{ type: "text", text: error.message }],
  });

  // ---- marble_presets_list --------------------------------------------------
  server.registerTool(
    "marble_presets_list",
    {
      title: "List custom marble/2-color process presets (catalog)",
      description:
        "Read-only. Lists the process presets in presets/catalog.json — each with its role mapping, flush matrix/vector, filaments, behavior summary, and dated test history (v1/v3/v4 …). Use before choosing which preset to slice with (pass its id as slicer_multimaterial preset=). Never modifies anything.",
      inputSchema: {
        id: z.string().max(120).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const { ok, catalog, error } = loadCatalog();
      if (!ok) return fail(new Error(error));
      if (id) {
        const p = findPreset(catalog, id);
        if (!p)
          return out({
            ok: false,
            found: false,
            id,
            available: catalog.presets.map((x) => x.id),
          });
        return out({ ok: true, found: true, preset: p, nozzle_note: catalog.nozzle_note });
      }
      return out({
        ok: true,
        count: catalog.presets.length,
        nozzle_note: catalog.nozzle_note,
        defaults: catalog.defaults,
        presets: catalog.presets.map((p) => ({
          id: p.id,
          name: p.name,
          aliases: p.alias ?? [],
          base: p.base,
          filaments: p.filaments,
          behavior: p.behavior,
          test_history: p.test_history,
        })),
      });
    },
  );
}
