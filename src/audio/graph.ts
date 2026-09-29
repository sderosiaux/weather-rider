// The Web Audio node graph. Built once per AudioContext; afterwards only AudioParams move
// (always via setTargetAtTime), except cues, which spawn a few short-lived nodes each.
//
//   wind, rumble, engine,
//   shimmer, sink, pads ──► world (cloud lowpass) ──► master ─► compressor ─► out
//   stall, cues, reverb return ──────────────────────┘
//   (shimmer, pads and cues also send to the convolver)
import { impulseResponse, pinkNoise } from './buffers'
import type { CueScore } from './cues'
import { cueDuration } from './cues'
import type { MixTargets } from './mix'
import { SMOOTHING } from './mix'
import { JET_CHORD, MENU_CHORDS, midiToHz, SHIMMER_BASE_HZ, SHIMMER_RATIOS, SINK_BASE_HZ, SINK_RATIOS } from './voices'

export interface AudioGraph {
  /** Final node before the destination (tap point for analysers). */
  readonly output: AudioNode
  /** `transition` = scene change: every level glides slowly instead of following the frame. */
  apply(mix: MixTargets, transition: boolean): void
  setMenuChord(midi: readonly number[]): void
  playCue(score: CueScore): void
  setVolume(volume: number): void
}

type Smooth = (value: number, tau: number) => void

const MASTER_HEADROOM = 1.3
const REVERB_RETURN = 0.3

