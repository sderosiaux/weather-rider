// Pure input shaping: no DOM, no clocks. Everything here is unit-tested.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Zero inside the deadzone, then rescaled so the output still reaches ±1 at full deflection. */
export const deadzone = (v: number, dz: number): number => {
  const a = Math.abs(v)
  if (a <= dz) return 0
  return Math.sign(v) * Math.min(1, (a - dz) / (1 - dz))
}

/** Blend of linear and cubic: k = 0 linear, k = 1 pure cubic. Fine control near center, full authority at the edge. */
export const expo = (v: number, k: number): number => (1 - k) * v + k * v * v * v

export const shapeAxis = (v: number, dz: number, k: number): number => expo(deadzone(clamp(v, -1, 1), dz), k)

export interface StickShape {
  /** Fraction of the stick radius ignored around center. */
  readonly deadzone: number
  readonly expo: number
}

/**
 * Mouse offset from the stick center (px, screen coords: +y = down) → pitch/roll.
 * `radiusPx` is full deflection. Screen-up gives nose-up unless `invertPitch`.
 * The deadzone is radial so diagonal moves don't snap to an axis.
 */
export const stickFromOffset = (
  dx: number,
  dy: number,
  radiusPx: number,
  shape: StickShape,
  invertPitch: boolean,
): { pitch: number; roll: number } => {
  const nx = dx / radiusPx
  const ny = -dy / radiusPx
  const mag = Math.hypot(nx, ny)
  if (mag <= shape.deadzone) return { pitch: 0, roll: 0 }
  const clampedMag = Math.min(1, mag)
  const scaled = (clampedMag - shape.deadzone) / (1 - shape.deadzone)
  const ux = nx / mag
  const uy = ny / mag
  const roll = expo(ux * scaled, shape.expo)
  const pitch = expo(uy * scaled, shape.expo)
  return { pitch: orientPitch(pitch, invertPitch), roll }
}

/** Two digital keys → -1 / 0 / +1. */
export const digitalAxis = (negative: boolean, positive: boolean): number => (positive ? 1 : 0) - (negative ? 1 : 0)

/** Frame-rate independent exponential approach toward target. tau = time constant (s); tau <= 0 snaps. */
export const smoothToward = (current: number, target: number, dt: number, tau: number): number => {
  if (tau <= 0 || dt <= 0) return tau <= 0 ? target : current
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

/** Throttle is persistent state: inputs are rates (per second), never absolute positions. */
export const integrateThrottle = (throttle: number, ratePerS: number, dt: number): number =>
  clamp(throttle + ratePerS * dt, 0, 1)

/** Wheel delta (px, +down like DOM WheelEvent.deltaY) → throttle step. Scroll up = more power. */
export const wheelToThrottleDelta = (deltaY: number, perPx: number): number => -deltaY * perPx

/**
 * Priority mix across devices: the first source actively deflected wins, so a resting
 * mouse offset never fights a held key or a gamepad stick.
 */
export const mixAxis = (sources: readonly number[], epsilon = 1e-3): number => {
  for (const v of sources) if (Math.abs(v) > epsilon) return clamp(v, -1, 1)
  return 0
}

/**
 * Pitch convention. `upInput` is "toward the top of the screen" (mouse up, W/↑, stick pushed forward) in -1..1.
 * Default: up = nose up (arcade). invert: pull back (down, S/↓) = nose up, like a real yoke.
 */
export const orientPitch = (upInput: number, invert: boolean): number => (invert ? -upInput : upInput)

/** Throttle handed over by the shell at flight start (the aircraft's trim). Garbage in → keep the current setting. */
export const flightStartThrottle = (trim: number, current: number): number => (Number.isFinite(trim) ? clamp(trim, 0, 1) : current)
