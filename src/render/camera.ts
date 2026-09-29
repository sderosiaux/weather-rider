// Chase camera: behind and above, smoothed in the aircraft's frame (no speed lag), a fraction of the
// bank, FOV opening with ground speed, a whisper of shake from cabin acceleration.
import * as THREE from 'three'
import { clamp, smoothstep } from '../core/math'
import type { AircraftSpec, AircraftState, Quat } from '../core/types'

/** Frame-rate independent exponential smoothing factor. */
export const smoothing = (rate: number, dt: number): number => 1 - Math.exp(-rate * Math.max(dt, 0))

/** Positive = right wing down. */
export function bankOf(q: Quat): number {
  // -(world y of the body +z axis), expanded to stay allocation-free.
  return Math.asin(clamp(2 * (q.w * q.x - q.y * q.z), -1, 1))
}

export const BASE_FOV = 50
const FOV_WIDEN = 9

export function fovForSpeed(groundSpeed: number, cruiseSpeed: number): number {
  return BASE_FOV + FOV_WIDEN * smoothstep(cruiseSpeed * 0.9, cruiseSpeed * 1.8, groundSpeed)
}

/** Chase distance (m): the airframe stays a small figure in a big sky whatever its size. */
export const chaseDistance = (lengthM: number): number => lengthM * 5.2 + 30

/** Fraction of the aircraft bank the camera follows: enough to feel the turn, not enough to tilt the world. */
const ROLL_FOLLOW = 0.25
/** Horizon tilt cap (rad): a knife-edge pass must not flip the world. */
const ROLL_MAX = 0.2
const SNAP_DISTANCE = 3000

export interface ChaseCamera {
  update(camera: THREE.PerspectiveCamera, state: AircraftState, spec: AircraftSpec | null, time: number, dt: number): void
  reset(): void
}

export function createChaseCamera(): ChaseCamera {
  const offset = new THREE.Vector3()
  const lastPos = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const desired = new THREE.Vector3()
  const target = new THREE.Vector3()
  const fwd = new THREE.Vector3()
  const pos = new THREE.Vector3()
  let roll = 0
  let shake = 0
  let fov = BASE_FOV
  let initialized = false

  return {
    reset() {
      initialized = false
    },
    update(camera, state, spec, time, dt) {
      const length = spec?.lengthM ?? 30
      const cruise = spec?.cruiseSpeedMs ?? 200
      const q = state.orientation
      // Body +x in world frame (first column of the rotation matrix).
      fwd.set(1 - 2 * (q.y * q.y + q.z * q.z), 2 * (q.x * q.y + q.w * q.z), 2 * (q.x * q.z - q.w * q.y))
      const vx = state.vel.x, vy = state.vel.y, vz = state.vel.z
      const speed = Math.hypot(vx, vy, vz)
      // Follow the flight path more than the nose: sideslip and crab don't swing the camera.
      if (speed > 5) dir.set(vx / speed, vy / speed, vz / speed).multiplyScalar(0.7).addScaledVector(fwd, 0.3)
      else dir.copy(fwd)
      dir.y *= 0.5
      dir.normalize()

      const dist = chaseDistance(length)
      const height = dist * 0.1
      desired.copy(dir).multiplyScalar(-dist)
      desired.y += height

      pos.set(state.pos.x, state.pos.y, state.pos.z)
      const snap = !initialized || pos.distanceTo(lastPos) > SNAP_DISTANCE
      lastPos.copy(pos)
      if (snap) {
        offset.copy(desired)
        roll = 0
        fov = fovForSpeed(speed, cruise)
        initialized = true
      } else {
        offset.lerp(desired, smoothing(2.0, dt))
      }

      roll += (clamp(bankOf(state.orientation) * ROLL_FOLLOW, -ROLL_MAX, ROLL_MAX) - roll) * smoothing(2.5, dt)
      shake += (clamp(Math.abs(state.cabinAccel) / 12, 0, 1) - shake) * smoothing(6, dt)
      fov += (fovForSpeed(speed, cruise) - fov) * smoothing(1.2, dt)

      camera.position.copy(pos).add(offset)
      // Aim past the aircraft and above it: the horizon sits low, the aircraft in the lower third, sky dominates.
      target.copy(pos).addScaledVector(dir, dist * 2)
      target.y += dist * 0.6
      camera.up.set(0, 1, 0)
      camera.lookAt(target)
      camera.rotateZ(-roll)
      if (shake > 0.001) {
        // Incommensurate sines: smooth, non-repeating, deterministic.
        const a = shake * 0.0045
        camera.rotateX(a * (Math.sin(time * 13.1) * 0.6 + Math.sin(time * 23.7) * 0.4))
        camera.rotateY(a * (Math.sin(time * 11.3 + 1.7) * 0.6 + Math.sin(time * 19.9) * 0.4))
      }
      if (Math.abs(camera.fov - fov) > 1e-3) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }
    },
  }
}
