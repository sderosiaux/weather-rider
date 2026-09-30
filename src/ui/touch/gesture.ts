// Multi-touch as a pure state machine. Each finger gets one role for its whole life, decided by where it
// lands: left half = floating stick, yaw pads, anything else = throttle lever. A role already held ignores
// extra fingers (a second thumb or a resting palm can't hijack the stick); lifting a finger frees only its role.
import { stickReach, touchStickRadius, type Point, type Reach, type Rect } from './axis'
import { dragThrottle } from './slider'

export type Yaw = -1 | 1

export interface StickHold {
  readonly id: number
  /** Landing point = neutral. */
  readonly origin: Point
  readonly at: Point
  readonly radius: number
  readonly reach: Reach
}

export interface ThrottleHold {
  readonly id: number
  readonly y: number
  readonly trackPx: number
  /** Setting while held: the lever in the hand wins over keys and wheel. */
  readonly throttle: number
}

export interface YawHold {
  readonly id: number
  readonly dir: Yaw
  /** Between the two pads: sliding across it switches direction without lifting. */
  readonly splitX: number
}

export interface TouchState {
  readonly stick: StickHold | null
  readonly throttle: ThrottleHold | null
  readonly yaw: YawHold | null
}

export type Landing =
  | { readonly role: 'stick'; readonly radius: number; readonly reach: Reach }
  | { readonly role: 'throttle'; readonly trackPx: number; readonly throttle: number }
  | { readonly role: 'yaw'; readonly dir: Yaw; readonly splitX: number }

export type FingerEvent =
  | { readonly type: 'down'; readonly id: number; readonly at: Point; readonly landing: Landing }
  | { readonly type: 'move'; readonly id: number; readonly at: Point }
  /** Lifted or cancelled by the browser. */
  | { readonly type: 'up'; readonly id: number }
  /** Menu, new flight, page hidden: every finger lets go. */
  | { readonly type: 'release' }

export const NO_TOUCH: TouchState = { stick: null, throttle: null, yaw: null }

/** Fingers are fat: the pads catch touches this far outside their drawn edge. */
export const PAD_SLOP = 10

export interface LandingContext {
  readonly surface: Rect
  /** Yaw pads as drawn, or null while the layer is hidden: an invisible button must never fire. */
  readonly pads: { readonly left: Rect; readonly right: Rect } | null
  /** Throttle track length on screen (px): a full track is the full range. */
  readonly trackPx: number
  /** Current setting: the lever starts from it. */
  readonly throttle: number
}

const inside = (p: Point, r: Rect, slop: number): boolean =>
  p.x >= r.left - slop && p.x <= r.right + slop && p.y >= r.top - slop && p.y <= r.bottom + slop

export const landingAt = (p: Point, ctx: LandingContext): Landing => {
  const { surface, pads } = ctx
  if (pads && (inside(p, pads.left, PAD_SLOP) || inside(p, pads.right, PAD_SLOP))) {
    const splitX = (pads.left.right + pads.right.left) / 2
    return { role: 'yaw', dir: p.x < splitX ? -1 : 1, splitX }
  }
  if (p.x < (surface.left + surface.right) / 2) {
    const radius = touchStickRadius(surface.right - surface.left, surface.bottom - surface.top)
    return { role: 'stick', radius, reach: stickReach(p, surface, radius) }
  }
  return { role: 'throttle', trackPx: ctx.trackPx, throttle: ctx.throttle }
}

const without = (s: TouchState, id: number): TouchState =>
  s.stick?.id === id || s.throttle?.id === id || s.yaw?.id === id
    ? {
        stick: s.stick?.id === id ? null : s.stick,
        throttle: s.throttle?.id === id ? null : s.throttle,
        yaw: s.yaw?.id === id ? null : s.yaw,
      }
    : s

const land = (s: TouchState, id: number, at: Point, l: Landing): TouchState => {
  switch (l.role) {
    case 'stick':
      return s.stick ? s : { ...s, stick: { id, origin: at, at, radius: l.radius, reach: l.reach } }
    case 'throttle':
      return s.throttle ? s : { ...s, throttle: { id, y: at.y, trackPx: l.trackPx, throttle: l.throttle } }
    case 'yaw':
      return s.yaw ? s : { ...s, yaw: { id, dir: l.dir, splitX: l.splitX } }
  }
}

const move = (s: TouchState, id: number, at: Point): TouchState => {
  const { stick, throttle, yaw } = s
  if (stick?.id === id) return { ...s, stick: { ...stick, at } }
  if (throttle?.id === id) {
    return { ...s, throttle: { ...throttle, y: at.y, throttle: dragThrottle(throttle.throttle, throttle.y, at.y, throttle.trackPx) } }
  }
  if (yaw?.id === id) {
    const dir: Yaw = at.x < yaw.splitX ? -1 : 1
    return dir === yaw.dir ? s : { ...s, yaw: { ...yaw, dir } }
  }
  return s
}

const finite = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y)

export const stepTouch = (s: TouchState, e: FingerEvent): TouchState => {
  switch (e.type) {
    case 'release':
      return NO_TOUCH
    case 'up':
      return without(s, e.id)
    case 'down':
      // A reused id means its 'up' never arrived (focus lost, gesture taken by the system): start it clean.
      return finite(e.at) ? land(without(s, e.id), e.id, e.at, e.landing) : s
    case 'move':
      return finite(e.at) ? move(s, e.id, e.at) : s
  }
}
