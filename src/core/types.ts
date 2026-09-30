// Frozen cross-module contracts. Changing this file is an architect decision:
// module owners must not edit it — report the need instead.
//
// World frame: meters/seconds, x = east (main route axis), y = up, z = south.
// Body frame: +x forward (nose), +y up (canopy), +z right wing.
// Identity orientation = level flight heading east.

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Unit quaternion, same component convention as THREE.Quaternion. */
export interface Quat {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
}

// ─── Weather ────────────────────────────────────────────────────────────────

export type WeatherFeature =
  /** Cumulonimbus: violent core, strong updraft on its flanks, downdraft under the anvil. */
  | { readonly kind: 'storm'; readonly id: string; readonly center: Vec3; readonly radius: number; readonly base: number; readonly top: number; readonly strength: number }
  /** Vertical column. strength = peak vertical wind (m/s), negative for downdraft. center.y = (base + top) / 2 for all column kinds. */
  | { readonly kind: 'updraft' | 'downdraft' | 'thermal'; readonly id: string; readonly center: Vec3; readonly radius: number; readonly base: number; readonly top: number; readonly strength: number }
  /** Tube of fast horizontal wind along a polyline. speed in m/s. */
  /** radius = horizontal half-width, thickness = vertical half-thickness (jets are flat ribbons). */
  | { readonly kind: 'jetstream'; readonly id: string; readonly path: readonly Vec3[]; readonly radius: number; readonly thickness: number; readonly speed: number }
  /** Horizontal layer where wind changes abruptly by deltaWind across thickness. */
  | { readonly kind: 'shear'; readonly id: string; readonly altitude: number; readonly thickness: number; readonly deltaWind: Vec3; readonly extentMin: Vec3; readonly extentMax: Vec3 }
  /** Wake left by background traffic: two counter-rotating vortices behind path points. */
  | { readonly kind: 'wake'; readonly id: string; readonly path: readonly Vec3[]; readonly radius: number; readonly strength: number }

export type WeatherFeatureKind = WeatherFeature['kind']

export interface WeatherSample {
  /** Air mass velocity in world frame (m/s). Includes mean flow, features and deterministic gusts. */
  wind: Vec3
  /** 0 = still air, 1 = severe. Drives gust amplitude felt by the aircraft and visual agitation. */
  turbulence: number
  /** Dominant feature at this point, or null in background flow. For HUD hints / audio. */
  dominant: WeatherFeatureKind | null
  /** Cloud density 0..1 at this point (for visuals and visibility). */
  cloud: number
}

export interface WeatherField {
  readonly seed: number
  /** World bounds the field is defined in (outside: background wind only). */
  readonly boundsMin: Vec3
  readonly boundsMax: Vec3
  /**
   * Pure, deterministic in (seed, p, t). Hot path: called per particle per frame.
   * Implementations must not allocate when `out` is provided.
   */
  sample(p: Vec3, t: number, out?: MutableWeatherSample): WeatherSample
  readonly features: readonly WeatherFeature[]
}

export interface MutableWeatherSample {
  wind: { x: number; y: number; z: number }
  turbulence: number
  dominant: WeatherFeatureKind | null
  cloud: number
}

export interface WeatherParams {
  readonly seed: number
  readonly boundsMin: Vec3
  readonly boundsMax: Vec3
  /** 0 = calm day, 1 = extreme weather. */
  readonly severity: number
  /** Route corridor the generator must make interesting (features biased along it). */
  readonly corridor: readonly [Vec3, Vec3]
}

export type CreateWeather = (params: WeatherParams) => WeatherField

// ─── Aircraft & flight ──────────────────────────────────────────────────────

export type AircraftClass = 'turboprop' | 'regional' | 'narrowbody' | 'widebody' | 'cargo' | 'supersonic' | 'experimental'

export interface AircraftSpec {
  readonly id: string
  readonly name: string
  readonly class: AircraftClass
  readonly massKg: number
  readonly wingAreaM2: number
  readonly maxThrustN: number
  readonly fuelCapacityKg: number
  /** kg of fuel per second at full throttle. */
  readonly fuelBurnFullKgS: number
  readonly stallSpeedMs: number
  readonly cruiseSpeedMs: number
  readonly maxSpeedMs: number
  readonly serviceCeilingM: number
  /** Max angular rates at full deflection (rad/s). */
  readonly rollRate: number
  readonly pitchRate: number
  readonly yawRate: number
  /** Seconds to reach commanded angular rate. Bigger = heavier feel. */
  readonly controlLag: number
  /** Multiplier on gust response. Small aircraft > 1, wide body < 1. */
  readonly gustSensitivity: number
  /** Multiplier on how much vertical accel reaches passengers. Wide body < 1. */
  readonly cabinDamping: number
  /** Positive/negative structural load limits (g). */
  readonly limitGPos: number
  readonly limitGNeg: number
  /** Visual length in meters (render scale). */
  readonly lengthM: number
}

