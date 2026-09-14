import { describe, it, expect } from 'vitest';
import { encodeQr, qrDataUri, qrSvg } from './qr';

// Scope note, because the last version of this file over-promised.
//
// These cover the WRAPPER: that we ask the library for the right thing and
// render its matrix faithfully. They deliberately do NOT re-test QR
// encoding — that belongs to qrcode-generator, and a hand-written encoder
// here previously passed eighteen structural tests while producing a grid
// that differed from a reference by a third of its modules. Structural
// tests verify shape, not function.
//
// Function was verified out of band: each link below was encoded and then
// decoded with jsQR (an independent decoder, installed outside the repo)
// and came back byte-identical. That is the check that actually proves a
// code scans; re-running it needs a decoder this project does not ship.

const LINK = 'https://wa.me/60123456789?text=batucaves';

describe('encodeQr', () => {
  it('encodes a branch link', () => {
    const m = encodeQr(LINK);
    expect(m).not.toBeNull();
    // Version 3 is 29 modules; the library picks the smallest that fits.
    expect(m!.size).toBe(29);
  });

  it('grows with the content rather than truncating it', () => {
    const small = encodeQr('hi')!;
    const large = encodeQr('x'.repeat(300))!;
    expect(small.size).toBeLessThan(large.size);
  });

  it('returns null for empty input instead of an empty grid', () => {
    expect(encodeQr('')).toBeNull();
  });

  it('is deterministic', () => {
    const a = encodeQr(LINK)!;
    const b = encodeQr(LINK)!;
    for (let r = 0; r < a.size; r++) {
      for (let c = 0; c < a.size; c++) {
        expect(a.isDark(r, c)).toBe(b.isDark(r, c));
      }
    }
  });

  it('produces a different matrix for a different branch', () => {
    const a = encodeQr('https://wa.me/60123456789?text=rawang')!;
    const b = encodeQr('https://wa.me/60123456789?text=batucaves')!;
    let diff = 0;
    for (let r = 0; r < a.size; r++) {
      for (let c = 0; c < a.size; c++) if (a.isDark(r, c) !== b.isDark(r, c)) diff++;
    }
    expect(diff).toBeGreaterThan(0);
  });
});

describe('qrSvg', () => {
  const m = encodeQr(LINK)!;

  it('keeps the four-module quiet zone', () => {
    // Part of the spec, not decoration: without it a scanner cannot find
    // the finder patterns against a busy background — a printed banner.
    expect(qrSvg(m)).toContain(`viewBox="0 0 ${m.size + 8} ${m.size + 8}"`);
  });

  it('paints an explicit white background', () => {
    // The code has to stay scannable on a dark-mode page; light modules
    // must actually be light, whatever is behind them.
    expect(qrSvg(m)).toContain('fill="#ffffff"');
  });

  it('draws exactly one rect per dark module, offset by the quiet zone', () => {
    let dark = 0;
    for (let r = 0; r < m.size; r++) {
      for (let c = 0; c < m.size; c++) if (m.isDark(r, c)) dark++;
    }
    const svg = qrSvg(m);
    // +1 for the background rect.
    expect(svg.match(/<rect /g)!.length).toBe(dark + 1);
    // The top-left dark module of the finder sits at the quiet-zone offset.
    expect(svg).toContain('<rect x="4" y="4" width="1" height="1"/>');
  });

  it('honours the requested pixel size without changing the grid', () => {
    expect(qrSvg(m, 320)).toContain('width="320"');
    expect(qrSvg(m, 320)).toContain(`viewBox="0 0 ${m.size + 8} ${m.size + 8}"`);
  });
});

describe('qrDataUri', () => {
  it('round-trips back to the same SVG', () => {
    const m = encodeQr('hi')!;
    const uri = qrDataUri(m);
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(uri.split(',')[1]!, 'base64').toString('utf8');
    expect(decoded).toBe(qrSvg(m));
  });
});
