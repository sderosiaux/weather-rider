// UI sandbox: HUD over bright / storm skies, every screen with realistic sample data.
// Deterministic shots: ?screen=hud|title|title-first|results|results-crash|hangar|settings|boards|boards-empty  &bg=bright|storm  &hud=cruise|jet|stall|rough
import { createHud, createInput, createScreens } from '../src/ui'
import type { AircraftSpec, DailyWeather, HudModel, LeaderboardEntry, PlayerProgress, Route, Upgrade, WeatherFeatureKind } from '../src/core/types'
import { DEFAULT_SETTINGS, type BoardKind, type BoardsModel, type ResultsModel, type Settings } from '../src/core/presentation'
import { v3 } from '../src/core/math'

const params = new URLSearchParams(location.search)
const stage = document.getElementById('stage')!
const dev = document.getElementById('dev')!
const hud = createHud(document.getElementById('hud')!)
const screens = createScreens(document.getElementById('screens')!)
const input = createInput(stage)

// ── Sample content ─────────────────────────────────────────────────────────

const route = (id: string, from: string, to: string, km: number, severity: number): Route => ({
  id,
  from,
  to,
  start: v3(0, 3000, 0),
  startHeading: v3(1, 0, 0),
  gate: v3(120_000, 3500, 0),
  gateRadius: 3000,
  gateMinAlt: 1500,
  gateMaxAlt: 6000,
  realDistanceKm: km,
  timeScale: 30,
  severity,
  label: `${from} → ${to}`,
})

const daily: DailyWeather = {
  number: 272,
  seed: 272_2026,
  routes: [route('jfk-lis', 'JFK', 'LIS', 5420, 0.55), route('sfo-hnl', 'SFO', 'HNL', 3860, 0.18), route('dxb-sin', 'DXB', 'SIN', 5840, 0.86)],
  sky: { sunElevationDeg: 22, sunAzimuthDeg: 125, haze: 0.35, warmth: 0.3 },
  boundsMin: v3(-10_000, 0, -40_000),
  boundsMax: v3(170_000, 14_000, 40_000),
}

const spec = (
  id: string,
  name: string,
  cls: AircraftSpec['class'],
  s: Omit<AircraftSpec, 'id' | 'name' | 'class'>,
): AircraftSpec => ({ id, name, class: cls, ...s })

const aircraft: AircraftSpec[] = [
  spec('turboprop', 'Dash Q400', 'turboprop', { massKg: 26_000, wingAreaM2: 64, maxThrustN: 60_000, fuelCapacityKg: 5_300, fuelBurnFullKgS: 0.3, stallSpeedMs: 52, cruiseSpeedMs: 150, maxSpeedMs: 185, serviceCeilingM: 8_200, rollRate: 1.3, pitchRate: 0.5, yawRate: 0.25, controlLag: 0.25, gustSensitivity: 1.4, cabinDamping: 1.1, limitGPos: 2.5, limitGNeg: -1, lengthM: 33 }),
  spec('regional', 'E-Jet 175', 'regional', { massKg: 38_000, wingAreaM2: 72, maxThrustN: 120_000, fuelCapacityKg: 9_400, fuelBurnFullKgS: 0.55, stallSpeedMs: 60, cruiseSpeedMs: 225, maxSpeedMs: 250, serviceCeilingM: 12_500, rollRate: 1.1, pitchRate: 0.42, yawRate: 0.22, controlLag: 0.35, gustSensitivity: 1.2, cabinDamping: 1.0, limitGPos: 2.5, limitGNeg: -1, lengthM: 32 }),
  spec('narrowbody', 'A320neo', 'narrowbody', { massKg: 70_000, wingAreaM2: 122, maxThrustN: 240_000, fuelCapacityKg: 19_000, fuelBurnFullKgS: 0.9, stallSpeedMs: 65, cruiseSpeedMs: 230, maxSpeedMs: 260, serviceCeilingM: 12_000, rollRate: 0.9, pitchRate: 0.35, yawRate: 0.18, controlLag: 0.45, gustSensitivity: 1, cabinDamping: 0.9, limitGPos: 2.5, limitGNeg: -1, lengthM: 38 }),
  spec('widebody', '787-9', 'widebody', { massKg: 220_000, wingAreaM2: 360, maxThrustN: 640_000, fuelCapacityKg: 101_000, fuelBurnFullKgS: 2.2, stallSpeedMs: 70, cruiseSpeedMs: 250, maxSpeedMs: 275, serviceCeilingM: 13_100, rollRate: 0.6, pitchRate: 0.25, yawRate: 0.12, controlLag: 0.7, gustSensitivity: 0.7, cabinDamping: 0.65, limitGPos: 2.5, limitGNeg: -1, lengthM: 63 }),
  spec('cargo', 'An-124 Freighter', 'cargo', { massKg: 330_000, wingAreaM2: 628, maxThrustN: 920_000, fuelCapacityKg: 210_000, fuelBurnFullKgS: 3.4, stallSpeedMs: 72, cruiseSpeedMs: 225, maxSpeedMs: 240, serviceCeilingM: 12_000, rollRate: 0.45, pitchRate: 0.2, yawRate: 0.1, controlLag: 0.9, gustSensitivity: 0.6, cabinDamping: 0.8, limitGPos: 2.3, limitGNeg: -0.8, lengthM: 69 }),
  spec('supersonic', 'Overture', 'supersonic', { massKg: 170_000, wingAreaM2: 358, maxThrustN: 600_000, fuelCapacityKg: 95_000, fuelBurnFullKgS: 4.5, stallSpeedMs: 85, cruiseSpeedMs: 520, maxSpeedMs: 600, serviceCeilingM: 18_000, rollRate: 0.8, pitchRate: 0.3, yawRate: 0.14, controlLag: 0.5, gustSensitivity: 0.9, cabinDamping: 0.85, limitGPos: 2.5, limitGNeg: -1, lengthM: 61 }),
  spec('experimental', 'Solar Wing X', 'experimental', { massKg: 2_300, wingAreaM2: 270, maxThrustN: 10_000, fuelCapacityKg: 400, fuelBurnFullKgS: 0.02, stallSpeedMs: 18, cruiseSpeedMs: 45, maxSpeedMs: 70, serviceCeilingM: 9_000, rollRate: 0.6, pitchRate: 0.4, yawRate: 0.2, controlLag: 0.4, gustSensitivity: 2.2, cabinDamping: 1.6, limitGPos: 3, limitGNeg: -1.5, lengthM: 22 }),
]

