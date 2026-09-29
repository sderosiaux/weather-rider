import { describe, expect, it } from 'vitest'
import type { AudioFrame } from '../core/presentation'
import type { AircraftClass } from '../core/types'
import { computeMix, NEUTRAL_FRAME, VERTICAL_THRESHOLD_MS, type MixTargets } from './mix'
import { ENGINE_VOICES, MENU_CHORD_S, MENU_CHORDS, menuChordIndex } from './voices'

const cruise: AudioFrame = { ...NEUTRAL_FRAME, airspeedMs: 220, throttle: 0.6, turbulence: 0.1 }
const fly = (over: Partial<AudioFrame>): MixTargets => computeMix({ ...cruise, ...over }, 'flight')
const CLASSES = Object.keys(ENGINE_VOICES) as AircraftClass[]

describe('wind bed', () => {
  it('gets louder, brighter and wider with airspeed', () => {
    const speeds = [0, 60, 140, 220, 300, 540]
    const mixes = speeds.map((airspeedMs) => fly({ airspeedMs }))
    for (let i = 1; i < mixes.length; i++) {
      expect(mixes[i]!.windLevel).toBeGreaterThan(mixes[i - 1]!.windLevel)
      expect(mixes[i]!.windCutoffHz).toBeGreaterThanOrEqual(mixes[i - 1]!.windCutoffHz)
      expect(mixes[i]!.windWidth).toBeGreaterThanOrEqual(mixes[i - 1]!.windWidth)
    }
  })
  it('gusts deeper and faster with turbulence', () => {
    const calm = fly({ turbulence: 0 })
    const rough = fly({ turbulence: 0.8 })
    expect(rough.gustDepth).toBeGreaterThan(calm.gustDepth)
    expect(rough.gustHz).toBeGreaterThan(calm.gustHz)
    // Gusts are slow swells, never an audible-rate flutter.
    expect(rough.gustHz).toBeLessThan(1)
  })
})

describe('rising and sinking air', () => {
  it('is silent below the threshold, then grows with strength', () => {
    expect(fly({ verticalWindMs: VERTICAL_THRESHOLD_MS - 0.5 }).shimmerLevel).toBe(0)
    expect(fly({ verticalWindMs: -(VERTICAL_THRESHOLD_MS - 0.5) }).sinkLevel).toBe(0)
    const ups = [4, 8, 14, 25].map((verticalWindMs) => fly({ verticalWindMs }))
    for (let i = 1; i < ups.length; i++) {
      expect(ups[i]!.shimmerLevel).toBeGreaterThanOrEqual(ups[i - 1]!.shimmerLevel)
      expect(ups[i]!.shimmerPitch).toBeGreaterThan(ups[i - 1]!.shimmerPitch)
    }
    expect(ups[0]!.shimmerLevel).toBeGreaterThan(0)
  })
  it('updraft shimmers, downdraft darkens: never both', () => {
    const up = fly({ verticalWindMs: 12 })
    const down = fly({ verticalWindMs: -12 })
    expect(up.shimmerLevel).toBeGreaterThan(0)
    expect(up.sinkLevel).toBe(0)
    expect(down.sinkLevel).toBeGreaterThan(0)
    expect(down.shimmerLevel).toBe(0)
    expect(fly({ verticalWindMs: -25 }).sinkPitch).toBeLessThan(fly({ verticalWindMs: -6 }).sinkPitch)
  })
})

describe('features', () => {
  it('jet stream pad only inside a jet stream', () => {
    expect(fly({ dominant: 'jetstream' }).jetPadLevel).toBeGreaterThan(0)
    for (const dominant of [null, 'storm', 'updraft', 'shear', 'wake'] as const) expect(fly({ dominant }).jetPadLevel).toBe(0)
  })
  it('clouds muffle the world progressively', () => {
    const cutoffs = [0, 0.3, 0.6, 1].map((cloud) => fly({ cloud }).worldCutoffHz)
    expect(cutoffs[0]).toBeGreaterThanOrEqual(10_000)
    for (let i = 1; i < cutoffs.length; i++) expect(cutoffs[i]!).toBeLessThan(cutoffs[i - 1]!)
    expect(cutoffs[3]!).toBeLessThan(1000)
  })
  it('storm core and severe turbulence rumble; calm air barely does', () => {
    const calm = fly({ turbulence: 0.1 })
    const severe = fly({ turbulence: 0.9 })
    const storm = fly({ turbulence: 0.6, dominant: 'storm' })
    expect(calm.rumbleLevel).toBeLessThan(0.01)
    expect(severe.rumbleLevel).toBeGreaterThan(10 * calm.rumbleLevel)
    expect(storm.rumbleLevel).toBeGreaterThan(fly({ turbulence: 0.6 }).rumbleLevel)
    expect(severe.buffetHz).toBeGreaterThan(calm.buffetHz)
  })
  it('stall warning only when stalled, and stays soft', () => {
    expect(fly({ stalled: false }).stallLevel).toBe(0)
    const stall = fly({ stalled: true })
    expect(stall.stallLevel).toBeGreaterThan(0)
    expect(stall.stallLevel).toBeLessThan(stall.windLevel)
  })
})

