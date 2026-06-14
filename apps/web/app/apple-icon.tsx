import { ImageResponse } from "next/og";

/**
 * R33 sweep fix: Apple touch-icon
 * generator. Renders at 180x180 (the
 * standard iOS home-screen icon
 * size) and is the "apple-touch-
 * icon" link the Safari add-to-
 * home-screen flow picks up. The
 * background is the same emerald
 * gradient as the regular icon so
 * the home-screen icon and the
 * browser tab are visually
 * consistent.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 96,
          background: "linear-gradient(135deg, #10b981 0%, #047857 100%)",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontWeight: 800,
          letterSpacing: "-0.05em",
          borderRadius: 32,
        }}
      >
        SP
      </div>
    ),
    { ...size },
  );
}