const upgrades: Upgrade[] = [
  { id: 'winglets', slot: 'wings', name: 'Blended winglets', description: 'Cleaner wingtips. Every bump reaches the airframe a little harder.', modifiers: { fuelBurnFullKgS: 0.93, gustSensitivity: 1.12 }, unlock: { kind: 'always' } },
  { id: 'laminar-wing', slot: 'wings', name: 'Laminar wing', description: 'Slippery at cruise, touchy near the stall.', modifiers: { maxSpeedMs: 1.05, stallSpeedMs: 1.08 }, unlock: { kind: 'flights', count: 3 } },
  { id: 'hi-bypass', slot: 'engines', name: 'High-bypass fans', description: 'More push down low, heavier nacelles, lower top speed.', modifiers: { maxThrustN: 1.1, massKg: 1.04, maxSpeedMs: 0.96 }, unlock: { kind: 'always' } },
  { id: 'lean-burn', slot: 'engines', name: 'Lean-burn cores', description: 'Sips fuel. Slow to answer the throttle.', modifiers: { fuelBurnFullKgS: 0.88, maxThrustN: 0.93 }, unlock: { kind: 'score', board: 'eco', atLeast: 700 } },
  { id: 'active-seats', slot: 'cabin', name: 'Active seat damping', description: 'Passengers barely notice the chop. Extra weight.', modifiers: { cabinDamping: 0.82, massKg: 1.03 }, unlock: { kind: 'always' } },
  { id: 'gust-probe', slot: 'instruments', name: 'Gust probe', description: 'Reads the air ahead; the control laws soften your inputs.', modifiers: { gustSensitivity: 0.9, rollRate: 0.92 }, unlock: { kind: 'flights', count: 5 } },
  { id: 'doppler', slot: 'radar', name: 'Doppler weather radar', description: 'Sees further into cells. The radome costs a little speed.', modifiers: { gustSensitivity: 0.95, maxSpeedMs: 0.98 }, unlock: { kind: 'score', board: 'smooth', atLeast: 600 } },
  { id: 'fbw', slot: 'avionics', name: 'Fly-by-wire tuning', description: 'Snappier response, tighter structural protection.', modifiers: { controlLag: 0.8, limitGPos: 0.92 }, unlock: { kind: 'flights', count: 8 } },
  { id: 'polar', slot: 'livery', name: 'Polar stripe', description: 'Painted for the jet stream crowd.', modifiers: {}, unlock: { kind: 'always' } },
]

