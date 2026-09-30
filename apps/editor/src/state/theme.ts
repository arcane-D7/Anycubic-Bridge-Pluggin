import { create } from "zustand";

/**
 * Theme state (S9.1-002). `data-theme` lives on <html>; boot resolution is
 * done pre-paint by the inline script in index.html (localStorage
 * 'anycubic-theme' → system → light). This store keeps the user's explicit
 * choice and applies it — the DOM attribute is the single source of truth
 * for CSS (Tailwind `@custom-variant dark` reads [data-theme=dark]).
 */

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "anycubic-theme";

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  return choice === "system" ? (systemPrefersDark() ? "dark" : "light") : choice;
}

interface ThemeState {
  readonly choice: ThemeChoice;
  /** Currently applied attribute value on <html>. */
  readonly applied: "light" | "dark";
  readonly setChoice: (choice: ThemeChoice) => void;
}

export const useTheme = create<ThemeState>()((set) => {
  const stored = readStored();
  return {
    choice: stored,
    applied: resolveTheme(stored),
    setChoice: (choice) => {
      const applied = resolveTheme(choice);
      document.documentElement.setAttribute("data-theme", applied);
      try {
        localStorage.setItem(STORAGE_KEY, choice);
      } catch {
        /* storage unavailable — attribute still applies */
      }
      set({ choice, applied });
    },
  };
});

/** Re-evaluate `system` when the OS preference changes mid-session. */
export function bindSystemThemeListener(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    const { choice } = useTheme.getState();
    if (choice === "system") {
      const applied = resolveTheme(choice);
      document.documentElement.setAttribute("data-theme", applied);
      useTheme.setState({ applied });
    }
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
