import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BARS = [
  { x: 9, y: 27, width: 10, height: 28 },
  { x: 21.5, y: 37, width: 9, height: 18 },
  { x: 33, y: 22, width: 10, height: 33 },
  { x: 45.5, y: 9, width: 10, height: 46 },
];

/** The default social share card: a dark navy field with the tile mark and the tagline. */
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
          background: "#0a0f1c",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 24,
              display: "flex",
              background: "linear-gradient(to top right, #1d4ed8, #3b82f6)",
            }}
          >
            <svg width="96" height="96" viewBox="0 0 64 64">
              <g transform="translate(8 8) scale(.75)">
                {BARS.map((bar) => (
                  <rect key={bar.x} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} fill="#fff" />
                ))}
              </g>
            </svg>
          </div>
          <span style={{ fontSize: 76, fontWeight: 600, letterSpacing: -2, color: "#fff" }}>Mandate</span>
        </div>
        <span style={{ fontSize: 32, color: "#94a3b8" }}>Credit for the AI economy</span>
      </div>
    ),
    { ...size },
  );
}
