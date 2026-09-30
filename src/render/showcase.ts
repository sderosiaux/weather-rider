// Hangar showcase: the selected airframe as a trophy on a slow turntable, framed from the canvas size
// alone (contract: WorldView.setShowcase). Pure framing math here; the view blends it with the chase camera.

/** Telephoto-ish lens: flattering proportions, little perspective distortion. */
export const SHOWCASE_FOV = 30

/**
 * Where the aircraft may sit, as fractions of the canvas (x from the left, y from the top). The hangar
 * UI keeps this box clear at every supported size: its panel starts at ≥ 58.8% of the width, the
 * title/back row ends ≤ 11% from the top, the caption starts ≤ 16% from the bottom.
 */
export const SAFE_BOX = { x0: 0.05, x1: 0.55, y0: 0.15, y1: 0.78 } as const
export type SafeBox = { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }

/** Share of the safe box the aircraft's bounding sphere fills (the box is already a margin). */
const FILL = 0.95
/**
 * Camera elevation relative to the aircraft (rad). Slightly below: the horizon then sits under the
 * trophy and the backdrop is sky, not sea.
 */
export const SHOWCASE_ELEVATION = -0.03
/** Turntable speed (rad/s): a full turn in ~50 s, calm enough to watch. */
export const TURNTABLE_RATE = 0.125

export interface ShowcaseFraming {
  /** Camera distance from the aircraft centre (m). */
  readonly distance: number
  /** View offset as fractions of the canvas (setViewOffset x = offsetX × width, y = offsetY × height). */
  readonly offsetX: number
  readonly offsetY: number
}

/**
 * Distance that fits a bounding sphere of `radius` inside the safe box, and the view offset that moves
 * the look-at point (screen centre) to the centre of the box.
 */
export function showcaseFraming(radius: number, aspect: number, vfovDeg: number, box: SafeBox = SAFE_BOX): ShowcaseFraming {
  const tanHalfV = Math.tan((vfovDeg * Math.PI) / 360)
  const tanHalfH = tanHalfV * aspect
  // Screen-space half extents of the box, as a share of the half screen, turned into view angles.
  const tanX = tanHalfH * (box.x1 - box.x0) * FILL
  const tanY = tanHalfV * (box.y1 - box.y0) * FILL
  const angle = Math.atan(Math.min(tanX, tanY))
  const distance = radius / Math.sin(angle)
  // Moving the view window right/down by d moves the content left/up by d.
  const offsetX = 0.5 - (box.x0 + box.x1) / 2
  const offsetY = 0.5 - (box.y0 + box.y1) / 2
  return { distance, offsetX, offsetY }
}

/** Smooth 0..1 ease for blends. */
export const easeInOut = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}
