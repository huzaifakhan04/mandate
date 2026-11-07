import { useId } from "react";

/**
 * The approved Mandate mark ("Option A · rising bars"): four rounded bars
 * forming an M that climbs, on a 64×64 viewBox.
 */
const BARS = [
  { x: 9, y: 27, width: 10, height: 28 },
  { x: 21.5, y: 37, width: 9, height: 18 },
  { x: 33, y: 22, width: 10, height: 33 },
  { x: 45.5, y: 9, width: 10, height: 46 },
] as const;

function Bars({ fill }: { fill: string }) {
  return (
    <>
      {BARS.map((bar) => (
        <rect key={bar.x} x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} fill={fill} />
      ))}
    </>
  );
}

export type MandateMarkVariant = "tile" | "flat";

/**
 * The Mandate mark on its own.
 *
 * - `variant="tile"` — a rounded-square tile with a blue gradient
 *   background and the bars in white (favicons, app icons, anywhere the
 *   mark needs to stand alone on a light or dark surface).
 * - `variant="flat"` — just the bars in `currentColor` (inline next to a
 *   text wordmark, where the surrounding element already sets color).
 */
export function MandateMark({
  size = 24,
  variant = "flat",
  className,
}: {
  size?: number;
  variant?: MandateMarkVariant;
  className?: string;
}) {
  const reactId = useId();
  const gradientId = `mandate-mark-gradient-${reactId}`;

  if (variant === "tile") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        role="img"
        aria-label="Mandate"
        className={className}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="64" x2="64" y2="0">
            <stop offset="0" stopColor="#1d4ed8" />
            <stop offset="1" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill={`url(#${gradientId})`} />
        <g transform="translate(8 8) scale(.75)">
          <Bars fill="#fff" />
        </g>
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Mandate" className={className}>
      <Bars fill="currentColor" />
    </svg>
  );
}

/**
 * The mark plus the "Mandate" wordmark, in the app's Geist font.
 */
export function MandateLogo({
  size = 24,
  withWordmark = true,
  variant = "tile",
  className,
}: {
  size?: number;
  withWordmark?: boolean;
  variant?: MandateMarkVariant;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <MandateMark size={size} variant={variant} />
      {withWordmark ? (
        <span className="font-semibold" style={{ letterSpacing: "-0.02em" }}>
          Mandate
        </span>
      ) : null}
    </span>
  );
}

/**
 * The tile mark as a standalone SVG string, for the server-rendered,
 * HTML-string pages (`simApproveRoutes.ts`, `claimRoutes.ts`) that can't
 * use React components or `useId`.
 */
export function mandateMarkSvg(size = 24): string {
  const bars = BARS.map(
    (bar) => `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="3" fill="#fff"/>`,
  ).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="Mandate" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="mandate-mark-gradient-static" x1="0" y1="64" x2="64" y2="0"><stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#mandate-mark-gradient-static)"/><g transform="translate(8 8) scale(.75)">${bars}</g></svg>`;
}
