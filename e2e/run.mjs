// `pnpm e2e [ids…]` (e.g. `pnpm e2e 2 7`): the real game in a real browser. Starts its own Vite (port 5209, or
// E2E_PORT) and a headless Chrome through the agent-browser CLI (session wr-e2e; AGENT_BROWSER_HEADED=1 to watch),
// runs the scenarios, prints a pass/fail table and exits 1 unless every scenario passed. Vite and the browser
// session are shut down on every exit path. Artifacts (failure screenshots, results.json): e2e/artifacts/, wiped per run.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createBrowser } from './browser.mjs'
import { SCENARIOS, Skip } from './scenarios.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('artifacts/', import.meta.url))
const PORT = Number(process.env.E2E_PORT ?? 5209)
const SESSION = 'wr-e2e'
const VIEWPORT = [1280, 800]

const wanted = process.argv.slice(2)
const unknown = wanted.filter((id) => !SCENARIOS.some((s) => s.id === id))
if (unknown.length > 0) {
  console.error(`unknown scenario ${unknown.join(', ')}; known: ${SCENARIOS.map((s) => s.id).join(' ')}`)
  process.exit(2)
}
const ids = new Set(wanted.length > 0 ? wanted : SCENARIOS.map((s) => s.id))
for (const s of SCENARIOS) if (ids.has(s.id) && s.needs) ids.add(s.needs)
const selected = SCENARIOS.filter((s) => ids.has(s.id))

let server = null
let browser = null
let stopping = null
const stop = () =>
  (stopping ??= (async () => {
    if (browser) {
      await browser.close().catch((err) => console.error(`WARN closing the browser: ${err.message}`))
      if (!(await browser.closed().catch(() => false))) console.error(`WARN agent-browser session ${SESSION} still active; run: agent-browser --session ${SESSION} close`)
    }
    if (server) await server.close().catch((err) => console.error(`WARN stopping Vite: ${err.message}`))
  })())

const bail = (why, code) => {
  console.error(`\n${why}: stopping Vite and the browser`)
  void stop().finally(() => process.exit(code))
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.once(signal, () => bail(signal, code))
process.once('uncaughtException', (err) => bail(`uncaught ${err.stack ?? err}`, 1))
process.once('unhandledRejection', (err) => bail(`unhandled rejection ${err?.stack ?? err}`, 1))

const seconds = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`)
const row = (id, name, status, time, detail) => `${id.padEnd(4)}${name.padEnd(48)}${status.padEnd(6)}${time.padStart(7)}  ${detail}`

async function main() {
  const started = Date.now()
  await rm(ARTIFACTS, { recursive: true, force: true })
  await mkdir(ARTIFACTS, { recursive: true })
  // Page errors are reported per scenario below; Vite echoing them into the table would only add noise.
  server = await createServer({ root: ROOT, clearScreen: false, logLevel: 'error', server: { port: PORT, strictPort: true, forwardConsole: false } })
  await server.listen()
  const base = `http://localhost:${PORT}`

  browser = createBrowser(SESSION)
  // A session left behind by an aborted run would bring its old page and log buffers.
  await browser.close()
  await browser.open(`${base}/e2e/blank.html`)
  await browser.viewport(...VIEWPORT)
  // First load pays Vite's cold transforms; keep that out of the first scenario's timing.
  await browser.open(`${base}/`)
  await browser
    .waitFor('the title screen (warm-up)', () => document.querySelector('.wr-screens')?.dataset.screen === 'title', undefined, { timeoutMs: 30_000 })
    .catch((err) => console.error(`WARN warm-up: ${err.message}`))

  console.log(`e2e · ${base} · agent-browser session ${SESSION} · ${VIEWPORT.join('×')}\n`)
  console.log(row('#', 'scenario', 'result', 'time', 'evidence'))
  const ctx = { base, browser, artifacts: ARTIFACTS, shared: {} }
  const results = []
  for (const s of selected) {
    const t0 = Date.now()
    await browser.viewport(...VIEWPORT)
    const mark = await browser.logMark()
    let status = 'PASS'
    let detail = ''
    const problems = []
    try {
      detail = await s.run(ctx)
    } catch (err) {
      status = err instanceof Skip ? 'SKIP' : 'FAIL'
      problems.push(err.message)
    }
    // Any uncaught page error or console.error during the scenario fails it, whatever it asserted.
    const logged = await browser.problemsSince(mark).catch((err) => [`could not read the browser logs: ${err.message}`])
    if (logged.length > 0 && status === 'PASS') status = 'FAIL'
    problems.push(...logged)
    const screenshot = status === 'FAIL' ? await browser.screenshot(join(ARTIFACTS, `${s.id}-fail.png`)).catch(() => null) : null
    const result = { id: s.id, name: s.name, status, ms: Date.now() - t0, detail, problems, screenshot }
    results.push(result)
    console.log(row(s.id, s.name, status, seconds(result.ms), detail))
    for (const p of problems) console.log(`${' '.repeat(4)}✗ ${p}`)
    if (screenshot) console.log(`${' '.repeat(4)}screenshot: ${relative(process.cwd(), screenshot)}`)
  }

  const count = (status) => results.filter((r) => r.status === status).length
  const total = Date.now() - started
  await writeFile(join(ARTIFACTS, 'results.json'), JSON.stringify({ base, ms: total, results }, null, 2))
  console.log(`\n${count('PASS')} passed · ${count('FAIL')} failed · ${count('SKIP')} skipped · ${seconds(total)} · ${relative(process.cwd(), ARTIFACTS)}`)
  return count('PASS') === results.length ? 0 : 1
}

let exitCode = 1
try {
  exitCode = await main()
} catch (err) {
  console.error(`e2e aborted: ${err.message}`)
} finally {
  await stop()
}
process.exit(exitCode)
