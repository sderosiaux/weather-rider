import { describe, expect, it } from 'vitest'
import type { LeaderboardEntry } from '../core/types'
import { equip, newProgress } from './progression'
import { createStore, STORAGE_KEY } from './store'

const memoryStorage = (init: Record<string, string> = {}) => {
  const data = new Map(Object.entries(init))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    raw: () => data.get(STORAGE_KEY),
  }
}

const entry = (over: Partial<LeaderboardEntry>): LeaderboardEntry => ({
  pilot: 'Ada', dailyNumber: 272, routeId: 'jfk-lis', board: 'smooth', value: 500, ghost: 'g', ...over,
})

describe('createStore: progress', () => {
  it('fresh storage → fresh default pilot', () => {
    expect(createStore(memoryStorage()).loadProgress()).toEqual(newProgress('Pilot'))
  })

  it('round-trips progress and remembers the last pilot', () => {
    const s = memoryStorage()
    const store = createStore(s)
    const p = { ...equip(newProgress('Ada'), 'turboprop', 'wings-flaps'), flights: 3 }
    expect(store.saveProgress(p)).toBe(true)
    expect(createStore(s).loadProgress()).toEqual(p)
    expect(createStore(s).loadProgress('Ada')).toEqual(p)
    expect(createStore(s).loadProgress('Bob')).toEqual(newProgress('Bob'))
  })

  it.each([
    ['not json', '{{{'],
    ['wrong version', JSON.stringify({ version: 99, pilots: {}, entries: [] })],
    ['wrong shape', JSON.stringify([1, 2, 3])],
    ['null', 'null'],
  ])('corrupt data (%s) → fresh state, no throw', (_, raw) => {
    const store = createStore(memoryStorage({ [STORAGE_KEY]: raw }))
    expect(store.loadProgress('Ada')).toEqual(newProgress('Ada'))
    expect(store.localLeaderboard(272, 'jfk-lis', 'smooth')).toEqual([])
  })

  it('drops a malformed pilot but keeps valid ones', () => {
    const good = newProgress('Ada')
    const raw = JSON.stringify({ version: 1, lastPilot: 'Bad', pilots: { Ada: good, Bad: { pilot: 'Bad', flights: 'x' } }, entries: [entry({}), { nope: 1 }] })
    const store = createStore(memoryStorage({ [STORAGE_KEY]: raw }))
    expect(store.loadProgress()).toEqual(newProgress('Pilot'))
    expect(store.loadProgress('Ada')).toEqual(good)
    expect(store.localLeaderboard(272, 'jfk-lis', 'smooth')).toHaveLength(1)
  })

  it('strips ids a newer build no longer knows', () => {
    const p = { ...newProgress('Ada'), unlockedAircraft: ['turboprop', 'zeppelin'], unlockedUpgrades: ['nitro'], loadouts: { turboprop: ['nitro', 'wings-flaps'] } }
    const store = createStore(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, lastPilot: 'Ada', pilots: { Ada: p }, entries: [] }) }))
    const loaded = store.loadProgress()
    expect(loaded.unlockedAircraft).toEqual(['turboprop'])
    expect(loaded.unlockedUpgrades).toEqual(newProgress('Ada').unlockedUpgrades)
    expect(loaded.loadouts).toEqual({ turboprop: ['wings-flaps'] })
  })

  it('never throws when storage itself throws', () => {
    const store = createStore({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } })
    expect(store.loadProgress('Ada')).toEqual(newProgress('Ada'))
    expect(store.saveProgress(newProgress('Ada'))).toBe(false)
    expect(store.submit([entry({})])).toBe(false)
    expect(store.bestGhost(272, 'jfk-lis', 'smooth')).toBeNull()
  })
})

describe('createStore: local leaderboards', () => {
  it('ranks per (day, route, board), highest first, earlier wins ties', () => {
    const store = createStore(memoryStorage())
    store.submit([entry({ pilot: 'A', value: 300, ghost: 'a' }), entry({ pilot: 'B', value: 700, ghost: 'b' })])
    store.submit([entry({ pilot: 'C', value: 700, ghost: 'c' }), entry({ pilot: 'D', value: 900, board: 'speed', ghost: 'd' })])
    store.submit([entry({ pilot: 'E', value: 999, routeId: 'lhr-jfk' }), entry({ pilot: 'F', value: 999, dailyNumber: 271 })])
    expect(store.localLeaderboard(272, 'jfk-lis', 'smooth').map((e) => e.pilot)).toEqual(['B', 'C', 'A'])
    expect(store.localLeaderboard(272, 'jfk-lis', 'smooth', 2)).toHaveLength(2)
    expect(store.bestGhost(272, 'jfk-lis', 'smooth')).toBe('b')
    expect(store.bestGhost(272, 'jfk-lis', 'speed')).toBe('d')
    expect(store.bestGhost(272, 'jfk-lis', 'eco')).toBeNull()
  })

  it('ignores exact duplicate submissions', () => {
    const store = createStore(memoryStorage())
    store.submit([entry({})])
    store.submit([entry({})])
    expect(store.localLeaderboard(272, 'jfk-lis', 'smooth')).toHaveLength(1)
  })

  it('keeps the top 10 per board and forgets days older than 30', () => {
    const store = createStore(memoryStorage())
    store.submit(Array.from({ length: 15 }, (_, i) => entry({ pilot: `P${i}`, value: i * 10, ghost: `g${i}` })))
    const board = store.localLeaderboard(272, 'jfk-lis', 'smooth', 100)
    expect(board).toHaveLength(10)
    expect(board.at(-1)!.value).toBe(50)
    store.submit([entry({ dailyNumber: 302 })])
    expect(store.localLeaderboard(272, 'jfk-lis', 'smooth')).toEqual([])
    expect(store.localLeaderboard(302, 'jfk-lis', 'smooth')).toHaveLength(1)
  })

  it('progress and boards share one versioned key without clobbering each other', () => {
    const s = memoryStorage()
    const store = createStore(s)
    store.saveProgress(newProgress('Ada'))
    store.submit([entry({})])
    store.saveProgress({ ...newProgress('Ada'), flights: 1 })
    expect(store.localLeaderboard(272, 'jfk-lis', 'smooth')).toHaveLength(1)
    expect(JSON.parse(s.raw()!).version).toBe(1)
  })
})
