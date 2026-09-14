import qrcode from 'qrcode-generator';

/**
 * QR for a branch's wa.me link.
 *
 * A thin wrapper over qrcode-generator rather than an encoder of our own.
 * That is a deliberate reversal: the first attempt here WAS hand-written,
 * passed eighteen structural tests, and differed from a reference
 * implementation by 281 of 841 modules — a grid that satisfied every test
 * we had and would not have scanned. Structural tests verify shape, not
 * function, and these codes get printed on branch banners where being
 * nearly right costs a reprint.
 *
 * We build the SVG from the module matrix instead of calling createSvgTag,
 * for two reasons: the background has to be explicitly white so the code
 * survives on a dark-mode page (a scanner needs the light modules light,
 * whatever the page behind it is doing), and the quiet zone has to be
 * guaranteed rather than assumed.
 */

/** Error-correction level. L maximises capacity; a printed banner is not
 *  a scuffed receipt, and the link is short. */
const EC_LEVEL = 'L' as const;

export interface QrMatrix {
  size: number;
  isDark: (row: number, col: number) => boolean;
}

/**
 * Encode `text`, letting the library pick the smallest version that fits.
 * Returns null if it cannot be encoded at all, so a caller can say so
 * rather than rendering something that scans to the wrong thing.
 */
export function encodeQr(text: string): QrMatrix | null {
  if (!text) return null;
  try {
    // 0 = choose the type number automatically.
    const qr = qrcode(0, EC_LEVEL);
    qr.addData(text); // Byte mode is the default and is what a URL needs.
    qr.make();
    return {
      size: qr.getModuleCount(),
      isDark: (row, col) => qr.isDark(row, col),
    };
  } catch {
    return null;
  }
}

/**
 * Render a matrix as a standalone SVG string.
 *
 * The four-module quiet zone is part of the spec, not decoration — without
 * it a scanner cannot find the finder patterns against a busy background,
 * which on a printed banner is exactly the situation.
 */
export function qrSvg(matrix: QrMatrix, pixels = 160): string {
  const quiet = 4;
  const span = matrix.size + quiet * 2;
  const rects: string[] = [];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.isDark(r, c)) {
        rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" ` +
    `viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges">` +
    `<rect width="${span}" height="${span}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects.join('')}</g></svg>`
  );
}

/** SVG as a data URI, for an `<img src>` or a download link. */
export function qrDataUri(matrix: QrMatrix, pixels = 160): string {
  return `data:image/svg+xml;base64,${btoa(qrSvg(matrix, pixels))}`;
}
