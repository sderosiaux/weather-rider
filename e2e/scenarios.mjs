// The player's main paths, driven in the real game. Each scenario sets its own localStorage, asserts what the
// player sees or what the sim does, and returns a one-line summary of the evidence. A thrown Error is a failure.
// Page code relies on the dev-only `window.__wr` handle (see debugDeepLink() in src/game/app.ts) and on modules'
// public index.ts, imported in the page so it shares the game's own module instances.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { changedFraction, decodePng } from './png.mjs'

const META_KEY = 'weather-rider/meta'
const SETTINGS_KEY = 'weather-rider/settings'
const TRIM_SECONDS = 15
/** A 12× surfer flight takes about a minute; this only bounds a stuck one. */
const FLIGHT_TIMEOUT_MS = 240_000
/** Share of canvas pixels that must change between two title screenshots for the demo sky to count as live. */
const MIN_SKY_CHANGE = 0.01

export class Skip extends Error {}

const check = (ok, message) => {
  if (!ok) throw new Error(message)
}
const num = (v, digits = 2) => Number(v).toFixed(digits)
const pct = (f) => `${(f * 100).toFixed(1)}%`

/** Replaces the origin's localStorage (empty = first-time player) from a page that doesn't boot the game. */
const setStorage = async ({ browser, base }, items = {}) => {
  await browser.open(`${base}/e2e/blank.html`)
  await browser.evaluate((items) => {
    localStorage.clear()
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value)
  }, items)
}

const readStorage = (browser) => browser.evaluate(() => Object.fromEntries(Object.entries(localStorage)))

const waitScreen = (browser, screen) =>
  browser.waitFor(
    `the ${screen} screen`,
    (screen) => {
      const layer = document.querySelector('.wr-screens')
      return !!layer && !layer.classList.contains('is-hidden') && layer.dataset.screen === screen
    },
    screen,
  )

const openTitle = async (ctx) => {
  await ctx.browser.open(`${ctx.base}/`)
  await waitScreen(ctx.browser, 'title')
}

/** A flight is up once the dev handle exists, the HUD shows and the sim has stepped. */
const waitFlight = (browser, what) =>
  browser.waitFor(what, () => {
    const s = window.__wr?.session
    const hud = document.querySelector('.wr-hud')
    if (!s || !hud || hud.classList.contains('is-hidden') || s.state().t <= 0) return null
    return { route: s.setup.route.id, daily: s.setup.daily.number, aircraft: s.setup.spec.id }
  })

/** The race as the player gets it: the flight's ghosts (each compared with the shared one) and the HUD delta. */
const raceState = (browser, code) =>
  browser.waitFor(
    'a race with the HUD ghost delta on',
    async (code) => {
      const s = window.__wr?.session
      const hud = document.querySelector('.wr-hud')
      if (!s || !hud || hud.classList.contains('is-hidden')) return null
      const { ghostCodec } = await import('/src/scoring/index.ts')
      const shared = JSON.stringify(ghostCodec.decode(code))
      const el = document.querySelector('.wr-hud__ghost')
      const box = el?.getBoundingClientRect()
      return {
        route: s.setup.route.id,
        daily: s.setup.daily.number,
        ghosts: s.setup.ghosts.map((g) => ({ pilot: g.pilot, aircraft: g.aircraftId, samples: g.samples.length, shared: JSON.stringify(g) === shared })),
        delta: el && {
          on: !el.classList.contains('is-off'),
          visible: el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && box.width > 0 && box.height > 0,
          text: el.querySelector('.wr-hud__ghost-val')?.textContent ?? '',
        },
      }
    },
    code,
    { ready: (v) => !!v?.delta?.on },
  )

