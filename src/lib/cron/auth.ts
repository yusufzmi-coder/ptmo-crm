import { timingSafeEqual } from "node:crypto";

/**
 * Authorise a scheduled request to a cron endpoint.
 *
 * TWO SHAPES, AND BOTH ARE NECESSARY.
 *
 * The endpoints were written to take `x-cron-secret`, which is what an
 * external pinger or a GitHub Action sends and what the operator docs
 * describe. Vercel Cron cannot send it: it sends
 * `Authorization: Bearer $CRON_SECRET` and has no way to add a custom
 * header.
 *
 * So a `vercel.json` schedule added to the app as it stood would have
 * produced a 401 on every run, and the obvious reading of that 401 is
 * "the secret is wrong" — sending whoever added it to re-provision a
 * secret that was already correct. Accepting both shapes removes that
 * dead end.
 *
 * Each header is checked against its OWN variable. A request carrying
 * `x-cron-secret` is never validated against `CRON_SECRET`, and a Bearer
 * token is never validated against `AUTOMATION_CRON_SECRET`, so
 * provisioning one scheduler does not silently widen the other's door.
 *
 * `CRON_SECRET` is the name Vercel injects; it is not ours to choose.
 */

export type CronAuth =
  | { ok: true; via: "x-cron-secret" | "bearer" }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Constant-time compare.
 *
 * `timingSafeEqual` THROWS on buffers of different lengths, so the length
 * check is required rather than an optimisation. It leaks the length of
 * the secret, which is not sensitive; the bytes are what matter.
 */
function secretMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false;
  // An empty supplied value must never match, even against an empty
  // expected one — that would turn a blank env var into an open door.
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the token out of `Authorization: Bearer <token>`, if it is one. */
function bearerToken(header: string | null): string | null {
  if (!header) return null;
  // The scheme is case-insensitive per RFC 7235, and exactly one space
  // separates it from the token. Anything else is malformed, not a near
  // miss to be generous about.
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function authorizeCronRequest(request: Request): CronAuth {
  const headerSecret = process.env.AUTOMATION_CRON_SECRET;
  const bearerSecret = process.env.CRON_SECRET;

  // Neither configured is a deployment state, not an attack: say so with
  // a 503 rather than a 401, so an operator reading the log can tell
  // "nobody set this up" apart from "someone tried and failed".
  if (!headerSecret && !bearerSecret) {
    return { ok: false, status: 503, error: "cron not configured" };
  }

  if (secretMatches(request.headers.get("x-cron-secret") ?? "", headerSecret)) {
    return { ok: true, via: "x-cron-secret" };
  }

  const token = bearerToken(request.headers.get("authorization"));
  if (token !== null && secretMatches(token, bearerSecret)) {
    return { ok: true, via: "bearer" };
  }

  return { ok: false, status: 401, error: "Unauthorized" };
}
