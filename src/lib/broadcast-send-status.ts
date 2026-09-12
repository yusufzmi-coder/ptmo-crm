/**
 * Status decisions for the wizard's client-side send pass.
 *
 * The send loop lives in `use-broadcast-sending.ts`, which runs in the
 * browser tab and cannot be unit-tested here (vitest runs `node` and
 * the repo carries no testing-library). The decisions it makes about
 * `broadcasts.status` are the part worth pinning down, so they live
 * here as pure functions.
 *
 * Deliberately NOT imported from `@/lib/whatsapp/broadcast-core`: that
 * module pulls in `encryption.ts`, which reads ENCRYPTION_KEY at module
 * load and must never reach the browser bundle. The rule below mirrors
 * `finalizeBroadcastStatus` for the single-pass case; the server keeps
 * the row-derived version for resumes.
 */

import type { BroadcastStatus } from '@/types';

/**
 * What a campaign is created as, before anything has been sent.
 *
 * Not `sending`. The row used to be inserted as `sending` ahead of the
 * first API call, so a failure anywhere before Step 5 left a campaign
 * pulsing "sending" forever with nothing left to move it. A campaign is
 * in flight only once a send call has actually landed.
 */
export const INITIAL_BROADCAST_STATUS: BroadcastStatus = 'draft';

/** Status once the first batch call has come back — the campaign is live. */
export const IN_FLIGHT_BROADCAST_STATUS: BroadcastStatus = 'sending';

export interface SendPassOutcome {
  /** Recipients this pass was responsible for. */
  total: number;
  /** How many of them ended the pass failed. */
  failed: number;
}

/**
 * Terminal status for a completed send pass.
 *
 * `failed` means every single recipient failed; anything that reached
 * Meta makes the campaign `sent`, with the individual failures visible
 * in `failed_count` (trigger-owned, migrations 003/005).
 */
export function finalBroadcastStatus({
  total,
  failed,
}: SendPassOutcome): BroadcastStatus {
  return failed > 0 && failed === total ? 'failed' : 'sent';
}

/**
 * Terminal status when a pass throws part-way through.
 *
 * Before the first call landed nothing was attempted upstream, so the
 * campaign falls back to a plain `draft` rather than claiming a send
 * that never happened. Either way it never stays `sending` — the
 * recipient rows still carry `pending`/`failed`, so the detail page
 * keeps offering Resume (issue #472).
 */
export function statusAfterAbort({
  sendingStarted,
}: {
  sendingStarted: boolean;
}): BroadcastStatus {
  return sendingStarted ? 'failed' : INITIAL_BROADCAST_STATUS;
}
