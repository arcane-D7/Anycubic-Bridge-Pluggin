import {
  hydrateFromPersisted,
  type ChatConversationsState,
  type Conversation,
} from "./chat-conversations-core";
import { useChatConversations } from "./chat-conversations";
import {
  createDebouncedChatWriter,
  resolvePersistence,
  type ChatPersistence,
} from "./chat-persistence";

/**
 * S9.6-007 — pod wiring: keeps the chat store in sync with the broker
 * chat-store lane.
 *
 * - On boot (`initChatPersistence`), hydrate the store from the backend
 *   (all persisted conversations; if none exist → keep the default state).
 * - Every store mutation that changes a conversation schedules that id on a
 *   500ms debounced writer (atomic JSON write + NDJSON delta via the Rust
 *   lane or the localStorage fallback).
 * - `flushChatPersistenceNow()` flushes everything synchronously (used on
 *   close / before app teardown).
 *
 * The hydrate logic itself lives in the pure core (`hydrateFromPersisted`);
 * this module only wires store + persistence together.
 */

let pod: ChatPersistencePod | null = null;

export interface ChatPersistencePod {
  readonly persistence: ChatPersistence;
  readonly flushNow: () => Promise<void>;
  readonly hydrate: () => Promise<void>;
  /** Schedule a conversation for persistence (debounced). */
  readonly touch: (id: string) => void;
}

/**
 * Wire a pod against an existing store (injectable for tests). The pod does
 * NOT subscribe — it only snapshots at flush time, so callers decide when to
 * `touch`. `hydrate()` replaces the store state from the backend.
 */
export function createChatPersistencePod(): ChatPersistencePod {
  const persistence = resolvePersistence();
  const snap = (): ChatConversationsState =>
    useChatConversations.getState() as ChatConversationsState;
  const writer = createDebouncedChatWriter(persistence, snap);

  return {
    persistence,
    flushNow: () => writer.flushNow(),
    hydrate: async () => {
      try {
        const ids = await persistence.list();
        const persisted: Conversation[] = [];
        for (const id of ids) {
          const c = await persistence.get(id);
          if (c) persisted.push(c);
        }
        const { state, restored } = hydrateFromPersisted(persisted);
        if (restored) {
          useChatConversations.getState().hydrate(state);
        }
      } catch (e) {
        // persistence failure is non-fatal — keep the in-memory default
        console.warn("[chat-persistence] hydrate failed", e);
      }
    },
    touch: (id) => writer.schedule(id),
  };
}

/** Boot the singleton pod (idempotent) and return it. */
export function initChatPersistence(): ChatPersistencePod {
  if (pod === null) pod = createChatPersistencePod();
  return pod;
}

/** Flush everything (used on beforeunload / visibilitychange hidden). */
export async function flushChatPersistenceNow(): Promise<void> {
  if (pod !== null) await pod.flushNow();
}
