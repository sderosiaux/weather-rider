// Frozen contracts for three.js / DOM modules. Same rule as types.ts: architect-owned.
import type * as THREE from 'three'
import type {
  AircraftSpec,
  AircraftState,
  DailyWeather,
  FlightScore,
  Ghost,
  GhostSample,
  HudModel,
  PlayerProgress,
  Route,
  Upgrade,
  UpgradeSlot,
  WeatherField,
  WeatherFeatureKind,
} from './types'

// ─── src/render ─────────────────────────────────────────────────────────────

export interface GhostVisual {
  readonly ghost: Ghost
  /** Airframe to draw (ghost.aircraftId resolved by the caller). */
  readonly spec: AircraftSpec
  /** CSS color string. */
  readonly color: string
  /** Draw the full track as a persistent line in the sky (best routes of the day). */
  readonly showTrail: boolean
}

export interface WorldFrame {
  readonly state: AircraftState
  /** Same order as the last setGhosts() call. */
  readonly ghostPoses: readonly GhostSample[]
  /** Wall-clock delta (s) for purely visual animation (clouds drift, camera smoothing). */
  readonly dtReal: number
}

export interface WorldView {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  setWeather(weather: WeatherField): void
  setRoute(route: Route): void
  setAircraft(spec: AircraftSpec, liveryColor: string): void
  setGhosts(ghosts: readonly GhostVisual[]): void
  /** Updates aircraft, ghosts, chase camera. Does not render. */
  update(frame: WorldFrame): void
  render(): void
  resize(width: number, height: number): void
  dispose(): void
}

export type CreateWorldView = (canvas: HTMLCanvasElement) => WorldView

// ─── src/flow ───────────────────────────────────────────────────────────────

export interface FlowLayer {
  setWeather(weather: WeatherField): void
  /** Advect and redraw particles around the camera. simT = weather time. */
  update(camera: THREE.Camera, simT: number, dtReal: number): void
  /** 0..1 global visual intensity (player setting / accessibility). */
  setIntensity(intensity: number): void
  dispose(): void
}

export type CreateFlowLayer = (scene: THREE.Scene) => FlowLayer

// ─── src/ui ─────────────────────────────────────────────────────────────────

export interface Hud {
  update(model: HudModel): void
  setVisible(visible: boolean): void
  dispose(): void
}

export type CreateHud = (root: HTMLElement) => Hud

export interface TitleCallbacks {
  onFly(routeId: string, aircraftId: string, ghostCode: string | null): void
  onHangar(): void
}

export interface ResultsModel {
  readonly score: FlightScore
  readonly route: Route
  readonly dailyNumber: number
  readonly aircraft: AircraftSpec
  /** Encoded ghost of this flight, for "Beat my run" sharing. */
  readonly ghostCode: string
  readonly previousBest: { readonly smooth: number; readonly speed: number; readonly eco: number } | null
  readonly newlyUnlocked: readonly string[]
}

/** aircraftId → human hint for locked aircraft ("2 more flights", "Smooth score 450 needed"). Absent = unlocked. */
export type UnlockHints = Readonly<Record<string, string>>

export interface HangarModel {
  readonly progress: PlayerProgress
  readonly aircraft: readonly AircraftSpec[]
  readonly upgrades: readonly Upgrade[]
  readonly unlockHints: UnlockHints
}

export interface Screens {
  showTitle(daily: DailyWeather, progress: PlayerProgress, aircraft: readonly AircraftSpec[], unlockHints: UnlockHints, cb: TitleCallbacks): void
  showResults(model: ResultsModel, cb: { onRetry(): void; onMenu(): void }): void
  showHangar(
    model: HangarModel,
    cb: { onEquip(aircraftId: string, upgradeId: string): void; onUnequip(aircraftId: string, slot: UpgradeSlot): void; onLivery(aircraftId: string, color: string): void; onBack(): void },
  ): void
  hide(): void
  dispose(): void
}

export type CreateScreens = (root: HTMLElement) => Screens

// ─── src/audio ──────────────────────────────────────────────────────────────

/** What the soundscape reacts to. Built by the game loop each frame. */
export interface AudioFrame {
  readonly airspeedMs: number
  readonly throttle: number
  readonly turbulence: number
  readonly dominant: WeatherFeatureKind | null
  /** Vertical wind at the aircraft (m/s), + = rising air. */
  readonly verticalWindMs: number
  readonly cloud: number
  readonly stalled: boolean
  readonly aircraftClass: AircraftSpec['class']
}

export interface AudioEngine {
  /** Must be called from a user gesture (browser autoplay policy). Idempotent. */
  resume(): void
  update(frame: AudioFrame, dtReal: number): void
  /** One-shot cues. */
  cue(kind: 'arrived' | 'crashed' | 'overstressed' | 'unlock' | 'record'): void
  /** 'menu' = ambient bed only, 'flight' = full soundscape. */
  setScene(scene: 'menu' | 'flight'): void
  setVolume(volume: number): void
  dispose(): void
}

export type CreateAudio = () => AudioEngine
