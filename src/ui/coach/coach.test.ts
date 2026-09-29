import { describe, expect, it } from 'vitest'
import type { HudModel } from '../../core/types'
import { HINT_TEXT, MASTERY, TIMING, initialCoach, stepCoach, type CoachEvent, type CoachState, type HintId } from './coach'
import { skyLine } from './sky'
import { DEFAULT_MEMORY, parseMemory } from './store'

const base: HudModel = {
  dailyNumber: 1,
  routeLabel: 'JFK → LIS',
  altitudeFt: 10_000,
  verticalSpeedFpm: 0,
  airspeedKt: 250,
  groundSpeedKmh: 460,
  headingDeg: 90,
  throttle: 0.7,
  fuelPct: 80,
  comfort: 90,
  stress: 5,
  turbulence: 0.05,
  dominant: null,
  gLoad: 1,
  stalled: false,
  gateDistanceKm: 5000,
  gateBearingDeg: 0,
  gateAltitudeOk: true,
  displayTimeS: 0,
  ghostDeltaS: null,
}

const DT = 0.1

/** Drive the engine over a scripted flight; `frame(i)` returns overrides for frame i. */
const fly = (
  start: CoachState,
  frames: number,
  frame: (i: number) => Partial<HudModel>,
  t0 = 0,
): { state: CoachState; events: (CoachEvent & { t: number })[] } => {
  let s = start
  const events: (CoachEvent & { t: number })[] = []
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * DT
    const r = stepCoach(s, { ...base, displayTimeS: t * 30, ...frame(i) }, t)
    s = r.state
    for (const e of r.events) events.push({ ...e, t })
  }
  return { state: s, events }
}

const shows = (evs: readonly CoachEvent[]): HintId[] => evs.flatMap((e) => (e.type === 'show' ? [e.id] : []))

const updraft = (): Partial<HudModel> => ({ dominant: 'updraft', verticalSpeedFpm: 1200 })

describe('coach: firing', () => {
  it('stays silent in calm air', () => {
    expect(fly(initialCoach(true, []), 300, () => ({})).events).toEqual([])
  })

  it('needs the condition to hold before speaking (no flicker on a one-frame brush)', () => {
    const r = fly(initialCoach(true, []), 50, (i) => (i === 10 ? updraft() : {}))
    expect(shows(r.events)).toEqual([])
    const held = fly(initialCoach(true, []), 50, () => updraft())
    expect(shows(held.events)).toEqual(['updraft'])
    expect(held.events[0]).toMatchObject({ type: 'show', text: HINT_TEXT.updraft })
    expect(held.events[0]!.t).toBeGreaterThanOrEqual(TIMING.sustainS)
  })

  it('shows one hint at a time and hides it after the hold', () => {
    const r = fly(initialCoach(true, []), 120, () => ({ ...updraft(), fuelPct: 10 }))
    const evs = r.events.filter((e) => e.type !== 'retire')
    expect(evs[0]).toMatchObject({ type: 'show', id: 'fuel' })
    expect(evs[1]!.type).toBe('hide')
    expect(evs[1]!.t - evs[0]!.t).toBeCloseTo(TIMING.holdS, 0)
    expect(shows(r.events)).toEqual(['fuel']) // updraft waits for the global cooldown
  })

  it('priority: storm beats everything else', () => {
    const r = fly(initialCoach(true, []), 20, () => ({ dominant: 'storm', turbulence: 0.5, fuelPct: 10 }))
    expect(shows(r.events)).toEqual(['storm'])
  })

  it('respects the global cooldown, the repeat cooldown and the per-flight cap', () => {
    const minutes = 60 * 10 * 6 // 6 minutes of frames at 0.1 s
    const r = fly(initialCoach(true, []), minutes, () => ({ fuelPct: 10, throttle: 0.9 }))
    const times = r.events.filter((e) => e.type === 'show').map((e) => e.t)
    expect(times).toHaveLength(TIMING.maxPerFlight)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(TIMING.repeatCooldownS - 1e-9)
  })

  it('a new flight (clock back to zero) resets the per-flight cap but keeps the repeat cooldown', () => {
    const lowFuel = { fuelPct: 10, throttle: 0.9 }
    const first = fly(initialCoach(true, []), 3600, () => lowFuel)
    expect(shows(first.events)).toHaveLength(TIMING.maxPerFlight)
    const second = fly(first.state, 3600, (i) => ({ ...lowFuel, displayTimeS: i * 3 }), 360)
    const times = second.events.filter((e) => e.type === 'show').map((e) => e.t)
    expect(times).toHaveLength(TIMING.maxPerFlight)
    expect(times[0]! - (first.state.lastShownAt.fuel ?? 0)).toBeGreaterThanOrEqual(TIMING.repeatCooldownS - 1e-9)
  })

  it('jet: only with a real tailwind', () => {
    const headwind = fly(initialCoach(true, []), 30, () => ({ dominant: 'jetstream', groundSpeedKmh: 380 }))
    expect(shows(headwind.events)).toEqual([])
    const tailwind = fly(initialCoach(true, []), 30, () => ({ dominant: 'jetstream', groundSpeedKmh: 800 }))
    expect(shows(tailwind.events)).toEqual(['jet'])
  })

  it('gate: only in the final stretch and only when outside the window', () => {
    const r = fly(initialCoach(true, []), 60, (i) => ({
      gateDistanceKm: i < 5 ? 5000 : i < 30 ? 2000 : 400,
      gateAltitudeOk: false,
    }))
    const shown = r.events.filter((e) => e.type === 'show')
    expect(shown.map((e) => e.type === 'show' && e.id)).toEqual(['gate'])
    expect(shown[0]!.t).toBeGreaterThan(3)
  })

  it('disabled coaching never speaks but still learns', () => {
    const r = fly(initialCoach(false, []), 400, (i) => ({ ...updraft(), altitudeFt: 10_000 + i * 10 }))
    expect(shows(r.events)).toEqual([])
    expect(r.state.retired).toContain('updraft')
  })
})

