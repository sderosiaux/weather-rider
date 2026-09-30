// App shell: title → flight → results, hangar. Owns persistence and wiring, no game rules.
import type { AircraftSpec, AircraftState, Ghost, PlayerProgress } from '../core/types'
import { AIRCRAFT, aircraftById } from '../flight'
import { createFlowLayer } from '../flow'
import {
  UPGRADES,
  applyLoadout,
  createStore,
  dailyWeather,
  dailyWeatherFor,
  equip,
  parseShareHash,
  recordFlight,
  setLivery,
  unequipSlot,
  unlockHints,
  weatherParamsFor,
} from '../meta'
import { createAudio } from '../audio'
import { createAutopilot, STRATEGIES, type Autopilot, type Strategy } from '../bot'
import { DEFAULT_SETTINGS, type Settings, type UnlockedItem } from '../core/presentation'
import { createWorldView } from '../render'
import { ghostCodec } from '../scoring'
import { createHud, createInput, createScreens } from '../ui'
import { createWeather } from '../weather'
import { createFlightSession, type FlightSession } from './session'

const GHOST_COLORS = ['#f4b860', '#8ec5ff', '#c9a7ff']

/** Outside a flight the sky keeps moving around a parked aircraft (`backdrop`). */
type Mode =
  /** autopilot: dev fast-check (?autopilot=). timeScale: dev fast-forward (?speed=). */
  | { readonly kind: 'flying'; readonly session: FlightSession; readonly autopilot: Autopilot | null; readonly timeScale: number }
  /** The title screen's sky is a real flight flown by the surfer bot: the game demonstrates itself. */
  | { readonly kind: 'title'; readonly demo: FlightSession; readonly autopilot: Autopilot }
  | { readonly kind: 'results'; readonly backdrop: AircraftState }

