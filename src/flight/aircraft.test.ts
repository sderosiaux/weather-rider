import { describe, expect, it } from 'vitest'
import type { AircraftClass, AircraftSpec } from '../core/types'
import { aeroOf, trimLevel } from './aero'
import { AIRCRAFT, aircraftById } from './aircraft'

const CLASSES: readonly AircraftClass[] = ['turboprop', 'regional', 'narrowbody', 'widebody', 'cargo', 'supersonic', 'experimental']

describe('roster', () => {
  it('has exactly one aircraft per class, id = class', () => {
    expect(AIRCRAFT.map((a) => a.id)).toEqual(CLASSES)
    for (const a of AIRCRAFT) expect(a.class).toBe(a.id)
  })

  it('aircraftById finds every id and throws on unknown', () => {
    for (const c of CLASSES) expect(aircraftById(c).class).toBe(c)
    expect(() => aircraftById('concorde')).toThrow()
  })

  it.each(AIRCRAFT.map((a) => [a.id, a] as const))('%s is internally consistent', (_id, a) => {
    expect(a.stallSpeedMs).toBeLessThan(a.cruiseSpeedMs)
    expect(a.cruiseSpeedMs).toBeLessThan(a.maxSpeedMs)
    expect(a.fuelCapacityKg).toBeLessThan(a.massKg * 0.5)
    expect(a.limitGNeg).toBeLessThan(0)
    // Cruise must be sustainable at the typical route altitude and near the ceiling band.
    expect(trimLevel(a, 3000, a.cruiseSpeedMs).throttle).toBeLessThan(1)
    const aero = aeroOf(a)
    expect(aero.maxLiftToDrag).toBeGreaterThan(5)
    expect(aero.alphaStall).toBeGreaterThan(0.1)
  })
})

describe('tradeoffs', () => {
  /** Higher = better on every axis. */
  const axes: Record<string, (a: AircraftSpec) => number> = {
    speed: (a) => a.cruiseSpeedMs,
    agility: (a) => a.rollRate,
    comfort: (a) => -a.gustSensitivity * a.cabinDamping,
    rangeKm: (a) => (a.fuelCapacityKg / (a.fuelBurnFullKgS * trimLevel(a, 3000, a.cruiseSpeedMs).throttle)) * a.cruiseSpeedMs / 1000,
    toughness: (a) => a.limitGPos,
    glide: (a) => aeroOf(a).maxLiftToDrag,
  }

  it('no aircraft strictly dominates another', () => {
    for (const a of AIRCRAFT) {
      for (const b of AIRCRAFT) {
        if (a === b) continue
        const scores = Object.values(axes).map((f) => f(a) - f(b))
        const dominates = scores.every((d) => d >= 0) && scores.some((d) => d > 0)
        expect(dominates, `${a.id} dominates ${b.id}`).toBe(false)
      }
    }
  })

  it('small is agile and bumpy, big is stable and smooth', () => {
    const tp = aircraftById('turboprop')
    const wb = aircraftById('widebody')
    expect(tp.rollRate).toBeGreaterThan(wb.rollRate)
    expect(tp.controlLag).toBeLessThan(wb.controlLag)
    expect(tp.gustSensitivity).toBeGreaterThan(1)
    expect(wb.gustSensitivity).toBeLessThan(1)
    expect(wb.cabinDamping).toBeLessThan(tp.cabinDamping)
  })

  it('supersonic is fastest and thirstiest per second; experimental glides best but breaks first', () => {
    const fastest = [...AIRCRAFT].sort((a, b) => b.cruiseSpeedMs - a.cruiseSpeedMs)[0]!
    expect(fastest.id).toBe('supersonic')
    const endurance = (a: AircraftSpec) => a.fuelCapacityKg / a.fuelBurnFullKgS
    expect(Math.min(...AIRCRAFT.map(endurance))).toBe(endurance(aircraftById('supersonic')))
    const bestGlide = [...AIRCRAFT].sort((a, b) => aeroOf(b).maxLiftToDrag - aeroOf(a).maxLiftToDrag)[0]!
    expect(bestGlide.id).toBe('experimental')
    const exp = aircraftById('experimental')
    expect(Math.min(...AIRCRAFT.map((a) => a.limitGPos))).toBe(exp.limitGPos)
    expect(Math.max(...AIRCRAFT.map((a) => a.gustSensitivity))).toBe(exp.gustSensitivity)
  })
})
