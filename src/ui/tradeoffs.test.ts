import { describe, expect, it } from 'vitest'
import { fixtureAircraft } from '../core/fixtures'
import type { PlayerProgress, Upgrade } from '../core/types'
import {
  applyUpgrades,
  equippedIn,
  formatChange,
  isTradeoff,
  isUpgradeUnlocked,
  loadoutDiff,
  modifierEffects,
  unlockHint,
} from './tradeoffs'

const winglets: Upgrade = {
  id: 'winglets',
  slot: 'wings',
  name: 'Winglets',
  description: 'Less drag, more gust response.',
  modifiers: { fuelBurnFullKgS: 0.92, gustSensitivity: 1.12 },
  unlock: { kind: 'flights', count: 3 },
}
const turbofan: Upgrade = {
  id: 'hi-bypass',
  slot: 'engines',
  name: 'High-bypass fans',
  description: '',
  modifiers: { maxThrustN: 1.1, massKg: 1.05, maxSpeedMs: 0.96 },
  unlock: { kind: 'score', board: 'eco', atLeast: 700 },
}
const cheat: Upgrade = { ...winglets, id: 'cheat', modifiers: { maxThrustN: 1.2, fuelBurnFullKgS: 0.8 } }
const paint: Upgrade = { ...winglets, id: 'paint', slot: 'livery', modifiers: {}, unlock: { kind: 'always' } }

const progress: PlayerProgress = {
  pilot: 'ada',
  flights: 1,
  best: { smooth: 420, speed: 610, eco: 380 },
  unlockedAircraft: ['fixture-turboprop'],
  unlockedUpgrades: ['winglets'],
  loadouts: { 'fixture-turboprop': ['winglets'] },
  livery: {},
}

describe('modifierEffects', () => {
  it('classifies each modifier as benefit, cost or trait from its direction', () => {
    const e = modifierEffects(turbofan.modifiers)
    expect(e.map((x) => [x.key, x.effect])).toEqual([
      ['maxThrustN', 'benefit'],
      ['maxSpeedMs', 'cost'],
      ['massKg', 'trait'],
    ])
    expect(e[0]!.change).toBeCloseTo(0.1)
  })
  it('lower fuel burn is a benefit, more gust sensitivity a cost', () => {
    const e = modifierEffects(winglets.modifiers)
    expect(e.find((x) => x.key === 'fuelBurnFullKgS')!.effect).toBe('benefit')
    expect(e.find((x) => x.key === 'gustSensitivity')!.effect).toBe('cost')
  })
  it('more negative g margin is a benefit', () => {
    expect(modifierEffects({ limitGNeg: 1.2 })[0]!.effect).toBe('benefit')
  })
})

describe('isTradeoff (no pay-to-win)', () => {
  it('accepts real tradeoffs and cosmetic liveries, flags pure upgrades', () => {
    expect(isTradeoff(winglets)).toBe(true)
    expect(isTradeoff(turbofan)).toBe(true)
    expect(isTradeoff(paint)).toBe(true)
    expect(isTradeoff(cheat)).toBe(false)
  })
})

describe('applyUpgrades / loadoutDiff', () => {
  it('multiplies spec fields and reports only changed rows', () => {
    const eff = applyUpgrades(fixtureAircraft, [winglets, turbofan])
    expect(eff.fuelBurnFullKgS).toBeCloseTo(0.35 * 0.92)
    expect(eff.maxThrustN).toBeCloseTo(45_000 * 1.1)
    expect(eff.name).toBe(fixtureAircraft.name)
    const rows = loadoutDiff(fixtureAircraft, eff)
    expect(rows.map((r) => r.key).sort()).toEqual(['fuelBurnFullKgS', 'gustSensitivity', 'massKg', 'maxSpeedMs', 'maxThrustN'].sort())
    expect(rows.find((r) => r.key === 'maxThrustN')!.value).toBe('50 kN')
  })
  it('stock loadout has no diff', () => {
    expect(loadoutDiff(fixtureAircraft, applyUpgrades(fixtureAircraft, []))).toEqual([])
  })
})

describe('unlocks', () => {
  it('reports what is left to do', () => {
    expect(unlockHint(winglets.unlock, progress)).toBe('Fly 2 more flights')
    expect(unlockHint(turbofan.unlock, progress)).toBe('Score 700 on Eco Pilots (best 380)')
    expect(unlockHint({ kind: 'always' }, progress)).toBeNull()
  })
  it('uses progress for unlock state and loadouts for equipped state', () => {
    expect(isUpgradeUnlocked(winglets, progress)).toBe(true)
    expect(isUpgradeUnlocked(turbofan, progress)).toBe(false)
    expect(isUpgradeUnlocked(paint, progress)).toBe(true)
    expect(equippedIn(progress, 'fixture-turboprop', [winglets, turbofan], 'wings')?.id).toBe('winglets')
    expect(equippedIn(progress, 'fixture-turboprop', [winglets, turbofan], 'engines')).toBeNull()
  })
  it('formats changes as signed percents', () => {
    expect(formatChange(0.08)).toBe('+8%')
    expect(formatChange(-0.12)).toBe('−12%')
    expect(formatChange(0.001)).toBe('+<1%')
  })
})
