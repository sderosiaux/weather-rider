// Wave-3 balance criteria (brief from the architect), computed from the lab rows. One source for the
// console summary, the report section and the balance-loop log.
import { AIRCRAFT_ORDER, type Board } from '../src/meta'
import { PILOTS, type FlightRow } from './matrix'
import { bestOf, median, quantile, simulateUnlocks } from './report'

const skilled = PILOTS.filter((p) => p.skilled).map((p) => p.name)
const naive = PILOTS.filter((p) => !p.skilled).map((p) => p.name)

export interface BoardEdge {
  /** Share of (day, route, aircraft) where the best weather-aware pilot beats the best naive one. */
  readonly ahead: number
  /** Median relative gain of best weather-aware over best naive (%). */
  readonly gainPct: number
}

export function boardEdge(rows: readonly FlightRow[], board: Board, tiers: readonly string[]): BoardEdge {
  const rs = rows.filter((r) => tiers.includes(r.tier))
  const n = bestOf(rs, naive, board)
  const s = bestOf(rs, skilled, board)
  let ahead = 0
  const gains: number[] = []
  for (const [k, nv] of n) {
    const sv = s.get(k) ?? 0
    if (sv > nv) ahead++
    if (nv > 0) gains.push((100 * (sv - nv)) / nv)
  }
  return { ahead: n.size ? ahead / n.size : NaN, gainPct: median(gains) }
}

export interface Criteria {
  readonly text: string
  readonly line: string
}

const pc = (x: number): string => `${Math.round(100 * x)}%`
const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '–')

