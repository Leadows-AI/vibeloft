import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const GAP = 6
const EDGE = 8

/**
 * Where to put the menu so it stays inside the window: below the button (or
 * above, if asked or if there's more room there), shifted sideways to fit, and
 * scrolling when the window is too short for all of it.
 */
function place(btn: DOMRect, width: number, up: boolean, align: 'left' | 'right'): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(width, vw - EDGE * 2)
  const wantLeft = align === 'left' ? btn.left : btn.right - w
  const left = Math.max(EDGE, Math.min(wantLeft, vw - w - EDGE))
  const below = vh - btn.bottom - GAP - EDGE
  const above = btn.top - GAP - EDGE
  const goUp = up ? above >= 160 || above > below : below < 260 && above > below
  return {
    position: 'fixed',
    left,
    right: 'auto',
    width: w,
    ...(goUp ? { bottom: vh - btn.top + GAP, top: 'auto', maxHeight: above } : { top: btn.bottom + GAP, bottom: 'auto', maxHeight: below }),
    overflowY: 'auto'
  }
}

/** A button that opens a menu below it; closes on outside click or Escape. */
export function Dropdown(props: {
  label: ReactNode
  title?: string
  className?: string
  align?: 'left' | 'right'
  up?: boolean
  width?: number
  onOpen?: () => void
  children: (close: () => void) => ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({})
  const ref = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const reposition = (): void => {
    if (btn.current) setStyle(place(btn.current.getBoundingClientRect(), props.width ?? 300, !!props.up, props.align ?? 'right'))
  }
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', reposition)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        ref={btn}
        className={props.className ?? 'btn small-btn'}
        title={props.title}
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            props.onOpen?.()
            reposition()
          }
          setOpen((o) => !o)
        }}
      >
        {props.label}
      </button>
      {open && (
        <div className="menu" role="menu" style={style}>
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
