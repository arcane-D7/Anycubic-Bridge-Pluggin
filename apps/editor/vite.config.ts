import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri dev server: STRICT fixed port 1420 (tauri.conf.json devUrl) and
// sourcemap-free — the shell is loaded through Tauri's WebView2, not displayed
// in a browser. clearScreen:false keeps the Tauri overlay readable.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
