import type { Controls, InputSource } from '../../core/types'
import {
  clamp,
  digitalAxis,
  integrateThrottle,
  mixAxis,
  shapeAxis,
  smoothToward,
  stickFromOffset,
  wheelToThrottleDelta,
} from './mapping'
import './input.css'

export interface InputOptions {
  /** Screen-up / W / stick-up = nose down (aviation stick convention). Default false: up = nose up. */
  readonly invertPitch?: boolean
  readonly initialThrottle?: number
  /** Request pointer lock when the target is clicked. Default true. */
  readonly pointerLock?: boolean
}

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
  const invertPitch = options.invertPitch ?? false
  const usePointerLock = options.pointerLock ?? true
  const keys = new Set<string>()

  let throttle = clamp(options.initialThrottle ?? 0.7, 0, 1)
  let pendingWheel = 0
  let last = performance.now()

  // Mouse stick: either absolute offset from target center, or a virtual offset accumulated under pointer lock.
  let mouseActive = false
  let clientX = 0
  let clientY = 0
  let lockedDx = 0
  let lockedDy = 0

  const smoothed = { kPitch: 0, kRoll: 0, kYaw: 0, mPitch: 0, mRoll: 0, pPitch: 0, pRoll: 0, pYaw: 0 }

  const reticle = document.createElement('div')
  reticle.className = 'wr-stick'
  reticle.innerHTML = '<span class="wr-stick__ring"></span><span class="wr-stick__dot"></span>'
  document.body.appendChild(reticle)
  const dot = reticle.querySelector<HTMLElement>('.wr-stick__dot')!

  const isLocked = (): boolean => document.pointerLockElement === target

  const radiusPx = (rect: DOMRect): number => Math.max(40, Math.min(rect.width, rect.height) * MOUSE_RADIUS_FRACTION)

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTyping() || !HANDLED.has(e.code)) return
    if (e.metaKey || e.altKey) return
    keys.add(e.code)
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
    if (isLocked()) {
      const r = radiusPx(target.getBoundingClientRect())
      lockedDx = clamp(lockedDx + e.movementX, -r, r)
      lockedDy = clamp(lockedDy + e.movementY, -r, r)
      mouseActive = true
      return
    }
    clientX = e.clientX
    clientY = e.clientY
    const rect = target.getBoundingClientRect()
    mouseActive = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  }
  const onPointerLockChange = (): void => {
    if (!isLocked()) mouseActive = false
  }
  const onClick = (e: MouseEvent): void => {
    if (!usePointerLock || isLocked()) return
    // Menus may sit inside the target: clicking a control must not grab the pointer.
    if (e.target instanceof Element && e.target.closest('button, a, input, textarea, select, label, summary, [role="button"], .wr-screens')) return
    const rect = target.getBoundingClientRect()
    // Start locked mode where the cursor was, so the aircraft doesn't jump.
    lockedDx = clientX - (rect.left + rect.width / 2)
    lockedDy = clientY - (rect.top + rect.height / 2)
    const req = target.requestPointerLock() as unknown
    if (req instanceof Promise) req.catch(() => undefined)
  }
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
      return { pitch: invertPitch ? -pitchUp : pitchUp, roll, yaw: clamp(yaw, -1, 1), throttleRate }
    }
    return null
  }

  const read = (): Controls => {
    const now = performance.now()
    const dt = clamp((now - last) / 1000, 0, 0.1)
    last = now

    const typing = isTyping()
    if (typing) keys.clear()

    // Keyboard
    const kPitchRaw = digitalAxis(has('KeyS', 'ArrowDown'), has('KeyW', 'ArrowUp')) * (invertPitch ? -1 : 1)
    const kRollRaw = digitalAxis(has('KeyA', 'ArrowLeft'), has('KeyD', 'ArrowRight'))
    const kYawRaw = digitalAxis(has('KeyQ'), has('KeyE'))
    smoothed.kPitch = smoothToward(smoothed.kPitch, kPitchRaw, dt, KEY_TAU)
    smoothed.kRoll = smoothToward(smoothed.kRoll, kRollRaw, dt, KEY_TAU)
    smoothed.kYaw = smoothToward(smoothed.kYaw, kYawRaw, dt, KEY_TAU)
    const kThrottleRate = digitalAxis(has('ControlLeft', 'ControlRight', 'KeyF'), has('ShiftLeft', 'ShiftRight', 'KeyR')) * KEY_THROTTLE_RATE

    // Mouse
    const rect = target.getBoundingClientRect()
    const r = radiusPx(rect)
    const locked = isLocked()
    const dx = locked ? lockedDx : clientX - (rect.left + rect.width / 2)
    const dy = locked ? lockedDy : clientY - (rect.top + rect.height / 2)
    const stick = mouseActive ? stickFromOffset(dx, dy, r, MOUSE_SHAPE, invertPitch) : { pitch: 0, roll: 0 }
    smoothed.mPitch = smoothToward(smoothed.mPitch, stick.pitch, dt, MOUSE_TAU)
    smoothed.mRoll = smoothToward(smoothed.mRoll, stick.roll, dt, MOUSE_TAU)

    // Gamepad
    const pad = readPad()
    smoothed.pPitch = smoothToward(smoothed.pPitch, pad?.pitch ?? 0, dt, PAD_TAU)
    smoothed.pRoll = smoothToward(smoothed.pRoll, pad?.roll ?? 0, dt, PAD_TAU)
    smoothed.pYaw = smoothToward(smoothed.pYaw, pad?.yaw ?? 0, dt, PAD_TAU)

    throttle = integrateThrottle(throttle, kThrottleRate + (pad?.throttleRate ?? 0), dt)
    throttle = clamp(throttle + pendingWheel, 0, 1)
    pendingWheel = 0

    // Stick reticle: only meaningful while the mouse is steering.
    const showReticle = mouseActive && !typing
    reticle.classList.toggle('is-on', showReticle)
    reticle.classList.toggle('is-locked', locked)
    if (showReticle) {
      reticle.style.left = `${rect.left + rect.width / 2}px`
      reticle.style.top = `${rect.top + rect.height / 2}px`
      reticle.style.setProperty('--wr-stick-r', `${r}px`)
      const cdx = clamp(dx, -r, r)
      const cdy = clamp(dy, -r, r)
      dot.style.transform = `translate(${cdx.toFixed(1)}px, ${cdy.toFixed(1)}px)`
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
    if (isLocked()) document.exitPointerLock()
    reticle.remove()
  }

  return { read, dispose }
}