const veteran: PlayerProgress = {
  pilot: 'Ada',
  flights: 4,
  best: { smooth: 640, speed: 512, eco: 455 },
  unlockedAircraft: ['turboprop', 'regional', 'narrowbody'],
  unlockedUpgrades: ['laminar-wing', 'doppler'],
  loadouts: { turboprop: ['winglets', 'active-seats'], regional: ['hi-bypass'] },
  livery: { regional: '#1f3b5c', narrowbody: '#c73a36' },
}
const rookie: PlayerProgress = { pilot: 'pilot', flights: 0, best: { smooth: 0, speed: 0, eco: 0 }, unlockedAircraft: ['turboprop'], unlockedUpgrades: [], loadouts: {}, livery: {} }

const results = (status: 'arrived' | 'crashed'): ResultsModel => ({
  score: {
    status,
    simTimeS: 582,
    displayTimeS: status === 'arrived' ? 17_460 : 9_020,
    fuelUsedKg: 4_980,
    fuelRemainingPct: status === 'arrived' ? 6 : 41,
    comfort: status === 'arrived' ? 84 : 38,
    severeTurbulenceS: status === 'arrived' ? 0 : 27,
    stress: status === 'arrived' ? 22 : 91,
    weatherUtilization: status === 'arrived' ? 63 : 18,
    smooth: status === 'arrived' ? 712 : 120,
    speed: status === 'arrived' ? 498 : 0,
    eco: status === 'arrived' ? 781 : 0,
  },
  route: daily.routes[0],
  dailyNumber: daily.number,
  aircraft: aircraft[0]!,
  ghostCode: 'v1.eJyrVkrOz0nNzUxRslIqSk1LLUrNS1ayUjI0MjIwMlCqBQCjFwk9',
  previousBest: veteran.best,
  newlyUnlocked: status === 'arrived' ? [{ id: 'widebody', name: 'Albatross 350', kind: 'aircraft' }, { id: 'gust-probe', name: 'Gust probe', kind: 'upgrade' }] : [],
})

// Mirrors what meta.unlockHints produces: absent = unlocked.
const SAMPLE_HINTS: Record<string, string> = {
  regional: '1 more flight',
  narrowbody: '3 more flights',
  widebody: 'Smooth 700',
  cargo: 'Eco 650',
  supersonic: 'Speed 800',
  experimental: '20 more flights',
}
const hintsFor = (p: PlayerProgress): Record<string, string> =>
  Object.fromEntries(Object.entries(SAMPLE_HINTS).filter(([id]) => !p.unlockedAircraft.includes(id)))

// Today's boards as the store hands them over: one run = one ghost on up to three boards (only scores > 0),
// best first, ten per board. Friends' names arrive raw from their ghost codes, hostile ones included.
interface SampleRun {
  readonly pilot: string
  readonly routeId: string
  readonly smooth: number
  readonly speed: number
  readonly eco: number
}
const RUNS: readonly SampleRun[] = [
  { pilot: 'Ada', routeId: 'jfk-lis', smooth: 812, speed: 540, eco: 903 },
  { pilot: 'Zoë ✈', routeId: 'jfk-lis', smooth: 812, speed: 1103, eco: 780 },
  { pilot: '<img src=x onerror=alert(1)>', routeId: 'jfk-lis', smooth: 455, speed: 1042, eco: 390 },
  { pilot: 'Captain Maximilian Alexander von Stratosphere-Cumulonimbus 3', routeId: 'jfk-lis', smooth: 598, speed: 611, eco: 655 },
  { pilot: 'Ada', routeId: 'jfk-lis', smooth: 640, speed: 702, eco: 611 },
  { pilot: 'مسافر الريح', routeId: 'jfk-lis', smooth: 377, speed: 488, eco: 702 },
  { pilot: '\u202Eyrollam', routeId: 'jfk-lis', smooth: 301, speed: 655, eco: 0 },
  { pilot: 'Ada\u200B', routeId: 'jfk-lis', smooth: 720, speed: 590, eco: 540 },
  { pilot: 'Z' + '\u0336\u0322\u031B\u0316\u0353\u0308\u0300\u0301'.repeat(4) + 'algo', routeId: 'jfk-lis', smooth: 250, speed: 300, eco: 280 },
  { pilot: 'Marco', routeId: 'jfk-lis', smooth: 700, speed: 655, eco: 598 },
  { pilot: 'Priya', routeId: 'jfk-lis', smooth: 690, speed: 760, eco: 820 },
  { pilot: 'Ada', routeId: 'dxb-sin', smooth: 310, speed: 1180, eco: 0 },
  { pilot: 'Kenji', routeId: 'dxb-sin', smooth: 205, speed: 1255, eco: 0 },
]
const BOARD_KINDS: readonly BoardKind[] = ['smooth', 'speed', 'eco']
const sampleBoards = (runs: readonly SampleRun[]): BoardsModel['boards'] =>
  Object.fromEntries(
    daily.routes.map((r) => [
      r.id,
      Object.fromEntries(
        BOARD_KINDS.map((board) => [
          board,
          runs
            .map((run, i): LeaderboardEntry => ({ pilot: run.pilot, dailyNumber: daily.number, routeId: run.routeId, board, value: run[board], ghost: `sample-ghost-${i}` }))
            .filter((e) => e.routeId === r.id && e.value > 0)
            .sort((a, b) => b.value - a.value)
            .slice(0, 10),
        ]),
      ) as Record<BoardKind, LeaderboardEntry[]>,
    ]),
  )

