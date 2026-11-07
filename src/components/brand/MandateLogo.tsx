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

/** Solid colours for the app-icon tile (favicon, apple icon, OG). No gradient. */
export const MARK_TILE_BG = "#151617";
export const MARK_TILE_FG = "#f5f5f4";

/**
 * The Mandate mark on its own.
 *
 * - `variant="flat"` (default): just the bars in `currentColor`. Use this
 *   everywhere inside the app, next to the wordmark or alone.
 * - `variant="tile"`: the bars on a solid graphite rounded square, for app
 *   icons and favicons that need their own ground.
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
  if (variant === "tile") {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Mandate" className={className}>
        <rect width="64" height="64" rx="14" fill={MARK_TILE_BG} />
        <g transform="translate(8 8) scale(.75)">
          <Bars fill={MARK_TILE_FG} />
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
  size = 18,
  withWordmark = true,
  variant = "flat",
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
        <span style={{ fontWeight: 560, letterSpacing: "-0.015em" }}>Mandate</span>
      ) : null}
    </span>
  );
}

/**
 * The flat mark as a standalone SVG string, for the server-rendered,
 * HTML-string pages (`simApproveRoutes.ts`, `claimRoutes.ts`) that can't
 * use React components. Bars in the light text colour, for the dark ground.
 */
export function mandateMarkSvg(size = 24): string {
  const bars = BARS.map(
    (bar) => `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="${bar.height}" rx="3" fill="${MARK_TILE_FG}"/>`,
  ).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="Mandate" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}
