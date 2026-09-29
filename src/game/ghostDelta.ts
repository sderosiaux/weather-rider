import type { Ghost, Route, Vec3 } from '../core/types'

/**
 * Race comparison against a ghost by progress along the route, not by distance between planes:
 * "how many seconds earlier/later did the ghost reach the point of the route I'm at now".
 * Positive = player ahead.
 */
export interface GhostPace {
  deltaS(t: number, pos: Vec3): number
}

const alongTrack = (route: Route, p: Vec3): number => {
  const dx = route.gate.x - route.start.x
  const dz = route.gate.z - route.start.z
  const len = Math.hypot(dx, dz)
  return ((p.x - route.start.x) * dx + (p.z - route.start.z) * dz) / len
}

export function createGhostPace(ghost: Ghost, route: Route): GhostPace {
  const n = ghost.samples.length
  const times = new Float64Array(n)
  // Running max so the curve is monotonic even if the ghost doubled back.
  const reach = new Float64Array(n)
  let best = -Infinity
  ghost.samples.forEach((s, i) => {
    best = Math.max(best, alongTrack(route, s.pos))
    reach[i] = best
    times[i] = s.t
  })
  return {
    deltaS(t, pos) {
      if (n === 0) return 0
      const d = alongTrack(route, pos)
      // Beyond the ghost's furthest point: it stopped there at its last sample.
      if (d > reach[n - 1]!) return times[n - 1]! - t
      let lo = 0
      let hi = n - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (reach[mid]! >= d) hi = mid
        else lo = mid + 1
      }
      if (lo === 0) return times[0]! - t
      const d0 = reach[lo - 1]!
      const d1 = reach[lo]!
      const k = d1 > d0 ? (d - d0) / (d1 - d0) : 1
      const tGhost = times[lo - 1]! + (times[lo]! - times[lo - 1]!) * k
      return tGhost - t
    },
  }
}
