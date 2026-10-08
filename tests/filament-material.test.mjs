import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("procedural texture cache releases a class after its last material is disposed", async () => {
  const priorDocument = globalThis.document;
  let materialApi;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData(width, height) {
              return { data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData() {},
          };
        },
      };
    },
  };
  try {
    const moduleUrl = pathToFileURL(
      path.join(ROOT, "apps/editor/src/viewport/filament-material.ts"),
    );
    materialApi = await import(`${moduleUrl.href}?key=${Date.now()}`);
    materialApi?.disposeFilamentTextures();
    const first = materialApi.filamentMaterial("#4fa8dc", "matte");
    const second = materialApi.filamentMaterial("#00aa55", "matte");
    assert.equal(materialApi.filamentTextureCacheSize(), 1);
    first.dispose();
    assert.equal(materialApi.filamentTextureCacheSize(), 1);
    second.dispose();
    assert.equal(materialApi.filamentTextureCacheSize(), 0);
  } finally {
    materialApi.disposeFilamentTextures();
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }
});
