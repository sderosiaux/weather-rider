// Aggregations and markdown for the balance report. Pure functions over FlightRow[].
import type { FlightScore } from '../src/core/types'
import { AIRCRAFT, airDensity, trimLevel } from '../src/flight'
import { AIRCRAFT_ORDER, AIRCRAFT_UNLOCKS, newProgress, recordFlight, type Board } from '../src/meta'
import { TIERS, type FlightRow, type PilotDef } from './matrix'

// ─── Stats ──────────────────────────────────────────────────────────────────

export const quantile = (xs: readonly number[], q: number): number => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo)
}
export const median = (xs: readonly number[]): number => quantile(xs, 0.5)
export const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : '–')
const f0 = (x: number): string => (Number.isFinite(x) ? x.toFixed(0) : '–')
const signed = (x: number, digits = 1): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(digits)}` : '–')

const key = (r: FlightRow): string => `${r.day}:${r.tier}:${r.aircraft}`
const arrived = (r: FlightRow): boolean => r.outcome === 'arrived'

export function index(rows: readonly FlightRow[]): Map<string, Map<string, FlightRow>> {
  const m = new Map<string, Map<string, FlightRow>>()
  for (const r of rows) {
    const k = key(r)
    const inner = m.get(k) ?? new Map<string, FlightRow>()
    inner.set(r.pilot, r)
    m.set(k, inner)
  }
  return m
}

// ─── Paired comparison ──────────────────────────────────────────────────────

export interface PairStats {
  readonly n: number
  readonly bothArrived: number
  readonly aOnly: number
  readonly bOnly: number
  readonly dTimePct: number
  readonly dFuelPct: number
  readonly dComfort: number
  readonly dSevereS: number
  readonly dWu: number
  readonly dSmooth: number
  readonly dSpeed: number
  readonly dEco: number
  readonly winTime: number
  readonly winFuel: number
  readonly winComfort: number
}

/** A vs B on the same (day, route, aircraft); deltas are A − B, medians over pairs where both arrived. */
export function pair(rows: readonly FlightRow[], a: string, b: string, filter: (r: FlightRow) => boolean = () => true): PairStats {
  const idx = index(rows.filter(filter))
  const d: Record<string, number[]> = { t: [], f: [], c: [], sv: [], wu: [], sm: [], sp: [], ec: [] }
  let n = 0
  let aOnly = 0
  let bOnly = 0
  let wt = 0
  let wf = 0
  let wc = 0
  for (const byPilot of idx.values()) {
    const ra = byPilot.get(a)
    const rb = byPilot.get(b)
    if (!ra || !rb) continue
    n++
    if (arrived(ra) && !arrived(rb)) aOnly++
    if (!arrived(ra) && arrived(rb)) bOnly++
    if (!arrived(ra) || !arrived(rb)) continue
    d.t!.push((100 * (ra.simTimeS - rb.simTimeS)) / rb.simTimeS)
    d.f!.push((100 * (ra.fuelUsedKg - rb.fuelUsedKg)) / rb.fuelUsedKg)
    d.c!.push(ra.comfort - rb.comfort)
    d.sv!.push(ra.severeS - rb.severeS)
    d.wu!.push(ra.weatherUtilization - rb.weatherUtilization)
    d.sm!.push(ra.smooth - rb.smooth)
    d.sp!.push(ra.speed - rb.speed)
    d.ec!.push(ra.eco - rb.eco)
    if (ra.simTimeS < rb.simTimeS) wt++
    if (ra.fuelUsedKg < rb.fuelUsedKg) wf++
    if (ra.comfort > rb.comfort) wc++
  }
  const both = d.t!.length
  return {
    n,
    bothArrived: both,
    aOnly,
    bOnly,
    dTimePct: median(d.t!),
    dFuelPct: median(d.f!),
    dComfort: median(d.c!),
    dSevereS: median(d.sv!),
    dWu: median(d.wu!),
    dSmooth: median(d.sm!),
    dSpeed: median(d.sp!),
    dEco: median(d.ec!),
    winTime: both ? wt / both : NaN,
    winFuel: both ? wf / both : NaN,
    winComfort: both ? wc / both : NaN,
  }
}

/** Best board score per (day, route, aircraft) within a pilot set; 0 if none arrived. */
export function bestOf(rows: readonly FlightRow[], pilots: readonly string[], board: Board): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (!pilots.includes(r.pilot)) continue
    out.set(key(r), Math.max(out.get(key(r)) ?? 0, r[board]))
  }
  return out
}

// ─── Progression ────────────────────────────────────────────────────────────

export interface UnlockRun {
  readonly player: string
  /** aircraft → flight number at which it unlocked (null = not within the cap). */
  readonly at: Record<string, number | null>
  readonly flights: number
}

/**
 * Plays days in order, three routes a day (looping over the lab days if needed), always flying the most recently
 * unlocked aircraft with `choose(nextLocked)`'s pilot, through meta's real recordFlight.
 */
export function simulateUnlocks(
  rows: readonly FlightRow[],
  days: readonly number[],
  player: string,
  choose: (nextLocked: string | null) => string,
  cap = 120,
): UnlockRun {
  const byKey = new Map<string, FlightRow>()
  for (const r of rows) byKey.set(`${r.day}:${r.tier}:${r.aircraft}:${r.pilot}`, r)
  let progress = newProgress(player)
  const at: Record<string, number | null> = Object.fromEntries(AIRCRAFT_ORDER.map((id) => [id, id === 'turboprop' ? 0 : null]))
  let flights = 0
  outer: for (let loop = 0; loop < 10; loop++) {
    for (const day of days) {
      for (const tier of TIERS) {
        if (flights >= cap) break outer
        const aircraft = progress.unlockedAircraft[progress.unlockedAircraft.length - 1]!
        const next = AIRCRAFT_ORDER.find((id) => !progress.unlockedAircraft.includes(id)) ?? null
        const row = byKey.get(`${day}:${tier}:${aircraft}:${choose(next)}`)
        if (!row) continue
        const score: FlightScore = {
          status: row.outcome === 'arrived' ? 'arrived' : row.outcome === 'overstressed' ? 'overstressed' : 'crashed',
          simTimeS: row.simTimeS,
          displayTimeS: row.simTimeS,
          fuelUsedKg: row.fuelUsedKg,
          fuelRemainingPct: row.fuelRemainingPct,
          comfort: row.comfort,
          severeTurbulenceS: row.severeS,
          stress: row.stress,
          weatherUtilization: row.weatherUtilization,
          smooth: row.smooth,
          speed: row.speed,
          eco: row.eco,
        }
        flights++
        const res = recordFlight(progress, { score, dailyNumber: day, routeId: row.routeId, aircraftId: aircraft, ghostCode: '' })
        progress = res.progress
        for (const id of res.newlyUnlocked) if (id in at && at[id] === null) at[id] = flights
        if (progress.unlockedAircraft.length === AIRCRAFT_ORDER.length) break outer
      }
    }
  }
  return { player, at, flights }
}

// ─── Airframe envelope (evidence for altitude findings) ────────────────────

export function envelopeTable(): string {
  const alts = [2000, 4000, 6000, 8000, 10000]
  const lines = [
    '| aircraft | ' + alts.map((h) => `${h / 1000} km: trim / climb m/s / km per kg`).join(' | ') + ' |',
    '|---|' + alts.map(() => '---').join('|') + '|',
  ]
  for (const s of AIRCRAFT) {
    const cells = alts.map((h) => {
      const lapse = Math.pow(airDensity(h) / airDensity(0), 0.9)
      const tr = trimLevel(s, h, s.cruiseSpeedMs).throttle
      const climb = ((1 - tr) * s.maxThrustN * lapse * s.cruiseSpeedMs) / (s.massKg * 9.81)
      const kmkg = tr > 1 ? NaN : s.cruiseSpeedMs / (tr * s.fuelBurnFullKgS) / 1000
      return `${tr.toFixed(2)} / ${climb.toFixed(1)} / ${Number.isFinite(kmkg) ? kmkg.toFixed(3) : 'n/a'}`
    })
    lines.push(`| ${s.id} | ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

