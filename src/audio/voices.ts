// Static timbre data: what each aircraft sounds like, which chords the pads play.
import type { AircraftClass } from '../core/types'

/** Per-class engine timbre. Levels are relative to the engine bus, which is mixed low on purpose. */
export interface EngineVoice {
  /** Overall engine loudness at full throttle (linear gain). */
  readonly level: number
  /** Fundamental of the drone (Hz) at mid throttle. */
  readonly baseHz: number
  /** Lowpass on the drone: low = soft hum, high = buzzier. */
  readonly droneCutoffHz: number
  readonly droneLevel: number
  /** Soft turbine whine (sine). */
  readonly whineHz: number
  readonly whineLevel: number
  /** Band-passed noise roar (afterburner-ish). */
  readonly roarHz: number
  readonly roarLevel: number
  /** Propeller blade-pass amplitude modulation (Hz / depth 0..1). */
  readonly thrumHz: number
  readonly thrumDepth: number
}

export const ENGINE_VOICES: Readonly<Record<AircraftClass, EngineVoice>> = {
  turboprop: { level: 0.075, baseHz: 72, droneCutoffHz: 420, droneLevel: 1, whineHz: 1450, whineLevel: 0.05, roarHz: 260, roarLevel: 0.15, thrumHz: 17, thrumDepth: 0.55 },
  regional: { level: 0.065, baseHz: 92, droneCutoffHz: 520, droneLevel: 0.7, whineHz: 2300, whineLevel: 0.16, roarHz: 380, roarLevel: 0.35, thrumHz: 0, thrumDepth: 0 },
  narrowbody: { level: 0.065, baseHz: 84, droneCutoffHz: 480, droneLevel: 0.7, whineHz: 2050, whineLevel: 0.14, roarHz: 330, roarLevel: 0.4, thrumHz: 0, thrumDepth: 0 },
  widebody: { level: 0.07, baseHz: 64, droneCutoffHz: 380, droneLevel: 0.8, whineHz: 1650, whineLevel: 0.1, roarHz: 260, roarLevel: 0.45, thrumHz: 0, thrumDepth: 0 },
  cargo: { level: 0.075, baseHz: 58, droneCutoffHz: 340, droneLevel: 0.9, whineHz: 1500, whineLevel: 0.08, roarHz: 220, roarLevel: 0.5, thrumHz: 0, thrumDepth: 0 },
  supersonic: { level: 0.085, baseHz: 50, droneCutoffHz: 300, droneLevel: 0.6, whineHz: 2600, whineLevel: 0.07, roarHz: 180, roarLevel: 1, thrumHz: 0, thrumDepth: 0 },
  experimental: { level: 0.03, baseHz: 110, droneCutoffHz: 260, droneLevel: 0.25, whineHz: 740, whineLevel: 0.35, roarHz: 400, roarLevel: 0, thrumHz: 0, thrumDepth: 0 },
}

export const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12)

/** Menu bed: slow lydian-leaning progression, one chord per MENU_CHORD_S, voices glide between them. */
export const MENU_CHORDS: readonly (readonly number[])[] = [
  [50, 57, 64, 66], // D  A  E  F#  — Dadd9
  [47, 54, 62, 64], // B  F# D  E   — Bm11
  [43, 50, 57, 61], // G  D  A  C#  — Gmaj7#11 colour
  [45, 52, 59, 61], // A  E  B  C#  — Aadd9
]
export const MENU_CHORD_S = 11

export function menuChordIndex(t: number): number {
  const i = Math.floor(Math.max(0, t) / MENU_CHORD_S) % MENU_CHORDS.length
  return Number.isFinite(i) ? i : 0
}

/** Jet stream pad: open, airy voicing (E: root, fifth, ninth, third, major seventh). */
export const JET_CHORD: readonly number[] = [52, 59, 66, 68, 75]

/** Rising-air shimmer partials, as ratios of SHIMMER_BASE_HZ (octaves and fifths only: always consonant). */
export const SHIMMER_BASE_HZ = 587.33
export const SHIMMER_RATIOS: readonly number[] = [1, 1.5, 2, 3]

/** Sinking air: two low tones (ratios of SINK_BASE_HZ), a fifth apart. */
export const SINK_BASE_HZ = 61.7
export const SINK_RATIOS: readonly number[] = [1, 1.498]
