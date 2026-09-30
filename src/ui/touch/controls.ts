// Touch (and pen) flight controls: floating stick on the left, throttle lever and yaw pads on the right.
// Fingers are read on the flight view; the layer only draws. Nothing here ever asks for pointer lock.
import { knobOffset, touchStickAxes, touchStickRadius } from './axis'
import { NO_TOUCH, landingAt, stepTouch, type FingerEvent, type TouchState } from './gesture'
import { createTouchLayer } from './layer'

/** Raw touch command for one frame (the input smooths and mixes it with the other devices). */
export interface TouchSample {
  readonly pitch: number
  readonly roll: number
  readonly yaw: number
  /** Setting of the held throttle lever, null when no finger is on it. */
  readonly throttle: number | null
}

export interface TouchControls {
  sample(invertPitch: boolean): TouchSample
  /** Draw this frame with the final throttle (keys, wheel and gamepad move the lever too). */
  render(throttle: number): void
  /** Flight start with the aircraft's trimmed throttle, or null when a menu takes over (hides, lets go). */
  setFlight(trim: number | null): void
  /** Mouse, keys or gamepad took the controls: the layer steps aside, unless a finger is still down. */
  disengage(): void
  /** Touch is the pilot's current device (survives menus: the next flight shows the controls at once). */
  readonly engaged: boolean
  dispose(): void
}

/** Direct manipulation: the finger or pen is on what it moves. The mouse steers through pointer lock instead. */
export const isDirectPointer = (pointerType: string): boolean => pointerType === 'touch' || pointerType === 'pen'

const INTERACTIVE = 'button, a, input, textarea, select, label, summary, [role="button"]'
const IDLE: TouchSample = { pitch: 0, roll: 0, yaw: 0, throttle: null }

export const createTouchControls = (target: HTMLElement, onEngage: () => void): TouchControls => {
  const layer = createTouchLayer(target)
  target.classList.add('wr-touch-surface')

  let state: TouchState = NO_TOUCH
  let trim: number | null = null
  let engaged = false
  let shown = false
  /** Last drawn setting: a grabbed lever starts from it. */
  let throttle = 0

  const inFlight = (): boolean => trim !== null
  const step = (e: FingerEvent): void => {
    state = stepTouch(state, e)
  }
  const letGo = (): void => step({ type: 'release' })

  const onDown = (e: PointerEvent): void => {
    if (!inFlight() || !isDirectPointer(e.pointerType)) return
    if (e.target !== target && e.target instanceof Element && e.target.closest(INTERACTIVE)) return
    // No compatibility mouse events, no text selection: the finger belongs to the controls.
    e.preventDefault()
    try {
      target.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic or already lifted pointer: moves still reach the view while the finger stays on it.
    }
    if (!engaged) {
      engaged = true
      onEngage()
    }
    const at = { x: e.clientX, y: e.clientY }
    const landing = landingAt(at, { surface: target.getBoundingClientRect(), pads: shown ? layer.pads() : null, trackPx: layer.trackPx(), throttle })
    step({ type: 'down', id: e.pointerId, at, landing })
  }
  const onMove = (e: PointerEvent): void => {
    if (isDirectPointer(e.pointerType)) step({ type: 'move', id: e.pointerId, at: { x: e.clientX, y: e.clientY } })
  }
  const onUp = (e: PointerEvent): void => {
    if (isDirectPointer(e.pointerType)) step({ type: 'up', id: e.pointerId })
  }
  const onHidden = (): void => {
    if (document.hidden) letGo()
  }
  // iOS pinch and long-press menus: in flight, two thumbs are controls, not a zoom.
  const onGesture = (e: Event): void => {
    if (inFlight()) e.preventDefault()
  }
  const onContextMenu = (e: Event): void => {
    if (inFlight() && engaged) e.preventDefault()
  }

  target.addEventListener('pointerdown', onDown)
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('pointercancel', onUp)
  target.addEventListener('lostpointercapture', onUp)
  target.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('blur', letGo)
  document.addEventListener('visibilitychange', onHidden)
  document.addEventListener('gesturestart', onGesture)

  const sample = (invertPitch: boolean): TouchSample => {
    const { stick, throttle: lever, yaw } = state
    if (!stick && !lever && !yaw) return IDLE
    const axes = stick ? touchStickAxes(stick.origin, stick.at, stick.reach, invertPitch) : { pitch: 0, roll: 0 }
    return { pitch: axes.pitch, roll: axes.roll, yaw: yaw?.dir ?? 0, throttle: lever?.throttle ?? null }
  }

  const render = (t: number): void => {
    throttle = t
    shown = inFlight() && engaged
    if (!shown) {
      layer.hide()
      return
    }
    const rect = target.getBoundingClientRect()
    const { stick } = state
    layer.draw({
      visible: true,
      radius: touchStickRadius(rect.width, rect.height),
      stick: stick ? { origin: stick.origin, knob: knobOffset(stick.origin, stick.at, stick.reach, stick.radius), radius: stick.radius } : null,
      throttle: t,
      trim,
      throttleHeld: state.throttle !== null,
      yaw: state.yaw?.dir ?? 0,
    })
  }

  return {
    sample,
    render,
    setFlight(next: number | null): void {
      letGo()
      trim = next
      if (next !== null) throttle = next
    },
    disengage(): void {
      if (!state.stick && !state.throttle && !state.yaw) engaged = false
    },
    get engaged(): boolean {
      return engaged
    },
    dispose(): void {
      target.removeEventListener('pointerdown', onDown)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      target.removeEventListener('lostpointercapture', onUp)
      target.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('blur', letGo)
      document.removeEventListener('visibilitychange', onHidden)
      document.removeEventListener('gesturestart', onGesture)
      target.classList.remove('wr-touch-surface')
      layer.dispose()
    },
  }
}
