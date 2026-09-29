// pnpm lab — balance matrix on the real modules; writes lab/reports/balance.{md,json}.
// LAB_DAYS=n shrinks the run for quick iterations (report is still written).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { ghostCodec } from '../src/scoring'
import { shareUrl } from '../src/meta'
import { PILOTS, runMatrix } from './matrix'
import { renderReport } from './report'

/** WORLD WEATHER #272 = 2026-09-29, the day this lab was first run. Fixed so reruns are comparable. */
const FIRST_DAY = 272
const DAYS = Number(process.env.LAB_DAYS ?? 14)
const OUT = 'lab/reports'
const DEV_URL = 'http://localhost:5173/'

it('balance matrix', () => {
  const days = Array.from({ length: DAYS }, (_, i) => FIRST_DAY + i)
  const result = runMatrix(days, PILOTS, (m) => console.log(m))
  mkdirSync(OUT, { recursive: true })
  const mdPath = `${OUT}/balance.md`
  const previous = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : ''
  const kept = /<!-- findings:start -->\n([\s\S]*?)<!-- findings:end -->/.exec(previous)?.[1] ?? '## Findings\n\n_Not written yet._\n'
  const ghostLinks = [...result.ghosts.entries()]
    .filter(([k]) => k.startsWith(`${days[0]}:`))
    .map(([k, g]) => ({
      label: `#${g.row.day} ${k.split(':')[1]} ${g.row.routeId} · ${g.row.aircraft} · ${g.row.simTimeS.toFixed(0)} s, fuel ${g.row.fuelRemainingPct.toFixed(0)} % left, speed ${g.row.speed}`,
      url: shareUrl(DEV_URL, ghostCodec.encode(g.ghost)),
    }))
  writeFileSync(mdPath, renderReport({ rows: result.rows, days, pilots: PILOTS, wallS: result.wallS, ghostLinks, findings: kept }))
  writeFileSync(`${OUT}/balance.json`, JSON.stringify({ days, wallS: result.wallS, pilots: PILOTS.map((p) => ({ name: p.name, strategy: p.strategy, opts: p.opts ?? {}, note: p.note })), rows: result.rows }))
  console.log(`wrote ${mdPath} (${result.rows.length} flights, ${result.wallS.toFixed(0)} s)`)
  expect(result.rows.length).toBe(days.length * 3 * 7 * PILOTS.length)
})
