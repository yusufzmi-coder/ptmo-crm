// ============================================================
// Focused-conversation store — which thread THIS tab has open.
//
// The heartbeat (PresenceHeartbeat) lives in the dashboard shell; the
// thread that knows which conversation is open (MessageThread) lives
// several levels down a different subtree. Rather than thread a prop
// through the shell — or lift the whole inbox selection into a context
// that re-renders every page on every click — the two talk through this
// tiny module-level store.
//
// Deliberately NOT React state: the value is per-tab, written by one
// component and read by one other, and a write must not re-render the
// inbox. `useSyncExternalStore` on the reader side gives React-safe
// subscription without any of that.
//
// Nothing here is trusted: the id is only a hint the client sends, and
// `touch_presence` verifies it belongs to the caller's account before
// storing it (migration 041).
// ============================================================

let focused: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Report the conversation this tab now has open.
 *
 * Returns a release function that clears the store ONLY if this call's
 * id is still the current one. That ordering matters under React's
 * double-invoked effects and during thread switches: the outgoing
 * thread's cleanup runs after the incoming thread's setup, and a naive
 * `set(null)` there would wipe the id that was just set.
 */
export function setFocusedConversation(id: string | null): () => void {
  if (focused !== id) {
    focused = id;
    emit();
  }
  return () => {
    if (focused === id) {
      focused = null;
      emit();
    }
  };
}

/** The conversation this tab has open, or null. */
export function getFocusedConversation(): string | null {
  return focused;
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeFocusedConversation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
