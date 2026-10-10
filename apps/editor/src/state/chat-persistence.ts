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
 * S9.17-004 NAV-05 — conversations are persisted keyed by PROJECT scope in
 * the plain-browser fallback: workspace-global conversations (projectId
 * null, including all LEGACY unscoped conversations) keep the original
 * `anycubic:chat-store:v1` key; project conversations live under
 * `anycubic:chat-store:project:<projectId>`. reads merge ALL buckets so no
 * scope's history is ever dropped on hydrate. The Tauri lane stays flat by
 * id (the broker FS has no scope setter yet — files carry `projectId` in
 * their JSON payload; scoped listing there is a reported backend TODO, not
 * a frontend change).
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
/** Project-bucket prefix: `anycubic:chat-store:project:<projectId>`. */
const PROJECT_BUCKET_PREFIX = "anycubic:chat-store:project:";

/** Scope bucket key for a conversation (null/undefined → legacy workspace key). */
export function chatBucketKeyFor(projectId: string | null): string {
  return projectId == null ? STORAGE_KEY : `${PROJECT_BUCKET_PREFIX}${projectId}`;
}

/** Minimal Storage shape (injectable for headless tests). */
export interface ChatStoreStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

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

/**
 * Plain-browser fallback backed by localStorage (never machine paths).
 * S9.17-004 — conversations are bucketed by project scope:
 *   - projectId null (incl. all legacy unscoped conversations) → legacy
 *     `anycubic:chat-store:v1` key (never renamed or dropped);
 *   - projectId string → `anycubic:chat-store:project:<projectId>`.
 * `read()` merges every bucket so hydrate never loses a scope's history.
 * Storage is injectable so headless tests can round-trip the exact contract.
 */
class LocalFallback implements ChatPersistence {
  readonly available = true;
  // Explicit field + constructor assignment (Node 24 type-strip rejects TS
  // "parameter properties", which this module must avoid to stay importable
  // from the headless .mjs unit tests).
  private readonly storage: ChatStoreStorage;
  constructor(storage?: ChatStoreStorage) {
    this.storage =
      storage ??
      (() => {
        if (typeof localStorage === "undefined") {
          throw new Error("localStorage unavailable — pass a ChatStoreStorage");
        }
        return localStorage;
      })();
  }

  private readBucket(key: string): Record<string, Conversation> {
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return Object.create(null) as Record<string, Conversation>;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Object.create(null) as Record<string, Conversation>;
      }
      // null-prototype map + own-property schema filter: a hostile
      // `"__proto__"`/`"constructor"` key in the JSON becomes an inert own
      // data property (never the [[Set]]/prototype-pollution path of
      // Object.assign) and non-object values (garbage) are dropped.
      const out = Object.create(null) as Record<string, Conversation>;
      for (const id of Object.keys(parsed)) {
        const value = (parsed as Record<string, unknown>)[id];
        if (value !== null && typeof value === "object") out[id] = value as Conversation;
      }
      return out;
    } catch {
      return Object.create(null) as Record<string, Conversation>;
    }
  }
  private read(): Record<string, Conversation> {
    // merge onto a null-prototype map with direct own-key writes (equivalent
    // to `{...a, ...b}` — safe CreateDataProperty semantics for hostile keys)
    const merged = this.readBucket(STORAGE_KEY);
    const keys: string[] = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      if (key !== null && key.startsWith(PROJECT_BUCKET_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const bucket = this.readBucket(key);
      for (const id of Object.keys(bucket)) {
        const value = bucket[id];
        if (value !== undefined) merged[id] = value;
      }
    }
    return merged;
  }
  private writeBucket(key: string, map: Record<string, Conversation>): void {
    this.storage.setItem(key, JSON.stringify(map));
  }
  async dir(): Promise<string | null> {
    return null; // fallback has no resolved fs dir
  }
  async list(): Promise<string[]> {
    try {
      return Object.keys(this.read());
    } catch {
      return [];
    }
  }
  async get(id: string): Promise<Conversation | null> {
    return this.read()[id] ?? null;
  }
  async put(id: string, convo: Conversation): Promise<void> {
    const key = chatBucketKeyFor(convo.projectId ?? null);
    const map = this.readBucket(key);
    map[id] = convo;
    this.writeBucket(key, map);
  }
  async delete(id: string): Promise<void> {
    const merged = this.read();
    if (!Object.hasOwn(merged, id)) return;
    const bucket = chatBucketKeyFor(merged[id]!.projectId ?? null);
    const map = this.readBucket(bucket);
    const wasActive = Object.hasOwn(map, id);
    delete map[id];
    if (wasActive) {
      if (Object.keys(map).length === 0 && bucket !== STORAGE_KEY) {
        this.storage.removeItem(bucket); // drop empty project buckets
      } else {
        this.writeBucket(bucket, map);
      }
    }
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

export function resolvePersistence(storage?: ChatStoreStorage): ChatPersistence {
  if (typeof window === "undefined") return new Unavailable();
  if (isTauri()) return new TauriPersistence();
  return storage !== undefined ? new LocalFallback(storage) : new LocalFallback();
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
