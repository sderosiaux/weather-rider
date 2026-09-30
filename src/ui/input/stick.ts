// Mouse virtual stick as a pure state machine. The stick only steers once the player
// has deliberately taken the controls (pointer lock); it starts at neutral, integrates
// relative movement, and eases back to neutral when the controls are released.
import { smoothToward } from './mapping'

export interface StickState {
  readonly armed: boolean
  /** Virtual offset from neutral (px, screen coords: +y = down). */
  readonly dx: number
  readonly dy: number
}

export type StickEvent =
  | { readonly type: 'lock' }
  | { readonly type: 'unlock' }
  | { readonly type: 'move'; readonly mx: number; readonly my: number; readonly radius: number }
  | { readonly type: 'tick'; readonly dt: number }

/** Window event fired by the screens when a menu takes over (releases the controls). */
export const MENU_EVENT = 'wr-menu'

export const DISARMED: StickState = { armed: false, dx: 0, dy: 0 }

/** Time constant (s) of the glide back to neutral after release. */
export const RELEASE_TAU = 0.35

/** Keep the offset inside the stick circle so pushing past the edge doesn't store travel. */
export const clampToRadius = (dx: number, dy: number, radius: number): { dx: number; dy: number } => {
  const m = Math.hypot(dx, dy)
  if (m <= radius || m === 0) return { dx, dy }
  const k = radius / m
  return { dx: dx * k, dy: dy * k }
}

export const stepStick = (s: StickState, e: StickEvent): StickState => {
  switch (e.type) {
    case 'lock':
      return { armed: true, dx: 0, dy: 0 }
    case 'unlock':
      return { ...s, armed: false }
    case 'move': {
      if (!s.armed) return s
      const c = clampToRadius(s.dx + e.mx, s.dy + e.my, e.radius)
      return { armed: true, dx: c.dx, dy: c.dy }
    }
    case 'tick': {
      if (s.armed || (s.dx === 0 && s.dy === 0)) return s
      const dx = smoothToward(s.dx, 0, e.dt, RELEASE_TAU)
      const dy = smoothToward(s.dy, 0, e.dt, RELEASE_TAU)
      // Snap the tail so "neutral" is exactly zero, not an endless denormal crawl.
      return Math.hypot(dx, dy) < 0.5 ? DISARMED : { armed: false, dx, dy }
    }
  }
}

/** A new flight starts at neutral; if the pointer is still captured the stick stays live (else it could never re-arm). */
export const stickForNewFlight = (pointerLocked: boolean): StickState => (pointerLocked ? { armed: true, dx: 0, dy: 0 } : DISARMED)
