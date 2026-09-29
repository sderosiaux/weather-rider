import { describe, expect, it } from 'vitest'
import { GHOST_HZ, SIM_DT } from '../core/constants'
import { createFixtureGhost, fixtureAircraft, fixtureFlightState, fixtureRoute } from '../core/fixtures'
import { length, qFromAxisAngle, qMul, sub, v3 } from '../core/math'
import { createRng } from '../core/rng'
import type { Ghost, GhostSample, Quat } from '../core/types'
import { fromBase64Url, toBase64Url } from './bytes'
import { createGhostRecorder, ghostCodec } from './index'

const angleBetween = (a: Quat, b: Quat): number => {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
  return 2 * Math.acos(Math.min(1, d))
}
const DEG = Math.PI / 180

const meta = { pilot: 'Zoë ✈', dailyNumber: 272, routeId: fixtureRoute.id, aircraftId: fixtureAircraft.id }

function withSamples(samples: readonly GhostSample[]): Ghost {
  return { ...createFixtureGhost(), samples }
}

/** Rate the encoder picked, read from the wire header. */
const wireHz = (encoded: string): number => fromBase64Url(encoded)[3]!

/** Original vs decoded poses at the encoder's sample times (where the tolerance contract applies). */
function wireErrors(original: Ghost, encoded: string) {
  const hz = wireHz(encoded)
  const decoded = ghostCodec.decode(encoded)
  const t0 = original.samples[0]!.t
  const tEnd = original.samples.at(-1)!.t
  let pos = 0
  let ang = 0
  for (let t = t0; t <= tEnd + 1e-9; t = Math.min(t + 1 / hz, t === tEnd ? Infinity : tEnd)) {
    const a = ghostCodec.poseAt(original, t)
    const b = ghostCodec.poseAt(decoded, t)
    pos = Math.max(pos, length(sub(a.pos, b.pos)))
    ang = Math.max(ang, angleBetween(a.orientation, b.orientation))
  }
  return { pos, ang }
}

/** Every original sample pose vs the decoded ghost at the same time. */
function maxErrors(original: Ghost, decoded: Ghost) {
  let pos = 0
  let ang = 0
  for (const s of original.samples) {
    const p = ghostCodec.poseAt(decoded, s.t)
    pos = Math.max(pos, length(sub(p.pos, s.pos)))
    ang = Math.max(ang, angleBetween(p.orientation, s.orientation))
  }
  return { pos, ang }
}

describe('ghost recorder', () => {
  it('keeps GHOST_HZ samples out of sim-rate states and always ends on the final state', () => {
    const rec = createGhostRecorder(meta)
    const lastT = 10 + 3 * SIM_DT
    for (let i = 0; i * SIM_DT <= lastT + 1e-9; i++) rec.push(fixtureFlightState(i * SIM_DT))
    const ghost = rec.finish(createFixtureGhost().score)

    expect(ghost).toMatchObject({ version: 1, ...meta })
    expect(ghost.samples.length).toBe(10 * GHOST_HZ + 2)
    ghost.samples.slice(0, -1).forEach((s, k) => expect(s.t).toBeCloseTo(k / GHOST_HZ, 9))
    expect(ghost.samples.at(-1)!.t).toBeCloseTo(lastT, 9)
    expect(ghost.samples.at(-1)!.pos).toEqual(fixtureFlightState(ghost.samples.at(-1)!.t).pos)
  })

  it('produces an empty track when nothing was pushed', () => {
    expect(createGhostRecorder(meta).finish(createFixtureGhost().score).samples).toEqual([])
  })
})

