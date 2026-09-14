import { describe, expect, it } from 'vitest';

import {
  INITIAL_BROADCAST_STATUS,
  IN_FLIGHT_BROADCAST_STATUS,
  finalBroadcastStatus,
  statusAfterAbort,
} from './broadcast-send-status';

describe('INITIAL_BROADCAST_STATUS', () => {
  it('does not start a campaign in `sending`', () => {
    // The whole point: a row created before the first API call must not
    // read as in-flight, or a failed first send strands it forever.
    expect(INITIAL_BROADCAST_STATUS).not.toBe('sending');
    expect(INITIAL_BROADCAST_STATUS).toBe('draft');
  });

  it('only calls a campaign in-flight once a send has landed', () => {
    expect(IN_FLIGHT_BROADCAST_STATUS).toBe('sending');
  });
});

describe('finalBroadcastStatus', () => {
  it('condemns a pass only when every recipient failed', () => {
    expect(finalBroadcastStatus({ total: 3, failed: 3 })).toBe('failed');
  });

  it('counts a partially failed pass as sent', () => {
    expect(finalBroadcastStatus({ total: 3, failed: 1 })).toBe('sent');
  });

  it('counts a clean pass as sent', () => {
    expect(finalBroadcastStatus({ total: 3, failed: 0 })).toBe('sent');
  });

  it('never returns `sending` — a finished pass is always terminal', () => {
    for (let total = 0; total <= 4; total++) {
      for (let failed = 0; failed <= total; failed++) {
        expect(finalBroadcastStatus({ total, failed })).not.toBe('sending');
      }
    }
  });
});

describe('statusAfterAbort', () => {
  it('leaves an aborted pre-send campaign out of `sending`', () => {
    const status = statusAfterAbort({ sendingStarted: false });
    expect(status).not.toBe('sending');
    // Nothing reached Meta, so nothing is claimed to have failed.
    expect(status).toBe('draft');
  });

  it('fails a campaign that died after the first call landed', () => {
    expect(statusAfterAbort({ sendingStarted: true })).toBe('failed');
  });
});