// ─── Markdown ───────────────────────────────────────────────────────────────

export interface ReportInput {
  readonly rows: readonly FlightRow[]
  readonly days: readonly number[]
  readonly pilots: readonly PilotDef[]
  readonly wallS: number
  readonly ghostLinks: readonly { label: string; url: string }[]
  readonly findings: string
}

const BOARDS: readonly Board[] = ['smooth', 'speed', 'eco']

export function renderReport(inp: ReportInput): string {
  const { rows, pilots } = inp
  const out: string[] = []
  const aircraftIds = AIRCRAFT.map((a) => a.id)
  const pilotNames = pilots.map((p) => p.name)
  const P = (s: string): void => {
    out.push(s)
  }

  P('# Balance lab: does the weather pay?')
  P('')
  P(
    `Generated by \`pnpm lab\` (lab/balance.lab.ts). WORLD WEATHER #${inp.days[0]}–#${inp.days[inp.days.length - 1]} (${inp.days.length} days) × 3 routes × ${aircraftIds.length} aircraft × ${pilots.length} pilots = ${rows.length} full headless flights on the real flight, weather, scoring and meta modules, stepped exactly like game/session.ts. Flights are cut at 1.5 × the scoring reference time (straight distance / cruise speed). Wall time ${inp.wallS.toFixed(0)} s.`,
  )
  P('')
  P('Pilots (all share the same human-rate hands: bounded stick rates, ±0.1 g planned manoeuvres, ±0.2 g corrections; reckless ±0.6 g):')
  P('')
  P('| pilot | skill side | what it does |')
  P('|---|---|---|')
  for (const p of pilots) P(`| ${p.name} | ${p.skilled ? 'weather-aware' : 'naive'} | ${p.note} |`)
  P('')
  P('<!-- findings:start -->')
  P(inp.findings.trim())
  P('<!-- findings:end -->')
  P('')

  // ── Feasibility ──
  P('## 1. Route feasibility')
  P('')
  P('Arrival rate per tier (cell: arrived % · median fuel left at arrival %).')
  for (const tier of TIERS) {
    const tr = rows.filter((r) => r.tier === tier)
    const sev = tr.map((r) => r.severity)
    P('')
    P(`### ${tier} (severity ${Math.min(...sev).toFixed(2)}–${Math.max(...sev).toFixed(2)})`)
    P('')
    P(`| aircraft | ${pilotNames.join(' | ')} |`)
    P(`|---|${pilotNames.map(() => '---').join('|')}|`)
    for (const a of aircraftIds) {
      const cells = pilotNames.map((p) => {
        const rs = tr.filter((r) => r.aircraft === a && r.pilot === p)
        const ok = rs.filter(arrived)
        return `${pct(ok.length, rs.length)} · ${f0(median(ok.map((r) => r.fuelRemainingPct)))}`
      })
      P(`| ${a} | ${cells.join(' | ')} |`)
    }
  }
  P('')
  P('Failure causes (all tiers):')
  P('')
  const outcomes = ['arrived', 'crashed', 'overstressed', 'fuel', 'timeout', 'missed-gate'] as const
  P(`| pilot | ${outcomes.join(' | ')} |`)
  P(`|---|${outcomes.map(() => '---').join('|')}|`)
  for (const p of pilotNames) {
    const rs = rows.filter((r) => r.pilot === p)
    P(`| ${p} | ${outcomes.map((o) => rs.filter((r) => r.outcome === o).length).join(' | ')} |`)
  }
  const fails = rows.filter((r) => !arrived(r))
  if (fails.length) {
    P('')
    P('Failures by aircraft × tier (all pilots):')
    P('')
    P(`| aircraft | ${TIERS.join(' | ')} |`)
    P('|---|---|---|---|')
    for (const a of aircraftIds) {
      P(`| ${a} | ${TIERS.map((t) => {
        const fs = fails.filter((r) => r.aircraft === a && r.tier === t)
        const by = new Map<string, number>()
        for (const r of fs) by.set(r.outcome, (by.get(r.outcome) ?? 0) + 1)
        return fs.length ? [...by].map(([o, c]) => `${o} ${c}`).join(', ') : '0'
      }).join(' | ')} |`)
    }
  }
  P('')

  // ── Core promise ──
  P('## 2. Core promise: does reading the weather pay?')
  P('')
  P('Paired on the same day, route and aircraft. Δ = A − B, medians over pairs where both arrived; "wins" = share of those pairs where A is better.')
  P('')
  const comparisons: [string, string][] = [
    ['surfer', 'direct'],
    ['surfer-smooth', 'direct'],
    ['surfer-jet', 'direct'],
    ['eco', 'eco-naive'],
    ['eco', 'direct'],
    ['eco-naive', 'direct'],
    ['surfer-fast', 'reckless'],
    ['surfer', 'surfer-smooth'],
  ]
  P('| A vs B | tier | pairs (both arrived) | A only / B only arrived | Δ time % | Δ fuel % | Δ comfort pts | Δ severe s | Δ weather util. pts | Δ smooth | Δ speed | Δ eco | A faster | A less fuel | A comfier |')
  P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const [a, b] of comparisons) {
    if (!pilotNames.includes(a) || !pilotNames.includes(b)) continue
    for (const tier of [...TIERS, 'all'] as const) {
      const s = pair(rows, a, b, (r) => tier === 'all' || r.tier === tier)
      P(
        `| ${a} vs ${b} | ${tier} | ${s.n} (${s.bothArrived}) | ${s.aOnly} / ${s.bOnly} | ${signed(s.dTimePct)} | ${signed(s.dFuelPct)} | ${signed(s.dComfort)} | ${signed(s.dSevereS)} | ${signed(s.dWu)} | ${signed(s.dSmooth, 0)} | ${signed(s.dSpeed, 0)} | ${signed(s.dEco, 0)} | ${pct(s.winTime * 100, 100)} | ${pct(s.winFuel * 100, 100)} | ${pct(s.winComfort * 100, 100)} |`,
      )
    }
  }
  P('')
  P('Surfer vs direct per aircraft (all tiers):')
  P('')
  P('| aircraft | pairs | Δ time % | Δ fuel % | Δ comfort | Δ smooth | Δ speed | Δ eco | eco vs eco-naive Δ fuel % | surfer-jet vs direct Δ time % / Δ fuel % | surfer plans the jet | surfer planned cruise alt (median) |')
  P('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const a of aircraftIds) {
    const s = pair(rows, 'surfer', 'direct', (r) => r.aircraft === a)
    const e = pair(rows, 'eco', 'eco-naive', (r) => r.aircraft === a)
    const j = pair(rows, 'surfer-jet', 'direct', (r) => r.aircraft === a)
    const plans = rows.filter((r) => r.aircraft === a && r.pilot === 'surfer' && r.plannedAlt !== null)
    P(
      `| ${a} | ${s.bothArrived} | ${signed(s.dTimePct)} | ${signed(s.dFuelPct)} | ${signed(s.dComfort)} | ${signed(s.dSmooth, 0)} | ${signed(s.dSpeed, 0)} | ${signed(s.dEco, 0)} | ${signed(e.dFuelPct)} | ${signed(j.dTimePct)} / ${signed(j.dFuelPct)} | ${pct(plans.filter((r) => r.followJet).length, plans.length)} | ${f0(median(plans.map((r) => r.plannedAlt ?? NaN)))} |`,
    )
  }
  P('')
  const skilled = pilots.filter((p) => p.skilled).map((p) => p.name)
  const naive = pilots.filter((p) => !p.skilled).map((p) => p.name)
  P(`Best weather-aware pilot (${skilled.join(', ')}) vs best naive pilot (${naive.join(', ')}), per board, per (day, route, aircraft): what a player who picks the right style for the board gains from reading the sky.`)
  P('')
  P('| board | tier | median best naive | median best weather-aware | median Δ | Δ % | weather-aware ahead |')
  P('|---|---|---|---|---|---|---|')
  for (const board of BOARDS) {
    for (const tier of [...TIERS, 'all'] as const) {
      const rs = rows.filter((r) => tier === 'all' || r.tier === tier)
      const n = bestOf(rs, naive, board)
      const s = bestOf(rs, skilled, board)
      const d: number[] = []
      const dp: number[] = []
      let ahead = 0
      for (const [k, nv] of n) {
        const sv = s.get(k) ?? 0
        d.push(sv - nv)
        if (nv > 0) dp.push((100 * (sv - nv)) / nv)
        if (sv > nv) ahead++
      }
      P(`| ${board} | ${tier} | ${f0(median([...n.values()]))} | ${f0(median([...s.values()]))} | ${signed(median(d), 0)} | ${signed(median(dp))} | ${pct(ahead, d.length)} |`)
    }
  }
  P('')

  // ── Scoring calibration ──
  P('## 3. Scoring calibration')
  P('')
  P('Board scores of arrived flights, all pilots: p10 / p50 / p90. Boards are meant to read ≈ 0..1000 with 1000 = reference flight.')
  P('')
  P('| aircraft | smooth | speed | eco | comfort | weather util. | arrived |')
  P('|---|---|---|---|---|---|---|')
  const q3 = (xs: number[]): string => `${f0(quantile(xs, 0.1))} / ${f0(quantile(xs, 0.5))} / ${f0(quantile(xs, 0.9))}`
  for (const a of aircraftIds) {
    const rs = rows.filter((r) => r.aircraft === a && arrived(r))
    P(`| ${a} | ${q3(rs.map((r) => r.smooth))} | ${q3(rs.map((r) => r.speed))} | ${q3(rs.map((r) => r.eco))} | ${q3(rs.map((r) => r.comfort))} | ${q3(rs.map((r) => r.weatherUtilization))} | ${rs.length} |`)
  }
  P('')
  P('Per-board best score per (day, route), which aircraft holds it (any pilot). A board where one aircraft always wins is a pay-to-win smell once that aircraft is unlocked.')
  P('')
  P(`| board | ${aircraftIds.join(' | ')} | max score seen |`)
  P(`|---|${aircraftIds.map(() => '---').join('|')}|---|`)
  for (const board of BOARDS) {
    const byRoute = new Map<string, FlightRow>()
    for (const r of rows) {
      const k = `${r.day}:${r.tier}`
      const cur = byRoute.get(k)
      if (!cur || r[board] > cur[board]) byRoute.set(k, r)
    }
    const counts = aircraftIds.map((a) => [...byRoute.values()].filter((r) => r.aircraft === a).length)
    P(`| ${board} | ${counts.map((c) => pct(c, byRoute.size)).join(' | ')} | ${f0(Math.max(...rows.map((r) => r[board])))} |`)
  }
  P('')
  P('Median board score per aircraft for its best-suited pilot (the pilot with the highest median on that board for that aircraft):')
  P('')
  P('| aircraft | smooth (pilot) | speed (pilot) | eco (pilot) |')
  P('|---|---|---|---|')
  for (const a of aircraftIds) {
    const cells = BOARDS.map((b) => {
      let best = -Infinity
      let who = ''
      for (const p of pilotNames) {
        const m = median(rows.filter((r) => r.aircraft === a && r.pilot === p).map((r) => r[b]))
        if (m > best) {
          best = m
          who = p
        }
      }
      return `${f0(best)} (${who})`
    })
    P(`| ${a} | ${cells.join(' | ')} |`)
  }
  P('')

  // ── Unlocks ──
  P('## 4. Unlock curve vs AIRCRAFT_UNLOCKS')
  P('')
  P('Thresholds: ' + AIRCRAFT_ORDER.map((id) => `${id} ${AIRCRAFT_UNLOCKS[id].flights} flights${Object.entries(AIRCRAFT_UNLOCKS[id].best).map(([b, v]) => ` + ${b} ≥ ${v}`).join('')}`).join(' · '))
  P('')
  P('Simulated players fly the lab days in order, three routes a day, always in their newest aircraft, recorded through meta.recordFlight. Cell = flight number of the unlock (— = not within 120 flights).')
  P('')
  const players: [string, (next: string | null) => string][] = [
    ['direct', () => 'direct'],
    ['reckless', () => 'reckless'],
    ['surfer', () => 'surfer'],
    ['eco', () => 'eco'],
    [
      'board-savvy',
      (next) => {
        const need = next ? Object.keys(AIRCRAFT_UNLOCKS[next as keyof typeof AIRCRAFT_UNLOCKS].best) : []
        if (need.length === 1 && need[0] === 'eco') return 'eco'
        if (need.length === 1 && need[0] === 'speed') return 'surfer-fast'
        return 'surfer-smooth'
      },
    ],
  ]
  P(`| player | ${AIRCRAFT_ORDER.join(' | ')} |`)
  P(`|---|${AIRCRAFT_ORDER.map(() => '---').join('|')}|`)
  for (const [name, choose] of players) {
    if (!pilotNames.includes(choose(null)) && name !== 'board-savvy') continue
    const run = simulateUnlocks(rows, inp.days, name, choose)
    P(`| ${name} | ${AIRCRAFT_ORDER.map((id) => (run.at[id] === null ? '—' : String(run.at[id]))).join(' | ')} |`)
  }
  P('')

  // ── Ghosts ──
  if (inp.ghostLinks.length) {
    P('## 5. Watch the surfer')
    P('')
    P('Fastest arrived surfer flight per route tier on the first lab day. Open with the dev server running (`pnpm dev`); the ghost carries its day, so the game loads that sky and route.')
    P('')
    for (const g of inp.ghostLinks) P(`- ${g.label}: [link](${g.url})`)
    P('')
  }

  // ── Appendix ──
  P('## Appendix A. Airframe envelope at cruise TAS (from flight/aero trimLevel)')
  P('')
  P('Trim throttle, excess climb rate at full throttle, and still-air range per kg of fuel. Fuel flow ∝ throttle while thrust lapses with density, so range per kg falls with altitude.')
  P('')
  P(envelopeTable())
  P('')
  P('## Appendix B. Mean per pilot × tier')
  P('')
  P('| pilot | tier | arrived | time / ref | fuel / ref | comfort | severe s | stress | weather util. | smooth | speed | eco | max alt | circling s (flights circling) |')
  P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const p of pilotNames) {
    for (const tier of TIERS) {
      const rs = rows.filter((r) => r.pilot === p && r.tier === tier)
      const ok = rs.filter(arrived)
      P(
        `| ${p} | ${tier} | ${pct(ok.length, rs.length)} | ${median(ok.map((r) => r.simTimeS / r.refTimeS)).toFixed(2)} | ${median(ok.map((r) => r.fuelUsedKg / r.refFuelKg)).toFixed(2)} | ${f0(median(ok.map((r) => r.comfort)))} | ${f0(median(ok.map((r) => r.severeS)))} | ${f0(median(ok.map((r) => r.stress)))} | ${f0(median(ok.map((r) => r.weatherUtilization)))} | ${f0(median(ok.map((r) => r.smooth)))} | ${f0(median(ok.map((r) => r.speed)))} | ${f0(median(ok.map((r) => r.eco)))} | ${f0(median(rs.map((r) => r.maxAltitude)))} | ${f0(mean(rs.map((r) => r.orbitS)))} (${pct(rs.filter((r) => r.orbits > 0).length, rs.length)}) |`,
      )
    }
  }
  P('')
  return out.join('\n')
}
