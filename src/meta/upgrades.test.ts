import { describe, expect, it } from 'vitest'
import { fixtureAircraft } from '../core/fixtures'
import type { NumericSpecKey } from '../core/types'
import { applyLoadout, GOOD_DIRECTION, UPGRADE_SLOTS, UPGRADES } from './upgrades'

/** Signed "goodness" of a modifier: > 0 helps the pilot, < 0 hurts, by GOOD_DIRECTION. */
const goodness = (key: NumericSpecKey, factor: number): number => GOOD_DIRECTION[key] * Math.log(factor)

describe('UPGRADES catalog', () => {
  it('covers every slot with 2–4 upgrades and unique ids', () => {
    for (const slot of UPGRADE_SLOTS) {
      const n = UPGRADES.filter((u) => u.slot === slot).length
      expect(n, slot).toBeGreaterThanOrEqual(2)
      expect(n, slot).toBeLessThanOrEqual(4)
    }
    expect(new Set(UPGRADES.map((u) => u.id)).size).toBe(UPGRADES.length)
  })

  it('every slot has at least one upgrade available from the start', () => {
    for (const slot of UPGRADE_SLOTS) {
      expect(UPGRADES.some((u) => u.slot === slot && u.unlock.kind === 'always'), slot).toBe(true)
    }
  })

  it('livery is purely cosmetic', () => {
    for (const u of UPGRADES.filter((u) => u.slot === 'livery')) expect(u.modifiers).toEqual({})
  })

  // SPEC §6: never pay_more = win. Every functional upgrade moves a tradeoff.
  it.each(UPGRADES.filter((u) => u.slot !== 'livery').map((u) => [u.id, u] as const))('%s has a genuine upside and a genuine downside', (_, u) => {
    const scores = Object.entries(u.modifiers).map(([k, f]) => goodness(k as NumericSpecKey, f))
    expect(scores.some((s) => s > 0)).toBe(true)
    expect(scores.some((s) => s < 0)).toBe(true)
    // Neither side is a token gesture: log-magnitudes within a factor 2 of each other.
    const up = scores.filter((s) => s > 0).reduce((a, b) => a + b, 0)
    const down = -scores.filter((s) => s < 0).reduce((a, b) => a + b, 0)
    expect(up / down).toBeGreaterThanOrEqual(0.5)
    expect(up / down).toBeLessThanOrEqual(2)
  })

  it('never touches render-only or direction-less fields', () => {
    for (const u of UPGRADES) {
      for (const k of Object.keys(u.modifiers) as NumericSpecKey[]) expect(GOOD_DIRECTION[k], `${u.id}.${k}`).not.toBe(0)
    }
  })

  it('modifiers stay within ±20 %', () => {
    for (const u of UPGRADES) for (const f of Object.values(u.modifiers)) {
      expect(f).toBeGreaterThanOrEqual(0.8)
      expect(f).toBeLessThanOrEqual(1.2)
    }
  })
})

describe('applyLoadout', () => {
  it('multiplies modifiers, keeps id and leaves the input untouched', () => {
    const before = { ...fixtureAircraft }
    const out = applyLoadout(fixtureAircraft, ['wings-winglets', 'eng-highbypass'])
    expect(out.id).toBe(fixtureAircraft.id)
    expect(out.fuelBurnFullKgS).toBeCloseTo(fixtureAircraft.fuelBurnFullKgS * 0.9 * 0.88, 12)
    expect(out.gustSensitivity).toBeCloseTo(fixtureAircraft.gustSensitivity * 1.12, 12)
    expect(out.maxThrustN).toBeCloseTo(fixtureAircraft.maxThrustN * 0.92, 12)
    expect(out.massKg).toBe(fixtureAircraft.massKg)
    expect(fixtureAircraft).toEqual(before)
  })

  it('empty loadout and livery-only loadout are the stock aircraft', () => {
    expect(applyLoadout(fixtureAircraft, [])).toEqual(fixtureAircraft)
    expect(applyLoadout(fixtureAircraft, ['livery-classic'])).toEqual(fixtureAircraft)
  })

  it('widens the negative g limit (stored negative)', () => {
    const out = applyLoadout(fixtureAircraft, ['wings-spar'])
    expect(out.limitGNeg).toBeLessThan(fixtureAircraft.limitGNeg)
  })

  it('throws on two upgrades in one slot or an unknown id', () => {
    expect(() => applyLoadout(fixtureAircraft, ['wings-winglets', 'wings-flaps'])).toThrow(/slot "wings"/)
    expect(() => applyLoadout(fixtureAircraft, ['nitro'])).toThrow(/unknown/)
  })
})
