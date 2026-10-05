import type { CreateWeather } from '../core/types'
import { createSampler } from './field'
import { generateLayout } from './layout'

/**
 * Procedural weather: westerly background, storms and lift columns biased along the corridor,
 * a low jet beside the corridor (4–5.5 km, fading out before the gate) and a high jet at 9–12 km, both with
 * shear layers, traffic wakes, and turbulence-scaled gusts.
 *
 * Jet `radius` is the horizontal half-width; the tube is flattened vertically (≈1.4–1.9 km half-thickness).
 * Published extents stop where the feature falls below half strength: a jet `path` runs exactly where its core
 * blows at ≥ half its `speed`, shear layers where their turbulence is ≥ half, wake tracks short of their tapered
 * ends. Past a path's end the jet is weaker than that: the low jet's path stops halfway through its fade before
 * the gate and the jet is gone ≤ 7 km further; at the bounds' x sides paths stop ≤ 2 km short; a core that
 * crosses a z side splits into several features.
 * Wakes move: each path is flown periodically and its wake only exists for a short window behind the traffic.
 */
export const createWeather: CreateWeather = (params) => {
  const layout = generateLayout(params)
  return {
    seed: params.seed,
    boundsMin: params.boundsMin,
    boundsMax: params.boundsMax,
    sample: createSampler(params, layout),
    features: layout.features,
  }
}
