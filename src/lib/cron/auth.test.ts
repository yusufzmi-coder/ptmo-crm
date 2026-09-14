import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authorizeCronRequest } from "./auth";

const HEADER_SECRET = "header-secret-value";
const BEARER_SECRET = "bearer-secret-value";

/** A bare Request carrying only the headers under test. */
const req = (headers: Record<string, string>) =>
  new Request("https://example.test/api/automations/cron", { headers });

let saved: { automation?: string; cron?: string };

beforeEach(() => {
  saved = {
    automation: process.env.AUTOMATION_CRON_SECRET,
    cron: process.env.CRON_SECRET,
  };
  process.env.AUTOMATION_CRON_SECRET = HEADER_SECRET;
  process.env.CRON_SECRET = BEARER_SECRET;
});

afterEach(() => {
  if (saved.automation === undefined) delete process.env.AUTOMATION_CRON_SECRET;
  else process.env.AUTOMATION_CRON_SECRET = saved.automation;
  if (saved.cron === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved.cron;
});

describe("x-cron-secret — the external pinger's shape", () => {
  it("accepts the matching secret", () => {
    const out = authorizeCronRequest(req({ "x-cron-secret": HEADER_SECRET }));
    expect(out).toEqual({ ok: true, via: "x-cron-secret" });
  });

  it("rejects a wrong secret of the same length", () => {
    // Same length on purpose: the length pre-check must not be what is
    // doing the rejecting.
    const wrong = "X".repeat(HEADER_SECRET.length);
    expect(authorizeCronRequest(req({ "x-cron-secret": wrong }))).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("rejects a secret of a different length", () => {
    expect(authorizeCronRequest(req({ "x-cron-secret": "short" }))).toMatchObject(
      { ok: false, status: 401 },
    );
  });

  it("is not validated against CRON_SECRET", () => {
    // Provisioning the Vercel scheduler must not widen this door.
    expect(
      authorizeCronRequest(req({ "x-cron-secret": BEARER_SECRET })),
    ).toMatchObject({ ok: false, status: 401 });
  });
});

describe("Authorization: Bearer — the shape Vercel Cron can actually send", () => {
  it("accepts the matching token", () => {
    const out = authorizeCronRequest(
      req({ authorization: `Bearer ${BEARER_SECRET}` }),
    );
    expect(out).toEqual({ ok: true, via: "bearer" });
  });

  it("accepts the scheme in any case, per RFC 7235", () => {
    expect(
      authorizeCronRequest(req({ authorization: `bearer ${BEARER_SECRET}` })),
    ).toMatchObject({ ok: true });
    expect(
      authorizeCronRequest(req({ authorization: `BEARER ${BEARER_SECRET}` })),
    ).toMatchObject({ ok: true });
  });

  it("rejects a wrong token of the same length", () => {
    const wrong = "X".repeat(BEARER_SECRET.length);
    expect(
      authorizeCronRequest(req({ authorization: `Bearer ${wrong}` })),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects malformed headers rather than being generous", () => {
    for (const value of [
      BEARER_SECRET, // no scheme
      `Basic ${BEARER_SECRET}`, // wrong scheme
      "Bearer", // scheme only
      "Bearer ", // scheme and nothing after it
    ]) {
      expect(authorizeCronRequest(req({ authorization: value }))).toMatchObject({
        ok: false,
        status: 401,
      });
    }
  });

  it("is not validated against AUTOMATION_CRON_SECRET", () => {
    expect(
      authorizeCronRequest(req({ authorization: `Bearer ${HEADER_SECRET}` })),
    ).toMatchObject({ ok: false, status: 401 });
  });
});

describe("configuration states", () => {
  it("503s when neither secret is set, so the log distinguishes it from an attack", () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    delete process.env.CRON_SECRET;
    expect(authorizeCronRequest(req({}))).toMatchObject({
      ok: false,
      status: 503,
      error: "cron not configured",
    });
  });

  it("401s rather than 503s when one secret is set and the request is wrong", () => {
    delete process.env.CRON_SECRET;
    expect(
      authorizeCronRequest(req({ authorization: `Bearer ${BEARER_SECRET}` })),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("still accepts the header shape when only that secret is provisioned", () => {
    delete process.env.CRON_SECRET;
    expect(
      authorizeCronRequest(req({ "x-cron-secret": HEADER_SECRET })),
    ).toMatchObject({ ok: true, via: "x-cron-secret" });
  });

  it("accepts the Bearer shape when only CRON_SECRET is provisioned", () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    expect(
      authorizeCronRequest(req({ authorization: `Bearer ${BEARER_SECRET}` })),
    ).toMatchObject({ ok: true, via: "bearer" });
  });

  it("never lets a blank env var open the door", () => {
    // An empty string is set, not absent — so the 503 branch does not
    // catch it, and an empty header would otherwise compare equal.
    process.env.AUTOMATION_CRON_SECRET = "";
    process.env.CRON_SECRET = BEARER_SECRET;
    expect(authorizeCronRequest(req({ "x-cron-secret": "" }))).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});

describe("no credentials at all", () => {
  it("401s when configured and nothing is sent", () => {
    expect(authorizeCronRequest(req({}))).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});