/** Screenshots the canvas alone (DOM overlay hidden) until the picture changes enough, or 5 s pass. */
const skyChange = async ({ browser, artifacts }) => {
  const shot = async (name) => decodePng(await readFile(await browser.screenshot(join(artifacts, name))))
  const overlay = (hidden) =>
    browser.evaluate((hidden) => {
      const el = document.querySelector('.overlay')
      if (el) el.style.visibility = hidden ? 'hidden' : ''
      return !!el
    }, hidden)
  check(await overlay(true), 'no .overlay element to hide over the canvas')
  try {
    const first = await shot('1-sky-a.png')
    const start = Date.now()
    for (;;) {
      const changed = changedFraction(first, await shot('1-sky-b.png'))
      const ms = Date.now() - start
      if (changed >= MIN_SKY_CHANGE || ms > 5000) return { changed, ms }
    }
  } finally {
    await overlay(false)
  }
}

export const SCENARIOS = [
  {
    id: '1',
    name: 'boot: title, routes, aircraft, live sky',
    async run(ctx) {
      const { browser } = ctx
      await setStorage(ctx)
      await openTitle(ctx)
      const title = await browser.evaluate(() => {
        const text = (el) => el?.textContent?.trim() ?? null
        const planes = [...document.querySelectorAll('.wr-planes .wr-plane')]
        const fly = document.querySelector('[data-screen="title"] .wr-btn--primary')
        return {
          daily: text(document.querySelector('.wr-title__daily')),
          routes: [...document.querySelectorAll('.wr-routes .wr-route')].map((r) => text(r.querySelector('.wr-route__label'))),
          planes: planes.length,
          unlocked: planes.filter((p) => !p.classList.contains('is-locked')).length,
          selected: planes
            .filter((p) => p.getAttribute('aria-pressed') === 'true')
            .map((p) => ({ name: text(p.querySelector('.wr-plane__name')), locked: p.classList.contains('is-locked') })),
          fly: fly && { label: text(fly), disabled: fly.disabled },
        }
      })
      check(/^WORLD WEATHER #\d+$/.test(title.daily ?? ''), `daily label ${JSON.stringify(title.daily)}, expected "WORLD WEATHER #<n>"`)
      check(title.routes.length === 3 && title.routes.every(Boolean), `route cards ${JSON.stringify(title.routes)}, expected 3 labelled cards`)
      check(title.planes >= 2 && title.unlocked >= 1, `aircraft picker: ${title.planes} aircraft, ${title.unlocked} unlocked`)
      check(title.selected.length === 1 && !title.selected[0].locked, `picked aircraft ${JSON.stringify(title.selected)}, expected exactly one, unlocked`)
      check(title.fly && !title.fly.disabled, `fly button ${JSON.stringify(title.fly)}`)
      const sky = await skyChange(ctx)
      check(
        sky.changed >= MIN_SKY_CHANGE,
        `demo sky looks frozen: ${pct(sky.changed)} of canvas pixels changed in ${sky.ms} ms (need ${pct(MIN_SKY_CHANGE)}), see 1-sky-a.png / 1-sky-b.png`,
      )
      return `${title.daily} · ${title.routes.join(' | ')} · ${title.planes} aircraft, ${title.selected[0].name} picked · sky ${pct(sky.changed)} changed in ${sky.ms} ms`
    },
  },
  {
    id: '2',
    name: 'hands-off: trimmed throttle, level flight',
    async run(ctx) {
      const { browser } = ctx
      await setStorage(ctx)
      await browser.open(`${ctx.base}/?fly=0&aircraft=turboprop`)
      const flight = await waitFlight(browser, 'the route-0 flight')
      check(flight.aircraft === 'turboprop', `flying ${flight.aircraft}, expected turboprop`)
      // Reference: the flight model's own trim for this setup. A start throttle that misses it (the regression
      // this guards) would already be baked into any sampled value.
      const trim = await browser.evaluate(async () => {
        const { flightModel } = await import('/src/flight/index.ts')
        const { spec, route, weather } = window.__wr.session.setup
        return flightModel.initialState(spec, route, weather).throttle
      })
      // Sampled every frame in the page, not over the CLI: nothing between two polls escapes.
      await browser.evaluate((seconds) => {
        const session = window.__wr.session
        const rec = { done: false, frames: 0, t0: session.state().t, t1: 0, status: 'flying', thrMin: Infinity, thrMax: -Infinity, vyMax: 0, vyAt: 0, gMin: Infinity, gMinAt: 0, gMax: -Infinity, gMaxAt: 0 }
        window.__e2eTrim = rec
        const sample = () => {
          const s = session.state()
          const vy = Math.abs(s.vel.y)
          rec.frames++
          rec.t1 = s.t
          rec.status = s.status
          rec.thrMin = Math.min(rec.thrMin, s.throttle)
          rec.thrMax = Math.max(rec.thrMax, s.throttle)
          if (vy > rec.vyMax) Object.assign(rec, { vyMax: vy, vyAt: s.t })
          if (s.gLoad < rec.gMin) Object.assign(rec, { gMin: s.gLoad, gMinAt: s.t })
          if (s.gLoad > rec.gMax) Object.assign(rec, { gMax: s.gLoad, gMaxAt: s.t })
          if (s.t - rec.t0 >= seconds || s.status !== 'flying') rec.done = true
          else requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }, TRIM_SECONDS)
      const rec = await browser.waitFor(`${TRIM_SECONDS} s of hands-off flight`, () => window.__e2eTrim, undefined, {
        timeoutMs: (TRIM_SECONDS + 30) * 1000,
        intervalMs: 500,
        ready: (r) => r?.done,
      })
      const span = rec.t1 - rec.t0
      const thrDev = Math.max(Math.abs(rec.thrMin - trim), Math.abs(rec.thrMax - trim))
      check(rec.status === 'flying', `flight ended '${rec.status}' at t=${num(rec.t1, 1)} s`)
      check(rec.frames >= span * 10, `only ${rec.frames} frames sampled over ${num(span, 1)} s of sim: the page isn't rendering`)
      check(thrDev <= 1e-6, `throttle left the trim ${num(trim, 4)}: ${num(rec.thrMin, 4)}–${num(rec.thrMax, 4)}`)
      check(rec.vyMax < 1.5, `|vel.y| reached ${num(rec.vyMax)} m/s at t=${num(rec.vyAt, 1)} s (limit 1.5)`)
      check(
        rec.gMin >= 0.9 && rec.gMax <= 1.1,
        `gLoad ${num(rec.gMin)} (t=${num(rec.gMinAt, 1)} s) to ${num(rec.gMax)} (t=${num(rec.gMaxAt, 1)} s), limits 0.9–1.1`,
      )
      return `throttle = trim ${num(trim, 4)} throughout · |vy| ≤ ${num(rec.vyMax)} m/s · g ${num(rec.gMin)}–${num(rec.gMax)} · ${num(span, 1)} s sim, ${rec.frames} frames`
    },
  },
  {
    id: '3',
    name: 'full flight (surfer 12×) → results, share',
    async run(ctx) {
      const { browser } = ctx
      await setStorage(ctx)
      await browser.open(`${ctx.base}/?fly=1&aircraft=turboprop&autopilot=surfer&speed=12`)
      const flight = await waitFlight(browser, 'the route-1 surfer flight')
      const end = await browser.waitFor(
        'the flight to end',
        () => {
          const s = window.__wr.session.state()
          return { status: s.status, t: Math.round(s.t), pos: [s.pos.x, s.pos.y, s.pos.z].map(Math.round) }
        },
        undefined,
        { timeoutMs: FLIGHT_TIMEOUT_MS, intervalMs: 1000, ready: (s) => s.status !== 'flying' },
      )
      check(end.status === 'arrived', `flight ended '${end.status}' at t=${end.t} s, pos ${end.pos.join(', ')} m`)
      const results = await browser.waitFor('the results screen', () => {
        const sheet = document.querySelector('.wr-results')
        return (
          sheet && {
            arrived: sheet.classList.contains('wr-results--arrived'),
            headline: sheet.querySelector('.wr-results__headline')?.textContent ?? '',
            boards: [...sheet.querySelectorAll('.wr-boards .wr-board')].map((b) => ({
              name: b.querySelector('.wr-board__name')?.textContent ?? '',
              score: b.querySelector('.wr-board__score')?.textContent ?? '',
            })),
            share: [...sheet.querySelectorAll('button')].some((b) => b.textContent === 'Share: Beat my run'),
          }
        )
      })
      check(results.arrived, `results screen says "${results.headline}", expected an arrival`)
      check(results.boards.length === 3 && results.boards.every((b) => b.name && /^\d+$/.test(b.score)), `boards ${JSON.stringify(results.boards)}, expected 3 scored boards`)
      check(results.share, 'no "Share: Beat my run" button on the results screen')

      await browser.clickButton('Share: Beat my run')
      const share = await browser.waitFor('share feedback', () => {
        const status = document.querySelector('.wr-share__status')
        const link = document.querySelector('.wr-share__fallback')
        return status?.textContent ? { state: status.dataset.state, text: status.textContent, url: link?.value ?? '', fallback: !!link?.classList.contains('is-on') } : null
      })
      check(share.state === 'ok' || (share.state === 'warn' && share.fallback), `share said "${share.text}" (${share.state}) and offered no link`)
      const raw = share.url.match(/#g=([^&]+)/)?.[1]
      check(raw, `share link ${share.url.slice(0, 60)}… carries no #g= ghost code`)
      const code = decodeURIComponent(raw)

      // The local boards got this flight, with the same ghost the link carries.
      const saved = await browser.evaluate(
        ({ key, daily, route }) => {
          const meta = JSON.parse(localStorage.getItem(key) ?? 'null')
          return (
            meta && {
              flights: meta.pilots?.[meta.lastPilot]?.flights ?? null,
              entries: meta.entries.filter((e) => e.dailyNumber === daily && e.routeId === route).map((e) => ({ board: e.board, ghost: e.ghost })),
            }
          )
        },
        { key: META_KEY, daily: flight.daily, route: flight.route },
      )
      check(saved?.flights === 1, `${META_KEY} records ${saved?.flights ?? 'no'} flights, expected 1`)
      check(
        ['smooth', 'speed', 'eco'].every((b) => saved.entries.some((e) => e.board === b && e.ghost === code)),
        `stored board entries (${saved.entries.map((e) => e.board).join(', ')}) don't all carry the shared ghost`,
      )

      ctx.shared.flight = { code, url: share.url, route: flight.route, daily: flight.daily, storage: await readStorage(browser) }
      return `arrived after ${end.t} s sim · ${results.boards.map((b) => `${b.name} ${b.score}`).join(', ')} · share ${share.state}, ghost ${code.length} chars`
    },
  },
  {
    id: '4',
    name: 'share link → race its ghost (fresh profile)',
    needs: '3',
    async run(ctx) {
      const { browser } = ctx
      const shared = ctx.shared.flight
      if (!shared) throw new Skip('no shared flight from scenario 3')
      await setStorage(ctx)
      await browser.open(shared.url)
      const race = await raceState(browser, shared.code)
      check(race.route === shared.route && race.daily === shared.daily, `race on ${race.route} #${race.daily}, the shared flight was ${shared.route} #${shared.daily}`)
      check(race.ghosts.length >= 1 && race.ghosts[0].shared, `ghosts ${JSON.stringify(race.ghosts)}: the shared flight isn't the race reference`)
      check(race.delta.visible && /^[+−]?\d+\.\d s$/.test(race.delta.text), `HUD ghost delta ${JSON.stringify(race.delta)}`)
      return `${race.route} #${race.daily} · ${race.ghosts.length} ghost (${race.ghosts[0].samples} samples) · HUD delta "${race.delta.text}"`
    },
  },
  {
    id: '4b',
    name: 'own share link → ghost loaded once',
    needs: '3',
    async run(ctx) {
      const { browser } = ctx
      const shared = ctx.shared.flight
      if (!shared) throw new Skip('no shared flight from scenario 3')
      // The sharer's own browser: the shared flight is also the local best on that route.
      await setStorage(ctx, shared.storage)
      await browser.open(shared.url)
      const race = await raceState(browser, shared.code)
      const copies = race.ghosts.filter((g) => g.shared).length
      if (copies > 1) {
        const codec = await browser.evaluate(async (code) => {
          const { ghostCodec } = await import('/src/scoring/index.ts')
          const again = ghostCodec.encode(ghostCodec.decode(code))
          return { same: again === code, from: code.length, to: again.length }
        }, shared.code)
        throw new Error(
          `the shared flight flies ${copies}× (${race.ghosts.length} ghosts, identical tracks): racing your own link isn't deduplicated. ` +
            `ghostCodec.encode(decode(code)) ${codec.same ? 'equals the code' : `differs from the code (${codec.from} → ${codec.to} chars)`}`,
        )
      }
      check(race.ghosts[0]?.shared, `ghosts ${JSON.stringify(race.ghosts)}: the shared flight isn't the race reference`)
      return `${race.ghosts.length} ghost(s), the shared flight once`
    },
  },
  {
    id: '5',
    name: 'hangar: livery choice persists',
    async run(ctx) {
      const { browser } = ctx
      await setStorage(ctx)
      await openTitle(ctx)
      await browser.clickButton('Open hangar')
      await waitScreen(browser, 'hangar')
      const hangar = await browser.waitFor('the aircraft and its livery swatches', () => {
        const pick = document.querySelector('.wr-pick[aria-pressed="true"]')
        const swatches = [...document.querySelectorAll('.wr-swatch')].map((s) => ({
          label: s.getAttribute('aria-label'),
          pressed: s.getAttribute('aria-pressed') === 'true',
          disabled: s.disabled,
        }))
        return pick && swatches.length > 1 ? { aircraft: pick.dataset.key?.replace(/^a:/, ''), swatches } : null
      })
      const current = hangar.swatches.findIndex((s) => s.pressed)
      const target = hangar.swatches.find((s, i) => i > current && !s.disabled) ?? hangar.swatches.find((s) => !s.pressed && !s.disabled)
      check(target, `no other livery to pick among ${JSON.stringify(hangar.swatches)}`)
      await browser.clickButton(target.label)
      const saved = await browser.waitFor(
        `${target.label} saved for ${hangar.aircraft}`,
        ({ key, aircraft, label }) => {
          const meta = JSON.parse(localStorage.getItem(key) ?? 'null')
          const color = meta?.pilots?.[meta.lastPilot]?.livery?.[aircraft] ?? null
          const swatch = [...document.querySelectorAll('.wr-swatch')].find((s) => s.getAttribute('aria-label') === label)
          if (!color || !swatch) return { color, pressed: false, matches: false }
          // Compared as rendered colors: the stored string is whatever CSS color the palette uses.
          const probe = document.createElement('i')
          probe.style.color = color
          document.body.append(probe)
          const rgb = getComputedStyle(probe).color
          probe.remove()
          return { color, pressed: swatch.getAttribute('aria-pressed') === 'true', matches: rgb === getComputedStyle(swatch).backgroundColor }
        },
        { key: META_KEY, aircraft: hangar.aircraft, label: target.label },
        { ready: (v) => v.pressed && v.matches },
      )
      await browser.clickButton('Back to menu')
      await waitScreen(browser, 'title')
      return `${hangar.aircraft}: "${target.label}" → ${META_KEY} livery ${saved.color} · back on the title`
    },
  },
  {
    id: '6',
    name: 'settings: wind 0, invert pitch, survive reload',
    async run(ctx) {
      const { browser } = ctx
      await setStorage(ctx)
      await openTitle(ctx)
      await browser.clickButton('Settings')
      await waitScreen(browser, 'settings')
      const readUi = () =>
        browser.evaluate(() => {
          const value = (id) => document.getElementById(id)?.value ?? null
          const checked = (id) => document.getElementById(id)?.checked ?? null
          return { flow: value('wr-set-flowIntensity'), volume: value('wr-set-volume'), invert: checked('wr-set-invertPitch'), coaching: checked('wr-set-coaching') }
        })
      const before = await readUi()
      check(before.flow !== '0' && before.invert === false, `unexpected starting settings ${JSON.stringify(before)}: nothing left to change`)
      // Keyboard and label clicks, like a player: Home drives the slider to 0 through its own input events.
      await browser.focus('#wr-set-flowIntensity')
      await browser.press('Home')
      await browser.checkLabel('Invert pitch')
      const saved = await browser.waitFor(`${SETTINGS_KEY} updated`, (key) => JSON.parse(localStorage.getItem(key) ?? 'null'), SETTINGS_KEY, {
        ready: (s) => s?.flowIntensity === 0 && s?.invertPitch === true,
      })
      check(
        Math.round(saved.volume * 100) === Number(before.volume) && saved.coaching === before.coaching,
        `untouched settings changed: saved ${JSON.stringify(saved)}, screen showed ${JSON.stringify(before)}`,
      )
      await browser.reload()
      await waitScreen(browser, 'title')
      const kept = await browser.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), SETTINGS_KEY)
      check(JSON.stringify(kept) === JSON.stringify(saved), `after reload ${SETTINGS_KEY} is ${JSON.stringify(kept)}, was ${JSON.stringify(saved)}`)
      await browser.clickButton('Settings')
      await waitScreen(browser, 'settings')
      const after = await readUi()
      check(after.flow === '0' && after.invert === true, `settings screen after reload shows ${JSON.stringify(after)}`)
      await browser.clickButton('Done')
      await waitScreen(browser, 'title')
      return `saved ${JSON.stringify(saved)} · kept after reload, screen shows wind ${after.flow}%, invert ${after.invert ? 'on' : 'off'}`
    },
  },
  {
    id: '7',
    name: 'Escape twice in flight → title',
    async run(ctx) {
      const { browser } = ctx
      await setStorage(ctx)
      await openTitle(ctx)
      await browser.click('[data-screen="title"] .wr-btn--primary')
      await waitFlight(browser, 'the flight started from the title')
      // Take the controls like a player: clicking the sky locks the pointer, the mouse becomes the stick.
      const [width, height] = await browser.evaluate(() => [innerWidth, innerHeight])
      await browser.clickAt(Math.round(width / 2), Math.round(height / 2))
      await browser.waitFor('pointer lock on the canvas', () => document.pointerLockElement?.tagName === 'CANVAS')
      const flightView = () => {
        const hud = document.querySelector('.wr-hud')
        const layer = document.querySelector('.wr-screens')
        return {
          locked: !!document.pointerLockElement,
          hud: !!hud && !hud.classList.contains('is-hidden'),
          menu: !!layer && !layer.classList.contains('is-hidden'),
          t: window.__wr.session.state().t,
        }
      }
      await browser.press('Escape')
      const first = await browser.waitFor('the first Escape to release the pointer', flightView, undefined, { ready: (v) => !v.locked })
      check(first.hud && !first.menu, `the first Escape left the flight (${JSON.stringify(first)}); it should only release the pointer`)
      await browser.waitFor('the flight to keep running', (t) => window.__wr.session.state().t > t, first.t)
      await browser.press('Escape')
      await waitScreen(browser, 'title')
      // The abandoned flight must stop, stay unrecorded, and take the HUD with it.
      const after = await browser.evaluate(async (key) => {
        const s = window.__wr.session
        const t0 = s.state().t
        await new Promise((resolve) => {
          let frames = 0
          const tick = () => (++frames >= 30 ? resolve() : requestAnimationFrame(tick))
          requestAnimationFrame(tick)
        })
        const meta = JSON.parse(localStorage.getItem(key) ?? 'null')
        return {
          t0,
          t1: s.state().t,
          hud: !document.querySelector('.wr-hud')?.classList.contains('is-hidden'),
          results: !!document.querySelector('.wr-results'),
          flights: meta?.pilots?.[meta.lastPilot]?.flights ?? 0,
        }
      }, META_KEY)
      check(after.t1 === after.t0, `the abandoned flight kept flying: t ${num(after.t0)} → ${num(after.t1)} s over 30 frames`)
      check(!after.hud && !after.results, `title shown with HUD ${after.hud ? 'visible' : 'hidden'}, results ${after.results ? 'present' : 'absent'}`)
      check(after.flights === 0, `the abandoned flight was recorded (flights = ${after.flights})`)
      return `Esc 1 released the pointer, still flying · Esc 2 → title at t=${num(after.t0, 1)} s, flight frozen, nothing recorded`
    },
  },
]
