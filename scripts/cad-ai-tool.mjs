/**
 * cad-ai-tool.mjs — MCP tool for AI text-to-CAD (S3-003).
 *
 * cad_generate_from_prompt: natural-language prompt → parametric script
 * (S3-001) → validated (S3-002) → executed on the manifold engine (S2-001) →
 * materialized in the workspace → optional STL/STEP payloads.
 * dry_run:true returns the script only — no provider call, no execution,
 * no secrets touched.
 */
import { translatePromptToScript, readProviderConfig } from "./cad-ai-translator.mjs";
import { validateParametricScript } from "./cad-script-validator.mjs";
import { runParametric } from "./cad-parametric-tool.mjs";
import { redact } from "./cloud-readonly-diagnostics.mjs";

/**
 * Full AI generation pipeline.
 * @param {{prompt:string, params?:object, dry_run?:boolean, object_name?:string,
 *          export_format?:string, url?:string, token?:string, provider?:object}} args
 */
export async function runPromptToCad(args) {
  const {
    prompt,
    params = {},
    dry_run = false,
    object_name = "ai_result",
    export_format = "none",
    url,
    token,
    provider,
  } = args;

  if (dry_run) {
    const translated = await translatePromptToScript({ prompt, params, dryRun: true, provider });
    const check = validateParametricScript(translated.script);
    return {
      ok: true,
      dry_run: true,
      model: translated.model,
      script: translated.script,
      script_valid: check.ok,
      script_error: check.ok ? null : check.error,
    };
  }

  const translated = await translatePromptToScript({ prompt, params, provider });
  const result = await runParametric({
    script: translated.script,
    params,
    export_format,
    object_name,
    url,
    token,
  });
  return {
    ...result,
    model: translated.model,
    prompt,
    script: translated.script,
    usage: translated.usage,
  };
}

export function registerCadAiTool(server, z) {
  server.registerTool(
    "cad_generate_from_prompt",
    {
      title: "Generate a CAD model from a natural-language prompt (AI)",
      description:
        "Translates a natural-language request into a parametric script (manifold declarative API), executes it, and materializes the mesh into the CAD workspace. Requires url+token from cad_open_workspace. Configuration via env vars only (CAD_AI_API_KEY / CAD_AI_BASE_URL / CAD_AI_MODEL); secrets never come from tool input. Use dry_run:true to preview the generated script without calling the provider or executing it. export_format 'stl' returns the STL base64; 'step' additionally requests STEP (falls back to STL when OCCT is unavailable).",
      inputSchema: {
        url: z.string().optional(),
        token: z.string().optional(),
        prompt: z.string().min(1),
        params: z.record(z.unknown()).optional(),
        dry_run: z.boolean().default(false),
        object_name: z.string().min(1).default("ai_result"),
        export_format: z.enum(["none", "stl", "step"]).default("none"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const result = await runPromptToCad(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        return {
          isError: true,
          content: [{ type: "text", text: message }],
          structuredContent: { ok: false, error: message },
        };
      }
    },
  );
}

export default registerCadAiTool;
