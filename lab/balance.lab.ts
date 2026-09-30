// pnpm lab — balance matrix on the real modules; writes lab/reports/balance.{md,json}.
// The flying happens in lab/shards/*.lab.ts (parallel workers); this file waits for them and reports.
// LAB_DAYS=n shrinks the run for quick iterations (report is still written).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { shareUrl } from '../src/meta'
import { criteriaSummary } from './criteria'
import { PILOTS, type FlightRow } from './matrix'
import { renderReport } from './report'
import { readLoadout, renderLoadouts, type LoadoutResult } from './loadout'
import { labDays, readShard, SHARDS, type ShardFile } from './shard'
import { AIRCRAFT } from '../src/flight'

const OUT = 'lab/reports'
const DEV_URL = 'http://localhost:5173/'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

it('balance matrix', async () => {
  const t0 = performance.now()
  const shards: (ShardFile | null)[] = Array.from({ length: SHARDS }, () => null)
  while (shards.some((s) => s === null)) {
    for (let k = 0; k < SHARDS; k++) shards[k] ??= readShard(k)
    if (shards.some((s) => s === null)) await sleep(1000)
  }
  const loadouts: (LoadoutResult | null)[] = AIRCRAFT.map(() => null)
  while (loadouts.some((l) => l === null)) {
    AIRCRAFT.forEach((a, i) => (loadouts[i] ??= readLoadout(a.id)))
    if (loadouts.some((l) => l === null)) await sleep(1000)
  }
  const brokenLoadout = (loadouts as LoadoutResult[]).find((l) => l.error)
  if (brokenLoadout) throw new Error(`loadout ${brokenLoadout.aircraft} crashed:\n${brokenLoadout.error}`)
  const hangar = renderLoadouts(loadouts as LoadoutResult[])
  const all = shards as ShardFile[]
  const crashed = all.find((s) => s.error)
  if (crashed) throw new Error(`shard ${crashed.shard} crashed:\n${crashed.error}`)
  const days = labDays()
  const order = (r: FlightRow): number => (r.day * 3 + ['calm', 'moderate', 'extreme'].indexOf(r.tier)) * 100
  const rows = all.flatMap((s) => s.rows).sort((a, b) => order(a) - order(b))
  const wallS = (performance.now() - t0) / 1000
  const cpuS = all.reduce((a, s) => a + s.wallS, 0)
  mkdirSync(OUT, { recursive: true })
  const mdPath = `${OUT}/balance.md`
  const previous = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : ''
  const kept = /<!-- findings:start -->\n([\s\S]*?)<!-- findings:end -->/.exec(previous)?.[1] ?? '## Findings\n\n_Not written yet._\n'
  const ghostLinks = all
    .flatMap((s) => Object.entries(s.ghosts))
    .filter(([k]) => k.startsWith(`${days[0]}:`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, g]) => ({
      label: `#${g.row.day} ${k.split(':')[1]} ${g.row.routeId} · ${g.row.aircraft} · ${g.row.simTimeS.toFixed(0)} s, fuel ${g.row.fuelRemainingPct.toFixed(0)} % left, speed ${g.row.speed}`,
      url: shareUrl(DEV_URL, g.code),
    }))
  writeFileSync(mdPath, renderReport({ rows, days, pilots: PILOTS, wallS, cpuS, ghostLinks, findings: kept, hangar: hangar.md }))
  writeFileSync(`${OUT}/balance.json`, JSON.stringify({ days, wallS, pilots: PILOTS.map((p) => ({ name: p.name, strategy: p.strategy, opts: p.opts ?? {}, note: p.note })), rows }))
  const criteria = criteriaSummary(rows)
  console.log(criteria.text)
  console.log(`LINE ${criteria.line} | loadouts beating stock on all three: ${hangar.dominated.length ? hangar.dominated.join(', ') : 'none'}`)
  console.log(`wrote ${mdPath} (${rows.length} flights, ${wallS.toFixed(0)} s wall, ${cpuS.toFixed(0)} s cpu)`)
  expect(rows.length).toBe(days.length * 3 * 7 * PILOTS.length)
})