export function startApp(root: HTMLElement): void {
  const canvas = document.createElement('canvas')
  canvas.className = 'world'
  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  root.append(canvas, overlay)

  const store = createStore(localStorage)
  let progress: PlayerProgress = store.loadProgress()
  const today = dailyWeather(new Date())

  const world = createWorldView(canvas)
  const flow = createFlowLayer(world.scene)
  const hud = createHud(overlay)
  const screens = createScreens(overlay)
  const input = createInput(canvas)
  const audio = createAudio()
  hud.setVisible(false)
  // Browsers only allow audio after a user gesture; resume() is idempotent.
  const unlockAudio = (): void => audio.resume()
  window.addEventListener('pointerdown', unlockAudio)
  window.addEventListener('keydown', unlockAudio)

  // Settings are shell-owned: ui edits them, the shell persists and applies them to every module.
  const SETTINGS_KEY = 'weather-rider/settings'
  const loadSettings = (): Settings => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {}
      return {
        invertPitch: typeof parsed.invertPitch === 'boolean' ? parsed.invertPitch : DEFAULT_SETTINGS.invertPitch,
        volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : DEFAULT_SETTINGS.volume,
        flowIntensity: typeof parsed.flowIntensity === 'number' ? Math.min(1, Math.max(0, parsed.flowIntensity)) : DEFAULT_SETTINGS.flowIntensity,
        coaching: typeof parsed.coaching === 'boolean' ? parsed.coaching : DEFAULT_SETTINGS.coaching,
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  }
  const applySettings = (s: Settings): void => {
    input.setInvertPitch(s.invertPitch)
    audio.setVolume(s.volume)
    flow.setIntensity(s.flowIntensity)
    hud.setCoaching(s.coaching)
  }
  let settings = loadSettings()
  applySettings(settings)

  const persist = (p: PlayerProgress): void => {
    progress = p
    store.saveProgress(p)
  }

  const liveryOf = (id: string): string => progress.livery[id] ?? '#f5f1ea'
  const specFor = (id: string): AircraftSpec => applyLoadout(aircraftById(id), progress.loadouts[id] ?? [])

  const decodeGhost = (code: string | null): Ghost | null => {
    if (!code) return null
    try {
      return ghostCodec.decode(parseShareHash(code) ?? code)
    } catch (err) {
      console.warn('Ignoring invalid ghost code', err)
      return null
    }
  }

  let mode: Mode

  const describeUnlock = (id: string): UnlockedItem => {
    const aircraft = AIRCRAFT.find((a) => a.id === id)
    if (aircraft) return { id, name: aircraft.name, kind: 'aircraft' }
    const upgrade = UPGRADES.find((u) => u.id === id)
    if (upgrade) return { id, name: upgrade.name, kind: 'upgrade' }
    throw new Error(`Unknown unlock id ${id}`)
  }

  /** Today's most dramatic sky, flown by the surfer bot in the player's first aircraft. Restarts when it lands. */
  const startDemo = (): void => {
    const route = today.routes[2]
    const spec = specFor(progress.unlockedAircraft[0] ?? AIRCRAFT[0]!.id)
    const weather = createWeather(weatherParamsFor(today, route))
    world.setWeather(weather)
    flow.setWeather(weather)
    world.setRoute(route)
    world.setAircraft(spec, liveryOf(spec.id))
    world.setGhosts([])
    const demo = createFlightSession({ daily: today, route, spec, weather, pilot: 'demo', ghosts: [] })
    mode = { kind: 'title', demo, autopilot: createAutopilot('surfer', spec, route, weather) }
  }

  const showTitle = (): void => {
    hud.setVisible(false)
    audio.setScene('menu')
    startDemo()
    screens.showTitle(today, progress, AIRCRAFT, unlockHints(progress), {
      onFly: (routeId, aircraftId, ghostCode) => fly(routeId, aircraftId, decodeGhost(ghostCode)),
      onHangar: showHangar,
      onSettings: showSettings,
    })
  }

  const showSettings = (): void => {
    screens.showSettings(settings, {
      onChange: (next) => {
        settings = next
        applySettings(next)
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
        } catch (err) {
          console.warn('Settings not saved', err)
        }
      },
      onBack: showTitle,
    })
  }

  /** The hangar trophy sits in the demo sky: freeze that flight and quiet the wind so the aircraft is the subject. */
  let hangarOpen = false
  const showcase = (aircraftId: string): void => {
    hangarOpen = true
    flow.setIntensity(settings.flowIntensity * 0.25)
    world.setShowcase({ spec: specFor(aircraftId), liveryColor: liveryOf(aircraftId) })
  }
  const closeHangar = (): void => {
    hangarOpen = false
    flow.setIntensity(settings.flowIntensity)
    world.setShowcase(null)
  }

  const showHangar = (): void => {
    screens.showHangar({ progress, aircraft: AIRCRAFT, upgrades: UPGRADES, unlockHints: unlockHints(progress) }, {
      onEquip: (aircraftId, upgradeId) => {
        persist(equip(progress, aircraftId, upgradeId))
        showHangar()
      },
      onUnequip: (aircraftId, slot) => {
        persist(unequipSlot(progress, aircraftId, slot))
        showHangar()
      },
      onLivery: (aircraftId, color) => {
        persist(setLivery(progress, aircraftId, color))
        showHangar()
      },
      onSelectAircraft: showcase,
      onBack: () => {
        closeHangar()
        showTitle()
      },
    })
  }

  /** A friend's ghost carries its own day: fly that day's sky and route so the race is fair. */
  const fly = (routeId: string, aircraftId: string, friendGhost: Ghost | null, dev?: { autopilot: Strategy | null; timeScale: number }): void => {
    const daily = friendGhost ? dailyWeatherFor(friendGhost.dailyNumber) : today
    const route = daily.routes.find((r) => r.id === (friendGhost?.routeId ?? routeId))
    if (!route) throw new Error(`Route ${routeId} not found in WORLD WEATHER #${daily.number}`)
    const spec = specFor(aircraftId)
    const weather = createWeather(weatherParamsFor(daily, route))
    const localCode = store.bestGhost(daily.number, route.id, 'speed')
    // Racing your own shared link: the friend ghost and the local best are the same flight.
    const localBest = localCode && (!friendGhost || ghostCodec.encode(friendGhost) !== localCode) ? decodeGhost(localCode) : null
    const ghosts = [friendGhost, localBest].filter((g): g is Ghost => g !== null)

    world.setWeather(weather)
    flow.setWeather(weather)
    world.setRoute(route)
    world.setAircraft(spec, liveryOf(spec.id))
    world.setGhosts(ghosts.map((ghost, i) => ({ ghost, spec: aircraftById(ghost.aircraftId), color: GHOST_COLORS[i % GHOST_COLORS.length]!, showTrail: true })))

    screens.hide()
    hud.setVisible(true)
    audio.setScene('flight')
    const session = createFlightSession({ daily, route, spec, weather, pilot: progress.pilot, ghosts })
    // Start hands-off in trim: the aircraft's trimmed throttle, not whatever the last flight left.
    input.resetForFlight(session.state().throttle)
    const autopilot = dev?.autopilot ? createAutopilot(dev.autopilot, spec, route, weather) : null
    mode = { kind: 'flying', session, autopilot, timeScale: dev?.timeScale ?? 1 }
  }

  const finish = (session: FlightSession, outcome: NonNullable<ReturnType<FlightSession['advance']>>): void => {
    const { daily, route, spec } = session.setup
    const previousBest = progress.flights > 0 ? progress.best : null
    const recorded = recordFlight(progress, {
      score: outcome.score,
      dailyNumber: daily.number,
      routeId: route.id,
      aircraftId: spec.id,
      ghostCode: outcome.ghostCode,
    })
    persist(recorded.progress)
    store.submit(recorded.entries)
    hud.setVisible(false)
    audio.setScene('menu')
    if (outcome.score.status !== 'flying') audio.cue(outcome.score.status)
    const beat = previousBest && (['smooth', 'speed', 'eco'] as const).some((b) => outcome.score[b] > previousBest[b])
    if (recorded.newlyUnlocked.length > 0) audio.cue('unlock')
    else if (beat) audio.cue('record')
    mode = { kind: 'results', backdrop: session.state() }
    screens.showResults(
      { score: outcome.score, route, dailyNumber: daily.number, aircraft: spec, ghostCode: outcome.ghostCode, previousBest, newlyUnlocked: recorded.newlyUnlocked.map(describeUnlock) },
      { onRetry: () => fly(route.id, spec.id, session.setup.ghosts[0] ?? null), onMenu: showTitle },
    )
  }

  const resize = (): void => world.resize(root.clientWidth, root.clientHeight)
  window.addEventListener('resize', resize)
  resize()

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mode.kind === 'flying') showTitle()
  })

  let last = performance.now()
  let titleT = 0
  const loop = (now: number): void => {
    const dtReal = Math.min((now - last) / 1000, 0.1)
    last = now
    if (mode.kind === 'flying') {
      const session = mode.session
      const controls = input.read()
      const outcome = session.advance(dtReal * mode.timeScale, mode.autopilot ?? controls)
      hud.update(session.hud())
      const air = session.air()
      const s = session.state()
      audio.update(
        {
          airspeedMs: s.airspeed,
          throttle: s.throttle,
          turbulence: air.turbulence,
          dominant: air.dominant,
          verticalWindMs: air.wind.y,
          cloud: air.cloud,
          stalled: s.stalled,
          aircraftClass: session.setup.spec.class,
        },
        dtReal,
      )
      world.update({ state: session.state(), ghostPoses: session.ghostPoses(), dtReal })
      flow.update(world.camera, session.state().t, dtReal)
      if (outcome) finish(session, outcome)
    } else if (mode.kind === 'title') {
      input.read()
      if (!hangarOpen && mode.demo.advance(dtReal, mode.autopilot)) startDemo()
      const s = mode.demo.state()
      world.update({ state: s, ghostPoses: [], dtReal })
      flow.update(world.camera, s.t, dtReal)
    } else {
      titleT += dtReal
      input.read()
      world.update({ state: mode.backdrop, ghostPoses: [], dtReal })
      flow.update(world.camera, mode.backdrop.t + titleT, dtReal)
    }
    world.render()
    requestAnimationFrame(loop)
  }

  const shared = decodeGhost(location.hash || null)
  if (shared) history.replaceState(null, '', location.search)
  showTitle()
  if (shared) fly(shared.routeId, progress.unlockedAircraft.includes(shared.aircraftId) ? shared.aircraftId : progress.unlockedAircraft[0]!, shared)
  else if (import.meta.env.DEV) debugDeepLink()
  requestAnimationFrame(loop)

  /**
   * Dev-only deep link so agents/screenshots reach real in-game states without menus:
   * ?fly=0|1|2 (route index) &aircraft=<id> &at=x,y,z (teleport, meters) &hud=0
   * &autopilot=direct|surfer|eco|reckless (bot flies) &speed=N (sim fast-forward, capped by the session's per-frame clamp)
   * window.__wr exposes the live session for eval-driven checks.
   */
  function debugDeepLink(): void {
    const q = new URLSearchParams(location.search)
    const routeIndex = q.get('fly')
    if (routeIndex === null) return
    const route = today.routes[Number(routeIndex)] ?? today.routes[0]
    const autopilot = STRATEGIES.find((s) => s === q.get('autopilot')) ?? null
    fly(route.id, q.get('aircraft') ?? AIRCRAFT[0]!.id, null, { autopilot, timeScale: Math.max(1, Number(q.get('speed') ?? 1)) })
    if (mode.kind !== 'flying') return
    const at = q.get('at')?.split(',').map(Number)
    if (at && at.length === 3 && at.every(Number.isFinite)) mode.session.teleport({ x: at[0]!, y: at[1]!, z: at[2]! })
    if (q.get('hud') === '0') hud.setVisible(false)
    ;(window as unknown as { __wr: unknown }).__wr = { session: mode.session, world, flow }
  }
}
