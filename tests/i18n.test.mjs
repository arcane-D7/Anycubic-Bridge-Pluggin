import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.8-005 (G38) — i18n PT/EN: pure core behavior (`state/i18n-core.ts`)
 * under Node 24. Covers:
 * - `defaultLocale()`/`isLocale` (system locale detection, navigator guard)
 * - EN ↔ PT-BR key-set parity (every key translated, none missing)
 * - `interpolate` {token} substitution (with/without params, unknown keep)
 * - plurals helpers (`pluralTail`, `pluralObjects`)
 * - `STRINGS` locale map completeness + non-empty EN/PT values
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "i18n-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();

test("defaultLocale: PT-BR for pt navigator, EN otherwise (and Node-safe default)", async () => {
  const { defaultLocale } = await corePromise;
  // Node has no navigator → EN default.
  assert.equal(defaultLocale(), "en");
});

test("defaultLocale: detects pt navigator.language (PT-BR)", async () => {
  const { defaultLocale } = await corePromise;
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
  const saved = globalThis.navigator;
  const stubNavigator = (language) => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { language },
    });
  };
  try {
    stubNavigator("pt-PT");
    assert.equal(defaultLocale(), "pt-BR");
    stubNavigator("pt-BR");
    assert.equal(defaultLocale(), "pt-BR");
    stubNavigator("en-US");
    assert.equal(defaultLocale(), "en");
    stubNavigator("de-DE");
    assert.equal(defaultLocale(), "en");
  } finally {
    if (hadNavigator) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: saved });
    } else {
      delete globalThis.navigator;
    }
  }
});

test("isLocale: only en / pt-BR", async () => {
  const { isLocale } = await corePromise;
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("pt-BR"), true);
  assert.equal(isLocale("fr"), false);
  assert.equal(isLocale("pt"), false);
  assert.equal(isLocale(null), false);
  assert.equal(isLocale(undefined), false);
});

test("EN ↔ PT-BR full key-set parity (systematically)", async () => {
  const { EN, PT_BR, STRINGS, localeKeysMatch } = await corePromise;
  assert.ok(localeKeysMatch(EN, PT_BR), "EN and PT-BR must expose the same keys");
  const enKeys = Object.keys(EN);
  const ptKeys = new Set(Object.keys(PT_BR));
  const missingInPt = enKeys.filter((k) => !ptKeys.has(k));
  const extraInPt = Object.keys(PT_BR).filter((k) => !(k in EN));
  assert.deepEqual(missingInPt, [], `PT missing keys: ${missingInPt.join(", ")}`);
  assert.deepEqual(extraInPt, [], `PT extra keys: ${extraInPt.join(", ")}`);
  // The map must expose both tables under the Locale union.
  assert.equal(STRINGS.en, EN);
  assert.equal(STRINGS["pt-BR"], PT_BR);
});

test("every string is non-empty in both locales", async () => {
  const { EN, PT_BR } = await corePromise;
  const emptyEn = Object.entries(EN)
    .filter(([, v]) => v === "")
    .map(([k]) => k);
  // common.empty is deliberately an empty sentinel; everything else must be
  // populated.
  const badEn = emptyEn.filter((k) => k !== "common.empty");
  assert.deepEqual(badEn, [], `EN empty strings: ${badEn.join(", ")}`);
  const emptyPt = Object.entries(PT_BR)
    .filter(([, v]) => v === "")
    .map(([k]) => k);
  const badPt = emptyPt.filter((k) => k !== "common.empty");
  assert.deepEqual(badPt, [], `PT empty strings: ${badPt.join(", ")}`);
});

test("interpolate: {token} substitution with params", async () => {
  const { interpolate } = await corePromise;
  assert.equal(interpolate("Hello {name}", { name: "World" }), "Hello World");
  assert.equal(interpolate("{a}-{b}", { a: "1", b: "2" }), "1-2");
  assert.equal(interpolate("{n} layer{s}", { n: "2", s: "s" }), "2 layers");
  assert.equal(interpolate("{n} layer{s}", { n: "1", s: "" }), "1 layer");
});

test("interpolate: no params → template unchanged; unknown token kept", async () => {
  const { interpolate } = await corePromise;
  assert.equal(interpolate("plain text"), "plain text");
  assert.equal(interpolate("{a} {b}", { a: "x" }), "x {b}");
});

test("plural helpers: EN/PT object(s) forms", async () => {
  const { pluralTail, pluralObjects } = await corePromise;
  assert.equal(pluralTail("en", 1), "");
  assert.equal(pluralTail("en", 3), "s");
  assert.equal(pluralTail("pt-BR", 1), "o");
  assert.equal(pluralTail("pt-BR", 3), "os");
  assert.equal(pluralObjects("en", 1), "object");
  assert.equal(pluralObjects("en", 3), "objects");
  assert.equal(pluralObjects("pt-BR", 1), "objeto");
  assert.equal(pluralObjects("pt-BR", 3), "objetos");
});

test("sample translations landed in both locales (spot-check)", async () => {
  const { STRINGS } = await corePromise;
  assert.equal(STRINGS.en["status.objects"], "{n} object{s}");
  assert.equal(STRINGS["pt-BR"]["status.objects"], "{n} objeto{s}");
  assert.equal(STRINGS["pt-BR"]["app.tab.prepare"], "Preparar");
  assert.equal(STRINGS.en["app.tab.prepare"], "Prepare");
  assert.equal(STRINGS["pt-BR"]["measure.clear"], "limpar");
  assert.equal(STRINGS.en["measure.clear"], "clear");
  // S9.12-002 — DevTools keys landed in both locales.
  assert.equal(STRINGS.en["devtools.rawConfirmWord"], "Type EXECUTE to enable send");
  assert.equal(STRINGS["pt-BR"]["devtools.rawConfirmWord"], "Escreva EXECUTE para ativar o envio");
  assert.equal(
    STRINGS.en["devtools.rawBlockedAgent"],
    "Raw hidden commands are blocked for the Agent by policy.",
  );
  assert.equal(
    STRINGS["pt-BR"]["devtools.rawBlockedAgent"],
    "Comandos ocultos brutos estão bloqueados para o Agente por política.",
  );
  assert.equal(STRINGS.en["device.tab.devtools"], "DevTools");
});
