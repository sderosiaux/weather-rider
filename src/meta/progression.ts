import type { FlightScore, LeaderboardEntry, PlayerProgress, UnlockRule, UpgradeSlot } from '../core/types'
import { findUpgrade, UPGRADES } from './upgrades'

export const AIRCRAFT_ORDER = ['turboprop', 'regional', 'narrowbody', 'widebody', 'cargo', 'supersonic', 'experimental'] as const
export type AircraftId = (typeof AIRCRAFT_ORDER)[number]

export type Board = 'smooth' | 'speed' | 'eco'
export const BOARDS: readonly Board[] = ['smooth', 'speed', 'eco']

/**
 * Aircraft unlock curve, the one tuning table (with upgrade thresholds in upgrades.ts).
 * Unlocks happen strictly in AIRCRAFT_ORDER: each needs the previous one plus its own rule.
 * Early aircraft reward showing up; later ones ask for a best score above 1000, which a blind flight never
 * reaches (boards read 1000 for flying the aircraft well without reading the sky): speed for the wide body and
 * the supersonic, eco for the cargo, all three for the experimental. Tuned with the balance lab.
 */
export const AIRCRAFT_UNLOCKS: Readonly<Record<AircraftId, { readonly flights: number; readonly best: Partial<Record<Board, number>> }>> = {
  turboprop: { flights: 0, best: {} },
  regional: { flights: 2, best: {} },
  narrowbody: { flights: 4, best: { smooth: 800 } },
  widebody: { flights: 7, best: { speed: 1050 } },
  cargo: { flights: 10, best: { eco: 1100 } },
  supersonic: { flights: 14, best: { speed: 1150 } },
  experimental: { flights: 20, best: { smooth: 1050, speed: 1150, eco: 1200 } },
}

const LIVERY_RE = /^#[0-9a-f]{6}$/i

export function newProgress(pilot: string): PlayerProgress {
  return {
    pilot,
    flights: 0,
    best: { smooth: 0, speed: 0, eco: 0 },
    unlockedAircraft: ['turboprop'],
    unlockedUpgrades: UPGRADES.filter((u) => u.unlock.kind === 'always').map((u) => u.id),
    loadouts: {},
    livery: {},
  }
}

function ruleMet(rule: UnlockRule, flights: number, best: PlayerProgress['best']): boolean {
  switch (rule.kind) {
    case 'always':
      return true
    case 'flights':
      return flights >= rule.count
    case 'score':
      return best[rule.board] >= rule.atLeast
  }
}

function aircraftRuleMet(id: AircraftId, flights: number, best: PlayerProgress['best']): boolean {
  const r = AIRCRAFT_UNLOCKS[id]
  return flights >= r.flights && BOARDS.every((b) => best[b] >= (r.best[b] ?? 0))
}

export interface FlightRecord {
  readonly score: FlightScore
  readonly dailyNumber: number
  readonly routeId: string
  readonly aircraftId: string
  readonly ghostCode: string
}

/**
 * Pure. A flight counts once it ended (arrived, crashed or overstressed); an aborted run (status 'flying') doesn't.
 * Boards only receive arrived flights with a positive score.
 */
export function recordFlight(
  progress: PlayerProgress,
  input: FlightRecord,
): { progress: PlayerProgress; newlyUnlocked: readonly string[]; entries: readonly LeaderboardEntry[] } {
  const { score } = input
  const ended = score.status !== 'flying'
  const arrived = score.status === 'arrived'
  const flights = progress.flights + (ended ? 1 : 0)
  const best = arrived
    ? { smooth: Math.max(progress.best.smooth, score.smooth), speed: Math.max(progress.best.speed, score.speed), eco: Math.max(progress.best.eco, score.eco) }
    : progress.best

  const aircraft = [...progress.unlockedAircraft]
  const newlyUnlocked: string[] = []
  for (let i = 1; i < AIRCRAFT_ORDER.length; i++) {
    const id = AIRCRAFT_ORDER[i]!
    if (aircraft.includes(id)) continue
    if (!aircraft.includes(AIRCRAFT_ORDER[i - 1]!) || !aircraftRuleMet(id, flights, best)) break
    aircraft.push(id)
    newlyUnlocked.push(id)
  }
  const upgrades = [...progress.unlockedUpgrades]
  for (const u of UPGRADES) {
    if (!upgrades.includes(u.id) && ruleMet(u.unlock, flights, best)) {
      upgrades.push(u.id)
      newlyUnlocked.push(u.id)
    }
  }

  const entries: LeaderboardEntry[] = arrived
    ? BOARDS.filter((b) => score[b] > 0).map((board) => ({
        pilot: progress.pilot,
        dailyNumber: input.dailyNumber,
        routeId: input.routeId,
        board,
        value: score[board],
        ghost: input.ghostCode,
      }))
    : []

  return {
    progress: { ...progress, flights, best, unlockedAircraft: aircraft, unlockedUpgrades: upgrades },
    newlyUnlocked,
    entries,
  }
}

