import type { ReactNode } from 'react'

// One small set of line icons (24×24, drawn with the current text colour) so
// every button and menu looks the same, instead of a mix of emoji and symbols.

const SHAPES = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
      <path d="M15.5 4.6a3.2 3.2 0 0 1 0 6.3M18 14c2.1.7 3.5 2.9 3.5 5.5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8v.5" />
      <path d="M12 17.2v.1" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.6A8 8 0 1 1 9.4 4a6.4 6.4 0 0 0 10.6 10.6z" />,
  sparkle: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />,
  timer: (
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M12 9.5v4l2.5 2M9.5 2.5h5" />
    </>
  ),
  report: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </>
  ),
  panelLeft: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />,
  edit: <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17zM14.5 7.5l3 3" />,
  sync: (
    <>
      <path d="M20 11a8 8 0 0 0-14.4-4.6L4 8.5M4 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 14.4 4.6L20 15.5M20 20v-4.5h-4.5" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" fill="currentColor" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.3" fill="currentColor" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 3.5v5h5" />
      <path d="M12 7.5v4.5l3 2" />
    </>
  ),
  split: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M12 4v16" />
    </>
  ),
  textSmaller: <path d="M3 18L8 6l5 12M4.8 14h6.4M16 12h5" />,
  textBigger: <path d="M3 18L8 6l5 12M4.8 14h6.4M16 12h5M18.5 9.5v5" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  bug: (
    <>
      <path d="M8.5 7.5a3.5 3.5 0 0 1 7 0" />
      <path d="M7 9.5h10v4.5a5 5 0 0 1-10 0zM12 12v7M3 13h4M17 13h4M4.5 7.5l2.5 2M19.5 7.5l-2.5 2M4.5 19l2.8-2M19.5 19l-2.8-2" />
    </>
  ),
  undo: <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5.5" r="2" />
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="7.5" r="2" />
      <path d="M6 7.5v9M18 9.5c0 4-4 4.5-12 7" />
    </>
  ),
  play: <path d="M7 5l12 7-12 7z" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5M20 4v4.5h-4.5" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9.5" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  link: <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  folderPlus: <path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10.5v5M9.5 13h5" />,
  tool: <path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3zM14.5 6.5L17 4l3 3-2.5 2.5" />,
  alert: <path d="M12 4L2.8 19.5h18.4zM12 10v4.5M12 17.2h.01" />,
  phone: <path d="M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2" />,
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />,
  copy: <path d="M9 9h10v11H9zM5 15V4h10" />,
  gauge: <path d="M4 17a8 8 0 1 1 16 0M12 17l4-5" />
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof SHAPES

export function Icon(props: { name: IconName; size?: number; className?: string; title?: string }): ReactNode {
  const size = props.size ?? 16
  return (
    <svg
      className={`icon ${props.className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props.title ? undefined : true}
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
    >
      {SHAPES[props.name]}
    </svg>
  )
}
