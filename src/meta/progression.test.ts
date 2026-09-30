import { describe, expect, it } from 'vitest'
import type { FlightScore, PlayerProgress } from '../core/types'
import { AIRCRAFT_ORDER, equip, newProgress, recordFlight, setLivery, unequip } from './progression'
import { UPGRADES } from './upgrades'

const score = (status: FlightScore['status'], boards: { smooth?: number; speed?: number; eco?: number } = {}): FlightScore => ({
  status, simTimeS: 500, displayTimeS: 20_000, fuelUsedKg: 1000, fuelRemainingPct: 50, comfort: 80,
  severeTurbulenceS: 0, stress: 10, weatherUtilization: 30,
  smooth: boards.smooth ?? 0, speed: boards.speed ?? 0, eco: boards.eco ?? 0,
})

const fly = (p: PlayerProgress, s: FlightScore) =>
  recordFlight(p, { score: s, dailyNumber: 272, routeId: 'jfk-lis', aircraftId: 'turboprop', ghostCode: 'GHOST' })

const flyN = (p: PlayerProgress, n: number, s: FlightScore): PlayerProgress => {
  let out = p
  for (let i = 0; i < n; i++) out = fly(out, s).progress
  return out
}

describe('newProgress', () => {
  it('starts with the turboprop and every "always" upgrade', () => {
    const p = newProgress('Ada')
    expect(p.pilot).toBe('Ada')
    expect(p.unlockedAircraft).toEqual(['turboprop'])
    expect(p.unlockedUpgrades).toEqual(UPGRADES.filter((u) => u.unlock.kind === 'always').map((u) => u.id))
    expect(p.flights).toBe(0)
  })
})

describe('recordFlight', () => {
  it('is pure', () => {
    const p = newProgress('Ada')
    const frozen = JSON.stringify(p)
    fly(p, score('arrived', { smooth: 500 }))
    expect(JSON.stringify(p)).toBe(frozen)
  })

  it('first unlock (regional) comes after the second flight, crashes included', () => {
    const one = fly(newProgress('Ada'), score('crashed'))
    expect(one.newlyUnlocked).not.toContain('regional')
    const two = fly(one.progress, score('arrived', { smooth: 100, speed: 100, eco: 100 }))
    expect(two.newlyUnlocked).toContain('regional')
    expect(two.progress.unlockedAircraft).toEqual(['turboprop', 'regional'])
  })

  it('an aborted run (still flying) counts for nothing', () => {
    const r = fly(newProgress('Ada'), score('flying', { smooth: 900 }))
    expect(r.progress.flights).toBe(0)
    expect(r.progress.best.smooth).toBe(0)
    expect(r.entries).toEqual([])
  })

  it('keeps best per board, only from arrived flights', () => {
    let p = fly(newProgress('Ada'), score('arrived', { smooth: 400, speed: 200, eco: 300 })).progress
    p = fly(p, score('arrived', { smooth: 100, speed: 600, eco: 50 })).progress
    p = fly(p, score('overstressed', { smooth: 999, speed: 999, eco: 999 })).progress
    expect(p.best).toEqual({ smooth: 400, speed: 600, eco: 300 })
  })

  it('emits one local board entry per positive board, only on arrival', () => {
    const r = fly(newProgress('Ada'), score('arrived', { smooth: 500, speed: 0, eco: 300 }))
    expect(r.entries).toEqual([
      { pilot: 'Ada', dailyNumber: 272, routeId: 'jfk-lis', board: 'smooth', value: 500, ghost: 'GHOST' },
      { pilot: 'Ada', dailyNumber: 272, routeId: 'jfk-lis', board: 'eco', value: 300, ghost: 'GHOST' },
    ])
    expect(fly(newProgress('Ada'), score('crashed', { smooth: 500 })).entries).toEqual([])
  })

  it('flying blind (boards ≤ 1000) stalls after narrow body: the wide body asks for a smooth ride well above blind', () => {
    const p = flyN(newProgress('Grinder'), 100, score('arrived', { smooth: 700, speed: 700, eco: 700 }))
    expect(p.unlockedAircraft).toEqual(['turboprop', 'regional'])
    const q = flyN(newProgress('Grinder'), 100, score('arrived', { smooth: 1000, speed: 1000, eco: 1000 }))
    expect(q.unlockedAircraft).toEqual(['turboprop', 'regional', 'narrowbody'])
  })

  it('experimental needs smooth 1300, speed 1150 and eco 1300', () => {
    const almost = flyN(newProgress('Ace'), 30, score('arrived', { smooth: 1400, speed: 1400, eco: 1290 }))
    expect(almost.unlockedAircraft).not.toContain('experimental')
    expect(almost.unlockedAircraft).toContain('supersonic')
    const r = fly(almost, score('arrived', { eco: 1310 }))
    expect(r.newlyUnlocked).toEqual(['experimental'])
    expect(r.progress.unlockedAircraft).toEqual([...AIRCRAFT_ORDER])
  })

  it('unlocks strictly in order, several at once when earned', () => {
    // A great first run still doesn't skip the flight counts…
    const first = fly(newProgress('Ace'), score('arrived', { smooth: 1300, speed: 1300, eco: 1300 }))
    expect(first.progress.unlockedAircraft).toEqual(['turboprop'])
    // …and once flights catch up, the chain unlocks in AIRCRAFT_ORDER.
    const p = flyN(first.progress, 13, score('arrived', { smooth: 1300, speed: 1300, eco: 1300 }))
    expect(p.unlockedAircraft).toEqual(AIRCRAFT_ORDER.slice(0, 7 - 1))
  })

  it('reports upgrade unlocks by flights and by score', () => {
    const p = flyN(newProgress('Ada'), 1, score('arrived'))
    const r = fly(p, score('arrived', { smooth: 1360 }))
    expect(r.newlyUnlocked).toEqual(expect.arrayContaining(['regional', 'wings-winglets', 'inst-gmeter']))
    expect(r.progress.unlockedUpgrades).toContain('wings-winglets')
  })
})

