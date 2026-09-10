import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// Favicon for CRM PTMO OPERATION DEPT.
//
// Renders the official Minda Optima logo rather than a hand-drawn
// stand-in. The square asset (`public/brand/minda-optima-mark.png`) is
// the full lockup padded into a square — no crop — and it is drawn here
// with `object-fit: contain` inside a white rounded tile, so at 32px the
// artwork shrinks whole instead of being sliced. White keeps the logo's
// own colours readable against dark browser chrome.
//
// Runs on the Node runtime (not edge) so the PNG can be read off disk at
// build time and inlined; next/og then rasterises the 32x32 output.
//
// This route takes precedence over src/app/favicon.ico.

export const runtime = "nodejs";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  const logo = readFileSync(
    join(process.cwd(), "public", "brand", "minda-optima-mark.png"),
  );
  const src = `data:image/png;base64,${logo.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          borderRadius: 6,
        }}
      >
        <img
          src={src}
          alt=""
          width={30}
          height={30}
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    { ...size },
  );
}
