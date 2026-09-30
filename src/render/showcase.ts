// Hangar showcase: the selected airframe as a trophy on a slow turntable, framed in the part of the
// canvas the hangar panel leaves free. Pure framing math here; the view blends it with the chase camera.

/** Telephoto-ish lens: flattering proportions, little perspective distortion. */
export const SHOWCASE_FOV = 30
/** Fraction of the canvas width left visible by the hangar panel (panel on the right). */
export const DEFAULT_VISIBLE_FRACTION = 0.6
/** Share of the visible width the aircraft's bounding sphere should fill. */
const FILL = 0.88
/** Camera elevation above the aircraft (rad): barely above, so the backdrop is sky, not sea. */
export const SHOWCASE_ELEVATION = 0.06
/** Camera aims this far above the aircraft (rad): horizon drops low, the trophy stands against the sky. */
export const SHOWCASE_TILT_UP = 0.06
/** Turntable speed (rad/s): a full turn in ~50 s, calm enough to watch. */
export const TURNTABLE_RATE = 0.125

export interface ShowcaseFraming {
  /** Camera distance from the aircraft centre (m). */
  readonly distance: number
  /** Horizontal view offset as a fraction of the canvas width (setViewOffset x = fraction × width). */
  readonly offsetFraction: number
}

/**
 * Distance that fits a bounding sphere of `radius` inside the visible part of the canvas, and the view
 * offset that centres it there. visibleFraction = 0.6 → the aircraft sits centred on the left 60%.
 */
export function showcaseFraming(radius: number, aspect: number, vfovDeg: number, visibleFraction = DEFAULT_VISIBLE_FRACTION): ShowcaseFraming {
  const halfV = (vfovDeg * Math.PI) / 360
  const tanHalfH = Math.tan(halfV) * aspect
  // Angular half-sizes available to the sphere, horizontally (visible band) and vertically.
  const halfWidthAngle = Math.atan(tanHalfH * visibleFraction * FILL)
  const halfHeightAngle = Math.atan(Math.tan(halfV) * FILL)
  const angle = Math.min(halfWidthAngle, halfHeightAngle)
  const distance = radius / Math.sin(angle)
  // Shift the view window right by half the covered part: the look-at point lands mid visible band.
  const offsetFraction = (1 - visibleFraction) / 2
  return { distance, offsetFraction }
}

/** Smooth 0..1 ease for blends. */
export const easeInOut = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}

/** Stable hook the hangar UI exposes on its side panel (see src/ui/screens/hangar.ts). */
export const HANGAR_PANEL_SELECTOR = '[data-hangar-panel]'
/** Breathing room between the aircraft's band and the panel edge (CSS px). */
const PANEL_GAP_PX = 16

/**
 * Fraction of the canvas width left of the hangar panel, or null when no panel is laid out.
 * Pure: takes the two rects so it can be tested without a DOM.
 */
export function visibleFractionFromRects(canvas: { left: number; width: number }, panel: { left: number; width: number } | null): number | null {
  if (!panel || panel.width <= 0 || canvas.width <= 0) return null
  const f = (panel.left - canvas.left - PANEL_GAP_PX) / canvas.width
  // A panel covering (almost) everything, e.g. narrow screens: keep the aircraft centred instead.
  return f < 0.35 ? 1 : Math.min(1, f)
}
