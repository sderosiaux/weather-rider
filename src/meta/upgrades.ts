import type { AircraftSpec, NumericSpecKey, Upgrade, UpgradeSlot } from '../core/types'

export const UPGRADE_SLOTS: readonly UpgradeSlot[] = ['instruments', 'radar', 'wings', 'engines', 'cabin', 'livery', 'avionics']

/**
 * Which way is "better" for the pilot, per spec field. The hangar rule (SPEC §6, never pay_more = win) is
 * checked against this table: every functional upgrade must move at least one field in its good direction
 * and at least one in its bad direction.
 * 0 = no clear good direction: wing area buys lift but also drag and gust exposure; length is render-only.
 * limitGNeg is stored negative, so ×>1 widens the envelope (good).
 */
export const GOOD_DIRECTION: Readonly<Record<NumericSpecKey, 1 | -1 | 0>> = {
  massKg: -1,
  wingAreaM2: 0,
  maxThrustN: 1,
  fuelCapacityKg: 1,
  fuelBurnFullKgS: -1,
  stallSpeedMs: -1,
  cruiseSpeedMs: 1,
  maxSpeedMs: 1,
  serviceCeilingM: 1,
  rollRate: 1,
  pitchRate: 1,
  yawRate: 1,
  controlLag: -1,
  gustSensitivity: -1,
  cabinDamping: -1,
  limitGPos: 1,
  limitGNeg: 1,
  lengthM: 0,
}

