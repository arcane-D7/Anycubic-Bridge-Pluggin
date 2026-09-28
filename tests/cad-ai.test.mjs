import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  translatePromptToScript,
  extractScript,
  dryRunPlaceholderScript,
  readProviderConfig,
} from "../scripts/cad-ai-translator.mjs";
import { validateParametricScript, dryRunParseScript } from "../scripts/cad-script-validator.mjs";
import { runPromptToCad } from "../scripts/cad-ai-tool.mjs";

// ---------------------------------------------------------------------------
// S3-001 translator + S3-002 validator + S3-003 tool tests
// ---------------------------------------------------------------------------

test("readProviderConfig reads env-only config with defaults", () => {
  const cfg = readProviderConfig({
    CAD_AI_API_KEY: "k",
    CAD_AI_BASE_URL: "http://x/",
    CAD_AI_MODEL: "m",
  });
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.baseUrl, "http://x");
  assert.equal(cfg.model, "m");
  const dflt = readProviderConfig({});
  assert.equal(dflt.baseUrl, "https://api.openai.com/v1");
  assert.equal(dflt.model, "gpt-4o-mini");
});

test("extractScript pulls the JS fenced block", () => {
  const reply = "Here you go:\n```js\nreturn box(10, 20, 30);\n```\nDone.";
  assert.equal(extractScript(reply).trim(), "return box(10, 20, 30);");
});

test("translatePromptToScript dryRun returns deterministic script without fetch", async () => {
  let called = false;
  mock.method(globalThis, "fetch", async () => {
    called = true;
    throw new Error("must not be called");
  });
  const out = await translatePromptToScript({
    prompt: "make a plate 40mm wide with a 4mm hole",
    params: {},
    dryRun: true,
  });
  assert.equal(out.dryRun, true);
  assert.match(out.script, /return subtract/);
  assert.equal(called, false, "fetch must not be called in dryRun");
  mock.restoreAll();
});

test("translatePromptToScript real path calls provider and validates", async () => {
  mock.method(globalThis, "fetch", async (url, opts) => {
    assert.match(String(url), /chat\/completions$/);
    const body = JSON.parse(opts.body);
    assert.ok(body.messages[0].role === "system");
    assert.match(body.messages[0].content, /box\(w, h, d\)/);
    assert.equal(opts.headers.Authorization, "Bearer secret-key");
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "```js\nreturn box(3, 4, 5);\n```" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  });
  const out = await translatePromptToScript({
    prompt: "a small cube",
    provider: { apiKey: "secret-key", baseUrl: "https://x/v1", model: "m" },
  });
  assert.match(out.script, /box\(3, 4, 5\)/);
  assert.equal(out.model, "m");
  assert.equal(out.usage.input, 10);
  mock.restoreAll();
});

test("translatePromptToScript rejects non-conforming scripts", async () => {
  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "```js\nprocess.exit(1)\n```" } }] }),
  }));
  await assert.rejects(
    () =>
      translatePromptToScript({
        prompt: "x",
        provider: { apiKey: "k", baseUrl: "https://x/v1", model: "m" },
      }),
    /sandboxed/,
  );
  mock.restoreAll();
});

test("translatePromptToScript surfaces provider errors cleanly", async () => {
  mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 401,
    text: async () => "no key",
  }));
  await assert.rejects(
    () =>
      translatePromptToScript({
        prompt: "x",
        provider: { apiKey: "", baseUrl: "https://x/v1", model: "m" },
      }),
    /not configured/,
  );
  mock.restoreAll();
});

test("validator rejects every forbidden global and accepts allowed API", () => {
  for (const bad of ["process", "require(", "import(", "fetch(", "eval(", "Function(", "Buffer"]) {
    assert.ok(!validateParametricScript(`return ${bad}x`).ok, `should reject ${bad}`);
  }
  assert.ok(validateParametricScript("return subtract(box(1,2,3), cylinder(1,2,3))").ok);
  assert.ok(!dryRunParseScript("return box(1,,").ok, "syntax error detected");
  assert.ok(dryRunParseScript("return box(1,2,3)").ok);
});

test("dryRunPlaceholderScript builds a valid watertight script", () => {
  const script = dryRunPlaceholderScript("40mm plate with 4mm hole", {});
  assert.equal(validateParametricScript(script).ok, true);
  assert.equal(dryRunParseScript(script).ok, true);
});

test("runPromptToCad dry_run returns script without provider/execution", async () => {
  let called = false;
  mock.method(globalThis, "fetch", async () => {
    called = true;
    throw new Error("must not be called");
  });
  const out = await runPromptToCad({ prompt: "a box", dry_run: true });
  assert.equal(out.ok, true);
  assert.equal(out.dry_run, true);
  assert.equal(out.script_valid, true);
  assert.equal(called, false);
  mock.restoreAll();
});

test("runPromptToCad full run executes a translated script on the engine", async () => {
  const content =
    "```js\nlet b = box(20, 24, 10); let h = cylinder(4, 40, 48); return subtract(b, h);\n```";
  mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }),
  }));
  const out = await runPromptToCad({
    prompt: "plate with a hole",
    object_name: "ai_part",
    export_format: "none",
    provider: { apiKey: "k", baseUrl: "https://x/v1", model: "m" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.object, "ai_part");
  assert.equal(out.watertight, true);
  assert.ok(out.vertices > 0);
  assert.equal(out.model, "m");
  assert.equal(out.usage.input, 2);
  mock.restoreAll();
});

test("runPromptToCad redacts provider errors (no crash)", async () => {
  mock.method(globalThis, "fetch", async () => ({
    ok: false,
    status: 500,
    text: async () => "boom",
  }));
  await assert.rejects(
    () =>
      runPromptToCad({
        prompt: "x",
        provider: { apiKey: "k", baseUrl: "https://x/v1", model: "m" },
      }),
    /HTTP 500/,
  );
  mock.restoreAll();
});
