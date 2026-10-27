import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fileKind } from '@shared/file-kind'
import { FLIGHT_FRAME } from '@shared/layout'
import { FileIcon } from '../../components/Illustration'
import { getT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { adoptChildDocument } from '../../lib/surface'
import { toast, useUi, type DownloadFlight } from '../../stores/ui'

// A download that starts throws its file from the pointer into the
// downloads button, along a parabola: a quadratic Bézier walked at constant
// speed is exactly a thrown object's path (steady sideways, gravity down).
//
// The page is a separate view above the shell, so the flight is drawn in a
// transparent child window over the whole browser window that lets every
// click through (see FLIGHT_FRAME). It is opened once, shown only while
// something flies, and lives in the shell's renderer like the surfaces.

/** Frames the downloads button gets to appear (it shows up with the first download). */
const TARGET_WAIT_FRAMES = 8
const SIZE = { width: 30, height: 38 }

interface Airborne extends DownloadFlight {
  from: { x: number; y: number }
  to: { x: number; y: number }
}

let layer: { win: Window; container: HTMLElement } | null = null

function flightLayer(): HTMLElement | null {
  if (layer && !layer.win.closed) return layer.container
  const win = window.open('about:blank', FLIGHT_FRAME)
  if (!win) return null
  layer = { win, container: adoptChildDocument(win, 'flight').container }
  return layer.container
}

function downloadsButton(): DOMRect | null {
  const el = document.querySelector<HTMLElement>('[data-downloads-button]')
  const rect = el?.getBoundingClientRect()
  return rect && rect.width > 0 && el!.checkVisibility() ? rect : null
}

function landed(): void {
  useUi.setState((s) => ({ downloadLanded: s.downloadLanded + 1 }))
}

export function DownloadFlights() {
  const queued = useUi((s) => s.flights)
  const [airborne, setAirborne] = useState<Airborne[]>([])

  // Take new flights off the queue once the button they aim at is laid out.
  useEffect(() => {
    if (queued.length === 0) return
    useUi.setState({ flights: [] })
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const flight of queued) {
      let frames = 0
      const aim = () => {
        const target = downloadsButton()
        if (!target && ++frames < TARGET_WAIT_FRAMES) return void requestAnimationFrame(aim)
        if (!target) {
          // The sidebar is hidden: say it instead.
          toast(getT()('downloads.started', { name: flight.filename }))
          return
        }
        if (!flight.from || reduced) return landed()
        const to = {
          x: target.left + target.width / 2,
          y: target.top + target.height / 2
        }
        setAirborne((list) => [...list, { ...flight, from: flight.from!, to }])
      }
      requestAnimationFrame(aim)
    }
  }, [queued])

  const flying = airborne.length > 0
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!flying) return
    setContainer(flightLayer())
    send('downloads.flightLayer', true)
    return () => send('downloads.flightLayer', false)
  }, [flying])

  if (!container || !flying) return null
  return createPortal(
    airborne.map((f) => (
      <Flight
        key={f.id}
        flight={f}
        done={() => {
          setAirborne((list) => list.filter((x) => x.id !== f.id))
          landed()
        }}
      />
    )),
    container
  )
}

function Flight({ flight, done }: { flight: Airborne; done: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const doneRef = useRef(done)
  doneRef.current = done
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const animation = el.animate(throwFrames(flight.from, flight.to), {
      duration: throwDuration(flight.from, flight.to),
      easing: 'linear',
      fill: 'forwards'
    })
    animation.onfinish = () => doneRef.current()
    return () => animation.cancel()
  }, [flight.from, flight.to])
  return (
    <div
      ref={ref}
      className="pointer-events-none fixed left-0 top-0 will-change-transform [filter:drop-shadow(0_6px_10px_rgb(0_0_0/0.22))_drop-shadow(0_1px_2px_rgb(0_0_0/0.18))]"
      style={{ opacity: 0 }}
    >
      <FileIcon kind={fileKind(flight.filename, flight.mimeType)} />
    </div>
  )
}

/** Longer throws take longer, within reason. */
function throwDuration(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.round(Math.min(720, Math.max(480, 360 + Math.hypot(to.x - from.x, to.y - from.y) * 0.36)))
}

/**
 * Keyframes along the arc. The file pops up out of the pointer, rises to an
 * apex above both ends, and shrinks into the button. Only transform and
 * opacity change, so the compositor runs it.
 */
export function throwFrames(from: { x: number; y: number }, to: { x: number; y: number }): Keyframe[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const lift = Math.min(220, Math.max(70, dist * 0.32))
  const control = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - lift }
  const POP = 0.14
  const STEPS = 28
  const frames: Keyframe[] = []
  const at = (t: number) => ({
    x: (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * control.x + t * t * to.x,
    y: (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * control.y + t * t * to.y
  })
  const place = (p: { x: number; y: number }, scale: number, tilt: number) =>
    `translate(${(p.x - SIZE.width / 2).toFixed(1)}px, ${(p.y - SIZE.height / 2).toFixed(1)}px) rotate(${tilt.toFixed(1)}deg) scale(${scale.toFixed(3)})`
  // Pop: out of the pointer, slightly past full size.
  frames.push({ offset: 0, opacity: 0, transform: place(from, 0.35, 0) })
  frames.push({
    offset: POP * 0.7,
    opacity: 1,
    transform: place(from, 1.08, 0)
  })
  frames.push({ offset: POP, opacity: 1, transform: place(from, 1, 0) })
  // The throw, at constant speed along the curve: a parabola.
  const lean = Math.sign(to.x - from.x) || -1
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS
    const offset = POP + (1 - POP) * t
    frames.push({
      offset,
      opacity: t > 0.88 ? (1 - t) / 0.12 : 1,
      transform: place(at(t), 1 - 0.55 * t * t, lean * 10 * Math.sin(Math.PI * t))
    })
  }
  return frames
}
