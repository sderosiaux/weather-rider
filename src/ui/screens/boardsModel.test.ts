import { describe, expect, it } from 'vitest'
import type { BoardKind, BoardsModel } from '../../core/presentation'
import type { DailyWeather, LeaderboardEntry, Route } from '../../core/types'
import { fixtureRoute } from '../../core/fixtures'
import { BOARD_ROWS, boardRows, openingRoute, rankRows, runCount, runsLabel } from './boardsModel'

const entry = (pilot: string, value: number, ghost = `g-${pilot}-${value}`, board: BoardKind = 'smooth', routeId = 'jfk-lis'): LeaderboardEntry => ({
  pilot,
  dailyNumber: 272,
  routeId,
  board,
  value,
  ghost,
})

const route = (id: string): Route => ({ ...fixtureRoute, id, label: id.toUpperCase().replace('-', ' → ') })
const daily: DailyWeather = {
  number: 272,
  seed: 272,
  routes: [route('jfk-lis'), route('sfo-hnl'), route('dxb-sin')],
  sky: { sunElevationDeg: 24, sunAzimuthDeg: 120, haze: 0.3, warmth: 0.3 },
  boundsMin: fixtureRoute.start,
  boundsMax: fixtureRoute.gate,
}
const empty = { smooth: [], speed: [], eco: [] }
const model = (boards: BoardsModel['boards'], pilot = 'Ada'): BoardsModel => ({ daily, pilot, boards })

describe('board ranking', () => {
  it('ranks best first and shares the rank on equal scores', () => {
    const rows = rankRows([entry('Marco', 640), entry('Ada', 812, 'first'), entry('Zoë', 812, 'second'), entry('Kenji', 455)], 'Ada')
    expect(rows.map((r) => [r.rank, r.name, r.score])).toEqual([
      [1, 'Ada', '812'],
      [1, 'Zoë', '812'],
      [3, 'Marco', '640'],
      [4, 'Kenji', '455'],
    ])
  })

  it('keeps the earlier run ahead on a tie, like the store', () => {
    const rows = rankRows([entry('Zoë', 700, 'early'), entry('Ada', 700, 'late')], 'Ada')
    expect(rows.map((r) => r.entry.ghost)).toEqual(['early', 'late'])
  })

  it('ranks on the shown score, so equal numbers never show different ranks', () => {
    const rows = rankRows([entry('A', 812.4), entry('B', 811.6), entry('C', 811.4)], 'x')
    expect(rows.map((r) => [r.rank, r.score])).toEqual([[1, '812'], [1, '812'], [3, '811']])
  })

  it('shows at most ten rows and skips unreadable scores', () => {
    const many = Array.from({ length: 14 }, (_, i) => entry(`P${i}`, 100 + i))
    const rows = rankRows([...many, entry('Broken', Number.NaN), entry('Inf', Number.POSITIVE_INFINITY)], 'x')
    expect(rows).toHaveLength(BOARD_ROWS)
    expect(rows[0]!.name).toBe('P13')
    expect(rows.some((r) => r.name === 'Broken' || r.name === 'Inf')).toBe(false)
  })

  it('does not reorder the entries it was given', () => {
    const given = [entry('B', 1), entry('A', 2)]
    rankRows(given, 'x')
    expect(given.map((e) => e.pilot)).toEqual(['B', 'A'])
  })

  it('marks the player’s rows by exact name, not by look-alikes', () => {
    const rows = rankRows([entry('Ada', 900), entry('Ada\u200B', 800), entry('ada', 700), entry('Zoë', 600), entry('Ada', 500)], 'Ada')
    expect(rows.map((r) => [r.name, r.you])).toEqual([
      ['Ada', true],
      ['Ada', false],
      ['ada', false],
      ['Zoë', false],
      ['Ada', true],
    ])
  })

  it('hands back the original entry for Race', () => {
    const e = entry('<img src=x onerror=alert(1)>', 1042, 'ghost-code')
    const [row] = rankRows([e], 'Ada')
    expect(row!.entry).toBe(e)
    expect(row!.name).toBe('<img src=x onerror=…')
  })
})

describe('routes on the boards', () => {
  const boards: BoardsModel['boards'] = {
    'jfk-lis': empty,
    'sfo-hnl': {
      smooth: [entry('Ada', 700, 'run-1'), entry('Zoë', 650, 'run-2')],
      speed: [entry('Zoë', 900, 'run-2'), entry('Ada', 800, 'run-1')],
      eco: [entry('Ada', 500, 'run-1')],
    },
    'dxb-sin': { ...empty, speed: [entry('Kenji', 1255, 'run-3')] },
  }

  it('counts distinct runs, not rows', () => {
    expect(runCount(boards['sfo-hnl'])).toBe(2)
    expect(runCount(boards['dxb-sin'])).toBe(1)
    expect(runCount(boards['jfk-lis'])).toBe(0)
    expect(runCount(undefined)).toBe(0)
    expect([0, 1, 2].map(runsLabel)).toEqual(['No runs yet', '1 run', '2 runs'])
  })

  it('opens on the title’s route, else the first route with runs, else the first route', () => {
    expect(openingRoute(model(boards), 'dxb-sin').id).toBe('dxb-sin')
    expect(openingRoute(model(boards), 'jfk-lis').id).toBe('jfk-lis')
    expect(openingRoute(model(boards), null).id).toBe('sfo-hnl')
    expect(openingRoute(model(boards), 'gone-yesterday').id).toBe('sfo-hnl')
    expect(openingRoute(model({}), null).id).toBe('jfk-lis')
  })

  it('reads a board, and an empty one when the shell left a route out', () => {
    expect(boardRows(model(boards), 'sfo-hnl', 'speed').map((r) => [r.name, r.you])).toEqual([['Zoë', false], ['Ada', true]])
    expect(boardRows(model(boards, 'Zoë'), 'sfo-hnl', 'speed').map((r) => r.you)).toEqual([true, false])
    expect(boardRows(model({}), 'sfo-hnl', 'eco')).toEqual([])
  })
})
