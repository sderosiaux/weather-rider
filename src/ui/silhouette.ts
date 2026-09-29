// Top-down aircraft silhouettes for the title picker and the hangar. Nose up.
import type { AircraftClass } from '../core/types'
import { svg } from './dom'

type Pt = readonly [number, number]
interface Shape {
  /** Right half of the outline, nose to tail, x >= 0. Mirrored to close the polygon. */
  readonly half: readonly Pt[]
  /** Engine pods on the right side (mirrored): cx, cy, rx, ry. */
  readonly pods: readonly (readonly [number, number, number, number])[]
}

const SHAPES: Record<AircraftClass, Shape> = {
  turboprop: {
    half: [[0, 4], [2.5, 7], [4, 13], [4, 35], [44, 37], [45, 43], [4, 46], [3.4, 82], [16, 86], [16, 90], [2, 92], [0, 96]],
    pods: [[15, 35, 2.4, 6]],
  },
  regional: {
    half: [[0, 2], [2.5, 6], [3.6, 13], [3.6, 40], [36, 53], [37, 57], [3.6, 52], [3.4, 80], [14, 90], [14, 93], [2, 93], [0, 97]],
    pods: [[7.5, 76, 2.6, 6.5]],
  },
  narrowbody: {
    half: [[0, 1], [3, 6], [4.6, 14], [4.6, 36], [45, 56], [45, 60], [4.6, 50], [4, 82], [17, 92], [17, 95], [2, 94], [0, 98]],
    pods: [[17, 41, 3, 6.5]],
  },
  widebody: {
    half: [[0, 0.5], [4, 5], [6.2, 14], [6.2, 35], [50, 58], [50, 62], [6.2, 50], [5.6, 84], [21, 94], [21, 97], [2.5, 96], [0, 99]],
    pods: [[20, 41, 4, 7.5]],
  },
  cargo: {
    half: [[0, 1], [4.5, 5], [6.4, 12], [6.4, 33], [49, 44], [49, 48.5], [6.4, 46], [5.4, 84], [20, 89], [20, 94], [2, 94], [0, 98]],
    pods: [[18, 37, 2.8, 5.5], [33, 41, 2.6, 5]],
  },
  supersonic: {
    half: [[0, 0], [1.4, 8], [3, 22], [3.2, 42], [14, 66], [30, 86], [30, 91], [3, 89], [2, 95], [0, 97]],
    pods: [],
  },
  experimental: {
    half: [[0, 14], [5, 20], [50, 62], [50, 66], [41, 68], [31, 63], [21, 71], [11, 65], [0, 71]],
    pods: [],
  },
}

const outline = (half: readonly Pt[]): string => {
  const right = half.map(([x, y]) => `${x},${y}`)
  const left = [...half].reverse().filter(([x]) => x !== 0).map(([x, y]) => `${-x},${y}`)
  return [...right, ...left].join(' ')
}

/** `fill` is the livery color (data) or a CSS var reference. */
export const aircraftSilhouette = (cls: AircraftClass, fill: string): SVGSVGElement => {
  const s = SHAPES[cls]
  const pods = s.pods.flatMap(([cx, cy, rx, ry]) => [
    svg('ellipse', { cx, cy, rx, ry, class: 'wr-sil__pod' }),
    svg('ellipse', { cx: -cx, cy, rx, ry, class: 'wr-sil__pod' }),
  ])
  const body = svg('polygon', { points: outline(s.half), class: 'wr-sil__body' })
  body.style.setProperty('fill', fill)
  return svg('svg', { viewBox: '-54 -2 108 104', class: 'wr-sil', 'aria-hidden': 'true' }, ...pods, body)
}