export function buildGraph(ctx: AudioContext): AudioGraph {
  const sr = ctx.sampleRate

  /** Wraps an AudioParam: skips redundant targets so per-frame updates don't pile up automation events. */
  const smooth = (param: AudioParam, initial: number): Smooth => {
    param.value = initial
    let last = initial
    return (value, tau) => {
      if (Math.abs(value - last) <= Math.max(1e-5, Math.abs(value) * 2e-3)) return
      last = value
      param.setTargetAtTime(value, ctx.currentTime, tau)
    }
  }
  const gain = (value = 1): GainNode => {
    const g = ctx.createGain()
    g.gain.value = value
    return g
  }
  const filter = (type: BiquadFilterType, hz: number, q = 0.707): BiquadFilterNode => {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = hz
    f.Q.value = q
    return f
  }
  const osc = (type: OscillatorType, hz: number, detuneCents = 0): OscillatorNode => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.value = hz
    o.detune.value = detuneCents
    o.start()
    return o
  }
  const makeBuffer = (channels: readonly Float32Array[]): AudioBuffer => {
    const b = ctx.createBuffer(channels.length, channels[0]!.length, sr)
    channels.forEach((data, i) => b.copyToChannel(data as Float32Array<ArrayBuffer>, i))
    return b
  }
  const loop = (buffer: AudioBuffer, rate = 1, offset = 0): AudioBufferSourceNode => {
    const s = ctx.createBufferSource()
    s.buffer = buffer
    s.loop = true
    s.playbackRate.value = rate
    s.start(0, offset)
    return s
  }
  /** Gain whose level is `base` ± `depth`, modulated by an LFO (audio-rate, so no zipper). */
  const modulated = (lfos: readonly OscillatorNode[], base: number, depth: number) => {
    const node = gain(0)
    const depthNode = gain(0)
    for (const l of lfos) l.connect(depthNode)
    depthNode.connect(node.gain)
    return { node, base: smooth(node.gain, base), depth: smooth(depthNode.gain, depth) }
  }

  // ─── buses ────────────────────────────────────────────────────────────────
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = -16
  compressor.knee.value = 12
  compressor.ratio.value = 3
  compressor.attack.value = 0.01
  compressor.release.value = 0.35
  compressor.connect(ctx.destination)

  const master = gain(0)
  const volume = smooth(master.gain, 0)
  master.connect(compressor)

  const world = filter('lowpass', 16_000, 0.5)
  const worldCutoff = smooth(world.frequency, 16_000)
  world.connect(master)

  const convolver = ctx.createConvolver()
  const irLen = Math.floor(sr * 3.8)
  convolver.buffer = makeBuffer([impulseResponse(irLen, sr, 3.6, 11), impulseResponse(irLen, sr, 3.6, 12)])
  const reverb = gain(REVERB_RETURN)
  convolver.connect(reverb)
  reverb.connect(master)
  const sendToReverb = (node: AudioNode, amount: number): void => {
    const s = gain(amount)
    node.connect(s)
    s.connect(convolver)
  }

  // ─── noise sources (looped, running forever; different lengths never line up) ─
  const stereoNoise = makeBuffer([pinkNoise(sr * 6, 1), pinkNoise(sr * 6, 2)])
  const monoNoise = makeBuffer([pinkNoise(sr * 5 + 331, 3)])

  // ─── wind bed ─────────────────────────────────────────────────────────────
  const windStereo = gain(0)
  const windMono = gain(0)
  loop(stereoNoise).connect(windStereo)
  loop(monoNoise, 1, 1.3).connect(windMono)
  const windHp = filter('highpass', 70)
  const windLp = filter('lowpass', 600, 0.4)
  const windBody = filter('peaking', 400, 0.8)
  windBody.gain.value = 3
  windStereo.connect(windHp)
  windMono.connect(windHp)
  windHp.connect(windLp).connect(windBody)
  const gustLfos = [osc('sine', 0.1), osc('sine', 0.1 * 1.618)]
  const wind = modulated(gustLfos, 0, 0)
  windBody.connect(wind.node).connect(world)
  // Gusts also open the filter a little: louder *and* brighter, like air pressing on the canopy.
  const gustCutoff = gain(0)
  for (const l of gustLfos) l.connect(gustCutoff)
  gustCutoff.connect(windLp.frequency)
  const s = {
    windStereo: smooth(windStereo.gain, 0),
    windMono: smooth(windMono.gain, 0),
    windCutoff: smooth(windLp.frequency, 600),
    windBody: smooth(windBody.frequency, 400),
    gustCutoff: smooth(gustCutoff.gain, 0),
    gustHz: gustLfos.map((l) => smooth(l.frequency, l.frequency.value)),
  }

  // ─── rumble + buffet ──────────────────────────────────────────────────────
  const buffetLfos = [osc('sine', 2), osc('sine', 2 * 1.37)]
  const rumble = modulated(buffetLfos, 0, 0)
  loop(monoNoise, 0.5, 2.1).connect(filter('lowpass', 150, 0.9)).connect(rumble.node).connect(world)
  const buffetHz = buffetLfos.map((l) => smooth(l.frequency, l.frequency.value))

  // ─── engine ───────────────────────────────────────────────────────────────
  const engineAmp = gain(0)
  const engineLevel = smooth(engineAmp.gain, 0)
  engineAmp.connect(world)
  const droneA = osc('sawtooth', 80)
  const droneB = osc('triangle', 40, 4)
  const droneLp = filter('lowpass', 400, 0.6)
  const droneLevel = gain(0)
  droneA.connect(droneLp)
  droneB.connect(droneLp)
  const thrumLfo = osc('sine', 15)
  const thrum = modulated([thrumLfo], 1, 0)
  droneLp.connect(droneLevel).connect(thrum.node).connect(engineAmp)
  const whine = osc('sine', 2000)
  const whineLevel = gain(0)
  whine.connect(whineLevel).connect(engineAmp)
  const roarBp = filter('bandpass', 300, 0.8)
  const roarLevel = gain(0)
  loop(monoNoise, 1, 3.7).connect(roarBp).connect(roarLevel).connect(engineAmp)
  const e = {
    droneA: smooth(droneA.frequency, 80),
    droneB: smooth(droneB.frequency, 40),
    droneLp: smooth(droneLp.frequency, 400),
    droneLevel: smooth(droneLevel.gain, 0),
    thrumHz: smooth(thrumLfo.frequency, 15),
    whine: smooth(whine.frequency, 2000),
    whineLevel: smooth(whineLevel.gain, 0),
    roarHz: smooth(roarBp.frequency, 300),
    roarLevel: smooth(roarLevel.gain, 0),
  }

  // ─── rising air: consonant shimmer with slow independent tremolos ─────────
  const shimmerAmp = gain(0)
  const shimmerLevel = smooth(shimmerAmp.gain, 0)
  shimmerAmp.connect(world)
  sendToReverb(shimmerAmp, 0.8)
  const shimmerFreqs = SHIMMER_RATIOS.map((ratio, i) => {
    const o = osc('sine', SHIMMER_BASE_HZ * ratio, i % 2 ? 5 : -5)
    const trem = modulated([osc('sine', 0.19 + 0.13 * i)], 0.6 / (1 + i * 0.6), 0.4 / (1 + i * 0.6))
    o.connect(trem.node).connect(shimmerAmp)
    return smooth(o.frequency, SHIMMER_BASE_HZ * ratio)
  })

  // ─── sinking air: dark low fifth + low noise ──────────────────────────────
  const sinkAmp = gain(0)
  const sinkLevel = smooth(sinkAmp.gain, 0)
  const sinkLp = filter('lowpass', 240, 0.7)
  sinkLp.connect(sinkAmp).connect(world)
  const sinkFreqs = SINK_RATIOS.map((ratio, i) => {
    const o = osc(i === 0 ? 'sine' : 'triangle', SINK_BASE_HZ * ratio)
    o.connect(gain(i === 0 ? 1 : 0.5)).connect(sinkLp)
    return smooth(o.frequency, SINK_BASE_HZ * ratio)
  })
  loop(monoNoise, 0.35, 0.7).connect(gain(0.6)).connect(sinkLp)

  // ─── pads: jet stream (moving, aurora-like panning) and menu bed ──────────
  const pad = (midi: readonly number[], cutoff: number, sweepHz: number, sweepDepth: number, movingPan: boolean) => {
    const amp = gain(0)
    const lp = filter('lowpass', cutoff, 0.5)
    const sweep = osc('sine', sweepHz)
    const sweepDepthNode = gain(sweepDepth)
    sweep.connect(sweepDepthNode).connect(lp.frequency)
    lp.connect(amp).connect(world)
    sendToReverb(amp, 0.9)
    const voices = midi.map((m, i) => {
      const panner = ctx.createStereoPanner()
      const spread = midi.length > 1 ? -0.7 + (1.4 * i) / (midi.length - 1) : 0
      panner.pan.value = spread
      if (movingPan) {
        const panLfo = osc('sine', 0.05 + 0.031 * i)
        panLfo.connect(gain(0.25)).connect(panner.pan)
      }
      const v = gain(0.5 / midi.length)
      const pair = [osc('sawtooth', midiToHz(m), -7), osc('sawtooth', midiToHz(m), 7)]
      for (const o of pair) o.connect(v)
      v.connect(panner).connect(lp)
      return pair.map((o) => smooth(o.frequency, midiToHz(m)))
    })
    return { level: smooth(amp.gain, 0), voices }
  }
  const jetPad = pad(JET_CHORD, 1900, 0.07, 900, true)
  const menuPad = pad(MENU_CHORDS[0]!, 850, 0.035, 350, false)

  // ─── stall: soft pulsing two-note tone, not a klaxon ──────────────────────
  const stallTone = filter('lowpass', 1400, 0.7)
  osc('triangle', midiToHz(74)).connect(stallTone)
  osc('sine', midiToHz(81)).connect(gain(0.5)).connect(stallTone)
  const stallAm = modulated([osc('sine', 2.4)], 0.5, 0.5)
  const stallAmp = gain(0)
  const stallLevel = smooth(stallAmp.gain, 0)
  stallTone.connect(stallAm.node).connect(stallAmp).connect(master)

  return {
    output: compressor,

    apply(m, transition) {
      const lvl = transition ? SMOOTHING.scene : SMOOTHING.normal
      const n = SMOOTHING.normal
      worldCutoff(m.worldCutoffHz, SMOOTHING.slow)

      s.windStereo(m.windWidth, n)
      s.windMono(1 - m.windWidth, n)
      s.windCutoff(m.windCutoffHz, n)
      s.windBody(m.windCutoffHz * 0.55, n)
      wind.base(m.windLevel, lvl)
      wind.depth(m.windLevel * m.gustDepth * 0.5, SMOOTHING.slow)
      s.gustCutoff(m.windCutoffHz * m.gustDepth * 0.25, SMOOTHING.slow)
      s.gustHz.forEach((set, i) => set(m.gustHz * (i ? 1.618 : 1), SMOOTHING.slow))

      rumble.base(m.rumbleLevel, lvl)
      rumble.depth(m.rumbleLevel * m.buffetDepth * 0.5, n)
      buffetHz.forEach((set, i) => set(m.buffetHz * (i ? 1.37 : 1), SMOOTHING.slow))

      const v = m.engine
      const p = m.enginePitch
      engineLevel(m.engineLevel, lvl)
      e.droneA(v.baseHz * p, n)
      e.droneB(v.baseHz * 0.5 * p, n)
      e.droneLp(v.droneCutoffHz * (0.7 + 0.5 * p), n)
      e.droneLevel(v.droneLevel, SMOOTHING.slow)
      thrum.base(1 - v.thrumDepth / 2, SMOOTHING.slow)
      thrum.depth(v.thrumDepth / 2, SMOOTHING.slow)
      e.thrumHz(Math.max(0.1, v.thrumHz * p), n)
      e.whine(v.whineHz * p, n)
      e.whineLevel(v.whineLevel, SMOOTHING.slow)
      e.roarHz(v.roarHz * (0.8 + 0.4 * p), n)
      e.roarLevel(v.roarLevel, SMOOTHING.slow)

      shimmerLevel(m.shimmerLevel, transition ? lvl : SMOOTHING.slow)
      shimmerFreqs.forEach((set, i) => set(SHIMMER_BASE_HZ * SHIMMER_RATIOS[i]! * m.shimmerPitch, SMOOTHING.slow))
      sinkLevel(m.sinkLevel, transition ? lvl : SMOOTHING.slow)
      sinkFreqs.forEach((set, i) => set(SINK_BASE_HZ * SINK_RATIOS[i]! * m.sinkPitch, SMOOTHING.slow))

      jetPad.level(m.jetPadLevel, SMOOTHING.pad)
      menuPad.level(m.menuPadLevel, SMOOTHING.pad)
      stallLevel(m.stallLevel, SMOOTHING.fast)
    },

    setMenuChord(midi) {
      menuPad.voices.forEach((pair, i) => {
        const m = midi[i % midi.length]!
        for (const set of pair) set(midiToHz(m), 1.8)
      })
    },

    playCue(score) {
      const t0 = ctx.currentTime + 0.02
      const bus = gain(1)
      bus.connect(master)
      sendToReverb(bus, score.reverb)
      const nodes: AudioNode[] = [bus]
      for (const n of score.notes) {
        const start = t0 + n.at
        const end = start + n.attack + n.hold + 5 * n.release
        const o = ctx.createOscillator()
        o.type = n.wave
        o.frequency.setValueAtTime(n.hz, start)
        if (n.glideTo) o.frequency.exponentialRampToValueAtTime(n.glideTo, start + n.attack + n.hold + 2 * n.release)
        const g = gain(0)
        g.gain.setValueAtTime(0, start)
        g.gain.linearRampToValueAtTime(n.gain, start + n.attack)
        g.gain.setTargetAtTime(0, start + n.attack + n.hold, n.release)
        const pan = ctx.createStereoPanner()
        pan.pan.value = n.pan
        o.connect(g).connect(pan).connect(bus)
        o.start(start)
        o.stop(end)
        nodes.push(o, g, pan)
      }
      if (score.noise) {
        const nz = score.noise
        const start = t0 + nz.at
        const src = ctx.createBufferSource()
        src.buffer = monoNoise
        const lp = filter('lowpass', nz.fromHz, 0.7)
        lp.frequency.setValueAtTime(nz.fromHz, start)
        lp.frequency.exponentialRampToValueAtTime(nz.toHz, start + nz.duration)
        const g = gain(0)
        g.gain.setValueAtTime(0, start)
        g.gain.linearRampToValueAtTime(nz.gain, start + 0.02)
        g.gain.setTargetAtTime(0, start + 0.05, nz.duration / 5)
        src.connect(lp).connect(g).connect(bus)
        src.start(start, Math.random() * 3)
        src.stop(start + nz.duration)
        nodes.push(src, lp, g)
      }
      // Release the one-shot nodes once the cue (and its reverb send) has finished.
      setTimeout(() => nodes.forEach((node) => node.disconnect()), (cueDuration(score) + 0.2) * 1000)
    },

    setVolume(v) {
      volume(Math.max(0, Math.min(1, v)) * MASTER_HEADROOM, 0.08)
    },
  }
}
