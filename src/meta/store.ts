// Local persistence. Leaderboards are this browser's only (SPEC §10): no backend, no validation, no world ranking.
import type { LeaderboardEntry, PlayerProgress } from '../core/types'
import { AIRCRAFT_ORDER, BOARDS, newProgress, type Board } from './progression'
import { findUpgrade } from './upgrades'

export const STORAGE_KEY = 'weather-rider/meta'
const VERSION = 1
export const DEFAULT_PILOT = 'Pilot'
/** Ghost codes are the heavy part of an entry; cap what one browser keeps. */
const KEEP_PER_BOARD = 10
const KEEP_DAYS = 30

interface SaveFile {
  readonly version: typeof VERSION
  readonly lastPilot: string | null
  readonly pilots: Readonly<Record<string, PlayerProgress>>
  readonly entries: readonly LeaderboardEntry[]
}

const EMPTY: SaveFile = { version: VERSION, lastPilot: null, pilots: {}, entries: [] }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string')
const isBoard = (x: unknown): x is Board => BOARDS.includes(x as Board)

function isProgress(x: unknown): x is PlayerProgress {
  if (!isObj(x) || typeof x.pilot !== 'string' || !isNum(x.flights)) return false
  const b = x.best
  if (!isObj(b) || !isNum(b.smooth) || !isNum(b.speed) || !isNum(b.eco)) return false
  if (!isStrArr(x.unlockedAircraft) || !isStrArr(x.unlockedUpgrades)) return false
  if (!isObj(x.loadouts) || !Object.values(x.loadouts).every(isStrArr)) return false
  return isObj(x.livery) && Object.values(x.livery).every((c) => typeof c === 'string')
}

function isEntry(x: unknown): x is LeaderboardEntry {
  return isObj(x) && typeof x.pilot === 'string' && isNum(x.dailyNumber) && typeof x.routeId === 'string'
    && isBoard(x.board) && isNum(x.value) && typeof x.ghost === 'string'
}

/** Anything unreadable becomes a fresh save; single bad records are dropped rather than nuking the rest. */
function parse(raw: string | null): SaveFile {
  if (raw === null) return EMPTY
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (!isObj(data) || data.version !== VERSION || !isObj(data.pilots) || !Array.isArray(data.entries)) return EMPTY
  const pilots = Object.fromEntries(Object.entries(data.pilots).flatMap(([name, p]): [string, PlayerProgress][] => (isProgress(p) && p.pilot === name ? [[name, sanitize(p)]] : [])))
  return {
    version: VERSION,
    lastPilot: typeof data.lastPilot === 'string' && pilots[data.lastPilot] ? data.lastPilot : null,
    pilots,
    entries: data.entries.filter(isEntry),
  }
}

/**
 * Rows that read the same on a board are one row: racing a friend's ghost again, or landing the same score twice,
 * adds nothing. The first occurrence wins, so a stored row keeps its ghost and its tie-break rank.
 */
function dedupe(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const key = JSON.stringify([e.pilot, e.dailyNumber, e.routeId, e.board, e.value])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Highest first; on ties the earlier submission (lower index) wins, so re-flying an equal score doesn't steal the spot. */
const ranked = (entries: readonly LeaderboardEntry[]): LeaderboardEntry[] =>
  entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.value - a.e.value || a.i - b.i).map(({ e }) => e)

function prune(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  const newestDay = entries.reduce((m, e) => Math.max(m, e.dailyNumber), -Infinity)
  const groups = new Map<string, LeaderboardEntry[]>()
  for (const e of entries) {
    if (e.dailyNumber <= newestDay - KEEP_DAYS) continue
    const k = `${e.dailyNumber}|${e.routeId}|${e.board}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  const kept = new Set([...groups.values()].flatMap((g) => ranked(g).slice(0, KEEP_PER_BOARD)))
  return entries.filter((e) => kept.has(e))
}

/** Stored progress may predate a tuning change: drop ids this build doesn't know, grant anything now free. */
function sanitize(p: PlayerProgress): PlayerProgress {
  const fresh = newProgress(p.pilot)
  const knownAircraft = (id: string): boolean => (AIRCRAFT_ORDER as readonly string[]).includes(id)
  const knownUpgrade = (id: string): boolean => findUpgrade(id) !== undefined
  const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])]
  return {
    ...p,
    unlockedAircraft: union(fresh.unlockedAircraft, p.unlockedAircraft.filter(knownAircraft)),
    unlockedUpgrades: union(fresh.unlockedUpgrades, p.unlockedUpgrades.filter(knownUpgrade)),
    loadouts: Object.fromEntries(Object.entries(p.loadouts).filter(([id]) => knownAircraft(id)).map(([id, ups]) => [id, ups.filter(knownUpgrade)])),
    livery: Object.fromEntries(Object.entries(p.livery).filter(([id]) => knownAircraft(id))),
  }
}

export interface MetaStore {
  /** Named pilot, else the last one saved, else a fresh "Pilot". Never throws. */
  loadProgress(pilot?: string): PlayerProgress
  /** false when the browser refused the write (quota, private mode): progress then lives only in memory. */
  saveProgress(progress: PlayerProgress): boolean
  submit(entries: readonly LeaderboardEntry[]): boolean
  localLeaderboard(dailyNumber: number, routeId: string, board: Board, limit?: number): LeaderboardEntry[]
  bestGhost(dailyNumber: number, routeId: string, board: Board): string | null
}

export function createStore(storage: Pick<Storage, 'getItem' | 'setItem'>): MetaStore {
  const read = (): SaveFile => {
    try {
      return parse(storage.getItem(STORAGE_KEY))
    } catch {
      return EMPTY
    }
  }
  const write = (file: SaveFile): boolean => {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(file))
      return true
    } catch {
      return false
    }
  }
  const board = (dailyNumber: number, routeId: string, b: Board): LeaderboardEntry[] =>
    ranked(read().entries.filter((e) => e.dailyNumber === dailyNumber && e.routeId === routeId && e.board === b))

  return {
    loadProgress(pilot) {
      const file = read()
      const name = pilot ?? file.lastPilot ?? DEFAULT_PILOT
      return file.pilots[name] ?? newProgress(name)
    },
    saveProgress(progress) {
      const file = read()
      return write({ ...file, lastPilot: progress.pilot, pilots: { ...file.pilots, [progress.pilot]: progress } })
    },
    submit(entries) {
      const file = read()
      return write({ ...file, entries: prune(dedupe([...file.entries, ...entries])) })
    },
    localLeaderboard(dailyNumber, routeId, b, limit = 10) {
      return board(dailyNumber, routeId, b).slice(0, limit)
    },
    bestGhost(dailyNumber, routeId, b) {
      return board(dailyNumber, routeId, b)[0]?.ghost ?? null
    },
  }
}
