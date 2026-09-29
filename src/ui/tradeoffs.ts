// Pure hangar logic: how an upgrade moves the aircraft's compromise. No DOM.
import type { AircraftSpec, NumericSpecKey, PlayerProgress, Upgrade, UpgradeSlot, UnlockRule } from '../core/types'

/**
 * direction: +1 = a multiplier above 1 helps the pilot, -1 = it hurts, 0 = a trait (neither).
 * Mass, wing area and length change the feel (inertia, lift, gust response) rather than being better or worse.
 */
interface KeyMeta {
  readonly label: string
  readonly direction: 1 | -1 | 0
  readonly format: (v: number) => string
}

const KT = 1.943844
const FT = 3.28084
const DEG = 180 / Math.PI
const num = (v: number, digits = 0): string => v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }).replace(/,/g, ' ')

export const SPEC_META: Record<NumericSpecKey, KeyMeta> = {
  massKg: { label: 'Mass', direction: 0, format: (v) => `${num(v / 1000, 1)} t` },
  wingAreaM2: { label: 'Wing area', direction: 0, format: (v) => `${num(v)} m²` },
  maxThrustN: { label: 'Thrust', direction: 1, format: (v) => `${num(v / 1000)} kN` },
  fuelCapacityKg: { label: 'Fuel capacity', direction: 1, format: (v) => `${num(v / 1000, 1)} t` },
  fuelBurnFullKgS: { label: 'Fuel burn', direction: -1, format: (v) => `${num(v, 2)} kg/s` },
  stallSpeedMs: { label: 'Stall speed', direction: -1, format: (v) => `${num(v * KT)} kt` },
  cruiseSpeedMs: { label: 'Cruise speed', direction: 1, format: (v) => `${num(v * KT)} kt` },
  maxSpeedMs: { label: 'Top speed', direction: 1, format: (v) => `${num(v * KT)} kt` },
  serviceCeilingM: { label: 'Ceiling', direction: 1, format: (v) => `${num(v * FT)} ft` },
  rollRate: { label: 'Roll rate', direction: 1, format: (v) => `${num(v * DEG)}°/s` },
  pitchRate: { label: 'Pitch rate', direction: 1, format: (v) => `${num(v * DEG)}°/s` },
  yawRate: { label: 'Yaw rate', direction: 1, format: (v) => `${num(v * DEG)}°/s` },
  controlLag: { label: 'Control lag', direction: -1, format: (v) => `${num(v, 2)} s` },
  gustSensitivity: { label: 'Gust sensitivity', direction: -1, format: (v) => `×${num(v, 2)}` },
  cabinDamping: { label: 'Bumps felt in cabin', direction: -1, format: (v) => `×${num(v, 2)}` },
  limitGPos: { label: 'Positive g limit', direction: 1, format: (v) => `${num(v, 1)} g` },
  // Stored negative; a multiplier > 1 pushes it further from zero = more margin.
  limitGNeg: { label: 'Negative g limit', direction: 1, format: (v) => `${num(v, 1)} g` },
  lengthM: { label: 'Length', direction: 0, format: (v) => `${num(v)} m` },
}

export const SPEC_KEYS = Object.keys(SPEC_META) as NumericSpecKey[]

export type Effect = 'benefit' | 'cost' | 'trait'

export interface ModifierEffect {
  readonly key: NumericSpecKey
  readonly label: string
  /** Relative change, e.g. 0.08 for ×1.08. */
  readonly change: number
  readonly effect: Effect
}

const effectOf = (key: NumericSpecKey, factor: number): Effect => {
  const d = SPEC_META[key].direction
  if (d === 0 || factor === 1) return 'trait'
  return (factor > 1) === (d > 0) ? 'benefit' : 'cost'
}

const EFFECT_ORDER: Record<Effect, number> = { benefit: 0, cost: 1, trait: 2 }