export function criteriaSummary(rows: readonly FlightRow[]): Criteria {
  const hard = ['moderate', 'extreme']
  const sp = boardEdge(rows, 'speed', hard)
  const spc = boardEdge(rows, 'speed', ['calm'])
  const ec = boardEdge(rows, 'eco', hard)
  const ecc = boardEdge(rows, 'eco', ['calm'])
  const smx = boardEdge(rows, 'smooth', ['extreme'])
  const direct = rows.filter((r) => r.pilot === 'direct' && r.outcome === 'arrived')
  const directFuel = median(direct.map((r) => r.fuelRemainingPct))
  const directFuelByAc = AIRCRAFT_ORDER.map((a) => median(direct.filter((r) => r.aircraft === a).map((r) => r.fuelRemainingPct)))
  const recklessDry = rows.filter((r) => r.pilot === 'reckless' && r.tier === 'extreme' && (r.outcome === 'fuel' || r.fuelRemainingPct < 0.5)).length
  const arrived = rows.filter((r) => r.outcome === 'arrived')
  const over60 = arrived.filter((r) => r.fuelRemainingPct > 60).length / Math.max(arrived.length, 1)
  const surferWu = median(rows.filter((r) => r.pilot === 'surfer' && r.outcome === 'arrived').map((r) => r.weatherUtilization))
  const dominance = (['smooth', 'speed', 'eco'] as const).map((b) => {
    const best = new Map<string, FlightRow>()
    for (const r of rows) {
      const k = `${r.day}:${r.tier}`
      const cur = best.get(k)
      if (!cur || r[b] > cur[b]) best.set(k, r)
    }
    const counts = new Map<string, number>()
    for (const r of best.values()) counts.set(r.aircraft, (counts.get(r.aircraft) ?? 0) + 1)
    const [top, n] = [...counts].sort((a, c) => c[1] - a[1])[0] ?? ['–', 0]
    return `${b} ${top} ${pc(n / Math.max(best.size, 1))}`
  })
  const days = [...new Set(rows.map((r) => r.day))].sort((a, b) => a - b)
  const unlocks = simulateUnlocks(rows, days, 'surfer', () => 'surfer')
  const unlockLine = AIRCRAFT_ORDER.map((id) => unlocks.at[id] ?? '—').join('/')
  const minutes = direct.map((r) => r.simTimeS / 60)
  // g) surfer vs direct on the speed board, paired, moderate+extreme.
  const byKey = new Map<string, FlightRow>()
  for (const r of rows) if (hard.includes(r.tier) && (r.pilot === 'direct' || r.pilot === 'surfer')) byKey.set(`${r.pilot}:${r.day}:${r.tier}:${r.aircraft}`, r)
  const gDeltas: number[] = []
  for (const r of byKey.values()) {
    if (r.pilot !== 'surfer') continue
    const d = byKey.get(`direct:${r.day}:${r.tier}:${r.aircraft}`)
    if (d && d.speed > 0) gDeltas.push((100 * (r.speed - d.speed)) / d.speed)
  }
  const gMedian = median(gDeltas)
  const minutesBy = AIRCRAFT_ORDER.map((a) => {
    const m = direct.filter((r) => r.aircraft === a).map((r) => r.simTimeS / 60)
    return `${a.slice(0, 4)} ${f1(Math.min(...m))}–${f1(Math.max(...m))}`
  }).join(', ')
  const failures = rows.filter((r) => r.outcome !== 'arrived').length
  const text = [
    `a) speed  mod+ext: ahead ${pc(sp.ahead)} gain ${f1(sp.gainPct)}% | calm: ahead ${pc(spc.ahead)} gain ${f1(spc.gainPct)}%   (want ≥70% & ≥+10% / ≥50%)`,
    `b) eco    mod+ext: ahead ${pc(ec.ahead)} gain ${f1(ec.gainPct)}% | calm: ahead ${pc(ecc.ahead)} gain ${f1(ecc.gainPct)}%   (want ≥70%)`,
    `c) smooth extreme: ahead ${pc(smx.ahead)} gain ${f1(smx.gainPct)}%`,
    `d) direct fuel left median ${f1(directFuel)}% (by aircraft ${directFuelByAc.map((x) => Math.round(x)).join('/')}); reckless dry on extreme: ${recklessDry}; arrivals >60% fuel: ${pc(over60)}   (want 10–30%, >0, 0%)`,
    `e) surfer weather utilization p50 ${f1(surferWu)}%   (want ≥30%)`,
    `f) board leaders: ${dominance.join(' · ')}; surfer unlock flights ${unlockLine}`,
    `h) stress on extreme: direct p50/max ${f1(median(rows.filter((r) => r.pilot === 'direct' && r.tier === 'extreme').map((r) => r.stress)))}/${f1(Math.max(...rows.filter((r) => r.pilot === 'direct' && r.tier === 'extreme').map((r) => r.stress)))}%, surfer max ${f1(Math.max(...rows.filter((r) => r.pilot === 'surfer' && r.tier === 'extreme').map((r) => r.stress)))}%, overstressed ${rows.filter((r) => r.outcome === 'overstressed').length}   (want direct 10–30, dodge < 20)`,
    `g) surfer vs direct speed board, mod+ext: median ${f1(gMedian)}%   (want ≥+10%)`,
    `   direct flight minutes p10/p50/p90 ${f1(quantile(minutes, 0.1))}/${f1(median(minutes))}/${f1(quantile(minutes, 0.9))} (want 6–12); by aircraft ${minutesBy}; failures ${failures}/${rows.length}`,
  ].join('\n')
  const line = `speed ${pc(sp.ahead)} ${f1(sp.gainPct)}% calm ${pc(spc.ahead)} | eco ${pc(ec.ahead)} ${f1(ec.gainPct)}% | smooth-ext ${pc(smx.ahead)} ${f1(smx.gainPct)}% | fuel ${f1(directFuel)}% dry ${recklessDry} >60 ${pc(over60)} | wu ${f1(surferWu)} | g ${f1(gMedian)}% | ${dominance.join(', ')} | unlock ${unlockLine} | min ${f1(median(minutes))} | fail ${failures}`
  return { text, line }
}
