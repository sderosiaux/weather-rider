// Procedural soundscape: the sky you hear. No assets; everything is synthesized in Web Audio.
// The AudioContext is only created on the first resume() (a user gesture), so nothing here
// touches Web Audio before the browser allows it, and createAudio() is safe in node / tests.
import type { AudioEngine, AudioFrame, CreateAudio } from '../core/presentation'
import { CUES } from './cues'
import { buildGraph, type AudioGraph } from './graph'

export type { AudioGraph } from './graph'
import { computeMix, LAYER_CLOSE_AFTER_S, layersFor, NEUTRAL_FRAME, SMOOTHING, type AudioScene } from './mix'
import { MENU_CHORDS, menuChordIndex } from './voices'

export interface AudioOptions {
  /** Called once the graph exists; `output` is the last node before the destination (for analysers). */
  readonly onGraph?: (ctx: AudioContext, output: AudioNode, graph: AudioGraph) => void
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
  let closeTimer: ReturnType<typeof setTimeout> | null = null
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

  /** Connect the scene's layers now (they fade in), disconnect the others once they have faded out. */
  const gateLayers = (immediate: boolean): void => {
    if (!graph) return
    const g = graph
    const active = layersFor(scene)
    g.openLayers(active)
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
    if (immediate) g.closeLayersExcept(active)
    else closeTimer = setTimeout(() => g.closeLayersExcept(active), LAYER_CLOSE_AFTER_S * 1000)
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
        // Every level starts at 0, so the inactive scene's layers can be cut right away.
        gateLayers(true)
        startTransition()
        apply()
        tickMenuChord()
        chordTimer = setInterval(tickMenuChord, 1000)
        options.onGraph?.(ctx, graph.output, graph)
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    },

    update(next, dtReal) {
      frame = next
      sinceApply += Number.isFinite(dtReal) ? dtReal : 0
      if (sinceApply >= 1 / APPLY_HZ) apply()
    },

    cue(kind) {
      // A context created in this very gesture may still be 'suspended' for a few ms; the cue is
      // scheduled on its clock and simply starts when rendering does.
      graph?.playCue(CUES[kind])
    },

    setScene(next) {
      if (next === scene) return
      scene = next
      gateLayers(false)
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
      if (closeTimer) clearTimeout(closeTimer)
      ctx?.close().catch(() => {})
      ctx = null
      graph = null
    },
  }
}

export const createAudio: CreateAudio = () => createAudioWith()