function requireAircraft(progress: PlayerProgress, aircraftId: string): void {
  if (!progress.unlockedAircraft.includes(aircraftId)) throw new Error(`aircraft "${aircraftId}" is locked`)
}

/** Pure. Replaces whatever sat in the upgrade's slot. Throws on locked aircraft or locked/unknown upgrade. */
export function equip(progress: PlayerProgress, aircraftId: string, upgradeId: string): PlayerProgress {
  requireAircraft(progress, aircraftId)
  const u = findUpgrade(upgradeId)
  if (!u) throw new Error(`unknown upgrade "${upgradeId}"`)
  if (!progress.unlockedUpgrades.includes(upgradeId)) throw new Error(`upgrade "${upgradeId}" is locked`)
  const current = progress.loadouts[aircraftId] ?? []
  const next = [...current.filter((id) => findUpgrade(id)?.slot !== u.slot), upgradeId]
  return { ...progress, loadouts: { ...progress.loadouts, [aircraftId]: next } }
}

/** Pure. Empties a slot (the hangar needs a way back to stock). */
export function unequip(progress: PlayerProgress, aircraftId: string, upgradeId: string): PlayerProgress {
  requireAircraft(progress, aircraftId)
  const current = progress.loadouts[aircraftId] ?? []
  return { ...progress, loadouts: { ...progress.loadouts, [aircraftId]: current.filter((id) => id !== upgradeId) } }
}

/** Pure. Color is a free choice ("#rrggbb"), only the aircraft must be unlocked. */
export function setLivery(progress: PlayerProgress, aircraftId: string, color: string): PlayerProgress {
  requireAircraft(progress, aircraftId)
  if (!LIVERY_RE.test(color)) throw new Error(`livery color must be #rrggbb, got "${color}"`)
  return { ...progress, livery: { ...progress.livery, [aircraftId]: color.toLowerCase() } }
}

const BOARD_LABEL: Readonly<Record<Board, string>> = { smooth: 'Smooth', speed: 'Speed', eco: 'Eco' }

/**
 * Why each locked aircraft is still locked, in player words. Unlocked aircraft are absent.
 * Aircraft further down AIRCRAFT_ORDER than the next one to unlock only say what they wait for.
 */
export function unlockHints(progress: PlayerProgress): Readonly<Record<string, string>> {
  const hints: Record<string, string> = {}
  let previousLocked: AircraftId | null = null
  for (const id of AIRCRAFT_ORDER) {
    if (progress.unlockedAircraft.includes(id)) continue
    if (previousLocked) {
      hints[id] = `Unlock ${previousLocked} first`
      continue
    }
    const r = AIRCRAFT_UNLOCKS[id]
    const parts: string[] = []
    const missingFlights = r.flights - progress.flights
    if (missingFlights > 0) parts.push(`${missingFlights} more flight${missingFlights > 1 ? 's' : ''}`)
    for (const b of BOARDS) {
      const need = r.best[b]
      if (need !== undefined && progress.best[b] < need) parts.push(`${BOARD_LABEL[b]} ${need}`)
    }
    hints[id] = parts.length > 0 ? parts.join(' · ') : 'Unlocks after your next flight'
    previousLocked = id
  }
  return hints
}

/** Unequip whatever occupies `slot` on this aircraft (back to stock). */
export function unequipSlot(progress: PlayerProgress, aircraftId: string, slot: UpgradeSlot): PlayerProgress {
  const current = progress.loadouts[aircraftId] ?? []
  const inSlot = current.find((id) => findUpgrade(id)?.slot === slot)
  return inSlot ? unequip(progress, aircraftId, inSlot) : progress
}
