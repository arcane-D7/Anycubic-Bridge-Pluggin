import type { ReactNode, SVGProps } from "react";

/**
 * Inline-SVG icon set (S9.1-004). NO lucide-react (ISC is license-gated out):
 * hand-rolled mono "toolpath glyph" strokes matching the engineering HUD
 * aesthetic. All icons inherit currentColor, 1.5 stroke, 16px viewBox.
 */

export type IconName =
  | "settings"
  | "objects"
  | "chat"
  | "cube"
  | "arrange"
  | "fit"
  | "detach"
  | "dock"
  | "collapse"
  | "theme"
  | "check"
  | "close"
  | "chevron-down"
  | "plus"
  | "duplicate"
  | "trash"
  | "lock"
  | "eye"
  | "measure"
  | "folder"
  | "snap"
  | "grid"
  | "move"
  | "rotate"
  | "scale"
  | "redo"
  | "undo"
  | "printer"
  | "refresh"
  | "wrench"
  | "bell";

const PATHS: Record<IconName, ReactNode> = {
  wrench: (
    <>
      <path
        d="M9.2 2.2a3.8 3.8 0 0 0-5.1 4.6L1.5 9.4a1.4 1.4 0 0 0 2 2l2.6-2.6A3.8 3.8 0 0 0 10.7 3.9L8.6 6l-2-2 2.1-2.1a3.8 3.8 0 0 0 .5.3z"
        strokeLinejoin="round"
      />
      <path d="M9.5 6.5l4 4a1.4 1.4 0 0 1-2 2l-4-4" strokeLinecap="round" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path
        d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M3.4 12.6l1.6-1.6M11 5l1.6-1.6"
        strokeLinecap="round"
      />
    </>
  ),
  objects: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M2.5 6.5h11M6.5 2.5v11" />
    </>
  ),
  chat: (
    <>
      <path d="M2.5 3.5h11v8h-11z" rx="1" />
      <path d="M4.5 7h7M4.5 9.5h4.5" strokeLinecap="round" />
    </>
  ),
  cube: (
    <>
      <path d="M8 1.8l5.4 3.2v6L8 14.2 2.6 11V5z" strokeLinejoin="round" />
      <path d="M2.6 5L8 8.2 13.4 5M8 8.2V14.2" strokeLinejoin="round" />
    </>
  ),
  arrange: (
    <>
      <rect x="1.8" y="1.8" width="5.4" height="5.4" />
      <rect x="8.8" y="1.8" width="5.4" height="5.4" />
      <rect x="1.8" y="8.8" width="5.4" height="5.4" />
      <rect x="8.8" y="8.8" width="5.4" height="5.4" />
    </>
  ),
  fit: (
    <>
      <path
        d="M1.8 5V1.8H5M11 1.8h3.2V5M14.2 11v3.2H11M5 14.2H1.8V11"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.2" />
    </>
  ),
  detach: (
    <>
      <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1" />
      <path d="M9 7v6.5H2.5V7z" strokeLinejoin="round" />
    </>
  ),
  dock: (
    <>
      <path d="M2.5 2.5h11v6.5h-11z" />
      <path d="M2.5 13.5h8" strokeLinecap="round" />
    </>
  ),
  collapse: (
    <>
      <path d="M5 3v5.5h5.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 13L5 5" strokeLinecap="round" />
    </>
  ),
  theme: (
    <>
      <path d="M13.1 9.3A5.2 5.2 0 1 1 6.7 2.9a4.4 4.4 0 0 0 6.4 6.4z" strokeLinejoin="round" />
    </>
  ),
  check: <path d="M2.5 8l4 4 7-8" strokeLinecap="round" strokeLinejoin="round" />,
  close: <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />,
  "chevron-down": <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />,
  plus: <path d="M8 2.5v11M2.5 8h11" strokeLinecap="round" />,
  duplicate: (
    <>
      <rect x="5" y="5" width="8.5" height="8.5" rx="1" />
      <path d="M2.5 8.5V3.2A1.7 1.7 0 0 1 4.2 1.5h5.3" strokeLinecap="round" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4h11M6.5 2.5h3v-1h-3z" strokeLinejoin="round" />
      <path d="M4 4l.6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4" strokeLinecap="round" />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
      <path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" strokeLinecap="round" />
    </>
  ),
  eye: (
    <>
      <path
        d="M1.5 8S4 3.6 8 3.6 14.5 8 14.5 8 12 12.4 8 12.4 1.5 8 1.5 8z"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  measure: (
    <>
      <path
        d="M2.5 13.5L13.5 2.5M5 13.5l1.5-1.5M8 13.5l1.5-1.5M11 13.5l1.5-1.5"
        strokeLinecap="round"
      />
    </>
  ),
  snap: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1" />
    </>
  ),
  folder: (
    <>
      <path
        d="M2.5 4.5v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-4.4L6.3 4a1 1 0 0 0-.8-.4H3.5a1 1 0 0 0-1 1z"
        strokeLinejoin="round"
      />
      <path d="M2.5 7h11" strokeLinecap="round" />
    </>
  ),
  grid: (
    <>
      <path
        d="M1.8 8h12.4M8 1.8v12.4M5 1.8v12.4M11 1.8v12.4M1.8 5h12.4M1.8 11h12.4"
        strokeLinecap="round"
      />
    </>
  ),
  move: (
    <>
      <path
        d="M8 1.5v13M1.5 8h13M8 4l-2.5 2.5M8 4l2.5 2.5M8 12l-2.5-2.5M8 12l2.5-2.5M4 8l2.5-2.5M4 8l2.5 2.5M12 8l-2.5-2.5M12 8l-2.5 2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  rotate: (
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 1.8v3.2h-3.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  scale: (
    <>
      <path d="M1.8 1.8v12.4h12.4V1.8z" />
      <path d="M6.3 1.8v12.4M1.8 6.3h12.4M4.6 4.6h3.4v3.4M1.8 1.8l3 3M14.2 1.8l-3 3" />
    </>
  ),
  undo: (
    <>
      <path d="M7.5 3L4 6.5 7.5 10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 6.5h5.6a3.6 3.6 0 0 1 0 7.2H6.5" strokeLinecap="round" />
    </>
  ),
  redo: (
    <>
      <path d="M8.5 3L12 6.5 8.5 10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 6.5H6.4a3.6 3.6 0 0 0 0 7.2H9.5" strokeLinecap="round" />
    </>
  ),
  printer: (
    <>
      <path d="M2.8 6h10.4l.8 5.2H2z" strokeLinejoin="round" />
      <rect x="3" y="4" width="10" height="2" rx="0.5" />
      <path d="M4.5 9h7v4h-7z" strokeLinejoin="round" />
      <path d="M11.5 7.8v1" strokeLinecap="round" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 1.8V5h-3.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  bell: (
    <>
      <path d="M4 9.5V8a4 4 0 1 1 8 0v1.5L13 13H3l1-3.5z" strokeLinejoin="round" />
      <path d="M7 13.5a1.5 1.5 0 0 0 2 0" strokeLinecap="round" />
    </>
  ),
};

export interface IconProps extends SVGProps<SVGSVGElement> {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 16, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      {...props}
    >
      {PATHS[name]}
    </svg>
  );
}
