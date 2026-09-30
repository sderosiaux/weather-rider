import type { CreateHud, Hud } from '../core/presentation'
import type { HudModel, WeatherFeatureKind } from '../core/types'
import { createWriter, h, svg } from './dom'
import { featureLabel, flightTime, ghostDelta, groupThousands, turbulenceLevel, wrapDeg } from './format'
import { initialCoach, newFlight, stepCoach, type CoachState } from './coach/coach'
import { loadMemory, saveMemory } from './coach/store'
import './hud.css'

/** Share of a full circle drawn by the cabin arcs (270° sweep). */
const ARC_SWEEP = 75
/** Riding a jet: ground speed beats true airspeed by this factor (tailwind). */
const JET_TAILWIND_RATIO = 1.12
const KT_TO_KMH = 1.852
const VS_FULL_SCALE_FPM = 3000

const arc = (r: number, cls: string): SVGCircleElement =>
  svg('circle', { class: cls, cx: 50, cy: 50, r, pathLength: 100, 'stroke-dasharray': `${ARC_SWEEP} 100` })

export const createHud: CreateHud = (root: HTMLElement): Hud => {
  const w = createWriter()

  // ── Top strip: day, route, time, ghost
  const daily = h('span', 'wr-hud__daily')
  const time = h('span', 'wr-hud__time')
  const ghostVal = h('span', 'wr-hud__ghost-val')
  const ghostWord = h('span', 'wr-hud__ghost-word')
  const ghost = h('span', 'wr-hud__ghost', h('span', 'wr-hud__ghost-glyph', '✈'), ghostVal, ghostWord)
  const top = h('div', 'wr-hud__panel wr-hud__top', daily, h('div', 'wr-hud__top-row', time, ghost))

  // ── Speed (left)
  const ias = h('span', 'wr-hud__big')
  const gs = h('span', 'wr-hud__gs-val')
  const gsLabel = h('span', 'wr-hud__label')
  const gsBlock = h('div', 'wr-hud__gs', gs, h('span', 'wr-hud__unit', 'km/h'), gsLabel)
  const speed = h(
    'div',
    'wr-hud__panel wr-hud__speed',
    h('div', 'wr-hud__readout', ias, h('span', 'wr-hud__unit', 'kt')),
    h('span', 'wr-hud__label', 'airspeed'),
    gsBlock,
  )

  // ── Altitude (right)
  const alt = h('span', 'wr-hud__big')
  const vsVal = h('span', 'wr-hud__vs-val')
  const vsNeedle = h('span', 'wr-hud__vs-needle')
  const altitude = h(
    'div',
    'wr-hud__panel wr-hud__alt',
    h('span', 'wr-hud__vs-scale', vsNeedle),
    h(
      'div',
      'wr-hud__alt-body',
      h('div', 'wr-hud__readout', alt, h('span', 'wr-hud__unit', 'ft')),
      h('span', 'wr-hud__label', 'altitude'),
      h('div', 'wr-hud__vs', vsVal, h('span', 'wr-hud__unit', 'ft/min')),
    ),
  )

  // ── Engine (bottom left)
  const thrFill = h('span', 'wr-hud__bar-fill')
  const thrVal = h('span', 'wr-hud__small-val')
  const fuelFill = h('span', 'wr-hud__bar-fill')
  const fuelVal = h('span', 'wr-hud__small-val')
  const fuelRow = h(
    'div',
    'wr-hud__meter',
    h('span', 'wr-hud__label', 'fuel'),
    h('span', 'wr-hud__bar', fuelFill),
    fuelVal,
  )
  const engine = h(
    'div',
    'wr-hud__panel wr-hud__engine',
    h('div', 'wr-hud__meter', h('span', 'wr-hud__label', 'throttle'), h('span', 'wr-hud__bar', thrFill), thrVal),
    fuelRow,
  )

  // ── Cabin (bottom right): comfort outer arc, stress inner arc, g in the middle
  const comfortArc = arc(44, 'wr-hud__arc-val wr-hud__arc-comfort')
  const stressArc = arc(36, 'wr-hud__arc-val wr-hud__arc-stress')
  const gVal = h('span', 'wr-hud__g-val')
  const comfortVal = h('span', 'wr-hud__small-val')
  const stressVal = h('span', 'wr-hud__small-val')
  const comfortRow = h('div', 'wr-hud__legend-row wr-hud__legend-comfort', h('i'), h('span', 'wr-hud__label', 'comfort'), comfortVal)
  const stressRow = h('div', 'wr-hud__legend-row wr-hud__legend-stress', h('i'), h('span', 'wr-hud__label', 'stress'), stressVal)
  const gauge = h(
    'div',
    'wr-hud__gauge',
    svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, arc(44, 'wr-hud__arc-track'), arc(36, 'wr-hud__arc-track'), comfortArc, stressArc),
    h('div', 'wr-hud__g', gVal, h('span', 'wr-hud__unit', 'g')),
  )
  const cabin = h('div', 'wr-hud__panel wr-hud__cabin', gauge, h('div', 'wr-hud__legend', comfortRow, stressRow))

  // ── Gate (bottom center)
  const gateArrow = svg('svg', { class: 'wr-hud__gate-arrow', viewBox: '-20 -20 40 40' }, svg('path', { d: 'M0,-16 L6,-3 L1.6,-4.5 L1.6,13 L-1.6,13 L-1.6,-4.5 L-6,-3 Z' }))
  const gateDist = h('span', 'wr-hud__gate-dist')
  const gateAlt = h('span', 'wr-hud__gate-alt')
  const heading = h('span', 'wr-hud__heading')
  const gate = h(
    'div',
    'wr-hud__panel wr-hud__gate',
    h('span', 'wr-hud__gate-dial', gateArrow),
    h('div', 'wr-hud__gate-body', h('div', 'wr-hud__readout', gateDist, h('span', 'wr-hud__unit', 'km to gate')), gateAlt),
    heading,
  )

  // ── Air (top right): turbulence
  const turbBars = [0, 1, 2, 3].map(() => h('i'))
  const turbWord = h('span', 'wr-hud__turb-word')
  const air = h('div', 'wr-hud__panel wr-hud__air', h('span', 'wr-hud__label', 'air'), h('span', 'wr-hud__turb-bars', turbBars), turbWord)

  // ── Center: stall + weather whisper
  const stall = h('div', 'wr-hud__stall', 'STALL', h('small', {}, 'lower the nose, add power'))
  const whisper = h('div', 'wr-hud__whisper')
  const coachLine = h('div', { class: 'wr-hud__coach', role: 'status', 'aria-live': 'polite' })
  // Shown by CSS from <html data-wr-stick="disarmed"> (published by the input module).
  const takeControls = h('div', 'wr-hud__take', h('b', {}, 'Click to take the controls'), h('span', {}, 'or fly with W A S D'))

  const el = h('div', { class: 'wr-hud', 'aria-hidden': 'true' }, top, air, speed, altitude, coachLine, stall, whisper, takeControls, engine, gate, cabin)
  root.appendChild(el)

  let lastDominant: WeatherFeatureKind | null | undefined

  // Coaching reads the same model stream. On/off comes from Settings via setCoaching; lessons from local memory.
  let coachEnabled = true
  const fromMemory = (): CoachState => {
    const mem = loadMemory()
    return initialCoach(coachEnabled, mem.retired, mem.jetRideS)
  }
  let coach = fromMemory()
  const persistCoach = (): void => saveMemory({ ...loadMemory(), retired: coach.retired, jetRideS: coach.jetRideS })
  const runCoach = (m: HudModel): void => {
    const r = stepCoach(coach, m, performance.now() / 1000)
    coach = r.state
    for (const e of r.events) {
      if (e.type === 'show') {
        w.text(coachLine, e.text)
        w.flag(coachLine, 'is-on', true)
      } else if (e.type === 'hide') {
        w.flag(coachLine, 'is-on', false)
      } else {
        persistCoach()
      }
    }
  }

  const update = (m: HudModel): void => {
    w.text(daily, `WORLD WEATHER #${m.dailyNumber} · ${m.routeLabel}`)
    w.text(time, flightTime(m.displayTimeS))

    if (m.ghostDeltaS === null) {
      w.flag(ghost, 'is-off', true)
    } else {
      const d = ghostDelta(m.ghostDeltaS)
      w.flag(ghost, 'is-off', false)
      w.text(ghostVal, d.text)
      w.text(ghostWord, d.state === 'level' ? 'level' : d.state)
      w.flag(ghost, 'is-ahead', d.state === 'ahead')
      w.flag(ghost, 'is-behind', d.state === 'behind')
    }

    // Speed: ground speed takes the stage when the jet stream is pushing you.
    w.text(ias, Math.round(m.airspeedKt).toString())
    w.text(gs, groupThousands(m.groundSpeedKmh))
    const onJet = m.dominant === 'jetstream' && m.groundSpeedKmh > m.airspeedKt * KT_TO_KMH * JET_TAILWIND_RATIO
    w.flag(speed, 'is-jet', onJet)
    w.text(gsLabel, onJet ? 'riding the jet stream' : 'ground speed')

    w.text(alt, groupThousands(Math.round(m.altitudeFt / 10) * 10))
    const vs = Math.round(m.verticalSpeedFpm / 50) * 50
    w.text(vsVal, vs === 0 ? '0' : `${vs > 0 ? '↑' : '↓'} ${groupThousands(Math.abs(vs))}`)
    const vsFrac = Math.max(-1, Math.min(1, m.verticalSpeedFpm / VS_FULL_SCALE_FPM))
    w.style(vsNeedle, 'transform', `translateY(${(-vsFrac * 50).toFixed(1)}%)`)
    w.flag(altitude, 'is-climbing', vs >= 500)
    w.flag(altitude, 'is-sinking', vs <= -1500)

    const thr = Math.round(m.throttle * 100)
    w.text(thrVal, `${thr}%`)
    w.style(thrFill, 'transform', `scaleX(${(thr / 100).toFixed(2)})`)
    const fuel = Math.max(0, Math.round(m.fuelPct))
    w.text(fuelVal, `${fuel}%`)
    w.style(fuelFill, 'transform', `scaleX(${(fuel / 100).toFixed(2)})`)
    w.flag(fuelRow, 'is-caution', fuel < 20 && fuel >= 8)
    w.flag(fuelRow, 'is-danger', fuel < 8)

    const comfort = Math.max(0, Math.min(100, Math.round(m.comfort)))
    const stress = Math.max(0, Math.min(100, Math.round(m.stress)))
    w.text(comfortVal, comfort.toString())
    w.text(stressVal, stress.toString())
    w.attr(comfortArc, 'stroke-dasharray', `${((comfort / 100) * ARC_SWEEP).toFixed(1)} 100`)
    w.attr(stressArc, 'stroke-dasharray', `${((stress / 100) * ARC_SWEEP).toFixed(1)} 100`)
    const comfortState = comfort < 35 ? 'danger' : comfort < 65 ? 'caution' : 'ok'
    const stressState = stress >= 80 ? 'danger' : stress >= 50 ? 'caution' : 'ok'
    w.flag(cabin, 'comfort-caution', comfortState === 'caution')
    w.flag(cabin, 'comfort-danger', comfortState === 'danger')
    w.flag(cabin, 'stress-caution', stressState === 'caution')
    w.flag(cabin, 'stress-danger', stressState === 'danger')
    w.text(gVal, m.gLoad.toFixed(1))
    const gHard = m.gLoad > 2 || m.gLoad < 0
    w.flag(cabin, 'g-hard', gHard)

    const bearing = Math.round(wrapDeg(m.gateBearingDeg))
    w.style(gateArrow, 'transform', `rotate(${bearing}deg)`)
    w.text(gateDist, groupThousands(m.gateDistanceKm))
    w.text(gateAlt, m.gateAltitudeOk ? 'in the altitude window' : 'outside the altitude window')
    w.flag(gate, 'is-alt-ok', m.gateAltitudeOk)
    w.flag(gate, 'is-off-course', Math.abs(bearing) > 60)
    w.text(heading, `HDG ${Math.round(((m.headingDeg % 360) + 360) % 360).toString().padStart(3, '0')}°`)

    const lvl = turbulenceLevel(m.turbulence)
    const lit = lvl === 'smooth' ? 0 : Math.min(4, Math.max(1, Math.ceil(m.turbulence * 4)))
    turbBars.forEach((b, i) => w.flag(b, 'is-lit', i < lit))
    w.text(turbWord, lvl)
    w.flag(el, 'is-heavy', m.stalled || m.dominant === 'storm' || lvl === 'moderate' || lvl === 'severe')
    w.flag(air, 'is-moderate', lvl === 'moderate')
    w.flag(air, 'is-severe', lvl === 'severe')

    w.flag(stall, 'is-on', m.stalled)
    runCoach(m)

    // Whisper the dominant feature; hold the last word while it fades out.
    if (m.dominant !== lastDominant) {
      lastDominant = m.dominant
      if (m.dominant) w.text(whisper, featureLabel(m.dominant))
      w.flag(whisper, 'is-on', m.dominant !== null)
      w.flag(whisper, 'is-jet', m.dominant === 'jetstream')
    }
  }

  return {
    update,
    setVisible(visible: boolean): void {
      if (visible && el.classList.contains('is-hidden')) {
        const mem = loadMemory()
        coach = newFlight({ ...coach, enabled: coachEnabled, retired: mem.retired, jetRideS: mem.jetRideS })
      }
      if (!visible && !el.classList.contains('is-hidden')) persistCoach()
      if (!visible) w.flag(coachLine, 'is-on', false)
      w.flag(el, 'is-hidden', !visible)
    },
    setCoaching(enabled: boolean): void {
      coachEnabled = enabled
      coach = { ...coach, enabled, showing: enabled ? coach.showing : null }
      if (!enabled) w.flag(coachLine, 'is-on', false)
    },
    dispose(): void {
      el.remove()
    },
  }
}
