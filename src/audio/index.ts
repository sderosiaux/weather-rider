// Procedural soundscape: the sky you hear. No assets; everything is synthesized in Web Audio.
// The AudioContext is only created on the first resume() (a user gesture), so nothing here
// touches Web Audio before the browser allows it, and createAudio() is safe in node / tests.
import type { AudioEngine, AudioFrame, CreateAudio } from '../core/presentation'
import { CUES } from './cues'
import { buildGraph, type AudioGraph } from './graph'
import { computeMix, NEUTRAL_FRAME, SMOOTHING, type AudioScene } from './mix'
import { MENU_CHORDS, menuChordIndex } from './voices'

export interface AudioOptions {
  /** Called once the graph exists; `output` is the last node before the destination (for analysers). */
  readonly onGraph?: (ctx: AudioContext, output: AudioNode) => void
}

/** Parameter pushes per second; the graph smooths between them. */
const APPLY_HZ = 30
const DEFAULT_VOLUME = 0.8

export function createAudioWith(options: AudioOptions = {}): AudioEngine {
  let ctx: AudioContext | null = null
  let graph: AudioGraph | null = null
  let disposed = false
  let scene: AudioScene = 'menu'
  let frame: AudioFrame = NEUTRAL_FRAME
  let volume = DEFAULT_VOLUME
  let sinceApply = Infinity
  let chord = -1
  let chordTimer: ReturnType<typeof setInterval> | null = null
  /** Context time until which levels keep the slow scene-change glide. */
  let transitionUntil = 0

  const apply = (): void => {
    if (!graph || !ctx) return
    graph.apply(computeMix(frame, scene), ctx.currentTime < transitionUntil)
    sinceApply = 0
  }
  const startTransition = (): void => {
    if (ctx) transitionUntil = ctx.currentTime + 3 * SMOOTHING.scene
  }

  const tickMenuChord = (): void => {
    if (!ctx || !graph) return
    const i = menuChordIndex(ctx.currentTime)
    if (i === chord) return
    chord = i
    graph.setMenuChord(MENU_CHORDS[i]!)
  }

  return {
    resume() {
      if (disposed) return
      if (!ctx) {
        const Ctor = globalThis.AudioContext
        if (!Ctor) return
        ctx = new Ctor({ latencyHint: 'balanced' })
        graph = buildGraph(ctx)
        graph.setVolume(volume)
        startTransition()
        apply()
        tickMenuChord()
        chordTimer = setInterval(tickMenuChord, 1000)
        options.onGraph?.(ctx, graph.output)
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    },

    update(next, dtReal) {
      frame = next
      sinceApply += Number.isFinite(dtReal) ? dtReal : 0
      if (sinceApply >= 1 / APPLY_HZ) apply()
    },

    cue(kind) {
      if (graph && ctx?.state === 'running') graph.playCue(CUES[kind])
    },

    setScene(next) {
      if (next === scene) return
      scene = next
      startTransition()
      apply()
    },

    setVolume(v) {
      volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : volume
      graph?.setVolume(volume)
    },

    dispose() {
      if (disposed) return
      disposed = true
      if (chordTimer) clearInterval(chordTimer)
      ctx?.close().catch(() => {})
      ctx = null
      graph = null
    },
  }
}

export const createAudio: CreateAudio = () => createAudioWith()
