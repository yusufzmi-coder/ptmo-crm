import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The module memoises its in-memory fallback, so every case needs a
// fresh copy — hence the dynamic import after resetModules().
async function freshGetTabId() {
  vi.resetModules();
  const mod = await import("./presence-tab");
  return mod.getTabId;
}

function installStorage(): Storage {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
  vi.stubGlobal("sessionStorage", store);
  return store;
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getTabId", () => {
  it("is stable within a tab", async () => {
    const getTabId = await freshGetTabId();
    expect(getTabId()).toBe(getTabId());
  });

  it("survives a reload by persisting to sessionStorage", async () => {
    // Same storage, fresh module — i.e. the page was refreshed. An agent
    // pressing F5 must keep one row, not orphan one on every reload.
    const getTabId = await freshGetTabId();
    const first = getTabId();

    const afterReload = await freshGetTabId();
    expect(afterReload()).toBe(first);
  });

  it("gives a different id to a different tab", async () => {
    const getTabId = await freshGetTabId();
    const first = getTabId();

    // A second tab: its own sessionStorage, its own module instance.
    installStorage();
    const other = await freshGetTabId();
    expect(other()).not.toBe(first);
  });

  it("still returns a stable id when sessionStorage throws", async () => {
    // Private browsing / sandboxed iframe / storage disabled. Falling
    // back to module scope is still per-tab; it just doesn't survive a
    // reload, which costs one extra row the pruner reclaims.
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage);

    const getTabId = await freshGetTabId();
    const id = getTabId();
    expect(id).toBeTruthy();
    expect(getTabId()).toBe(id);
  });

  it("fits the column bound the RPC enforces", async () => {
    // touch_presence truncates to 64 chars (migration 045); an id longer
    // than that would silently collide with its own truncation.
    const getTabId = await freshGetTabId();
    expect(getTabId().length).toBeLessThanOrEqual(64);
  });
});
