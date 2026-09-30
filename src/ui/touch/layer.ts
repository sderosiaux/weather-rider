// The on-screen controls, drawing only. Fingers are read on the flight view itself (controls.ts), so the
// layer never needs pointer events and never catches a mouse click. It is inserted right after the view,
// before whatever follows it (the HUD overlay): the instruments always paint on top of the controls.
import { createWriter, h, svg } from '../dom'
import type { Point, Rect } from './axis'
import './touch.css'

export interface TouchView {
  readonly visible: boolean
  /** Stick radius for this screen (px): sizes the resting ring. */
  readonly radius: number
  /** Held stick: ring on the landing point, knob offset from it (px). */
  readonly stick: { readonly origin: Point; readonly knob: Point; readonly radius: number } | null
  readonly throttle: number
  /** Trimmed throttle of this flight, marked on the track. */
  readonly trim: number | null
  readonly throttleHeld: boolean
  readonly yaw: -1 | 0 | 1
}

export interface TouchLayer {
  draw(view: TouchView): void
  hide(): void
  /** Yaw pads as drawn (client px). */
  pads(): { readonly left: Rect; readonly right: Rect }
  /** Travel of the throttle handle on screen (px). */
  trackPx(): number
  dispose(): void
}

const chevron = (dir: -1 | 1): SVGSVGElement =>
  svg('svg', { class: 'wr-touch__glyph', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('path', { d: dir < 0 ? 'M14.5 6 L8.5 12 L14.5 18' : 'M9.5 6 L15.5 12 L9.5 18' }))

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`

export const createTouchLayer = (target: HTMLElement): TouchLayer => {
  const w = createWriter()

  const home = h('div', 'wr-touch__home', h('span', 'wr-touch__home-knob'), h('span', 'wr-touch__tag wr-touch__home-label', h('span', 'wr-touch__label', 'steer')))
  const knob = h('span', 'wr-touch__knob')
  const stick = h('div', 'wr-touch__stick', h('span', 'wr-touch__ring'), knob)

  const fill = h('span', 'wr-touch__fill')
  const trimMark = h('span', 'wr-touch__trim')
  const handle = h('span', 'wr-touch__handle-carrier', h('span', 'wr-touch__handle'))
  const rail = h('span', 'wr-touch__rail', fill, trimMark, handle)
  const value = h('span', 'wr-touch__value')
  const throttle = h(
    'div',
    'wr-touch__throttle',
    h('span', 'wr-touch__tag wr-touch__readout', value, h('span', 'wr-touch__label', 'throttle')),
    h('span', 'wr-touch__track', rail),
  )

  const padLeft = h('span', 'wr-touch__pad', chevron(-1))
  const padRight = h('span', 'wr-touch__pad', chevron(1))
  const yaw = h('div', 'wr-touch__yaw', h('span', 'wr-touch__tag', h('span', 'wr-touch__label', 'yaw')), h('div', 'wr-touch__pads', padLeft, padRight))

  const el = h('div', { class: 'wr-touch', 'aria-hidden': 'true' }, home, stick, h('div', 'wr-touch__right', yaw, throttle))
  if (target.parentNode) target.after(el)
  else document.body.appendChild(el)

  const draw = (v: TouchView): void => {
    w.flag(el, 'is-on', v.visible)
    w.style(el, '--wr-touch-stick-r', `${v.radius.toFixed(1)}px`)

    w.flag(el, 'is-steering', v.stick !== null)
    if (v.stick) {
      w.style(stick, '--wr-touch-stick-r', `${v.stick.radius.toFixed(1)}px`)
      w.style(stick, 'transform', `translate(${v.stick.origin.x.toFixed(1)}px, ${v.stick.origin.y.toFixed(1)}px)`)
      w.style(knob, 'transform', `translate(${v.stick.knob.x.toFixed(1)}px, ${v.stick.knob.y.toFixed(1)}px)`)
    }

    const t = Math.min(1, Math.max(0, v.throttle))
    w.style(fill, 'transform', `scaleY(${t.toFixed(3)})`)
    w.style(handle, 'transform', `translateY(-${pct(t)})`)
    w.text(value, `${Math.round(t * 100)}%`)
    w.flag(throttle, 'is-held', v.throttleHeld)
    w.flag(trimMark, 'is-off', v.trim === null)
    if (v.trim !== null) w.style(trimMark, 'bottom', pct(Math.min(1, Math.max(0, v.trim))))

    w.flag(padLeft, 'is-held', v.yaw < 0)
    w.flag(padRight, 'is-held', v.yaw > 0)
  }

  return {
    draw,
    hide: () => w.flag(el, 'is-on', false),
    pads: () => ({ left: padLeft.getBoundingClientRect(), right: padRight.getBoundingClientRect() }),
    trackPx: () => rail.getBoundingClientRect().height,
    dispose: () => el.remove(),
  }
}
