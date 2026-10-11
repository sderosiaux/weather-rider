// Cities: the departure behind the start, the arrival under the gate, towns on rivers and coasts along the way
// (and further out, so the horizon has lights too).
import { CELL, type Raster } from './bake'
import type { ChannelLine } from './rivers'
import { alongOf, lateralOf, type JourneyPlan } from './plan'

const KM = 1000

export interface PlacedCity {
  readonly name: string
  readonly x: number
  readonly z: number
  readonly radius: number
  readonly role: 'departure' | 'arrival' | 'town'
}

const HEADS = ['Val', 'Mont', 'Bel', 'Ros', 'Kar', 'Lin', 'Brae', 'Ost', 'Fen', 'Mar', 'Cor', 'Ald', 'Sar', 'Tor', 'Vel', 'Hal', 'Nor', 'Ash', 'Elm', 'Bran', 'Cal', 'Dun', 'Ever', 'Gal', 'Har', 'Kel', 'Lor', 'Mel', 'Oak', 'Pen', 'Quin', 'Red', 'Sil', 'Tal', 'Wes', 'Arn']
const TAILS = ['mont', 'haven', 'bury', 'stad', 'ville', 'dal', 'wick', 'holm', 'burg', 'lan', 'mere', 'field', 'ridge', 'by', 'ton', 'leigh', 'more', 'gard']
const RIVER_TAILS = ['ford', 'bridge', 'brook', 'water']
const COAST_TAILS = ['port', 'mouth', 'sands', 'haven']

interface Candidate {
  readonly x: number
  readonly z: number
  readonly score: number
  readonly kind: 'river' | 'coast'
}

export interface PlaceInput {
  readonly plan: JourneyPlan
  readonly raster: Raster
  readonly channels: readonly ChannelLine[]
  readonly departureName: string
  readonly arrivalName: string
  readonly macroAt: (x: number, z: number) => number
  /** Ground height before any city is flattened in. */
  readonly heightAt: (x: number, z: number) => number
  readonly ridgeAmpAt: (x: number, z: number) => number
  readonly inLake: (x: number, z: number) => boolean
  readonly rng: () => number
}

export function placeCities(inp: PlaceInput): PlacedCity[] {
  const { plan, rng, macroAt } = inp
  const f = plan.frame
  const L = f.length
  // Cities stand on land: slide the departure inland (forward), the arrival back, until the ground is dry.
  const settle = (x0: number, z0: number, dir: number): { x: number; z: number } => {
    let x = x0
    let z = z0
    for (let k = 0; k < 14 && (macroAt(x, z) < 8 || inp.heightAt(x, z) < 5 || inp.inLake(x, z)); k++) {
      x += f.dirX * 600 * dir
      z += f.dirZ * 600 * dir
    }
    return { x, z }
  }
  const dep = settle(plan.departure.x, plan.departure.z, 1)
  const arr = settle(plan.arrival.x, plan.arrival.z, -1)
  const cities: PlacedCity[] = [
    { name: inp.departureName, ...dep, radius: plan.departure.radius, role: 'departure' },
    { name: inp.arrivalName, ...arr, radius: plan.arrival.radius, role: 'arrival' },
  ]

  const habitable = (x: number, z: number): boolean => {
    const m = macroAt(x, z)
    return m > 3 && m < 700 && inp.heightAt(x, z) > 5 && inp.ridgeAmpAt(x, z) < 120 && !inp.inLake(x, z)
  }
  const candidates: Candidate[] = []
  for (const c of inp.channels) {
    for (let i = 0; i < c.xs.length; i += 3) {
      const x = c.xs[i]!
      const z = c.zs[i]!
      if (c.width[i]! >= 120 && habitable(x, z)) candidates.push({ x, z, score: rng() + c.width[i]! / 600, kind: 'river' })
    }
  }
  const { ox, oz, nx, nz } = inp.raster
  for (let j = 1; j < nz - 1; j += 2) {
    for (let i = 1; i < nx - 1; i += 2) {
      const x = ox + i * CELL
      const z = oz + j * CELL
      const m = macroAt(x, z)
      if (m < 4 || m > 30) continue
      const coastal = macroAt(x + CELL, z) <= 0 || macroAt(x - CELL, z) <= 0 || macroAt(x, z + CELL) <= 0 || macroAt(x, z - CELL) <= 0
      if (coastal && habitable(x, z)) candidates.push({ x, z, score: rng() * 0.9, kind: 'coast' })
    }
  }
  candidates.sort((a, b) => b.score - a.score)

  const used = new Set<string>()
  const name = (kind: Candidate['kind']): string => {
    for (let k = 0; k < 40; k++) {
      const head = HEADS[Math.floor(rng() * HEADS.length)]!
      const pool = rng() < 0.45 ? (kind === 'river' ? RIVER_TAILS : COAST_TAILS) : TAILS
      const n = head + pool[Math.floor(rng() * pool.length)]!
      if (!used.has(n) && n !== inp.departureName && n !== inp.arrivalName) {
        used.add(n)
        return n
      }
    }
    return `${HEADS[cities.length % HEADS.length]!}${cities.length}`
  }
  const pick = (want: number, spacing: number, radius: () => number, accept: (s: number, n: number) => boolean): void => {
    let got = 0
    for (const c of candidates) {
      if (got >= want) break
      const s = alongOf(f, c.x, c.z)
      const n = lateralOf(f, c.x, c.z)
      if (!accept(s, n)) continue
      if (cities.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < spacing)) continue
      cities.push({ name: name(c.kind), x: c.x, z: c.z, radius: radius(), role: 'town' })
      got++
    }
  }
  // Towns along the way, then the scattered ones out to the horizon.
  pick(3 + Math.floor(rng() * 3), 13 * KM, () => (1.2 + rng()) * KM, (s, n) => s > 10 * KM && s < L - 8 * KM && Math.abs(n) < 16 * KM)
  pick(9 + Math.floor(rng() * 5), 18 * KM, () => (1 + rng() * 1.5) * KM, (s, n) => s > -90 * KM && s < L + 90 * KM && Math.abs(n) < 95 * KM)
  return cities
}
