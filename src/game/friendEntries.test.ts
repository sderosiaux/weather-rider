import { describe, expect, it } from 'vitest'
import { createFixtureGhost } from '../core/fixtures'
import { friendEntries, sanitizePilotName } from './friendEntries'

describe('friendEntries', () => {
  it('turns an arrived ghost into one row per scored board', () => {
    const ghost = createFixtureGhost()
    const rows = friendEntries(ghost, 'code')
    expect(rows.map((r) => r.board)).toEqual(['smooth', 'speed', 'eco'])
    expect(rows[1]).toMatchObject({ pilot: ghost.pilot, routeId: ghost.routeId, dailyNumber: ghost.dailyNumber, value: ghost.score.speed, ghost: 'code' })
  })
  it('a crashed ghost scores nothing', () => {
    const ghost = createFixtureGhost()
    expect(friendEntries({ ...ghost, score: { ...ghost.score, status: 'crashed' } }, 'code')).toEqual([])
  })
})

describe('sanitizePilotName', () => {
  it('trims, collapses spaces, caps at 20', () => {
    expect(sanitizePilotName('  Ada   Lovelace  ', 'Pilot')).toBe('Ada Lovelace')
    expect(sanitizePilotName('x'.repeat(40), 'Pilot')).toHaveLength(20)
  })
  it('strips control and bidi characters, falls back when empty or not a string', () => {
    expect(sanitizePilotName('A\u202eB\u0000C', 'Pilot')).toBe('ABC')
    expect(sanitizePilotName('   ', 'Pilot')).toBe('Pilot')
    expect(sanitizePilotName(42, 'Pilot')).toBe('Pilot')
  })
})