/** Benefits first, then costs, then traits; largest change first inside each group. */
export const modifierEffects = (modifiers: Upgrade['modifiers']): ModifierEffect[] =>
  (Object.entries(modifiers) as [NumericSpecKey, number | undefined][])
    .filter((e): e is [NumericSpecKey, number] => typeof e[1] === 'number' && e[1] !== 1 && e[0] in SPEC_META)
    .map(([key, factor]) => ({ key, label: SPEC_META[key].label, change: factor - 1, effect: effectOf(key, factor) }))
    .sort((a, b) => EFFECT_ORDER[a.effect] - EFFECT_ORDER[b.effect] || Math.abs(b.change) - Math.abs(a.change))

/** "+8%" / "−12%". */
export const formatChange = (change: number): string => {
  const pct = Math.round(change * 100)
  if (pct === 0) return change > 0 ? '+<1%' : '−<1%'
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`
}

/** A real tradeoff has something to give and something to pay; livery is purely cosmetic. */
export const isTradeoff = (u: Upgrade): boolean => {
  if (u.slot === 'livery') return true
  const effects = modifierEffects(u.modifiers)
  return effects.some((e) => e.effect === 'benefit') && effects.some((e) => e.effect === 'cost')
}

export const applyUpgrades = (spec: AircraftSpec, upgrades: readonly Upgrade[]): AircraftSpec => {
  const out: Record<string, unknown> = { ...spec }
  for (const u of upgrades) {
    for (const [k, f] of Object.entries(u.modifiers)) {
      if (typeof f === 'number' && typeof out[k] === 'number') out[k] = (out[k] as number) * f
    }
  }
  return out as unknown as AircraftSpec
}

export interface SpecRow {
  readonly key: NumericSpecKey
  readonly label: string
  readonly base: string
  readonly value: string
  readonly change: number
  readonly effect: Effect
}

/** Rows whose value differs from the stock aircraft, with the net direction of the whole loadout. */
export const loadoutDiff = (base: AircraftSpec, effective: AircraftSpec): SpecRow[] =>
  SPEC_KEYS.filter((k) => base[k] !== 0 && Math.abs(effective[k] / base[k] - 1) > 1e-6).map((k) => {
    const factor = effective[k] / base[k]
    return {
      key: k,
      label: SPEC_META[k].label,
      base: SPEC_META[k].format(base[k]),
      value: SPEC_META[k].format(effective[k]),
      change: factor - 1,
      effect: effectOf(k, factor),
    }
  })

export const isUpgradeUnlocked = (u: Upgrade, progress: PlayerProgress): boolean =>
  u.unlock.kind === 'always' || progress.unlockedUpgrades.includes(u.id)

const BOARD_NAME = { smooth: 'Smooth Pilots', speed: 'Speedrunners', eco: 'Eco Pilots' } as const
export const boardName = (b: keyof typeof BOARD_NAME): string => BOARD_NAME[b]

/** What the player still has to do. Null when nothing is required. */
export const unlockHint = (rule: UnlockRule, progress: PlayerProgress): string | null => {
  switch (rule.kind) {
    case 'always':
      return null
    case 'flights': {
      const left = Math.max(0, rule.count - progress.flights)
      return left === 0 ? 'Unlocks after your next landing' : `Fly ${left} more ${left === 1 ? 'flight' : 'flights'}`
    }
    case 'score':
      return `Score ${Math.round(rule.atLeast)} on ${BOARD_NAME[rule.board]} (best ${Math.round(progress.best[rule.board])})`
  }
}

export const equippedIn = (
  progress: PlayerProgress,
  aircraftId: string,
  upgrades: readonly Upgrade[],
  slot: UpgradeSlot,
): Upgrade | null => {
  const ids = progress.loadouts[aircraftId] ?? []
  return upgrades.find((u) => u.slot === slot && ids.includes(u.id)) ?? null
}

export const SLOT_ORDER: readonly UpgradeSlot[] = ['wings', 'engines', 'cabin', 'instruments', 'radar', 'avionics', 'livery']
export const SLOT_LABEL: Record<UpgradeSlot, string> = {
  wings: 'Wings',
  engines: 'Engines',
  cabin: 'Cabin',
  instruments: 'Instruments',
  radar: 'Radar',
  avionics: 'Avionics',
  livery: 'Livery',
}
