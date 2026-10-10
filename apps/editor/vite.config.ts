import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri dev server: STRICT fixed port 1420 (tauri.conf.json devUrl) and
// sourcemap-free — the shell is loaded through Tauri's WebView2, not displayed
// in a browser. clearScreen:false keeps the Tauri overlay readable.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // S9.5-003 (G43): expose ONLY the printer-IP env var to the editor shell
  // (printer discovery never hardcodes device identifiers). Deliberately NOT
  // a blanket ANYCUBIC_ prefix — tokens/access codes stay server-side.
  // S9.13-002: the CLOUD lane is also loopback-only — we expose the bridge
  // URL + region (no token ever leaves the MCP child).
  // S9.18-001: the broker lane env is loopback-only too — expose exactly
  // ANYCUBIC_BROKER_URL (the status/chunk protocol is public-safe), never
  // ANYCUBIC_MODEL_* secrets (those stay in the Rust broker process).
  envPrefix: [
    "VITE_",
    "ANYCUBIC_PRINTER_IPS",
    "ANYCUBIC_CLOUD_LOOPBACK_URL",
    "ANYCUBIC_CLOUD_REGION",
    "ANYCUBIC_BROKER_URL",
  ],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