// ── Screens ────────────────────────────────────────────────────────────────

const log = (msg: string): void => console.info(`[ui sandbox] ${msg}`)

const showTitle = (progress: PlayerProgress): void => {
  hud.setVisible(false)
  screens.showTitle(daily, progress, aircraft, hintsFor(progress), {
    onFly: (r, a, g) => {
      log(`onFly(${r}, ${a}, ${g ? JSON.stringify(g.slice(0, 40)) : 'null'})`)
      showHud()
    },
    onHangar: () => showHangar(),
    onSettings: () => showSettings(),
    onBoards: () => showBoards(RUNS),
  })
}
const showBoards = (runs: readonly SampleRun[]): void => {
  hud.setVisible(false)
  // Highlight follows the Settings name, like the shell: rename yourself and your rows lose the mark.
  screens.showBoards({ daily, pilot: sandboxSettings.pilotName, boards: sampleBoards(runs) }, {
    onRace: (e) => {
      log(`onRace(${e.routeId}/${e.board} #${e.ghost}, value ${e.value})`)
      showHud()
    },
    onBack: () => showTitle(veteran),
  })
}
let hangarProgress = veteran
const showHangar = (): void => {
  hud.setVisible(false)
  screens.showHangar({ progress: hangarProgress, aircraft, upgrades, unlockHints: hintsFor(hangarProgress) }, {
    onUnequip: (a, slot) => {
      log(`onUnequip(${a}, ${slot})`)
      const kept = (hangarProgress.loadouts[a] ?? []).filter((id) => upgrades.find((x) => x.id === id)?.slot !== slot)
      hangarProgress = { ...hangarProgress, loadouts: { ...hangarProgress.loadouts, [a]: kept } }
      showHangar()
    },
    onEquip: (a, u) => {
      log(`onEquip(${a}, ${u})`)
      const slot = upgrades.find((x) => x.id === u)!.slot
      const kept = (hangarProgress.loadouts[a] ?? []).filter((id) => upgrades.find((x) => x.id === id)?.slot !== slot)
      hangarProgress = { ...hangarProgress, loadouts: { ...hangarProgress.loadouts, [a]: [...kept, u] } }
      showHangar()
    },
    onLivery: (a, c) => {
      log(`onLivery(${a}, ${c})`)
      hangarProgress = { ...hangarProgress, livery: { ...hangarProgress.livery, [a]: c } }
      showHangar()
    },
    onSelectAircraft: (a) => log(`onSelectAircraft(${a})`),
    onBack: () => showTitle(veteran),
  })
}
let sandboxSettings: Settings = { ...DEFAULT_SETTINGS, pilotName: veteran.pilot }
const showSettings = (): void => {
  hud.setVisible(false)
  screens.showSettings(sandboxSettings, {
    onChange: (s) => {
      sandboxSettings = s
      input.setInvertPitch(s.invertPitch)
      hud.setCoaching(s.coaching)
      log(`onChange(${JSON.stringify(s)})`)
    },
    onBack: () => showTitle(veteran),
  })
}
const showResults = (status: 'arrived' | 'crashed'): void => {
  hud.setVisible(false)
  screens.showResults(results(status), { onRetry: () => showHud(), onMenu: () => showTitle(veteran) })
}
const showHud = (): void => {
  screens.hide()
  hud.setVisible(true)
}

// ── Synthetic flight ───────────────────────────────────────────────────────

