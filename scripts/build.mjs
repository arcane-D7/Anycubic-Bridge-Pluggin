#!/usr/bin/env node
/**
 * build.mjs — reproduce `dist/server.mjs` from the versioned base bundle.
 *
 * Why this script exists (see README, "Build"):
 *   - `src/` and `tsconfig.json` do NOT exist in this repo; `pnpm run build`
 *     (tsc + esbuild) was legacy and could never rebuild the shipped server.
 *   - The CAD extension is written as standalone ESM modules in `scripts/`
 *     (cad-bool-tool, cad-parametric-tool, cad-ai-tool) and is WIRED into the
 *     bundle at the END of dist/server.mjs by appending register calls.
 *   - To make the build reproducible, the fully-wired bundle is frozen as the
 *     versioned base `vendor/server.mjs`. This script copies it to
 *     `dist/server.mjs` and guarantees the CAD wiring + handleApi cases are
 *     present (idempotent — safe to run repeatedly, also after a fresh clone).
 *
 * Health gate: `node scripts/build.mjs && node --test "tests/*.test.mjs" && node scripts/smoke.mjs`
 */
import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorBase = path.join(root, "vendor", "server.mjs");
const outFile = path.join(root, "dist", "server.mjs");

// Snippets appended at the very end of the bundle, before the transport connect.
// Must match what is already in vendor/server.mjs so re-running is a no-op.
const CAD_WIRING = `// Robust boolean CSG engine (Sprint 1): exposes cad_v2_boolean — watertight
// boolean ops via three-bvh-csg between two objects of the CAD workspace.
const { registerCadBoolTool } = await import("../scripts/cad-bool-tool.mjs");
registerCadBoolTool(server, z2);
// Parametric engine (Sprint 2): cad_generate_parametric — declarative script
// over manifold-3d (sandboxed), materialized into the CAD workspace, with
// optional STL/STEP (replicad) export payloads.
const { registerCadParametricTool } = await import("../scripts/cad-parametric-tool.mjs");
registerCadParametricTool(server, z2);
// AI text-to-cad (Sprint 3): cad_generate_from_prompt — natural-language
// prompt → parametric script (env-configured provider) → validated →
// executed on the manifold engine → materialized in the CAD workspace.
const { registerCadAiTool } = await import("../scripts/cad-ai-tool.mjs");
registerCadAiTool(server, z2);`;

// Slicer CLI control: wire the native CLI tools right after edge tools.
const SLICER_WIRING = `const { registerSlicerTools } = await import("../scripts/slicer-tools.mjs");
registerSlicerTools(server, z2);
const { registerPresetTools } = await import("../scripts/presets-tools.mjs");
registerPresetTools(server, z2);`;

// Anchor right before the transport is instantiated so wiring is stable.
const TRANSPORT_ANCHOR = "var transport = new StdioServerTransport();";

const CAD_CASES = [
  // case "ai_prompt" (Sprint 3) — declared before "parametric"
  `case "ai_prompt":`,
  // case "parametric" (Sprint 2)
  `case "parametric":`,
];

async function build() {
  await mkdir(path.dirname(outFile), { recursive: true });
  let base;
  try {
    base = await readFile(vendorBase, "utf8");
  } catch {
    throw new Error(
      `vendor base bundle not found at ${vendorBase}. Run 'pnpm install' first; the base is committed.`,
    );
  }

  let out = base;
  // 1) Ensure handleApi cases exist (ai_prompt + parametric). If the base is
  //    the frozen fully-wired bundle they already do — no mutation needed.
  for (const c of CAD_CASES) {
    if (!out.includes(c)) {
      throw new Error(
        `base bundle is missing '${c}' — update vendor/server.mjs (sprint wiring missing)`,
      );
    }
  }
  // 2) Ensure tool registrations are wired BEFORE transport connect.
  if (out.includes(TRANSPORT_ANCHOR) && !out.includes("registerCadBoolTool")) {
    out = out.replace(TRANSPORT_ANCHOR, `${CAD_WIRING}\n${TRANSPORT_ANCHOR}`);
  }
  // 2b) Ensure the slicer CLI tools wiring is present (added after edge tools).
  if (out.includes("registerEdgeTools") && !out.includes("registerSlicerTools")) {
    out = out.replace(
      /registerEdgeTools\(server, z2, \{ manager: commandManager \}\);/,
      `registerEdgeTools(server, z2, { manager: commandManager });\n${SLICER_WIRING}`,
    );
  }
  // 2c) Ensure the preset catalog wiring is present on top of existing slicer
  //     wiring (idempotent — safe when the base already has slicer tools).
  if (out.includes("registerSlicerTools") && !out.includes("registerPresetTools")) {
    out = out.replace(
      /registerSlicerTools\(server, z2\);/,
      `registerSlicerTools(server, z2);\nconst { registerPresetTools } = await import("../scripts/presets-tools.mjs");\nregisterPresetTools(server, z2);`,
    );
  }
  // 3) Copy the built file over.
  await rm(outFile, { force: true });
  await copyFile(vendorBase, outFile);
  await writeFile(outFile, out);

  // 4) Verify the result is structurally sane.
  assert.ok(out.includes("registerCadBoolTool"), "cad bool wiring missing");
  assert.ok(out.includes("registerCadParametricTool"), "cad parametric wiring missing");
  assert.ok(out.includes("registerCadAiTool"), "cad ai wiring missing");
  assert.ok(out.includes("registerSlicerTools"), "slicer CLI tools wiring missing");
  assert.ok(out.includes("registerPresetTools"), "preset catalog tools wiring missing");
  assert.ok(out.includes('case "ai_prompt":'), "ai_prompt case missing");
  assert.ok(out.includes('case "parametric":'), "parametric case missing");
  assert.ok(out.includes(TRANSPORT_ANCHOR), "transport connect anchor missing");

  const stat = await (await import("node:fs")).statSync(outFile);
  console.log(`build ok → dist/server.mjs (${stat.size} bytes)`);
}

build().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
});
