// In-flight coaching: a pure rule engine over the HudModel stream.
// It teaches the player to read the sky, one quiet line at a time, and retires
// each lesson for good once the pilot has shown they know it.
import type { HudModel, WeatherFeatureKind } from '../../core/types'

export type HintId = 'storm' | 'gate' | 'fuel' | 'updraft' | 'jet'

/** Highest priority first: what protects passengers and the flight beats what makes it faster. */
export const PRIORITY: readonly HintId[] = ['storm', 'gate', 'fuel', 'updraft', 'jet']

export const HINT_TEXT: Record<HintId, string> = {
  storm: 'Storm core: your passengers feel every bump. Go around it, or over it.',
  gate: 'Line up with the gate’s altitude window.',
  fuel: 'Low fuel: ease the throttle and glide, trading altitude for distance.',
  updraft: 'Rising air: circle inside it to climb for free.',
  jet: 'Jet stream: ride it and watch your ground speed.',
}

export const TIMING = {
  /** A condition must hold this long before its hint fires (s). */
  sustainS: 0.8,
  /** How long a hint stays up (s). */
  holdS: 5.5,
  /** Quiet time after any hint before the next one (s). */
  globalCooldownS: 18,
  /** Before the same hint can come back (s). */
  repeatCooldownS: 75,
  /** The same hint at most this many times per flight. */
  maxPerFlight: 2,
} as const

/** What "the pilot has shown it" means, per lesson. */
export const MASTERY = {
  /** Altitude gained in one continuous stay in rising air. */
  updraftClimbFt: 984, // 300 m
  /** Seconds riding a jet stream tailwind (cumulative, across flights). */
  jetRideS: 20,
  /** Seconds gliding (throttle < glideThrottle) while low on fuel. */
  glideS: 10,
  glideThrottle: 0.3,
} as const

const RISING: ReadonlySet<WeatherFeatureKind> = new Set(['updraft', 'thermal'])
const VS_RISING_FPM = 200
const STORM_TURBULENCE = 0.3
const SEVERE = 0.7
const JET_TAILWIND_RATIO = 1.12
const KT_TO_KMH = 1.852
const LOW_FUEL_PCT = 20
const GATE_FINAL_FRACTION = 0.15

export type CoachEvent =
  | { readonly type: 'show'; readonly id: HintId; readonly text: string }
  | { readonly type: 'hide' }
  | { readonly type: 'retire'; readonly id: HintId }

export interface CoachState {
  readonly enabled: boolean
  readonly retired: readonly HintId[]
  /** Last frame time (s) and flight clock, to detect a new flight. */
  readonly t: number | null
  readonly lastDisplayTimeS: number
  readonly showing: { readonly id: HintId; readonly until: number } | null
  readonly quietUntil: number
  readonly lastShownAt: Readonly<Partial<Record<HintId, number>>>
  readonly shownThisFlight: Readonly<Partial<Record<HintId, number>>>
  readonly heldFor: Readonly<Partial<Record<HintId, number>>>
  // Mastery trackers
  readonly climbStartFt: number | null
  readonly stormPeak: number | null
  readonly jetRideS: number
  readonly glideS: number
  readonly startGateKm: number
  readonly gateWasOff: boolean
}

export const initialCoach = (enabled: boolean, retired: readonly HintId[], jetRideS = 0): CoachState => ({
  enabled,
  retired,
  t: null,
  lastDisplayTimeS: 0,
  showing: null,
  quietUntil: 0,
  lastShownAt: {},
  shownThisFlight: {},
  heldFor: {},
  climbStartFt: null,
  stormPeak: null,
  jetRideS,
  glideS: 0,
  startGateKm: 0,
  gateWasOff: false,
})

/** Per-flight state goes; what the pilot has learned stays. */
export const newFlight = (s: CoachState): CoachState => ({
  ...initialCoach(s.enabled, s.retired, s.jetRideS),
  lastShownAt: s.lastShownAt,
})

const onJet = (m: HudModel): boolean =>
  m.dominant === 'jetstream' && m.groundSpeedKmh > m.airspeedKt * KT_TO_KMH * JET_TAILWIND_RATIO

const inFinalStretch = (s: CoachState, m: HudModel): boolean =>
  s.startGateKm > 0 && m.gateDistanceKm < s.startGateKm * GATE_FINAL_FRACTION

