// Touch stick → pitch/roll. Same curves as the mouse stick (radial deadzone, expo, invertPitch),
// sized for a thumb. Neutral is wherever the thumb landed, so touching down never commands anything.
import { clamp, stickFromOffset, type StickShape } from '../input/mapping'

export interface Point {
  readonly x: number
  readonly y: number
}

/** Screen rectangle (px, client coords). */
export interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** Thumb travel (px) from the landing point to full deflection, per direction. Screen coords: up = -y. */
export interface Reach {
  readonly left: number
  readonly right: number
  readonly up: number
  readonly down: number
}

/** A thumb jitters more than a mouse: slightly wider deadzone, a bit less expo. */
export const TOUCH_SHAPE: StickShape = { deadzone: 0.1, expo: 0.4 }

/** Full deflection as a share of the smaller viewport side: 13–17 mm of thumb travel on iPads (132 CSS px per inch). */
const RADIUS_FRACTION = 0.09
const MIN_RADIUS = 56
const MAX_RADIUS = 88
/** Near an edge the reach toward it shrinks to the room left, but never below this share of the radius. */
const MIN_REACH = 0.45
/** Screen edges swallow touches (system gestures, bezel): full deflection lands this far inside. */
const EDGE_MARGIN = 6

export const touchStickRadius = (width: number, height: number): number =>
  clamp(Math.min(width, height) * RADIUS_FRACTION, MIN_RADIUS, MAX_RADIUS)

/**
 * A thumb that lands near an edge still reaches full deflection toward that edge, over a shorter travel.
 * Without this, a stick started 40 px from the left edge could never command full left roll.
 */
export const stickReach = (origin: Point, surface: Rect, radius: number): Reach => {
  const fit = (room: number): number => clamp(room - EDGE_MARGIN, radius * MIN_REACH, radius)
  return {
    left: fit(origin.x - surface.left),
    right: fit(surface.right - origin.x),
    up: fit(origin.y - surface.top),
    down: fit(surface.bottom - origin.y),
  }
}

/** Thumb offset as a fraction of the reach in its direction: 1 = full deflection, beyond 1 saturates. */
export const stickDeflection = (origin: Point, at: Point, reach: Reach): Point => {
  const dx = at.x - origin.x
  const dy = at.y - origin.y
  return { x: dx / (dx < 0 ? reach.left : reach.right), y: dy / (dy < 0 ? reach.up : reach.down) }
}

/** Screen-up is nose-up unless `invertPitch`; right is roll right. */
export const touchStickAxes = (origin: Point, at: Point, reach: Reach, invertPitch: boolean): { pitch: number; roll: number } => {
  const d = stickDeflection(origin, at, reach)
  return stickFromOffset(d.x, d.y, 1, TOUCH_SHAPE, invertPitch)
}

/** Knob position (px from the ring center): follows the thumb, stops at the ring, so the drawing matches the command. */
export const knobOffset = (origin: Point, at: Point, reach: Reach, radius: number): Point => {
  const d = stickDeflection(origin, at, reach)
  const m = Math.hypot(d.x, d.y)
  const k = m > 1 ? radius / m : radius
  return { x: d.x * k, y: d.y * k }
}
