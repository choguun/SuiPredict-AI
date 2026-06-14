import { ImageResponse } from "next/og";

/**
 * R33 sweep fix: app-icon generator.
 * The previous build had no dynamic
 * favicon — only a static
 * `apps/web/app/favicon.ico`. Adding
 * this `icon.tsx` makes Next.js
 * generate a 32x32 PNG icon at
 * `/icon.png` (and emit a
 * `<link rel="icon">` tag at build
 * time) for browsers that prefer
 * SVG/PNG over ICO. The icon is
 * the SuiPredict "SP" wordmark on
 * an emerald gradient — the same
 * palette the WC dashboard uses.
 *
 * Edge runtime: Next.js runs this
 * file in a V8 isolate at the
 * edge when the icon is requested,
 * so the `ImageResponse` import
 * comes from `next/og` (the
 * on-demand image-generation
 * runtime) and is the only
 * Node-API-touching dep in this
 * file.
 */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 18,
          background: "linear-gradient(135deg, #10b981 0%, #047857 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontWeight: 800,
          letterSpacing: "-0.05em",
          borderRadius: 6,
        }}
      >
        SP
      </div>
    ),
    { ...size },
  );
}
