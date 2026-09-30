// Shared ghosts arrive from URLs and pasted text: attacker-controlled. The codec guarantees a well-formed
// Ghost; this gate checks it makes sense for THIS game before anything flies it.
import type { DailyWeather, Ghost, Route } from '../core/types'

/** A shared ghost is raceable while its day is still on the local boards (their retention window). */
export const SHARE_WINDOW_DAYS = 30

/** The ghost plus the exact code it was decoded from: identity for dedupe, never re-encoded. */
export interface RaceGhost {
  readonly ghost: Ghost
  readonly code: string
}

export type GhostVerdict =
  | { readonly ok: true; readonly race: RaceGhost; readonly daily: DailyWeather; readonly route: Route }
  | { readonly ok: false; readonly reason: string }

export interface GhostGateDeps {
  readonly today: number
  readonly aircraftIds: readonly string[]
  readonly dailyFor: (n: number) => DailyWeather
}

export function admitGhost(race: RaceGhost, deps: GhostGateDeps): GhostVerdict {
  const { ghost } = race
  if (ghost.samples.length === 0) return { ok: false, reason: 'ghost has no samples' }
  const n = ghost.dailyNumber
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, reason: `invalid day ${n}` }
  if (n > deps.today) return { ok: false, reason: `WORLD WEATHER #${n} has not happened yet` }
  if (n <= deps.today - SHARE_WINDOW_DAYS) return { ok: false, reason: `WORLD WEATHER #${n} is older than ${SHARE_WINDOW_DAYS} days` }
  if (!deps.aircraftIds.includes(ghost.aircraftId)) return { ok: false, reason: `unknown aircraft ${ghost.aircraftId}` }
  const daily = deps.dailyFor(n)
  const route = daily.routes.find((r) => r.id === ghost.routeId)
  if (!route) return { ok: false, reason: `route ${ghost.routeId} is not part of WORLD WEATHER #${n}` }
  return { ok: true, race, daily, route }
}