export interface Controls {
  /** -1..1, positive = nose up. */
  readonly pitch: number
  /** -1..1, positive = right wing down. */
  readonly roll: number
  /** -1..1, positive = nose right. */
  readonly yaw: number
  /** 0..1 */
  readonly throttle: number
}

export interface AircraftState {
  /** Sim time (s) since takeoff. */
  readonly t: number
  readonly pos: Vec3
  /** Ground velocity (world frame) = air velocity + wind. */
  readonly vel: Vec3
  readonly orientation: Quat
  /** Body-frame angular velocity (rad/s), right-handed: +x = right wing down (roll right), +z = nose up, +y = nose LEFT (so yaw-right control ⇒ negative y). See core/math.test.ts. */
  readonly angVel: Vec3
  /** True airspeed (m/s). */
  readonly airspeed: number
  readonly throttle: number
  readonly fuelKg: number
  /** Load factor along body up axis (1 = level flight). */
  readonly gLoad: number
  /** Vertical acceleration felt in the cabin (m/s², gravity removed, damped by cabinDamping). */
  readonly cabinAccel: number
  /** Accumulated structural fatigue 0..1. 1 = airframe failure. */
  readonly stress: number
  readonly stalled: boolean
  readonly status: 'flying' | 'arrived' | 'crashed' | 'overstressed'
}

export interface FlightModel {
  /** Starts trimmed at route.start with airspeed = cruise in the local wind (ground vel = air vel + wind). */
  initialState(spec: AircraftSpec, route: Route, weather: WeatherField): AircraftState
  /** Pure: same inputs → same output. dt is always SIM_DT. */
  step(spec: AircraftSpec, state: AircraftState, controls: Controls, weather: WeatherField, route: Route, dt: number): AircraftState
}

// ─── Routes, daily weather ──────────────────────────────────────────────────

export interface Route {
  readonly id: string
  /** e.g. "JFK" / "LIS" — flavour only. */
  readonly from: string
  readonly to: string
  readonly start: Vec3
  readonly startHeading: Vec3
  /** Arrival gate: cylinder around `gate`, vertical window [gateMinAlt, gateMaxAlt]. */
  readonly gate: Vec3
  readonly gateRadius: number
  readonly gateMinAlt: number
  readonly gateMaxAlt: number
  /** Real-world distance (km) the game route stands for. Display only. */
  readonly realDistanceKm: number
  /** Multiply sim seconds by this to get the displayed "real" flight time. */
  readonly timeScale: number
  readonly severity: number
  readonly label: string
}

/**
 * The day's light: same for every route of the day, generated by meta from the daily seed, drawn by render.
 * Always daylight (the game is contemplative, no night): elevation stays in [6, 40].
 */
export interface SkyParams {
  /** Sun height above the horizon (degrees): 6 = low golden glow … 40 = high, bright light. */
  readonly sunElevationDeg: number
  /** Sun compass bearing (degrees): 0 = north (−z), 90 = east (+x, the direction of travel), 180 = south (+z). */
  readonly sunAzimuthDeg: number
  /** Aerial perspective: 0 = crystal clear … 1 = milky haze. */
  readonly haze: number
  /** Light colour: 0 = neutral white … 1 = deep golden hour. */
  readonly warmth: number
}

export interface DailyWeather {
  /** "WORLD WEATHER #N" where N = days since 2026-01-01 (UTC) + 1. */
  readonly number: number
  readonly seed: number
  readonly routes: readonly [Route, Route, Route]
  readonly sky: SkyParams
  readonly boundsMin: Vec3
  readonly boundsMax: Vec3
}

// ─── Telemetry, scoring ─────────────────────────────────────────────────────

/** One per sim step, produced by the game loop, consumed by scoring. */
export interface TelemetryFrame {
  readonly state: AircraftState
  readonly controls: Controls
  readonly weather: WeatherSample
  readonly dt: number
}

