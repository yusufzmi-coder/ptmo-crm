import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("redirects a signed-out user off /ops to /login", async () => {
    // /ops shipped after the protected list was written, so an
    // unauthenticated visit rendered a broken shell instead of the
    // login page. RLS kept the data safe; the redirect keeps it sane.
    mockUser = null;
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/ops/unanswered"),
    );

    expect(res.headers.get("location")).toContain("/login");
  });

  // /flows, /agents and /notifications are all pages in the (dashboard)
  // route group, but none of them was ever added to `protectedPaths`. An
  // unauthenticated visit rendered a broken shell instead of the login page.
  it.each(["/flows", "/flows/abc", "/flows/abc/runs", "/agents", "/notifications", "/calls"])(
    "redirects a signed-out user off %s to /login",
    async (path) => {
      mockUser = null;
      refreshedCookies = [ROTATED];

      const res = await middleware(new NextRequest(`https://app.test${path}`));

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
    },
  );

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — the public webhook is an allowlist, not a substring", () => {
  // Meta calls this with no session of its own: GET answers the hub
  // subscription challenge, POST carries the signed inbound payload. The
  // route verifies `verify_token` / `x-hub-signature-256` itself, so the
  // middleware must not 401 it. Breaking this silently stops every inbound
  // message.
  it("lets an unauthenticated /api/whatsapp/webhook through", async () => {
    mockUser = null;

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/webhook"),
    );

    expect(res.status).not.toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets it through with a trailing slash too", async () => {
    mockUser = null;

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/webhook/"),
    );

    expect(res.status).not.toBe(401);
  });

  // The gate used to be `!pathname.includes("/webhook")`, so ANY route with
  // a `webhook` segment anywhere in its path fell out of it on spelling
  // alone. These two are the regression this allowlist exists to prevent.
  it.each([
    "/api/whatsapp/templates/webhook",
    "/api/whatsapp/media/webhook",
    "/api/whatsapp/webhook/replay",
  ])("still requires auth for %s", async (path) => {
    mockUser = null;

    const res = await middleware(new NextRequest(`https://app.test${path}`));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("401s an unauthenticated /api/whatsapp/send and keeps rotated cookies", async () => {
    mockUser = null;
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/send"),
    );

    expect(res.status).toBe(401);
    // Same #288 guarantee as the redirect branches: a response we build
    // ourselves must still carry whatever getUser() wrote.
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("lets a signed-in user reach /api/whatsapp/send", async () => {
    mockUser = { id: "user-1" };

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/send"),
    );

    expect(res.status).not.toBe(401);
  });
});

describe("middleware — every (dashboard) segment is gated", () => {
  // The reason `protectedPaths` drifted twice is that nothing connected it
  // to the route tree: /ops was missing until someone noticed, then /flows,
  // /agents and /notifications shipped unguarded. Reviewing the array tells
  // you nothing, because the omission is the page that ISN'T named in it.
  //
  // So derive the expectation from the filesystem instead of restating the
  // list. Every top-level directory in the (dashboard) route group is a
  // page behind the app shell, and every one of them must redirect an
  // anonymous visitor. Add a page under (dashboard) without touching
  // middleware.ts and this test fails with that segment's name.
  const segments = readdirSync(
    join(import.meta.dirname, "app", "(dashboard)"),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    // Route groups `(x)`, private folders `_x` and dynamic segments `[x]`
    // are not top-level paths of their own.
    .filter((entry) => !/^[([_]/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  it("finds the route group (guards against a silently empty glob)", () => {
    // Without this, a moved or renamed (dashboard) directory would make
    // `segments` empty and every assertion below would vacuously pass.
    expect(segments.length).toBeGreaterThanOrEqual(11);
    expect(segments).toContain("dashboard");
  });

  it.each(segments)("redirects an anonymous visitor off /%s", async (segment) => {
    mockUser = null;
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest(`https://app.test/${segment}`),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});
