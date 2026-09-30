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
