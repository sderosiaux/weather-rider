// App shell: title → flight → results, hangar. Owns persistence and wiring, no game rules.
import type { AircraftSpec, AircraftState, Ghost, PlayerProgress } from '../core/types'
import { AIRCRAFT, aircraftById, flightModel } from '../flight'
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
import { createWorldView } from '../render'
import { ghostCodec } from '../scoring'
import { createHud, createInput, createScreens } from '../ui'
import { createWeather } from '../weather'
import { createFlightSession, type FlightSession } from './session'

const GHOST_COLORS = ['#f4b860', '#8ec5ff', '#c9a7ff']

/** Outside a flight the sky keeps moving around a parked aircraft (`backdrop`). */
type Mode =
  | { readonly kind: 'flying'; readonly session: FlightSession }
  | { readonly kind: 'title' | 'results'; readonly backdrop: AircraftState }

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
  hud.setVisible(false)

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

  const showTitle = (): void => {
    hud.setVisible(false)
    const route = today.routes[0]
    const spec = specFor(progress.unlockedAircraft[0] ?? AIRCRAFT[0]!.id)
    const weather = createWeather(weatherParamsFor(today, route))
    world.setWeather(weather)
    flow.setWeather(weather)
    world.setRoute(route)
    world.setAircraft(spec, liveryOf(spec.id))
    world.setGhosts([])
    mode = { kind: 'title', backdrop: flightModel.initialState(spec, route, weather) }
    screens.showTitle(today, progress, AIRCRAFT, unlockHints(progress), {
      onFly: (routeId, aircraftId, ghostCode) => fly(routeId, aircraftId, decodeGhost(ghostCode)),
      onHangar: showHangar,
    })
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
      onBack: showTitle,
    })
  }

  /** A friend's ghost carries its own day: fly that day's sky and route so the race is fair. */
  const fly = (routeId: string, aircraftId: string, friendGhost: Ghost | null): void => {
    const daily = friendGhost ? dailyWeatherFor(friendGhost.dailyNumber) : today
    const route = daily.routes.find((r) => r.id === (friendGhost?.routeId ?? routeId))
    if (!route) throw new Error(`Route ${routeId} not found in WORLD WEATHER #${daily.number}`)
    const spec = specFor(aircraftId)
    const weather = createWeather(weatherParamsFor(daily, route))
    const localBest = decodeGhost(store.bestGhost(daily.number, route.id, 'speed'))
    const ghosts = [friendGhost, localBest].filter((g): g is Ghost => g !== null)

    world.setWeather(weather)
    flow.setWeather(weather)
    world.setRoute(route)
    world.setAircraft(spec, liveryOf(spec.id))
    world.setGhosts(ghosts.map((ghost, i) => ({ ghost, spec: aircraftById(ghost.aircraftId), color: GHOST_COLORS[i % GHOST_COLORS.length]!, showTrail: true })))

    screens.hide()
    hud.setVisible(true)
    mode = { kind: 'flying', session: createFlightSession({ daily, route, spec, weather, pilot: progress.pilot, ghosts }) }
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
    mode = { kind: 'results', backdrop: session.state() }
    screens.showResults(
      { score: outcome.score, route, dailyNumber: daily.number, aircraft: spec, ghostCode: outcome.ghostCode, previousBest, newlyUnlocked: recorded.newlyUnlocked },
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
      const outcome = session.advance(dtReal, input.read())
      hud.update(session.hud())
      world.update({ state: session.state(), ghostPoses: session.ghostPoses(), dtReal })
      flow.update(world.camera, session.state().t, dtReal)
      if (outcome) finish(session, outcome)
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
   * window.__wr exposes the live session for eval-driven checks.
   */
  function debugDeepLink(): void {
    const q = new URLSearchParams(location.search)
    const routeIndex = q.get('fly')
    if (routeIndex === null) return
    const route = today.routes[Number(routeIndex)] ?? today.routes[0]
    fly(route.id, q.get('aircraft') ?? AIRCRAFT[0]!.id, null)
    if (mode.kind !== 'flying') return
    const at = q.get('at')?.split(',').map(Number)
    if (at && at.length === 3 && at.every(Number.isFinite)) mode.session.teleport({ x: at[0]!, y: at[1]!, z: at[2]! })
    if (q.get('hud') === '0') hud.setVisible(false)
    ;(window as unknown as { __wr: unknown }).__wr = { session: mode.session, world, flow }
  }
}
