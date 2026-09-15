/**
 * cad-script-validator.mjs — shared parametric-script sandbox validator.
 * Sprint 3 (S3-002). DRY single source for the allowed/forbidden tokens used by
 * both cad_generate_parametric (S2-003) and the AI translator (S3-001).
 *
 * Rule: parametric scripts may only use the engine's declarative API names
 * (box/cylinder/.../mirror) plus plain JS — never Node globals or I/O.
 */

/** Tokens that must never appear in a parametric script (sandbox). */
export const FORBIDDEN_TOKENS = Object.freeze([
  "process",
  "require",
  "import(",
  "import ",
  "fetch",
  "eval",
  "Function",
  "child_process",
  "module",
  "globalThis",
  "Buffer",
  "\\",
]);

/**
 * Validates a parametric script for forbidden tokens. Shared by tool + AI
 * translator.
 * @param {string} source
 * @returns {{ ok:true } | { ok:false, error:string }}
 */
export function validateParametricScript(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    return { ok: false, error: "script must be a non-empty string" };
  }
  for (const token of FORBIDDEN_TOKENS) {
    if (token === "\\") {
      if (source.includes("\\")) return { ok: false, error: "script may not contain backslashes" };
      continue;
    }
    if (source.includes(token)) {
      return { ok: false, error: `script may not contain '${token}' (sandboxed)` };
    }
  }
  return { ok: true };
}

/** Dry-run parse: catches syntax errors without executing (safe). */
export function dryRunParseScript(source) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`"use strict";\n${source}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `script syntax error: ${error?.message ?? error}` };
  }
}

export default validateParametricScript;
