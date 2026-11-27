import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../icons'
import type { TourId } from './topics'
import { TOURS, type TourStep } from './tours'

// A spotlight tour: dims the screen except the part being explained, with a
// short note next to it. Back / Next / Esc. Steps whose target isn't on the
// screen are skipped.

interface Box {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 6

export function Tour(props: { id: TourId; go: (step: TourStep) => void; onClose: (finished: boolean) => void }): ReactNode {
  const tour = TOURS[props.id]
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const dir = useRef(1)
  const step = tour.steps[index]

  // Move to the step's screen, then find its target (it may take a moment to appear).
  useEffect(() => {
    let cancelled = false
    setBox(null)
    if (step.go) props.go(step)
    const started = Date.now()
    const find = (): void => {
      if (cancelled) return
      const el = document.querySelector(step.target) as HTMLElement | null
      const r = el?.getBoundingClientRect()
      if (el && r && r.width > 0 && r.height > 0) {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        const r2 = el.getBoundingClientRect()
        setBox({ top: r2.top - PAD, left: r2.left - PAD, width: r2.width + PAD * 2, height: r2.height + PAD * 2 })
        return
      }
      if (Date.now() - started > 2500) {
        // Not on this screen: skip it in the direction we were going.
        const next = index + dir.current
        if (next >= 0 && next < tour.steps.length) setIndex(next)
        else props.onClose(dir.current > 0)
        return
      }
      setTimeout(find, 100)
    }
    find()
    return () => {
      cancelled = true
    }
  }, [index])

  // Follow layout changes (window resize, panels opening).
  useEffect(() => {
    const t = setInterval(() => {
      const el = document.querySelector(step.target) as HTMLElement | null
      const r = el?.getBoundingClientRect()
      if (r && r.width > 0) setBox({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
    }, 400)
    return () => clearInterval(t)
  }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose(false)
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const next = (): void => {
    dir.current = 1
    if (index + 1 < tour.steps.length) setIndex(index + 1)
    else props.onClose(true)
  }
  const back = (): void => {
    dir.current = -1
    if (index > 0) setIndex(index - 1)
  }

  // Place the note below the target if there's room, else above, else beside it.
  const W = 340
  let pop: { top: number; left: number } = { top: window.innerHeight / 2 - 80, left: window.innerWidth / 2 - W / 2 }
  if (box) {
    const below = box.top + box.height + 12
    const left = Math.min(Math.max(12, box.left), window.innerWidth - W - 12)
    if (below + 180 < window.innerHeight) pop = { top: below, left }
    else if (box.top - 190 > 0) pop = { top: box.top - 190, left }
    else pop = { top: Math.max(12, Math.min(box.top, window.innerHeight - 200)), left: Math.min(box.left + box.width + 12, window.innerWidth - W - 12) }
  }

  return (
    <div className="tour-layer" role="dialog" aria-label={`${tour.title}: ${step.title}`}>
      {box ? (
        <div className="tour-spot" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-pop" style={{ top: pop.top, left: pop.left, width: W }}>
        <div className="tour-pop-head">
          <span className="muted small">
            {tour.title} · {index + 1} of {tour.steps.length}
          </span>
          <button className="icon-btn" aria-label="Close tour" onClick={() => props.onClose(false)}>
            <Icon name="close" size={15} />
          </button>
        </div>
        <h4>{step.title}</h4>
        <p>{step.text}</p>
        <div className="row gap-s">
          <button className="btn small-btn" onClick={back} disabled={index === 0}>
            Back
          </button>
          <div className="grow" />
          <button className="btn small-btn primary" onClick={next} autoFocus>
            {index + 1 < tour.steps.length ? 'Next' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