describe('engine', () => {
  it('is mixed under the wind at cruise for every class', () => {
    for (const aircraftClass of CLASSES) {
      const m = fly({ aircraftClass, throttle: 1 })
      expect(m.engineLevel).toBeLessThan(m.windLevel)
    }
  })
  it('experimental is the quietest, supersonic roars most, only the turboprop thrums', () => {
    const v = ENGINE_VOICES
    for (const c of CLASSES) {
      if (c !== 'experimental') expect(v.experimental.level).toBeLessThan(v[c].level)
      if (c !== 'supersonic') expect(v.supersonic.roarLevel).toBeGreaterThan(v[c].roarLevel)
      if (c !== 'turboprop') expect(v[c].thrumDepth).toBe(0)
    }
    expect(v.turboprop.thrumDepth).toBeGreaterThan(0)
    expect(v.experimental.roarLevel).toBe(0)
  })
  it('throttle raises level and pitch', () => {
    const idle = fly({ throttle: 0 })
    const full = fly({ throttle: 1 })
    expect(full.engineLevel).toBeGreaterThan(idle.engineLevel)
    expect(full.enginePitch).toBeGreaterThan(idle.enginePitch)
    expect(idle.engineLevel).toBeGreaterThan(0)
  })
})

describe('scenes', () => {
  it('menu is the ambient bed only', () => {
    const m = computeMix({ ...cruise, verticalWindMs: 20, dominant: 'jetstream', stalled: true, turbulence: 1 }, 'menu')
    expect(m.menuPadLevel).toBeGreaterThan(0)
    expect(m.windLevel).toBeGreaterThan(0)
    for (const k of ['engineLevel', 'shimmerLevel', 'sinkLevel', 'jetPadLevel', 'rumbleLevel', 'stallLevel'] as const) expect(m[k]).toBe(0)
    expect(fly({}).menuPadLevel).toBe(0)
  })
  it('menu progression cycles through every chord, one per period', () => {
    const seen = new Set<number>()
    for (let t = 0; t < MENU_CHORD_S * MENU_CHORDS.length; t += MENU_CHORD_S) seen.add(menuChordIndex(t + 0.5))
    expect(seen.size).toBe(MENU_CHORDS.length)
    expect(menuChordIndex(MENU_CHORD_S * MENU_CHORDS.length + 0.5)).toBe(0)
    expect(menuChordIndex(Number.NaN)).toBe(0)
  })
})

describe('robustness', () => {
  it('garbage in → finite, bounded targets (a NaN AudioParam target would silence the whole graph)', () => {
    const bad: AudioFrame = {
      airspeedMs: Number.NaN,
      throttle: Number.POSITIVE_INFINITY,
      turbulence: -3,
      dominant: null,
      verticalWindMs: Number.NaN,
      cloud: 7,
      stalled: false,
      aircraftClass: 'cargo',
    }
    for (const m of [computeMix(bad, 'flight'), computeMix({ ...bad, airspeedMs: 1e9, verticalWindMs: -1e9 }, 'flight')]) {
      for (const [k, v] of Object.entries(m)) {
        if (typeof v !== 'number') continue
        expect(Number.isFinite(v), k).toBe(true)
        expect(v, k).toBeGreaterThanOrEqual(0)
      }
      expect(m.windLevel + m.rumbleLevel + m.engineLevel + m.shimmerLevel + m.sinkLevel + m.jetPadLevel + m.stallLevel).toBeLessThan(1)
    }
  })
})
