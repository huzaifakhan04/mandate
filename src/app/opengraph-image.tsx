import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BARS = [
  { x: 9, y: 27, width: 10, height: 28 },
  { x: 21.5, y: 37, width: 9, height: 18 },
  { x: 33, y: 22, width: 10, height: 33 },
  { x: 45.5, y: 9, width: 10, height: 46 },
];

/** The default social share card: a near-black field with the flat mark and the tagline. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 28,
          background: "#08090a",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <svg width="88" height="88" viewBox="0 0 64 64">
            {BARS.map((bar) => (
              <rect key={bar.x} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} fill="#f5f5f4" />
            ))}
          </svg>
          <span style={{ fontSize: 76, fontWeight: 600, letterSpacing: -2, color: "#f5f5f4" }}>Mandate</span>
        </div>
        <span style={{ fontSize: 32, color: "#8b8d93" }}>Credit for the AI economy</span>
      </div>
    ),
    { ...size },
  );
}
