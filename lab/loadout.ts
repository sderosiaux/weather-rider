// Hangar check (SPEC §6, never pay_more = win): does any upgrade, or any loadout built from them, beat the stock
// aircraft on all three boards? Each board is flown by its weather-aware specialist (surfer-smooth, surfer-fast,
// eco) on LOADOUT_DAYS × 3 routes; scores are normalised on the upgraded aircraft's own blind flight, exactly
// as in the game (session scores with the loadout spec).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createAutopilot, runFlight } from '../src/bot'
import type { AircraftSpec } from '../src/core/types'
import { AIRCRAFT } from '../src/flight'
import { applyLoadout, dailyWeatherFor, UPGRADES, terrainParamsFor, weatherParamsFor } from '../src/meta'
import { createTerrain } from '../src/terrain'
import { createWeather } from '../src/weather'
import { PILOTS } from './matrix'
import { CACHE, FIRST_DAY } from './shard'

const LOADOUT_DAYS = 3
const BOARDS = ['smooth', 'speed', 'eco'] as const
type BoardName = (typeof BOARDS)[number]
const SPECIALIST: Record<BoardName, string> = { smooth: 'surfer-smooth', speed: 'surfer-fast', eco: 'eco' }

export interface LoadoutResult {
  readonly run: number
  readonly aircraft: string
  /** Mean board score per loadout label ('stock', an upgrade id, or 'best:<board>' / 'best:all'). */
  readonly scores: Record<string, Record<BoardName, number>>
  readonly loadouts: Record<string, readonly string[]>
  readonly error?: string
}

const path = (aircraft: string): string => `${CACHE}/loadout-${aircraft}.json`

function evaluate(spec: AircraftSpec): Record<BoardName, number> {
  const out = { smooth: 0, speed: 0, eco: 0 }
  let n = 0
  for (let i = 0; i < LOADOUT_DAYS; i++) {
    const daily = dailyWeatherFor(FIRST_DAY + i)
    for (const route of daily.routes) {
      const weather = createWeather(weatherParamsFor(daily, route))
      const terrain = createTerrain(terrainParamsFor(daily, route))
      n++
      for (const b of BOARDS) {
        const p = PILOTS.find((x) => x.name === SPECIALIST[b])!
        out[b] += runFlight(spec, { route, weather, terrain }, createAutopilot(p.strategy, spec, route, weather, p.opts)).score[b]
      }
    }
  }
  return { smooth: out.smooth / n, speed: out.speed / n, eco: out.eco / n }
}

export function runLoadoutShard(aircraftIndex: number): void {
  const stock = AIRCRAFT[aircraftIndex]!
  try {
    const functional = UPGRADES.filter((u) => u.slot !== 'livery')
    const scores: LoadoutResult['scores'] = { stock: evaluate(stock) }
    for (const u of functional) scores[u.id] = evaluate(applyLoadout(stock, [u.id]))
    // Additive guess of the best loadout per board and for all three together (max of the smallest gain),
    // one upgrade per slot, then flown for real.
    const slots = [...new Set(functional.map((u) => u.slot))]
    const delta = (id: string, b: BoardName): number => scores[id]![b] - scores.stock![b]
    const pick = (score: (id: string) => number): string[] =>
      slots.flatMap((slot) => {
        const best = functional.filter((u) => u.slot === slot).sort((a, c) => score(c.id) - score(a.id))[0]
        return best && score(best.id) > 0 ? [best.id] : []
      })
    const loadouts: Record<string, string[]> = {}
    for (const b of BOARDS) loadouts[`best:${b}`] = pick((id) => delta(id, b))
    loadouts['best:all'] = pick((id) => Math.min(...BOARDS.map((b) => delta(id, b))))
    for (const [label, ids] of Object.entries(loadouts)) scores[label] = ids.length ? evaluate(applyLoadout(stock, ids)) : scores.stock!
    write({ run: process.ppid, aircraft: stock.id, scores, loadouts })
  } catch (err) {
    write({ run: process.ppid, aircraft: stock.id, scores: {}, loadouts: {}, error: String((err as Error).stack ?? err) })
    throw err
  }
}

function write(r: LoadoutResult): void {
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(path(r.aircraft), JSON.stringify(r))
}

export function readLoadout(aircraft: string): LoadoutResult | null {
  if (!existsSync(path(aircraft))) return null
  try {
    const r = JSON.parse(readFileSync(path(aircraft), 'utf8')) as LoadoutResult
    return r.run === process.ppid ? r : null
  } catch {
    return null
  }
}

/** Markdown section + the one-line verdict for the criteria. */
export function renderLoadouts(results: readonly LoadoutResult[]): { md: string; dominated: string[] } {
  const lines: string[] = []
  const dominated: string[] = []
  const f0 = (x: number): string => (Number.isFinite(x) ? x.toFixed(0) : '–')
  const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(0)}`
  lines.push(`Mean board score over ${LOADOUT_DAYS} days × 3 routes, each board flown by its specialist (smooth: surfer-smooth, speed: surfer-fast, eco: eco). A row "beats stock on all three" (by ≥ 1 % each, above run-to-run noise) is a pay_more = win violation.`)
  lines.push('')
  lines.push('| aircraft | loadout | upgrades | Δ smooth | Δ speed | Δ eco | beats stock on all three |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const r of results) {
    const stock = r.scores.stock!
    lines.push(`| ${r.aircraft} | stock | – | ${f0(stock.smooth)} | ${f0(stock.speed)} | ${f0(stock.eco)} | – |`)
    for (const [label, s] of Object.entries(r.scores)) {
      if (label === 'stock') continue
      const d = BOARDS.map((b) => s[b] - stock[b])
      // Beyond noise: at least 1 % better than stock on every board.
      const all = BOARDS.every((b, i) => d[i]! > 0.01 * stock[b])
      if (all) dominated.push(`${r.aircraft}:${label}`)
      const isCombo = label.startsWith('best:')
      if (!isCombo && !all) continue
      lines.push(`| ${r.aircraft} | ${label} | ${isCombo ? (r.loadouts[label] ?? []).join(', ') || '(stock)' : label} | ${d.map(signed).join(' | ')} | ${all ? '**yes**' : 'no'} |`)
    }
  }
  lines.push('')
  lines.push('Single upgrades are listed only when they beat stock on all three boards.')
  return { md: lines.join('\n'), dominated }
}