// Boards read 1000 for a good blind flight of the aircraft (scoring/score.ts); score unlocks above ~1000 need the
// weather. Flight-count unlocks come one per flight from the 2nd to the 8th. Tuned with the balance lab.
export const UPGRADES: readonly Upgrade[] = [
  // Instruments: how the pilot reads the air.
  {
    id: 'inst-glass', slot: 'instruments', name: 'Glass cockpit',
    description: 'Crisp, instant readouts. You react sooner, and overreact to every bump.',
    modifiers: { controlLag: 0.9, gustSensitivity: 1.08 }, unlock: { kind: 'always' },
  },
  {
    id: 'inst-steam', slot: 'instruments', name: 'Steam gauges',
    description: 'Needles that lag and smooth the chop. Calmer hands, slower answers.',
    modifiers: { gustSensitivity: 0.9, controlLag: 1.12 }, unlock: { kind: 'flights', count: 3 },
  },
  {
    id: 'inst-gmeter', slot: 'instruments', name: 'Cabin g-meter',
    description: 'You feel what the passengers feel, so you pull gently.',
    modifiers: { cabinDamping: 0.92, pitchRate: 0.92 }, unlock: { kind: 'score', board: 'smooth', atLeast: 1150 },
  },
  // Radar: seeing weather before it hits.
  {
    id: 'radar-wx', slot: 'radar', name: 'Weather radar',
    description: 'Softens gust response. The radome adds weight.',
    modifiers: { gustSensitivity: 0.92, massKg: 1.06 }, unlock: { kind: 'always' },
  },
  {
    id: 'radar-doppler', slot: 'radar', name: 'Doppler turbulence radar',
    description: 'Smoother cabin ride, paid in weight and power draw.',
    modifiers: { cabinDamping: 0.9, massKg: 1.04, fuelBurnFullKgS: 1.06 }, unlock: { kind: 'flights', count: 5 },
  },
  {
    id: 'radar-lidar', slot: 'radar', name: 'Clear-air lidar',
    description: 'Spots invisible shear. Its generator eats engine power.',
    modifiers: { gustSensitivity: 0.88, maxThrustN: 0.93, massKg: 1.03 }, unlock: { kind: 'score', board: 'speed', atLeast: 1050 },
  },
  // Wings.
  {
    id: 'wings-winglets', slot: 'wings', name: 'Winglets',
    description: 'Less induced drag, lower burn. Bigger span catches every gust.',
    modifiers: { fuelBurnFullKgS: 0.9, gustSensitivity: 1.12 }, unlock: { kind: 'flights', count: 2 },
  },
  {
    id: 'wings-flaps', slot: 'wings', name: 'High-lift flaps',
    description: 'Fly slow without stalling. Draggy at the top end.',
    modifiers: { stallSpeedMs: 0.9, maxSpeedMs: 0.94, cruiseSpeedMs: 0.97 }, unlock: { kind: 'always' },
  },
  {
    id: 'wings-swept', slot: 'wings', name: 'Swept tips',
    description: 'Faster cruise and top speed. Stalls earlier, rolls lazier.',
    modifiers: { maxSpeedMs: 1.06, cruiseSpeedMs: 1.04, stallSpeedMs: 1.08, rollRate: 0.94 }, unlock: { kind: 'score', board: 'speed', atLeast: 1100 },
  },
  {
    id: 'wings-spar', slot: 'wings', name: 'Reinforced spar',
    description: 'Takes more g both ways. Heavier and stiffer in roll.',
    modifiers: { limitGPos: 1.15, limitGNeg: 1.15, massKg: 1.06, rollRate: 0.92 }, unlock: { kind: 'score', board: 'smooth', atLeast: 1300 },
  },
  // Engines.
  {
    id: 'eng-highbypass', slot: 'engines', name: 'High-bypass fans',
    description: 'Sips fuel, gives up thrust and top speed.',
    modifiers: { fuelBurnFullKgS: 0.88, maxThrustN: 0.92, maxSpeedMs: 0.97 }, unlock: { kind: 'always' },
  },
  {
    id: 'eng-uprated', slot: 'engines', name: 'Uprated cores',
    description: 'More thrust, much thirstier.',
    modifiers: { maxThrustN: 1.12, fuelBurnFullKgS: 1.14 }, unlock: { kind: 'flights', count: 4 },
  },
  {
    id: 'eng-geared', slot: 'engines', name: 'Geared turbofan',
    description: 'Efficient at cruise, heavy gearbox, runs out of breath up high.',
    modifiers: { fuelBurnFullKgS: 0.9, massKg: 1.05, serviceCeilingM: 0.94 }, unlock: { kind: 'score', board: 'eco', atLeast: 1100 },
  },
  // Cabin.
  {
    id: 'cabin-dampers', slot: 'cabin', name: 'Active seat dampers',
    description: 'Passengers barely notice the bumps. Heavy actuators.',
    modifiers: { cabinDamping: 0.88, massKg: 1.06, fuelBurnFullKgS: 1.03 }, unlock: { kind: 'always' },
  },
  {
    id: 'cabin-light', slot: 'cabin', name: 'Lightweight interior',
    description: 'Thin seats, light aircraft, every bump reaches row 32.',
    modifiers: { massKg: 0.93, cabinDamping: 1.1 }, unlock: { kind: 'flights', count: 6 },
  },
  {
    id: 'cabin-lounge', slot: 'cabin', name: 'Lounge cabin',
    description: 'Floating floor, bar and fewer fuel tanks.',
    modifiers: { cabinDamping: 0.85, massKg: 1.08, fuelCapacityKg: 0.95 }, unlock: { kind: 'score', board: 'smooth', atLeast: 1400 },
  },
  // Avionics.
  {
    id: 'avio-fbw', slot: 'avionics', name: 'Fly-by-wire',
    description: 'Snappier pitch and roll. Transmits more of the chop.',
    modifiers: { rollRate: 1.08, pitchRate: 1.08, gustSensitivity: 1.1 }, unlock: { kind: 'always' },
  },
  {
    id: 'avio-gla', slot: 'avionics', name: 'Gust load alleviation',
    description: 'Ailerons fight the gusts for you, and fight you a little too.',
    modifiers: { gustSensitivity: 0.85, rollRate: 0.92, pitchRate: 0.92 }, unlock: { kind: 'flights', count: 8 },
  },
  {
    id: 'avio-relaxed', slot: 'avionics', name: 'Relaxed stability',
    description: 'Twitchy and quick. Lower structural margin, rougher ride.',
    modifiers: { pitchRate: 1.15, controlLag: 0.9, limitGPos: 0.9, cabinDamping: 1.08 }, unlock: { kind: 'score', board: 'speed', atLeast: 1150 },
  },
  // Livery: trophies, no effect on flight.
  { id: 'livery-classic', slot: 'livery', name: 'Classic cheatline', description: 'The one it left the factory with.', modifiers: {}, unlock: { kind: 'always' } },
  { id: 'livery-silk', slot: 'livery', name: 'Silk', description: 'Earned by a flight nobody felt.', modifiers: {}, unlock: { kind: 'score', board: 'smooth', atLeast: 1500 } },
  { id: 'livery-jet', slot: 'livery', name: 'Jet stream', description: 'Earned by riding the wind flat out.', modifiers: {}, unlock: { kind: 'score', board: 'speed', atLeast: 1250 } },
  { id: 'livery-leaf', slot: 'livery', name: 'Leaf', description: 'Earned by gliding home on fumes.', modifiers: {}, unlock: { kind: 'score', board: 'eco', atLeast: 1300 } },
]

const BY_ID: ReadonlyMap<string, Upgrade> = new Map(UPGRADES.map((u) => [u.id, u]))

export function findUpgrade(id: string): Upgrade | undefined {
  return BY_ID.get(id)
}

/** Pure. At most one upgrade per slot; unknown ids and slot collisions throw. Keeps `id` so ghosts/boards still name the airframe. */
export function applyLoadout(spec: AircraftSpec, upgradeIds: readonly string[]): AircraftSpec {
  const seen = new Set<UpgradeSlot>()
  const out: { -readonly [K in keyof AircraftSpec]: AircraftSpec[K] } = { ...spec }
  for (const id of upgradeIds) {
    const u = BY_ID.get(id)
    if (!u) throw new Error(`applyLoadout: unknown upgrade "${id}"`)
    if (seen.has(u.slot)) throw new Error(`applyLoadout: two upgrades in slot "${u.slot}"`)
    seen.add(u.slot)
    for (const [key, factor] of Object.entries(u.modifiers) as [NumericSpecKey, number][]) {
      out[key] = out[key] * factor
    }
  }
  return out
}
