import type { Controls, InputSource } from '../../core/types'
import {
  clamp,
  digitalAxis,
  flightStartThrottle,
  integrateThrottle,
  mixAxis,
  orientPitch,
  shapeAxis,
  smoothToward,
  stickFromOffset,
  wheelToThrottleDelta,
} from './mapping'
import { DISARMED, MENU_EVENT, stepStick, stickForNewFlight, type StickState } from './stick'
import './input.css'

export interface InputOptions {
  /** Initial value; see setInvertPitch. */
  readonly invertPitch?: boolean
  readonly initialThrottle?: number
}

/**
 * Published on <html data-wr-stick>, read by the HUD (CSS only) to show the "take the controls" hint:
 * - disarmed: mouse stick inactive, nothing else used yet
 * - keys: mouse stick inactive, but the pilot is flying with keyboard/gamepad (hint would be noise)
 * - armed: pointer locked, the mouse steers
 */
export type StickMode = 'disarmed' | 'keys' | 'armed'

const MOUSE_SHAPE = { deadzone: 0.06, expo: 0.45 }
/** Stick full deflection as a fraction of the smaller viewport side. */
const MOUSE_RADIUS_FRACTION = 0.32
const PAD_DEADZONE = 0.12
const PAD_EXPO = 0.35
const KEY_TAU = 0.16
const MOUSE_TAU = 0.05
const PAD_TAU = 0.04
const KEY_THROTTLE_RATE = 0.45
const PAD_THROTTLE_RATE = 0.6
const WHEEL_PER_PX = 0.0008

const isTyping = (): boolean => {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
}

const HANDLED = new Set([
  'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
])