describe('ghost codec', () => {
  const ghost = createFixtureGhost()

  it('fits a smooth 10 min flight in 12 KB of URL-safe text at the full 5 Hz', () => {
    const encoded = ghostCodec.encode(ghost)
    expect(ghost.samples.at(-1)!.t).toBeGreaterThan(599)
    expect(encoded.length).toBeLessThanOrEqual(12 * 1024)
    expect(wireHz(encoded)).toBe(5)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('keeps a jittery 10 min flight under 12 KB by lowering the rate, not the precision', () => {
    const rng = createRng(9)
    const jitter = (): number => 3 * (rng() - 0.5)
    const noisy = withSamples(ghost.samples.map((s) => ({
      t: s.t,
      pos: v3(s.pos.x + jitter(), s.pos.y + jitter(), s.pos.z + jitter()),
      orientation: qMul(s.orientation, qFromAxisAngle(v3(rng() - 0.5, rng() - 0.5, rng() - 0.5), jitter() * DEG)),
    })))
    const encoded = ghostCodec.encode(noisy)
    expect(encoded.length).toBeLessThanOrEqual(12 * 1024)
    expect(wireHz(encoded)).toBeLessThan(5)
    const err = wireErrors(noisy, encoded)
    expect(err.pos).toBeLessThan(2)
    expect(err.ang).toBeLessThan(1 * DEG)
  })

  it('round-trips metadata, score and poses within tolerance', () => {
    const decoded = ghostCodec.decode(ghostCodec.encode(ghost))
    expect(decoded.pilot).toBe(ghost.pilot)
    expect(decoded.dailyNumber).toBe(ghost.dailyNumber)
    expect(decoded.routeId).toBe(ghost.routeId)
    expect(decoded.aircraftId).toBe(ghost.aircraftId)
    expect(decoded.score).toEqual(ghost.score)
    expect(decoded.samples[0]!.t).toBe(ghost.samples[0]!.t)
    expect(decoded.samples.at(-1)!.t).toBe(ghost.samples.at(-1)!.t)

    const err = maxErrors(ghost, decoded)
    expect(err.pos).toBeLessThan(2)
    expect(err.ang).toBeLessThan(1 * DEG)
  })

  it('decodes back to GHOST_HZ samples', () => {
    const decoded = ghostCodec.decode(ghostCodec.encode(ghost))
    const dt = decoded.samples[1]!.t - decoded.samples[0]!.t
    expect(dt).toBeCloseTo(1 / GHOST_HZ, 9)
  })

  it('handles a recorded flight with unicode pilot name', () => {
    const rec = createGhostRecorder(meta)
    for (let i = 1; i * SIM_DT <= 120; i++) rec.push(fixtureFlightState(i * SIM_DT))
    const g = rec.finish(ghost.score)
    const decoded = ghostCodec.decode(ghostCodec.encode(g))
    expect(decoded.pilot).toBe('Zoë ✈')
    const err = maxErrors(g, decoded)
    expect(err.pos).toBeLessThan(2)
    expect(err.ang).toBeLessThan(1 * DEG)
  })

  it('handles 0 and 1 samples', () => {
    const empty = ghostCodec.decode(ghostCodec.encode(withSamples([])))
    expect(empty.samples).toEqual([])

    const only = { t: 4.2, pos: v3(1234.5, 3000, -77), orientation: qFromAxisAngle(v3(0, 1, 0), 2) }
    const one = ghostCodec.decode(ghostCodec.encode(withSamples([only])))
    expect(one.samples.length).toBe(1)
    expect(one.samples[0]!.t).toBe(4.2)
    expect(length(sub(one.samples[0]!.pos, only.pos))).toBeLessThan(0.5)
    expect(angleBetween(one.samples[0]!.orientation, only.orientation)).toBeLessThan(0.5 * DEG)
  })

  it('handles a very long flight (1 h)', () => {
    const samples: GhostSample[] = []
    for (let t = 0; t <= 3600; t += 0.1) {
      const s = fixtureFlightState(t)
      samples.push({ t, pos: s.pos, orientation: s.orientation })
    }
    const long = withSamples(samples)
    const encoded = ghostCodec.encode(long)
    expect(wireHz(encoded)).toBe(1)
    const decoded = ghostCodec.decode(encoded)
    expect(decoded.samples.at(-1)!.t).toBe(long.samples.at(-1)!.t)
    const err = wireErrors(long, encoded)
    expect(err.pos).toBeLessThan(2)
    expect(err.ang).toBeLessThan(1 * DEG)
  })

  it('survives violent maneuvers (snap rolls, quaternion sign flips)', () => {
    const samples: GhostSample[] = []
    for (let i = 0; i <= 600; i++) {
      const t = i / GHOST_HZ
      const q = qFromAxisAngle(v3(1, 0.3, 0.2), 3 * t)
      const flip = i % 7 === 0 ? -1 : 1
      samples.push({ t, pos: v3(150 * t, 3000 + 800 * Math.sin(t), 50 * Math.cos(3 * t)), orientation: { x: q.x * flip, y: q.y * flip, z: q.z * flip, w: q.w * flip } })
    }
    const g = withSamples(samples)
    const err = wireErrors(g, ghostCodec.encode(g))
    expect(err.pos).toBeLessThan(2)
    expect(err.ang).toBeLessThan(1 * DEG)
  })

  it('rejects malformed and foreign input with a clear error', () => {
    const good = ghostCodec.encode(ghost)
    expect(() => ghostCodec.decode('')).toThrow(/empty/)
    expect(() => ghostCodec.decode('not a ghost!')).toThrow(/base64url character/)
    expect(() => ghostCodec.decode('eyJoZWxsbyI6MX0')).toThrow(/bad magic/)
    expect(() => ghostCodec.decode(good.slice(0, good.length - 40))).toThrow(/truncated|count|trailing/)
    expect(() => ghostCodec.decode(good + 'AAAA')).toThrow(/trailing/)
    expect(() => ghostCodec.decode(toBase64Url(new Uint8Array([0x57, 0x52, 9, 2])))).toThrow(/unsupported version 9/)
    expect(() => ghostCodec.decode(toBase64Url(new Uint8Array([0x57, 0x52, 1])))).toThrow(/truncated/)
  })
})

describe('poseAt', () => {
  const a = { t: 10, pos: v3(0, 1000, 0), orientation: qFromAxisAngle(v3(0, 1, 0), 0) }
  const b = { t: 12, pos: v3(300, 1100, -40), orientation: qFromAxisAngle(v3(0, 1, 0), 1) }
  const c = { t: 13, pos: v3(400, 1100, -40), orientation: qFromAxisAngle(v3(0, 1, 0), 1) }
  const g = withSamples([a, b, c])

  it('interpolates position linearly and orientation with slerp', () => {
    const p = ghostCodec.poseAt(g, 11.5)
    expect(p.t).toBe(11.5)
    expect(p.pos.x).toBeCloseTo(225, 9)
    expect(p.pos.y).toBeCloseTo(1075, 9)
    expect(p.pos.z).toBeCloseTo(-30, 9)
    expect(angleBetween(p.orientation, qFromAxisAngle(v3(0, 1, 0), 0.75))).toBeLessThan(1e-6)
  })

  it('clamps at both ends', () => {
    expect(ghostCodec.poseAt(g, -5).pos).toEqual(a.pos)
    expect(ghostCodec.poseAt(g, 99).orientation).toEqual(c.orientation)
  })

  it('throws on an empty ghost', () => {
    expect(() => ghostCodec.poseAt(withSamples([]), 0)).toThrow(/no samples/)
  })
})
