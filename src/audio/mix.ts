// AudioFrame → target parameters. Pure: no Web Audio here, so it runs under vitest.
// Gains are linear. The graph smooths every value, so these are targets, not instant settings.
import { SEVERE_TURBULENCE } from '../core/constants'
import { clamp, smoothstep } from '../core/math'
import type { AudioFrame } from '../core/presentation'
import { ENGINE_VOICES, type EngineVoice } from './voices'

export type AudioScene = 'menu' | 'flight'

export interface MixTargets {
  readonly windLevel: number
  readonly windCutoffHz: number
  /** 0 = mono, 1 = fully decorrelated stereo. */
  readonly windWidth: number
  /** Fraction of windLevel the slow gust LFOs swing by. */
  readonly gustDepth: number
  readonly gustHz: number
  /** Low rumble bed (storm / severe turbulence). */
  readonly rumbleLevel: number
  /** Fraction of the rumble level the buffet LFOs swing by. */
  readonly buffetDepth: number
  readonly buffetHz: number
  readonly engine: EngineVoice
  readonly engineLevel: number
  /** Multiplier on every engine frequency. */
  readonly enginePitch: number
  readonly shimmerLevel: number
  readonly shimmerPitch: number
  readonly sinkLevel: number
  readonly sinkPitch: number
  readonly jetPadLevel: number
  readonly menuPadLevel: number
  /** Lowpass on the "world" bus: clear air ≈ open, inside cloud ≈ muffled. */
  readonly worldCutoffHz: number
  readonly stallLevel: number
}

/** Rising/sinking air below this (m/s) is background noise, not terrain. */
export const VERTICAL_THRESHOLD_MS = 3
const VERTICAL_FULL_MS = 16
const VERTICAL_TOP_MS = 25
/** Airspeed that counts as "fast" for the wind bed (typical jet cruise). */
const WIND_REF_MS = 240
const OPEN_CUTOFF_HZ = 16_000
const CLOUD_CUTOFF_HZ = 650

const finite = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback)

export const NEUTRAL_FRAME: AudioFrame = {
  airspeedMs: 0,
  throttle: 0,
  turbulence: 0,
  dominant: null,
  verticalWindMs: 0,
  cloud: 0,
  stalled: false,
  aircraftClass: 'narrowbody',
}

export function computeMix(frame: AudioFrame, scene: AudioScene): MixTargets {
  const engine = ENGINE_VOICES[frame.aircraftClass] ?? ENGINE_VOICES.narrowbody
  if (scene === 'menu') return menuMix(engine)

  const s = clamp(finite(frame.airspeedMs) / WIND_REF_MS, 0, 2.5)
  const sLow = Math.min(1, s)
  const throttle = clamp(finite(frame.throttle), 0, 1)
  const turb = clamp(finite(frame.turbulence), 0, 1)
  const vz = finite(frame.verticalWindMs)
  const cloud = clamp(finite(frame.cloud), 0, 1)
  const storm = frame.dominant === 'storm' ? 1 : 0

  const severe = smoothstep(SEVERE_TURBULENCE - 0.25, SEVERE_TURBULENCE + 0.2, turb)
  const up = smoothstep(VERTICAL_THRESHOLD_MS, VERTICAL_FULL_MS, vz)
  const down = smoothstep(VERTICAL_THRESHOLD_MS, VERTICAL_FULL_MS, -vz)

  return {
    windLevel: 0.025 + 0.2 * sLow ** 1.4 + 0.04 * (s - sLow),
    windCutoffHz: Math.min(7000, 280 * 2 ** (3 * s)),
    windWidth: 0.25 + 0.65 * sLow,
    gustDepth: 0.12 + 0.6 * turb,
    gustHz: 0.08 + 0.5 * turb,
    rumbleLevel: 0.03 * turb + 0.3 * clamp(severe + 0.4 * storm, 0, 1),
    buffetDepth: 0.2 + 0.7 * turb,
    buffetHz: 2 + 5 * turb,
    engine,
    engineLevel: engine.level * (0.3 + 0.7 * throttle),
    enginePitch: 0.78 + 0.34 * throttle + 0.06 * sLow,
    shimmerLevel: 0.065 * up,
    shimmerPitch: 1 + 0.5 * smoothstep(VERTICAL_THRESHOLD_MS, VERTICAL_TOP_MS, vz),
    sinkLevel: 0.075 * down,
    sinkPitch: 1 - 0.22 * smoothstep(VERTICAL_THRESHOLD_MS, VERTICAL_TOP_MS, -vz),
    jetPadLevel: frame.dominant === 'jetstream' ? 0.22 : 0,
    menuPadLevel: 0,
    worldCutoffHz: OPEN_CUTOFF_HZ * (CLOUD_CUTOFF_HZ / OPEN_CUTOFF_HZ) ** (cloud ** 0.8),
    stallLevel: frame.stalled ? 0.045 : 0,
  }
}

function menuMix(engine: EngineVoice): MixTargets {
  return {
    windLevel: 0.035,
    windCutoffHz: 520,
    windWidth: 0.95,
    gustDepth: 0.45,
    gustHz: 0.06,
    rumbleLevel: 0,
    buffetDepth: 0,
    buffetHz: 2,
    engine,
    engineLevel: 0,
    enginePitch: 1,
    shimmerLevel: 0,
    shimmerPitch: 1,
    sinkLevel: 0,
    sinkPitch: 1,
    jetPadLevel: 0,
    menuPadLevel: 0.16,
    worldCutoffHz: OPEN_CUTOFF_HZ,
    stallLevel: 0,
  }
}

/** Seconds (time constant) each family of parameters takes to settle. Longer = more contemplative. */
export const SMOOTHING = {
  fast: 0.08,
  normal: 0.25,
  slow: 0.9,
  pad: 1.6,
  scene: 1.2,
} as const
