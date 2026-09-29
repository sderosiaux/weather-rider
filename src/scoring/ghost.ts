import { GHOST_HZ } from '../core/constants'
import { lerpV, qNormalize, qSlerp } from '../core/math'
import type { AircraftState, FlightScore, Ghost, GhostCodec, GhostSample, Quat } from '../core/types'
import { BitReader, BitWriter, ByteReader, ByteWriter, fromBase64Url, toBase64Url } from './bytes'

export interface GhostMeta {
  readonly pilot: string
  readonly dailyNumber: number
  readonly routeId: string
  readonly aircraftId: string
}

const EPS_T = 1e-6

/** Keeps one state every 1/GHOST_HZ s out of sim-rate states, plus the final state. */
export function createGhostRecorder(meta: GhostMeta): { push(state: AircraftState): void; finish(score: FlightScore): Ghost } {
  const samples: GhostSample[] = []
  let nextT = -Infinity
  let last: AircraftState | null = null

  const toSample = (s: AircraftState): GhostSample => ({ t: s.t, pos: s.pos, orientation: s.orientation })

  return {
    push(state) {
      last = state
      if (state.t < nextT - EPS_T) return
      samples.push(toSample(state))
      nextT = (Math.floor(state.t * GHOST_HZ + EPS_T) + 1) / GHOST_HZ
    },
    finish(score) {
      const tail = samples[samples.length - 1]
      const all = last && (!tail || last.t > tail.t) ? [...samples, toSample(last)] : [...samples]
      return { version: 1, ...meta, score, samples: all }
    },
  }
}

// ─── Wire format (all integers are LEB128 varints, s = zigzag-signed) ───────
//   'W' 'R' version=1 encodeHz
//   pilot routeId aircraftId (uvarint length + UTF-8)   dailyNumber(u)
//   status(byte) + 11 score fields (f64, FlightScore key order)
//   count(u) [t0 f64, tEnd f64]
//   bitstream, per sample: pos x,y,z then quat x,y,z,w (signed Exp-Golomb), zero-padded
// encodeHz is the first of ENCODE_RATES whose output fits TARGET_CHARS (a smooth 10 min
// flight fits at 5 Hz; a jittery one falls back to 2 or 1 Hz rather than losing precision).
// Samples are re-taken at encodeHz via poseAt (plus the exact final pose), quantized
// (POS_Q m, QUAT_Q per component) and stored as second-order residuals:
// r[i] = q[i] − (2·q[i−1] − q[i−2]). Smooth flight → residuals of a few units → a few bits.
// Quaternions are sign-aligned with their predecessor so the sequence stays continuous.
const MAGIC_0 = 0x57 // 'W'
const MAGIC_1 = 0x52 // 'R'
const WIRE_VERSION = 1
/** Each must divide GHOST_HZ: the decoder re-grids to GHOST_HZ, which then passes through every wire pose. */
const ENCODE_RATES = [5, 2, 1] as const
const TARGET_CHARS = 12 * 1024
const POS_Q = 0.5 // m
const QUAT_Q = 1 / 1024
/** Guards decode against absurd counts from forged input (≈ 5.5 h at 5 Hz). */
const MAX_SAMPLES = 100_000

const STATUSES = ['flying', 'arrived', 'crashed', 'overstressed'] as const
const SCORE_KEYS = [
  'simTimeS', 'displayTimeS', 'fuelUsedKg', 'fuelRemainingPct', 'comfort', 'severeTurbulenceS',
  'stress', 'weatherUtilization', 'smooth', 'speed', 'eco',
] as const satisfies readonly Exclude<keyof FlightScore, 'status'>[]

/** Sample times on the wire: t0, t0 + 1/hz, … strictly before tEnd, then tEnd. */
function wireTimes(t0: number, tEnd: number, hz: number): number[] {
  const times: number[] = []
  for (let i = 0; ; i++) {
    const t = t0 + i / hz
    if (t >= tEnd - EPS_T) break
    times.push(t)
  }
  times.push(tEnd)
  return times
}

function resampleTimes(t0: number, tEnd: number, hz: number): number[] {
  return tEnd - t0 < EPS_T ? [t0] : wireTimes(t0, tEnd, hz)
}

function poseAt(ghost: Ghost, t: number): GhostSample {
  return poseAtSamples(ghost.samples, t)
}

function poseAtSamples(s: readonly GhostSample[], t: number): GhostSample {
  if (s.length === 0) throw new Error('ghost has no samples')
  const first = s[0]!
  const lastS = s[s.length - 1]!
  if (t <= first.t) return { t, pos: first.pos, orientation: first.orientation }
  if (t >= lastS.t) return { t, pos: lastS.pos, orientation: lastS.orientation }
  let lo = 0
  let hi = s.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s[mid]!.t <= t) lo = mid
    else hi = mid
  }
  const a = s[lo]!
  const b = s[hi]!
  const u = (t - a.t) / (b.t - a.t)
  return { t, pos: lerpV(a.pos, b.pos, u), orientation: qSlerp(a.orientation, b.orientation, u) }
}

function encode(ghost: Ghost): string {
  let out = ''
  for (const hz of ENCODE_RATES) {
    out = encodeAt(ghost, hz)
    if (out.length <= TARGET_CHARS) break
  }
  return out
}

