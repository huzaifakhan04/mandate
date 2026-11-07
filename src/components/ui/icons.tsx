import type { SVGProps } from "react";

/**
 * Drawn icon set: 16px grid, 1.5px stroke, round caps. Use these instead of
 * unicode glyphs (✓ ✕ →) or emoji. Icons are decorative unless given a title.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={rest["aria-label"] ? undefined : true}
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconCheck = (p: IconProps) => <Svg {...p}><path d="M3.5 8.5l3 3 6-7" /></Svg>;
export const IconX = (p: IconProps) => <Svg {...p}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>;
export const IconArrowRight = (p: IconProps) => <Svg {...p}><path d="M3 8h10M9 4l4 4-4 4" /></Svg>;
export const IconArrowLeft = (p: IconProps) => <Svg {...p}><path d="M13 8H3M7 4L3 8l4 4" /></Svg>;
/** Money into the bank. */
export const IconIn = (p: IconProps) => <Svg {...p}><path d="M11.5 4.5l-7 7M4.5 6.5v5h5" /></Svg>;
/** Money out of the bank. */
export const IconOut = (p: IconProps) => <Svg {...p}><path d="M4.5 11.5l7-7M6.5 4.5h5v5" /></Svg>;
export const IconClock = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></Svg>;
export const IconAlert = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.5M8 10.75v.25" /></Svg>;
export const IconBell = (p: IconProps) => <Svg {...p}><path d="M4 11V7a4 4 0 018 0v4l1 1.5H3L4 11zM6.5 14h3" /></Svg>;
export const IconPlus = (p: IconProps) => <Svg {...p}><path d="M8 3.5v9M3.5 8h9" /></Svg>;
export const IconLedger = (p: IconProps) => <Svg {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6.5h11M6.5 6.5v7" /></Svg>;
export const IconLoan = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M9.75 6.25c-.4-.5-1-.75-1.75-.75-1 0-1.75.5-1.75 1.25 0 1.75 3.5 1 3.5 2.75 0 .75-.75 1.25-1.75 1.25-.75 0-1.4-.3-1.8-.8M8 4.5v1M8 10.5v1" /></Svg>;
export const IconNote = (p: IconProps) => <Svg {...p}><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M6.5 8h3M6.5 10.5h3" /></Svg>;
export const IconAgent = (p: IconProps) => <Svg {...p}><rect x="3" y="5" width="10" height="7.5" rx="2" /><path d="M8 5V3M6 8.5v.5M10 8.5v.5" /></Svg>;
export const IconShield = (p: IconProps) => <Svg {...p}><path d="M8 2.5l4.5 1.75v3.5c0 3-2 4.75-4.5 5.75-2.5-1-4.5-2.75-4.5-5.75v-3.5z" /></Svg>;
export const IconCalendar = (p: IconProps) => <Svg {...p}><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></Svg>;
export const IconConsole = (p: IconProps) => <Svg {...p}><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M2.5 6h11M6 6v7.5" /></Svg>;
export const IconTimeline = (p: IconProps) => <Svg {...p}><path d="M2.5 4h6M5 8h8.5M2.5 12h5" /></Svg>;
export const IconGlobe = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.75 2.25 3.6 2.25 5.5S9.6 11.75 8 13.5C6.4 11.75 5.75 9.9 5.75 8S6.4 4.25 8 2.5z" /></Svg>;
export const IconDoc = (p: IconProps) => <Svg {...p}><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M9.5 2.5V5H12" /></Svg>;
export const IconCode = (p: IconProps) => <Svg {...p}><path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3" /></Svg>;
export const IconBox = (p: IconProps) => <Svg {...p}><path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11z" /><path d="M2.5 5L8 7.5 13.5 5M8 7.5v6" /></Svg>;
export const IconKey = (p: IconProps) => <Svg {...p}><circle cx="5.5" cy="10.5" r="2.5" /><path d="M7.25 8.75L13 3M11 5l1.5 1.5" /></Svg>;
export const IconChevronDown = (p: IconProps) => <Svg {...p}><path d="M4.5 6.5L8 10l3.5-3.5" /></Svg>;
export const IconSearch = (p: IconProps) => <Svg {...p}><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></Svg>;
export const IconLogout = (p: IconProps) => <Svg {...p}><path d="M9.5 3.5h3v9h-3M6.5 5L3.5 8l3 3M3.5 8h7" /></Svg>;