describe('equip / unequip / setLivery', () => {
  const p = newProgress('Ada')

  it('equips one per slot, replacing the previous one', () => {
    const a = equip(p, 'turboprop', 'wings-flaps')
    const b = equip(a, 'turboprop', 'eng-highbypass')
    expect(b.loadouts.turboprop).toEqual(['wings-flaps', 'eng-highbypass'])
    const unlocked = { ...b, unlockedUpgrades: [...b.unlockedUpgrades, 'wings-winglets'] }
    expect(equip(unlocked, 'turboprop', 'wings-winglets').loadouts.turboprop).toEqual(['eng-highbypass', 'wings-winglets'])
    expect(p.loadouts).toEqual({})
  })

  it('rejects locked aircraft, locked or unknown upgrades', () => {
    expect(() => equip(p, 'widebody', 'wings-flaps')).toThrow(/locked/)
    expect(() => equip(p, 'turboprop', 'wings-winglets')).toThrow(/locked/)
    expect(() => equip(p, 'turboprop', 'nitro')).toThrow(/unknown/)
  })

  it('unequips back to stock', () => {
    const a = equip(p, 'turboprop', 'wings-flaps')
    expect(unequip(a, 'turboprop', 'wings-flaps').loadouts.turboprop).toEqual([])
  })

  it('sets a #rrggbb livery on an unlocked aircraft', () => {
    expect(setLivery(p, 'turboprop', '#1A2B3C').livery).toEqual({ turboprop: '#1a2b3c' })
    expect(() => setLivery(p, 'turboprop', 'red')).toThrow(/#rrggbb/)
    expect(() => setLivery(p, 'cargo', '#ffffff')).toThrow(/locked/)
  })
})
