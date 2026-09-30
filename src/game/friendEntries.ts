import type { Ghost, LeaderboardEntry } from '../core/types'

const BOARDS = ['smooth', 'speed', 'eco'] as const

/**
 * A raced friend's ghost becomes rows on today's local boards (the only "social" board without a backend).
 * Only arrived flights score; dedupe of repeated races is the store's job.
 */
export function friendEntries(ghost: Ghost, code: string): readonly LeaderboardEntry[] {
  if (ghost.score.status !== 'arrived') return []
  return BOARDS.filter((board) => ghost.score[board] > 0).map((board) => ({
    pilot: ghost.pilot,
    dailyNumber: ghost.dailyNumber,
    routeId: ghost.routeId,
    board,
    value: ghost.score[board],
    ghost: code,
  }))
}

/** Pilot names are user text that travels inside shared ghosts: keep them short and printable. */
export function sanitizePilotName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20)
  return clean.length > 0 ? clean : fallback
}
