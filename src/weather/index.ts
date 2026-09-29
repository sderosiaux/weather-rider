import type { CreateWeather } from '../core/types'
import { createSampler } from './field'
import { generateLayout } from './layout'

/**
 * Procedural weather: westerly background, storms and lift columns biased along the corridor,
 * meandering jets at 9–12 km with shear layers, traffic wakes, and turbulence-scaled gusts.
 *
 * Jet `radius` is the horizontal half-width; the tube is flattened vertically (≈1.4–1.9 km half-thickness).
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
