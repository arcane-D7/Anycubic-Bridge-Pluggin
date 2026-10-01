import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bindSystemThemeListener } from "./state/theme";
// Tailwind v4 + design tokens first (Sprint 9.1); legacy styles.css then
// adds its class rules on top. CSS cascade order is import order, so legacy
// beats tailwind utilities only where both define the same property.
import "./index.css";
import "./styles.css";

// Keep `system` theme in sync with OS preference changes (S9.1-002).
bindSystemThemeListener();

// S9.2-006 — silence the R3F-internal `THREE.Clock` deprecation warning.
// @react-three/fiber 9.8.1 (current latest) instantiates `new THREE.Clock()`
// unconditionally in its root store (dist chunk line ~1054); three r183+
// warns "Clock: This module has been deprecated. Please use THREE.Timer".
// There is no R3F config to opt into `THREE.Timer` on 9.8.x — the warning is
// emitted by the DEPENDENCY, not by our code (we have zero `Clock` refs).
// We only filter that exact deprecation notice in DEV so the console stays
// actionable for OUR warnings; runtime behavior is untouched.
if (import.meta.env.DEV) {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && first.includes("Clock: This module has been deprecated")) {
      return;
    }
    originalWarn(...args);
  };
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