function encodeAt(ghost: Ghost, hz: number): string {
  const w = new ByteWriter()
  w.byte(MAGIC_0)
  w.byte(MAGIC_1)
  w.byte(WIRE_VERSION)
  w.byte(hz)
  w.str(ghost.pilot)
  w.str(ghost.routeId)
  w.str(ghost.aircraftId)
  w.uvarint(ghost.dailyNumber)
  const status = STATUSES.indexOf(ghost.score.status)
  if (status < 0) throw new Error(`ghost codec: unknown status ${ghost.score.status}`)
  w.byte(status)
  for (const k of SCORE_KEYS) w.f64(ghost.score[k])

  const n = ghost.samples.length
  if (n === 0) {
    w.uvarint(0)
    return toBase64Url(w.bytes())
  }
  const t0 = ghost.samples[0]!.t
  const tEnd = ghost.samples[n - 1]!.t
  const times = resampleTimes(t0, tEnd, hz)
  w.uvarint(times.length)
  w.f64(t0)
  w.f64(tEnd)

  const bits = new BitWriter()
  const prev1 = new Array<number>(7).fill(0)
  const prev2 = new Array<number>(7).fill(0)
  let prevQ: Quat | null = null
  times.forEach((t, i) => {
    const p = poseAt(ghost, t)
    let q = qNormalize(p.orientation)
    if (prevQ && q.x * prevQ.x + q.y * prevQ.y + q.z * prevQ.z + q.w * prevQ.w < 0) q = { x: -q.x, y: -q.y, z: -q.z, w: -q.w }
    prevQ = q
    const cur = [
      Math.round(p.pos.x / POS_Q), Math.round(p.pos.y / POS_Q), Math.round(p.pos.z / POS_Q),
      Math.round(q.x / QUAT_Q), Math.round(q.y / QUAT_Q), Math.round(q.z / QUAT_Q), Math.round(q.w / QUAT_Q),
    ]
    for (let c = 0; c < 7; c++) {
      const pred = i === 0 ? 0 : i === 1 ? prev1[c]! : 2 * prev1[c]! - prev2[c]!
      bits.sgolomb(cur[c]! - pred)
      prev2[c] = prev1[c]!
      prev1[c] = cur[c]!
    }
  })
  w.raw(bits.bytes())
  return toBase64Url(w.bytes())
}

function decode(encoded: string): Ghost {
  if (typeof encoded !== 'string' || encoded.length === 0) throw new Error('ghost codec: empty input')
  const r = new ByteReader(fromBase64Url(encoded))
  if (r.byte() !== MAGIC_0 || r.byte() !== MAGIC_1) throw new Error('ghost codec: not a Weather Rider ghost (bad magic)')
  const version = r.byte()
  if (version !== WIRE_VERSION) throw new Error(`ghost codec: unsupported version ${version}`)
  const hz = r.byte()
  if (hz === 0) throw new Error('ghost codec: invalid sample rate 0')
  const pilot = r.str()
  const routeId = r.str()
  const aircraftId = r.str()
  const dailyNumber = r.uvarint()
  const status = STATUSES[r.byte()]
  if (!status) throw new Error('ghost codec: invalid status')
  const fields: Record<string, number> = {}
  for (const k of SCORE_KEYS) {
    const v = r.f64()
    if (!Number.isFinite(v)) throw new Error(`ghost codec: invalid score field ${k}`)
    fields[k] = v
  }
  const score = { status, ...fields } as unknown as FlightScore

  const count = r.uvarint()
  if (count > MAX_SAMPLES) throw new Error(`ghost codec: too many samples (${count})`)
  const samples: GhostSample[] = []
  if (count > 0) {
    const t0 = r.f64()
    const tEnd = r.f64()
    if (!Number.isFinite(t0) || !Number.isFinite(tEnd) || tEnd < t0) throw new Error('ghost codec: invalid time range')
    if ((tEnd - t0) * hz > MAX_SAMPLES) throw new Error('ghost codec: time range too long')
    const times = resampleTimes(t0, tEnd, hz)
    if (times.length !== count) throw new Error('ghost codec: sample count does not match time range')
    const bits = new BitReader(r.rest())
    const prev1 = new Array<number>(7).fill(0)
    const prev2 = new Array<number>(7).fill(0)
    const cur = new Array<number>(7).fill(0)
    const wire: GhostSample[] = times.map((t, i) => {
      for (let c = 0; c < 7; c++) {
        const pred = i === 0 ? 0 : i === 1 ? prev1[c]! : 2 * prev1[c]! - prev2[c]!
        cur[c] = pred + bits.sgolomb()
        prev2[c] = prev1[c]!
        prev1[c] = cur[c]!
      }
      const q = { x: cur[3]! * QUAT_Q, y: cur[4]! * QUAT_Q, z: cur[5]! * QUAT_Q, w: cur[6]! * QUAT_Q }
      if (Math.hypot(q.x, q.y, q.z, q.w) < 0.5) throw new Error('ghost codec: corrupt orientation')
      return { t, pos: { x: cur[0]! * POS_Q, y: cur[1]! * POS_Q, z: cur[2]! * POS_Q }, orientation: qNormalize(q) }
    })
    // Back to GHOST_HZ so consumers see the rate the contract promises.
    bits.end()
    for (const t of resampleTimes(t0, tEnd, GHOST_HZ)) samples.push(poseAtSamples(wire, t))
  }
  if (r.remaining !== 0) throw new Error('ghost codec: trailing data')
  return { version: 1, pilot, dailyNumber, routeId, aircraftId, score, samples }
}

export const ghostCodec: GhostCodec = { encode, decode, poseAt }
