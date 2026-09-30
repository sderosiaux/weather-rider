// Pure view of today's boards: ranks, the player's rows, which route to open on. No DOM.
import type { BoardKind, BoardsModel } from '../../core/presentation'
import type { LeaderboardEntry, Route } from '../../core/types'
import { displayName } from './pilotName'

export const BOARD_ORDER: readonly BoardKind[] = ['smooth', 'speed', 'eco']
/** The store keeps ten per board and day; the screen holds to that even if handed more. */
export const BOARD_ROWS = 10

export interface BoardRow {
  readonly entry: LeaderboardEntry
  /** Shared by equal shown scores: 812, 812, 640 → 1, 1, 3. */
  readonly rank: number
  readonly score: string
  /** Display text only. `you` compares the raw names. */
  readonly name: string
  readonly you: boolean
}

type RouteBoards = BoardsModel['boards'][string] | undefined

const scored = (entries: readonly LeaderboardEntry[]): LeaderboardEntry[] => entries.filter((e) => Number.isFinite(e.value))

/**
 * Best first, stable on ties (the store's order: the earlier run keeps the spot).
 * "You" is name equality, the only link the contract gives: a friend who shares your name is marked too,
 * and your runs under a previous name are not.
 */
export const rankRows = (entries: readonly LeaderboardEntry[], pilot: string): BoardRow[] => {
  const top = scored(entries).sort((a, b) => b.value - a.value).slice(0, BOARD_ROWS)
  const shown = top.map((e) => Math.round(e.value))
  return top.map((entry, i) => ({
    entry,
    rank: shown.indexOf(shown[i]!) + 1,
    score: String(shown[i]),
    name: displayName(entry.pilot),
    you: entry.pilot === pilot,
  }))
}

export const boardRows = (model: BoardsModel, routeId: string, board: BoardKind): BoardRow[] =>
  rankRows(model.boards[routeId]?.[board] ?? [], model.pilot)

/** Distinct flights on a route: one run usually sits on all three boards. */
export const runCount = (boards: RouteBoards): number =>
  boards ? new Set(BOARD_ORDER.flatMap((b) => scored(boards[b] ?? [])).map((e) => e.ghost)).size : 0

export const runsLabel = (n: number): string => (n === 0 ? 'No runs yet' : n === 1 ? '1 run' : `${n} runs`)

/** The route picked on the title, else the first one with runs, else the first. */
export const openingRoute = (model: BoardsModel, preferredId: string | null): Route => {
  const routes = model.daily.routes
  return (
    routes.find((r) => r.id === preferredId) ??
    routes.find((r) => runCount(model.boards[r.id]) > 0) ??
    routes[0]
  )
}