export interface FlightScore {
  readonly status: AircraftState['status']
  readonly simTimeS: number
  /** simTimeS * route.timeScale */
  readonly displayTimeS: number
  readonly fuelUsedKg: number
  readonly fuelRemainingPct: number
  /** 0..100, 100 = nobody spilled coffee. */
  readonly comfort: number
  /** Seconds spent in severe turbulence (turbulence > 0.7). Smooth pilots want 0. */
  readonly severeTurbulenceS: number
  /** 0..100, final airframe stress. */
  readonly stress: number
  /** 0..100, share of mechanical energy gained from the atmosphere. */
  readonly weatherUtilization: number
  /** Per-leaderboard scores; higher = better. */
  readonly smooth: number
  readonly speed: number
  readonly eco: number
}

export interface ScoreTracker {
  push(frame: TelemetryFrame): void
  /** Live partial score for the HUD. */
  current(): FlightScore
  finish(): FlightScore
}

export type CreateScoreTracker = (spec: AircraftSpec, route: Route) => ScoreTracker

// ─── Ghosts ─────────────────────────────────────────────────────────────────

export interface GhostSample {
  readonly t: number
  readonly pos: Vec3
  readonly orientation: Quat
}

export interface Ghost {
  readonly version: 1
  readonly pilot: string
  readonly dailyNumber: number
  readonly routeId: string
  readonly aircraftId: string
  readonly score: FlightScore
  /** Sampled at GHOST_HZ. */
  readonly samples: readonly GhostSample[]
}

export interface GhostCodec {
  encode(ghost: Ghost): string
  decode(encoded: string): Ghost
  /** Interpolated pose at sim time t (clamped to track). */
  poseAt(ghost: Ghost, t: number): GhostSample
}

// ─── Progression / hangar ───────────────────────────────────────────────────

export type UpgradeSlot = 'instruments' | 'radar' | 'wings' | 'engines' | 'cabin' | 'livery' | 'avionics'

export interface Upgrade {
  readonly id: string
  readonly slot: UpgradeSlot
  readonly name: string
  readonly description: string
  /** Multiplicative deltas on AircraftSpec numeric fields. Must trade off: at least one > 1 and one < 1, except livery (cosmetic, empty). */
  readonly modifiers: Partial<Record<NumericSpecKey, number>>
  readonly unlock: UnlockRule
}

export type NumericSpecKey = { [K in keyof AircraftSpec]: AircraftSpec[K] extends number ? K : never }[keyof AircraftSpec]

export type UnlockRule =
  | { readonly kind: 'always' }
  | { readonly kind: 'flights'; readonly count: number }
  | { readonly kind: 'score'; readonly board: 'smooth' | 'speed' | 'eco'; readonly atLeast: number }

export interface PlayerProgress {
  readonly pilot: string
  readonly flights: number
  readonly best: { readonly smooth: number; readonly speed: number; readonly eco: number }
  readonly unlockedAircraft: readonly string[]
  readonly unlockedUpgrades: readonly string[]
  /** aircraftId → equipped upgrade ids (one per slot). */
  readonly loadouts: Readonly<Record<string, readonly string[]>>
  readonly livery: Readonly<Record<string, string>>
}

export interface LeaderboardEntry {
  readonly pilot: string
  readonly dailyNumber: number
  readonly routeId: string
  readonly board: 'smooth' | 'speed' | 'eco'
  readonly value: number
  readonly ghost: string
}

// ─── Presentation contracts ─────────────────────────────────────────────────

/** Everything the HUD shows. Built by the game loop, rendered by ui/.
 *  Units: comfort/stress/fuelPct 0..100 (stress 100 = failure), turbulence/throttle 0..1, gLoad in g. */
export interface HudModel {
  readonly dailyNumber: number
  readonly routeLabel: string
  readonly altitudeFt: number
  readonly verticalSpeedFpm: number
  readonly airspeedKt: number
  readonly groundSpeedKmh: number
  readonly headingDeg: number
  readonly throttle: number
  readonly fuelPct: number
  readonly comfort: number
  readonly stress: number
  readonly turbulence: number
  readonly dominant: WeatherFeatureKind | null
  readonly gLoad: number
  readonly stalled: boolean
  /** Distance to gate (real-world km, scaled) and bearing relative to nose (deg, + = right). */
  readonly gateDistanceKm: number
  readonly gateBearingDeg: number
  readonly gateAltitudeOk: boolean
  readonly displayTimeS: number
  /** Ghost delta: + = you are ahead (seconds). null if no ghost. */
  readonly ghostDeltaS: number | null
}

export interface InputSource {
  /** Poll once per frame. */
  read(): Controls
  setInvertPitch(invert: boolean): void
  /** New flight: stick to neutral, held keys cleared, persistent throttle set to the aircraft's trimmed throttle. */
  resetForFlight(throttle: number): void
  dispose(): void
}