export const createInput = (target: HTMLElement, options: InputOptions = {}): InputSource => {
  let invertPitch = options.invertPitch ?? false
  const keys = new Set<string>()

  let throttle = clamp(options.initialThrottle ?? 0.7, 0, 1)
  let pendingWheel = 0
  let last = performance.now()
  let stick: StickState = DISARMED
  let usedKeysOrPad = false
  let mode: StickMode | null = null

  const smoothed = { kPitch: 0, kRoll: 0, kYaw: 0, mPitch: 0, mRoll: 0, pPitch: 0, pRoll: 0, pYaw: 0 }

  const reticle = document.createElement('div')
  reticle.className = 'wr-stick'
  reticle.innerHTML = '<span class="wr-stick__ring"></span><span class="wr-stick__dot"></span>'
  document.body.appendChild(reticle)
  const dot = reticle.querySelector<HTMLElement>('.wr-stick__dot')!

  const isLocked = (): boolean => document.pointerLockElement === target
  const radiusPx = (rect: DOMRect): number => Math.max(40, Math.min(rect.width, rect.height) * MOUSE_RADIUS_FRACTION)

  const publish = (next: StickMode): void => {
    if (next === mode) return
    mode = next
    document.documentElement.dataset.wrStick = next
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping() || !HANDLED.has(e.code)) return
    if (e.metaKey || e.altKey) return
    keys.add(e.code)
    usedKeysOrPad = true
    e.preventDefault()
  }
  const onKeyUp = (e: KeyboardEvent): void => {
    keys.delete(e.code)
  }
  const clearKeys = (): void => keys.clear()
  const onFocusIn = (): void => {
    if (isTyping()) keys.clear()
  }

  const onMouseMove = (e: MouseEvent): void => {
    if (!isLocked()) return
    stick = stepStick(stick, { type: 'move', mx: e.movementX, my: e.movementY, radius: radiusPx(target.getBoundingClientRect()) })
  }
  const onPointerLockChange = (): void => {
    if (isLocked()) {
      stick = stepStick(stick, { type: 'lock' })
    } else if (stick.armed) {
      stick = stepStick(stick, { type: 'unlock' })
      usedKeysOrPad = false
    }
  }
  const onClick = (e: MouseEvent): void => {
    if (isLocked()) return
    // Menus may sit over the target: clicking a control must not grab the pointer.
    if (e.target instanceof Element && e.target.closest('button, a, input, textarea, select, label, summary, [role="button"], .wr-screens')) return
    const req = target.requestPointerLock() as unknown
    if (req instanceof Promise) req.catch(() => undefined)
  }
  // Drop everything the pilot was holding: stick, keys, smoothing, queued wheel, stale frame time.
  const releaseControls = (nextStick: StickState): void => {
    stick = nextStick
    usedKeysOrPad = false
    keys.clear()
    pendingWheel = 0
    last = performance.now()
    for (const k of Object.keys(smoothed) as (keyof typeof smoothed)[]) smoothed[k] = 0
  }
  // A menu came up (it also releases pointer lock): the next flight starts disarmed at neutral.
  const onMenu = (): void => releaseControls(DISARMED)
  const onWheel = (e: WheelEvent): void => {
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
    pendingWheel += wheelToThrottleDelta(px, WHEEL_PER_PX)
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', clearKeys)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('pointerlockchange', onPointerLockChange)
  target.addEventListener('click', onClick)
  target.addEventListener('wheel', onWheel, { passive: true })
  window.addEventListener(MENU_EVENT, onMenu)

  const has = (...codes: string[]): boolean => codes.some((c) => keys.has(c))

  const readPad = (): { pitch: number; roll: number; yaw: number; throttleRate: number } | null => {
    if (typeof navigator.getGamepads !== 'function') return null
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected) continue
      const ax = (i: number): number => pad.axes[i] ?? 0
      const btn = (i: number): number => pad.buttons[i]?.value ?? 0
      const roll = shapeAxis(ax(0), PAD_DEADZONE, PAD_EXPO)
      const pitchUp = shapeAxis(-ax(1), PAD_DEADZONE, PAD_EXPO)
      const triggers = btn(7) - btn(6)
      const shoulders = btn(5) - btn(4)
      const yaw = Math.abs(triggers) > 0.05 ? triggers : shoulders
      const throttleRate = shapeAxis(-ax(3), PAD_DEADZONE, 0) * PAD_THROTTLE_RATE
      return { pitch: orientPitch(pitchUp, invertPitch), roll, yaw: clamp(yaw, -1, 1), throttleRate }
    }
    return null
  }

  const read = (): Controls => {
    const now = performance.now()
    const dt = clamp((now - last) / 1000, 0, 0.1)
    last = now

    if (isTyping()) keys.clear()

    // Keyboard
    const kPitchRaw = orientPitch(digitalAxis(has('KeyS', 'ArrowDown'), has('KeyW', 'ArrowUp')), invertPitch)
    const kRollRaw = digitalAxis(has('KeyA', 'ArrowLeft'), has('KeyD', 'ArrowRight'))
    const kYawRaw = digitalAxis(has('KeyQ'), has('KeyE'))
    smoothed.kPitch = smoothToward(smoothed.kPitch, kPitchRaw, dt, KEY_TAU)
    smoothed.kRoll = smoothToward(smoothed.kRoll, kRollRaw, dt, KEY_TAU)
    smoothed.kYaw = smoothToward(smoothed.kYaw, kYawRaw, dt, KEY_TAU)
    const kThrottleRate = digitalAxis(has('ControlLeft', 'ControlRight', 'KeyF'), has('ShiftLeft', 'ShiftRight', 'KeyR')) * KEY_THROTTLE_RATE

    // Mouse: armed stick, or the glide back to neutral after release
    stick = stepStick(stick, { type: 'tick', dt })
    const rect = target.getBoundingClientRect()
    const r = radiusPx(rect)
    const m = stickFromOffset(stick.dx, stick.dy, r, MOUSE_SHAPE, invertPitch)
    smoothed.mPitch = smoothToward(smoothed.mPitch, m.pitch, dt, MOUSE_TAU)
    smoothed.mRoll = smoothToward(smoothed.mRoll, m.roll, dt, MOUSE_TAU)

    // Gamepad
    const pad = readPad()
    if (pad && (pad.pitch !== 0 || pad.roll !== 0 || pad.yaw !== 0 || pad.throttleRate !== 0)) usedKeysOrPad = true
    smoothed.pPitch = smoothToward(smoothed.pPitch, pad?.pitch ?? 0, dt, PAD_TAU)
    smoothed.pRoll = smoothToward(smoothed.pRoll, pad?.roll ?? 0, dt, PAD_TAU)
    smoothed.pYaw = smoothToward(smoothed.pYaw, pad?.yaw ?? 0, dt, PAD_TAU)

    throttle = integrateThrottle(throttle, kThrottleRate + (pad?.throttleRate ?? 0), dt)
    throttle = clamp(throttle + pendingWheel, 0, 1)
    pendingWheel = 0

    publish(stick.armed ? 'armed' : usedKeysOrPad ? 'keys' : 'disarmed')
    reticle.classList.toggle('is-on', stick.armed)
    if (stick.armed) {
      reticle.style.left = `${rect.left + rect.width / 2}px`
      reticle.style.top = `${rect.top + rect.height / 2}px`
      reticle.style.setProperty('--wr-stick-r', `${r}px`)
      dot.style.transform = `translate(${stick.dx.toFixed(1)}px, ${stick.dy.toFixed(1)}px)`
    }

    return {
      pitch: mixAxis([smoothed.pPitch, smoothed.kPitch, smoothed.mPitch]),
      roll: mixAxis([smoothed.pRoll, smoothed.kRoll, smoothed.mRoll]),
      yaw: mixAxis([smoothed.pYaw, smoothed.kYaw]),
      throttle,
    }
  }

  const dispose = (): void => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', clearKeys)
    document.removeEventListener('focusin', onFocusIn)
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('pointerlockchange', onPointerLockChange)
    target.removeEventListener('click', onClick)
    target.removeEventListener('wheel', onWheel)
    window.removeEventListener(MENU_EVENT, onMenu)
    if (isLocked()) document.exitPointerLock()
    delete document.documentElement.dataset.wrStick
    reticle.remove()
  }

  // Applies to mouse, keys and gamepad from the next read(); the smoothed axes carry over so nothing jumps.
  const setInvertPitch = (invert: boolean): void => {
    invertPitch = invert
  }

  // Shell calls this right after creating a flight: neutral stick and the aircraft's trimmed throttle,
  // so hands-off flight is level instead of pitching on a mismatched power setting.
  const resetForFlight = (trim: number): void => {
    releaseControls(stickForNewFlight(isLocked()))
    throttle = flightStartThrottle(trim, throttle)
  }

  return { read, setInvertPitch, resetForFlight, dispose }
}
