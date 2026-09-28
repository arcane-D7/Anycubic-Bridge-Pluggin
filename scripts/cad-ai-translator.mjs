/**
 * cad-ai-translator.mjs — prompt→parametric-script translation (S3-001).
 *
 * Turns a natural-language CAD description into a script conforming to the
 * engine's declarative API (S2-001) by calling a configurable OpenAI-compatible
 * chat-completions provider. Secrets come ONLY from env vars:
 *   CAD_AI_API_KEY   (required for real calls)
 *   CAD_AI_BASE_URL  (default https://api.openai.com/v1)
 *   CAD_AI_MODEL     (default gpt-4o-mini)
 * Pure module — no bundle dependency, unit-testable (mock fetch / dryRun).
 */

import { validateParametricScript, dryRunParseScript } from "./cad-script-validator.mjs";

/** Engine API contract embedded into the system prompt (S2-001 surface). */
export const ENGINE_CONTRACT = `
Available functions (engine declarative API):
  box(w, h, d)                 — axis-aligned box, centered, mm
  cylinder(r, h, segments?)    — cylinder centered on Y, mm
  sphere(r, segments?)         — sphere centered, mm
  cone(rBottom, rTop, h, segments?) — rTop=0 gives a point
  tetrahedron(edge)            — regular tetrahedron
  add(a, b)                    — boolean union
  subtract(a, b)               — a minus b
  intersect(a, b)              — boolean intersection
  translate(handle, {x, y, z}) — move by mm
  rotate(handle, rx, ry, rz)   — radians
  scale(handle, {x, y, z})     — factor
  mirror(handle, {x, y, z})    — mirror plane normal
Rules:
  - Use ONLY the functions above plus plain JS (let/const, for, if, Math).
  - You MUST end with a top-level 'return <expression>' producing one handle.
  - All dimensions in millimeters. Never mutate an existing handle.
  - No process/require/import/fetch/eval. No comments about tools.
`.trim();

/** Reads provider configuration from the environment (never tool input). */
export function readProviderConfig(env = process.env) {
  return {
    apiKey: env.CAD_AI_API_KEY ?? "",
    baseUrl: (env.CAD_AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: env.CAD_AI_MODEL ?? "gpt-4o-mini",
  };
}

/** Extracts the code block (or last fenced ```js block) from an LLM reply. */
export function extractScript(reply) {
  if (typeof reply !== "string") return "";
  const fence = /```(?:js|javascript)?\s*([\s\S]*?)```/g;
  const matches = [...reply.matchAll(fence)];
  let script = (matches.length ? matches[matches.length - 1][1] : reply).trim();
  // If the body already contains a `return` statement somewhere, treat it as a
  // full multi-line body (handles `let x = ...; return x;`). Otherwise wrap the
  // single expression in `return <expr>`.
  const hasReturn = /\breturn\b/.test(script);
  if (!hasReturn) {
    script = `return\n${script}`;
  }
  return script;
}

const SYSTEM_PROMPT = `You translate natural-language 3D modeling requests into a parametric script.

${ENGINE_CONTRACT}

Reply with ONLY the JavaScript code inside a single fenced code block. No prose.`;

function buildUserPrompt(prompt, params = {}) {
  const extra = Object.entries(params ?? {})
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join("; ");
  return [
    `Request: ${prompt}`,
    extra ? `Parameters: ${extra}` : "",
    "Produce the script per the system rules.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Calls the configured provider. Exposed for tests (mocked fetch).
 * @returns {Promise<{script:string}>}
 */
export async function callProvider({ prompt, params = {}, provider, timeoutMs = 30_000 }) {
  const cfg = provider ?? readProviderConfig();
  if (!cfg.apiKey) {
    throw new Error(
      "AI provider not configured — set CAD_AI_API_KEY (and optionally CAD_AI_BASE_URL, CAD_AI_MODEL)",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(prompt, params) },
        ],
        temperature: 0.2,
        max_tokens: 800,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`AI provider HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const script = extractScript(data?.choices?.[0]?.message?.content ?? "");
    if (!script.trim()) throw new Error("AI provider returned an empty script");
    const tokens = {
      input: data?.usage?.prompt_tokens ?? 0,
      output: data?.usage?.completion_tokens ?? 0,
    };
    return { script, tokens };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translates a prompt to a validated parametric script.
 * @param {{prompt:string, params?:object, dryRun?:boolean, provider?:object,
 *          timeoutMs?:number}} opts
 * @returns {Promise<{script:string, model:string, usage?:object, dryRun?:boolean}>}
 */
export async function translatePromptToScript({
  prompt,
  params = {},
  dryRun = false,
  provider,
  timeoutMs,
}) {
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt is required (non-empty string)");
  }
  const cfg = provider ?? readProviderConfig();

  if (dryRun) {
    // Deterministic preview: synthesize an obviously-correct script from the
    // prompt? No — dryRun means "run the translation without calling the LLM".
    // To stay testable and honest, dryRun returns a placeholder script that
    // uses the API surface with any numeric params found in the prompt.
    const script = dryRunPlaceholderScript(prompt, params);
    return { script, model: cfg.model, dryRun: true, usage: { input: 0, output: 0 } };
  }

  const { script, tokens } = await callProvider({ prompt, params, provider, timeoutMs });

  // Validate: forbidden tokens + dry parse before returning.
  const sandbox = validateParametricScript(script);
  if (!sandbox.ok) throw new Error(sandbox.error);
  const parsed = dryRunParseScript(script);
  if (!parsed.ok) throw new Error(parsed.error);

  return { script, model: cfg.model, usage: tokens };
}

/**
 * Builds a placeholder script deterministically from the prompt (dryRun).
 * Extracts numeric measurements (e.g. "4 cm" or "30 mm") when present and maps
 * to a box+hole so agents can preview the API shape.
 */
export function dryRunPlaceholderScript(prompt, params = {}) {
  const mm = (re) => {
    const m = prompt.match(re);
    return m ? Number(m[1]) * (m[2] === "cm" ? 10 : 1) : 20;
  };
  const w = params.w ?? mm(/(\d+(?:\.\d+)?)\s*(mm|cm)/i);
  const h = params.h ?? params.height ?? 24;
  const holeR = params.hole_r ?? 4;
  return [
    "// dryRun placeholder (no LLM call). Adjust per request.",
    `let base = box(${w}, ${h}, ${h});`,
    `let hole = cylinder(${holeR}, ${h * 2}, 48);`,
    `return subtract(base, hole);`,
  ].join("\n");
}

export default translatePromptToScript;
