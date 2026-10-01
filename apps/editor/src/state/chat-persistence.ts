import type { ChatConversationsState, Conversation } from "./chat-conversations-core";

/**
 * S9.6-007 — Chat-store persistence adapter (browser side).
 *
 * The Rust broker owns the filesystem lane:
 *   - `<ANYCUBIC_CHAT_DIR|APPDATA/anycubic-bridge/chat>/<id>.json`  (snapshot)
 *   - `<same>/<id>.ndjson`                                          (delta journal)
 *   - atomic writes (temp-file + rename), corruption-safe reads
 *     (snapshot → journal replay fallback), env-resolved path.
 *
 * This module lives in the webview and talks to that lane through the Tauri
 * command surface (`invoke("chat_store_*")`). When Tauri is NOT available
 * (plain browser dev), the adapter degrades to an in-memory map + a
 * `localStorage`-backed fallback (same contract, no machine paths) so the
 * store round-trips even without the shell; all exported functions keep the
 * exact same signature either way (no UI drift).
 */

export interface ChatPersistence {
  readonly available: boolean;
  /** Resolve dir (or null when the bridge is not available). */
  readonly dir: () => Promise<string | null>;
  readonly list: () => Promise<string[]>;
  readonly get: (id: string) => Promise<Conversation | null>;
  readonly put: (id: string, convo: Conversation) => Promise<void>;
  readonly delete: (id: string) => Promise<void>;
}

const STORAGE_KEY = "anycubic:chat-store:v1";

/** True when running inside the Tauri webview. */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Minimal `@tauri-apps/api/core.invoke` shape (no static import — the
 *  package exists in the shell bundle but we keep the adapter dependency-free
 *  for unit tests). */
async function tauriInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  // @tauri-apps/api is a real dep (apps/editor/package.json). Dynamic import
  // keeps this module importable from root unit tests (which never resolve
  // the browser bundle).
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

/** Plain-browser fallback backed by localStorage (never machine paths). */
class LocalFallback implements ChatPersistence {
  readonly available = true;
  private read(): Record<string, Conversation> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as Record<string, Conversation>;
    } catch {
      return {};
    }
  }
  private write(map: Record<string, Conversation>): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  }
  async dir(): Promise<string | null> {
    return null; // fallback has no resolved fs dir
  }
  async list(): Promise<string[]> {
    return Object.keys(this.read());
  }
  async get(id: string): Promise<Conversation | null> {
    return this.read()[id] ?? null;
  }
  async put(id: string, convo: Conversation): Promise<void> {
    const map = this.read();
    map[id] = convo;
    this.write(map);
  }
  async delete(id: string): Promise<void> {
    const map = this.read();
    delete map[id];
    this.write(map);
  }
}

/** Tauri-backed persistence over the broker chat-store lane. */
class TauriPersistence implements ChatPersistence {
  readonly available = true;
  async dir(): Promise<string | null> {
    return (await tauriInvoke("chat_store_dir", {})) as string;
  }
  async list(): Promise<string[]> {
    return (await tauriInvoke("chat_store_list", {})) as string[];
  }
  async get(id: string): Promise<Conversation | null> {
    const v = (await tauriInvoke("chat_store_get", { id })) as unknown;
    return (v as Conversation | null) ?? null;
  }
  async put(id: string, convo: Conversation): Promise<void> {
    await tauriInvoke("chat_store_put", { id, value: convo });
  }
  async delete(id: string): Promise<void> {
    await tauriInvoke("chat_store_delete", { id });
  }
}

class Unavailable implements ChatPersistence {
  readonly available = false;
  async dir(): Promise<string | null> {
    return null;
  }
  async list(): Promise<string[]> {
    return [];
  }
  async get(): Promise<Conversation | null> {
    return null;
  }
  async put(): Promise<void> {}
  async delete(): Promise<void> {}
}

export function resolvePersistence(): ChatPersistence {
  if (typeof window === "undefined") return new Unavailable();
  if (isTauri()) return new TauriPersistence();
  return new LocalFallback();
}

/**
 * Debounced writer bound to a single persistence backend + store snapshot
 * function. `schedule(id)` records the conversation as dirty and flushes the
 * FULL state after `debounceMs` of quiet; `flushNow()` flushes immediately
 * (used on close). Multiple ids are batched into one `put` per id in the same
 * flush cycle.
 */
export interface DebouncedChatWriter {
  readonly schedule: (id: string) => void;
  readonly flushNow: () => Promise<void>;
}

export function createDebouncedChatWriter(
  persistence: ChatPersistence,
  snap: () => ChatConversationsState,
  debounceMs = 500,
): DebouncedChatWriter {
  let dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const ids = [...dirty];
    dirty = new Set();
    const state = snap();
    if (ids.length === 0) return;
    await Promise.all(
      ids.map((id) => {
        const convo = state.conversations[id];
        return convo ? persistence.put(id, convo) : Promise.resolve();
      }),
    );
  };

  return {
    schedule: (id) => {
      dirty.add(id);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        void flush();
      }, debounceMs);
    },
    flushNow: flush,
  };
}
