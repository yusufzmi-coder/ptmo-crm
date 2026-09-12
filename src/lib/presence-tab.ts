// ============================================================
// Per-tab identity for the presence heartbeat (migration 045).
//
// Why this exists
// ---------------
// Migration 024 keyed `member_presence` on `user_id` alone: one row per
// person, reused forever. PresenceHeartbeat mounts in the dashboard
// shell, so EVERY dashboard tab beat into that one row — writing its own
// `status` and (after 041) its own `viewing_conversation_id`.
//
// The common shape, not a dark corner:
//
//   Tab 1  Inbox, thread X open, focused  -> ('online', X)
//   Tab 2  /dashboard, hidden             -> ('away',   NULL)
//
// Those alternate every ~30s. `coViewers()` requires 'online' AND a
// matching conversation pointer, so roughly half the time the agent
// reading thread X was invisible to everyone else — and the "someone
// else is in here" guard that migration 041 exists for silently did
// nothing. Deep-linking (`/inbox?c=<id>`) actively encourages the second
// tab that breaks it.
//
// A tab is the thing that has a conversation open, so a tab is what the
// row must describe.
// ============================================================

const STORAGE_KEY = "wacrm:presence:tab-id";

// Fallback when sessionStorage is unavailable (private mode, sandboxed
// iframe, storage disabled). Module scope is per-document, so this is
// still per-tab — it just doesn't survive a reload, which costs nothing
// beyond one extra row that the pruner reclaims.
let memoryId: string | null = null;

function mint(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A stable id for THIS browser tab.
 *
 * `sessionStorage` rather than `localStorage`: localStorage is shared by
 * every tab on the origin, which would reproduce exactly the collision
 * this is meant to fix. sessionStorage is per-tab and survives a reload,
 * so an agent refreshing the inbox keeps one row instead of orphaning
 * one on every F5.
 *
 * Known limitation: duplicating a tab copies its sessionStorage, so the
 * copy starts out sharing an id until one of them is reloaded. Two tabs
 * briefly sharing a row is the pre-045 behaviour — degraded, not broken
 * — and it resolves itself. Worth knowing before chasing it as a bug.
 */
export function getTabId(): string {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = mint();
    sessionStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    if (memoryId === null) memoryId = mint();
    return memoryId;
  }
}
