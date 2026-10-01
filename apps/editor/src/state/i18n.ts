import { create } from "zustand";
import {
  defaultLocale,
  interpolate,
  isLocale,
  LOCALE_KEY,
  localeKeysMatch,
  STRINGS,
  type Locale,
  type MsgKey,
} from "./i18n-core";

/**
 * S9.8-005 (G38) — i18n store (browser side).
 *
 * Thin zustand wrapper over the pure `i18n-core` table. Holds the active
 * locale + a STABLE `t(key, params?)` translation function (reference never
 * changes across renders — safe to memoize / use as a hook dependency).
 *
 * The locale preference persists to `localStorage` under `anycubic:locale`
 * (per-context; never a filesystem path — AGENTS.md golden rule). Boot falls
 * back to the system locale via `defaultLocale()`.
 *
 * `t` returns the translated template with `{token}` params interpolated. For
 * plural-friendly keys the caller passes the suffix via param `s` (e.g.
 * `t("status.objects", { n: "3", s: "s" })`) or the `pluralObjects` helper.
 */

export interface I18nState {
  readonly locale: Locale;
  /** Translate a key in the current locale (stable reference per store). */
  readonly t: (key: MsgKey, params?: Readonly<Record<string, string>>) => string;
  /** Switch live (persists + re-renders via subscription). */
  readonly setLocale: (locale: Locale) => void;
}

function readRaw(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(locale: Locale): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(LOCALE_KEY, locale);
    return true;
  } catch {
    return false; // quota / private mode — session-only is fine
  }
}

function bootLocale(): Locale {
  const raw = readRaw();
  if (raw !== null && isLocale(raw)) return raw;
  const fallback = defaultLocale();
  writeRaw(fallback);
  return fallback;
}

const makeT = (locale: Locale) => (key: MsgKey, params?: Readonly<Record<string, string>>) =>
  interpolate(STRINGS[locale][key] ?? STRINGS.en[key] ?? key, params);

export const useI18n = create<I18nState>()((set, get) => {
  const locale = bootLocale();
  // EN/PT parity is enforced at import time — a drift here is a build-time
  // signal (the unit tests re-assert it on every gate).
  if (!localeKeysMatch(STRINGS.en, STRINGS["pt-BR"])) {
    console.warn("[i18n] EN/PT-BR key-set mismatch — translations out of sync");
  }
  return {
    locale,
    t: makeT(locale),
    setLocale: (next) => {
      if (next === get().locale) return;
      writeRaw(next);
      set({ locale: next, t: makeT(next) });
    },
  };
});
