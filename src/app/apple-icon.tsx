import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const BARS = [
  { x: 9, y: 27, width: 10, height: 28 },
  { x: 21.5, y: 37, width: 9, height: 18 },
  { x: 33, y: 22, width: 10, height: 33 },
  { x: 45.5, y: 9, width: 10, height: 46 },
];

/** The tile mark, rendered at 180×180 for iOS home-screen icons. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "linear-gradient(to top right, #1d4ed8, #3b82f6)",
        }}
      >
        <svg width="180" height="180" viewBox="0 0 64 64">
          <g transform="translate(8 8) scale(.75)">
            {BARS.map((bar) => (
              <rect key={bar.x} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} fill="#fff" />
            ))}
          </g>
        </svg>
      </div>
    ),
    { ...size },
  );
}