/** Conditions under which each lesson is worth saying right now. */
const wants = (s: CoachState, m: HudModel): Record<HintId, boolean> => ({
  storm: m.dominant === 'storm' && m.turbulence >= STORM_TURBULENCE,
  gate: inFinalStretch(s, m) && !m.gateAltitudeOk,
  fuel: m.fuelPct < LOW_FUEL_PCT,
  updraft: m.dominant !== null && RISING.has(m.dominant) && m.verticalSpeedFpm > VS_RISING_FPM,
  jet: onJet(m),
})

/** Update mastery trackers; returns lessons demonstrated this frame. */
const learn = (s: CoachState, m: HudModel, dt: number): { s: CoachState; learned: HintId[] } => {
  const learned: HintId[] = []

  // Rising air: one continuous stay, climb measured from where it began.
  const rising = m.dominant !== null && RISING.has(m.dominant)
  let climbStartFt = rising ? (s.climbStartFt ?? m.altitudeFt) : null
  if (climbStartFt !== null) {
    climbStartFt = Math.min(climbStartFt, m.altitudeFt)
    if (m.altitudeFt - climbStartFt >= MASTERY.updraftClimbFt) learned.push('updraft')
  }

  // Storm: an encounter ends when the storm is no longer dominant; clean if never severe.
  let stormPeak = s.stormPeak
  if (m.dominant === 'storm') stormPeak = Math.max(stormPeak ?? 0, m.turbulence)
  else if (stormPeak !== null) {
    if (stormPeak < SEVERE) learned.push('storm')
    stormPeak = null
  }

  const jetRideS = onJet(m) ? s.jetRideS + dt : s.jetRideS
  if (jetRideS >= MASTERY.jetRideS) learned.push('jet')

  const glideS = m.fuelPct < LOW_FUEL_PCT && m.throttle < MASTERY.glideThrottle ? s.glideS + dt : s.glideS
  if (glideS >= MASTERY.glideS) learned.push('fuel')

  // Gate: coming back into the window during the final stretch.
  const final = inFinalStretch(s, m)
  const gateWasOff = final ? s.gateWasOff || !m.gateAltitudeOk : false
  if (final && s.gateWasOff && m.gateAltitudeOk) learned.push('gate')

  return { s: { ...s, climbStartFt, stormPeak, jetRideS, glideS, gateWasOff }, learned }
}

export const stepCoach = (prev: CoachState, m: HudModel, t: number): { state: CoachState; events: CoachEvent[] } => {
  const events: CoachEvent[] = []
  // The flight clock going backwards means a new flight started.
  let s = prev.t !== null && m.displayTimeS + 1e-6 < prev.lastDisplayTimeS ? newFlight(prev) : prev
  const dt = s.t === null ? 0 : Math.max(0, Math.min(0.25, t - s.t))
  s = { ...s, t, lastDisplayTimeS: m.displayTimeS, startGateKm: Math.max(s.startGateKm, m.gateDistanceKm) }

  const lesson = learn(s, m, dt)
  s = lesson.s
  for (const id of lesson.learned) {
    if (s.retired.includes(id)) continue
    s = { ...s, retired: [...s.retired, id] }
    events.push({ type: 'retire', id })
  }

  // Current hint: ends on time, or immediately once retired.
  if (s.showing && (t >= s.showing.until || s.retired.includes(s.showing.id))) {
    s = { ...s, showing: null, quietUntil: t + TIMING.globalCooldownS }
    events.push({ type: 'hide' })
  }

  const want = wants(s, m)
  const heldFor: Partial<Record<HintId, number>> = {}
  for (const id of PRIORITY) heldFor[id] = want[id] ? (s.heldFor[id] ?? 0) + dt : 0
  s = { ...s, heldFor }

  if (s.enabled && !s.showing && t >= s.quietUntil) {
    const pick = PRIORITY.find(
      (id) =>
        want[id] &&
        !s.retired.includes(id) &&
        (heldFor[id] ?? 0) >= TIMING.sustainS &&
        (s.shownThisFlight[id] ?? 0) < TIMING.maxPerFlight &&
        t - (s.lastShownAt[id] ?? -Infinity) >= TIMING.repeatCooldownS,
    )
    if (pick) {
      s = {
        ...s,
        showing: { id: pick, until: t + TIMING.holdS },
        lastShownAt: { ...s.lastShownAt, [pick]: t },
        shownThisFlight: { ...s.shownThisFlight, [pick]: (s.shownThisFlight[pick] ?? 0) + 1 },
      }
      events.push({ type: 'show', id: pick, text: HINT_TEXT[pick] })
    }
  }

  return { state: s, events }
}