type Scene = 'live' | 'cruise' | 'jet' | 'stall' | 'rough'
const scene = (params.get('hud') ?? 'live') as Scene

const model = (t: number, throttle: number): HudModel => {
  const cycle = t % 40
  const jet = scene === 'jet' || (scene === 'live' && cycle > 22 && cycle < 31)
  const stall = scene === 'stall' || (scene === 'live' && cycle > 34 && cycle < 36.5)
  const rough = scene === 'rough' || (scene === 'live' && cycle > 12 && cycle < 18)
  const dominant: WeatherFeatureKind | null = jet ? 'jetstream' : rough ? 'storm' : cycle > 4 && cycle < 11 ? 'updraft' : null
  const airspeedKt = stall ? 104 + Math.sin(t * 3) * 3 : 268 + Math.sin(t * 0.3) * 14
  const groundSpeedKmh = jet ? 847 + Math.sin(t * 0.8) * 9 : airspeedKt * 1.852 * 0.97
  const turbulence = rough ? 0.78 + Math.sin(t * 5) * 0.1 : dominant === 'updraft' ? 0.32 : 0.06 + Math.abs(Math.sin(t * 0.7)) * 0.08
  return {
    dailyNumber: daily.number,
    routeLabel: daily.routes[0].label,
    altitudeFt: 31_400 + Math.sin(t * 0.12) * 2_600 + (dominant === 'updraft' ? cycle * 180 : 0),
    verticalSpeedFpm: dominant === 'updraft' ? 2_400 : stall ? -1_900 : Math.cos(t * 0.12) * 900,
    airspeedKt,
    groundSpeedKmh,
    headingDeg: 84 + Math.sin(t * 0.2) * 12,
    throttle,
    fuelPct: Math.max(4, 64 - t * 0.25),
    comfort: rough ? 52 : 88,
    stress: rough ? 58 : stall ? 34 : 14,
    turbulence,
    dominant,
    gLoad: rough ? 1 + Math.sin(t * 6) * 0.9 : 1 + Math.sin(t * 0.9) * 0.08,
    stalled: stall,
    gateDistanceKm: Math.max(0, 2_140 - t * 4.2),
    gateBearingDeg: Math.sin(t * 0.25) * 38 + (rough ? 70 : 0),
    gateAltitudeOk: cycle < 20,
    displayTimeS: 3 * 3600 + 12 * 60 + t * 30,
    ghostDeltaS: jet ? 12.4 + Math.sin(t) * 0.4 : -3.1 + Math.sin(t * 0.3) * 1.5,
  }
}

// ── Dev bar ────────────────────────────────────────────────────────────────

const readout = document.createElement('output')
const btn = (label: string, fn: () => void): HTMLButtonElement => {
  const b = document.createElement('button')
  b.textContent = label
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    fn()
  })
  return b
}
const setBg = (bg: string): void => {
  stage.classList.toggle('storm', bg === 'storm')
}
dev.append(
  btn('Sky', () => setBg(stage.classList.contains('storm') ? 'bright' : 'storm')),
  btn('HUD', showHud),
  btn('Title', () => showTitle(veteran)),
  btn('First run', () => showTitle(rookie)),
  btn('Results', () => showResults('arrived')),
  btn('Crash', () => showResults('crashed')),
  btn('Hangar', showHangar),
  btn('Settings', showSettings),
  btn('Boards', () => showBoards(RUNS)),
  btn('No boards', () => showBoards([])),
  readout,
)

setBg(params.get('bg') ?? 'bright')
const initial = params.get('screen')
if (initial) document.body.classList.add('shot')
switch (initial) {
  case 'title': showTitle(veteran); break
  case 'title-first': showTitle(rookie); break
  case 'results': showResults('arrived'); break
  case 'results-crash': showResults('crashed'); break
  case 'hangar': showHangar(); break
  case 'settings': showSettings(); break
  case 'boards': showBoards(RUNS); break
  case 'boards-empty': showBoards([]); break
  default: showHud()
}

// Frozen scenes render one deterministic frame; live mode animates.
const frozenT = scene === 'live' ? null : 7.5
const start = performance.now()
const frame = (): void => {
  const t = frozenT ?? (performance.now() - start) / 1000
  const c = input.read()
  hud.update(model(t, c.throttle))
  readout.textContent = `pitch ${c.pitch.toFixed(2)}  roll ${c.roll.toFixed(2)}  yaw ${c.yaw.toFixed(2)}  thr ${c.throttle.toFixed(2)}`
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
