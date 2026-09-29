// One-shot cues as scores: plain data, played by the graph with fresh (short-lived) nodes.
import type { AudioEngine } from '../core/presentation'
import { midiToHz } from './voices'

export type CueKind = Parameters<AudioEngine['cue']>[0]

export interface CueNote {
  readonly hz: number
  /** Offset from cue start (s). */
  readonly at: number
  /** Time to peak (s). */
  readonly attack: number
  /** Exponential release time constant (s), starting at `at + attack + hold`. */
  readonly release: number
  readonly hold: number
  readonly gain: number
  readonly wave: OscillatorType
  /** -1..1 */
  readonly pan: number
  /** Glide target (Hz) reached over the note, for sighs / swells. */
  readonly glideTo?: number
}

export interface CueNoise {
  readonly at: number
  readonly gain: number
  readonly fromHz: number
  readonly toHz: number
  readonly duration: number
}

export interface CueScore {
  readonly notes: readonly CueNote[]
  readonly noise?: CueNoise
  /** 0..1 share sent to the reverb. */
  readonly reverb: number
}

const note = (midi: number, at: number, gain: number, opts: Partial<CueNote> = {}): CueNote => ({
  hz: midiToHz(midi),
  at,
  attack: 0.04,
  hold: 0.1,
  release: 0.9,
  gain,
  wave: 'sine',
  pan: 0,
  ...opts,
})

const sparkle = (base: number, gain: number): CueNote[] =>
  [0, 4, 7, 12, 16, 19].map((step, i) =>
    note(base + step, i * 0.07, gain * (1 - i * 0.08), { attack: 0.005, hold: 0.02, release: 0.45, wave: 'sine', pan: -0.5 + i * 0.2 }),
  )

export const CUES: Readonly<Record<CueKind, CueScore>> = {
  // Suspended fourth resolving to the major chord: a warm landing.
  arrived: {
    reverb: 0.5,
    notes: [
      ...[50, 57, 62, 67].map((m, i) => note(m, 0, 0.05, { attack: 0.25, hold: 0.6, release: 0.35, wave: 'triangle', pan: -0.3 + i * 0.2 })),
      ...[50, 57, 62, 66, 69].map((m, i) => note(m, 1.0, 0.05, { attack: 0.35, hold: 1.2, release: 1.6, wave: 'triangle', pan: -0.4 + i * 0.2 })),
      note(74, 1.1, 0.025, { attack: 0.5, hold: 0.8, release: 1.8 }),
    ],
  },
  // Soft descending sigh with a muted thump; no alarm.
  crashed: {
    reverb: 0.35,
    notes: [
      note(45, 0, 0.07, { attack: 0.03, hold: 0.25, release: 1.2, wave: 'triangle', glideTo: midiToHz(38) }),
      note(52, 0.05, 0.035, { attack: 0.06, hold: 0.2, release: 1.0, glideTo: midiToHz(45), pan: 0.2 }),
    ],
    noise: { at: 0, gain: 0.12, fromHz: 900, toHz: 120, duration: 1.4 },
  },
  // Airframe complaint: a low creak-ish minor second that fades, gentler than crashed.
  overstressed: {
    reverb: 0.25,
    notes: [
      note(40, 0, 0.05, { attack: 0.08, hold: 0.3, release: 0.8, wave: 'triangle', pan: -0.2 }),
      note(41, 0.02, 0.035, { attack: 0.1, hold: 0.25, release: 0.8, wave: 'triangle', pan: 0.2, glideTo: midiToHz(40) }),
    ],
    noise: { at: 0, gain: 0.05, fromHz: 400, toHz: 150, duration: 0.8 },
  },
  unlock: { reverb: 0.6, notes: sparkle(79, 0.03) },
  record: {
    reverb: 0.6,
    notes: [...sparkle(84, 0.028), note(72, 0, 0.03, { attack: 0.02, hold: 0.3, release: 1.2, wave: 'triangle' })],
  },
}

/** Seconds until the last note has decayed by ~60 dB (5 time constants). */
export function cueDuration(score: CueScore): number {
  const noteEnd = score.notes.reduce((m, n) => Math.max(m, n.at + n.attack + n.hold + 5 * n.release), 0)
  const noiseEnd = score.noise ? score.noise.at + score.noise.duration : 0
  return Math.max(noteEnd, noiseEnd)
}