describe('coach: retirement', () => {
  it('climbing 300 m in rising air retires the updraft lesson and hides it at once', () => {
    const r = fly(initialCoach(true, []), 200, (i) => ({ ...updraft(), altitudeFt: 10_000 + i * 20 }))
    const kinds = r.events.map((e) => e.type + (e.type !== 'hide' ? `:${e.id}` : ''))
    expect(kinds).toEqual(['show:updraft', 'retire:updraft', 'hide'])
    expect(r.state.retired).toEqual(['updraft'])
  })

  it('climb is measured within one continuous stay', () => {
    const r = fly(initialCoach(true, []), 200, (i) => ({
      ...(i % 40 < 20 ? updraft() : {}),
      altitudeFt: 10_000 + i * 8,
    }))
    expect(r.state.retired).not.toContain('updraft')
  })

  it('retired lessons never come back', () => {
    const r = fly(initialCoach(true, ['updraft']), 600, () => updraft())
    expect(shows(r.events)).toEqual([])
  })

  it('leaving a storm without severe turbulence retires the storm lesson; a rough one does not', () => {
    const clean = fly(initialCoach(true, []), 60, (i) => (i < 30 ? { dominant: 'storm', turbulence: 0.5 } : {}))
    expect(clean.state.retired).toContain('storm')
    const rough = fly(initialCoach(true, []), 60, (i) => (i < 30 ? { dominant: 'storm', turbulence: 0.9 } : {}))
    expect(rough.state.retired).not.toContain('storm')
  })

  it('jet riding is cumulative across flights', () => {
    const half = (MASTERY.jetRideS / 2 + 1) / DT
    const a = fly(initialCoach(true, []), half, () => ({ dominant: 'jetstream', groundSpeedKmh: 800 }))
    expect(a.state.retired).not.toContain('jet')
    const b = fly(a.state, half, () => ({ dominant: 'jetstream', groundSpeedKmh: 800 }), 1000)
    expect(b.state.retired).toContain('jet')
  })

  it('gliding on low fuel retires the fuel lesson', () => {
    const r = fly(initialCoach(true, []), (MASTERY.glideS + 1) / DT, () => ({ fuelPct: 12, throttle: 0.1 }))
    expect(r.state.retired).toContain('fuel')
  })

  it('getting back into the gate window in the final stretch retires the gate lesson', () => {
    const r = fly(initialCoach(true, []), 60, (i) => ({
      gateDistanceKm: i < 5 ? 5000 : 400,
      gateAltitudeOk: i > 40,
    }))
    expect(r.state.retired).toContain('gate')
  })
})

describe('coach memory', () => {
  it('parses a valid record and drops duplicates', () => {
    const m = parseMemory(JSON.stringify({ version: 1, enabled: false, retired: ['jet', 'jet', 'storm'], jetRideS: 4 }))
    expect(m).toEqual({ version: 1, enabled: false, retired: ['jet', 'storm'], jetRideS: 4 })
  })
  it('resets on missing, corrupt, unknown version or unknown hint ids', () => {
    expect(parseMemory(null)).toEqual(DEFAULT_MEMORY)
    expect(parseMemory('{nope')).toEqual(DEFAULT_MEMORY)
    expect(parseMemory(JSON.stringify({ version: 2, enabled: true, retired: [] }))).toEqual(DEFAULT_MEMORY)
    expect(parseMemory(JSON.stringify({ version: 1, enabled: true, retired: ['teleport'] }))).toEqual(DEFAULT_MEMORY)
    expect(parseMemory('null')).toEqual(DEFAULT_MEMORY)
  })
  it('sanitizes a bad jet counter without losing the rest', () => {
    expect(parseMemory(JSON.stringify({ version: 1, enabled: true, retired: ['fuel'], jetRideS: -3 }))).toEqual({
      version: 1,
      enabled: true,
      retired: ['fuel'],
      jetRideS: 0,
    })
  })
})

describe('skyLine', () => {
  it('names what the sky gave and cost', () => {
    expect(skyLine({ weatherUtilization: 34.4, severeTurbulenceS: 0 })).toBe('The sky carried 34% of your energy, without a second of severe turbulence.')
    expect(skyLine({ weatherUtilization: 34, severeTurbulenceS: 12.2 })).toBe('The sky carried 34% of your energy, and cost 12 s in severe turbulence.')
    expect(skyLine({ weatherUtilization: 1, severeTurbulenceS: 12 })).toBe('12 s in severe turbulence, and almost nothing back from the sky.')
    expect(skyLine({ weatherUtilization: 0, severeTurbulenceS: 0.2 })).toMatch(/engines did all the work/)
  })
})
