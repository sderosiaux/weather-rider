// Allocation-light vector/quaternion helpers for sim code (which must not depend on three).
import type { Quat, Vec3 } from './types'

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
export const ZERO: Vec3 = v3(0, 0, 0)
export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z)
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z)
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s)
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const cross = (a: Vec3, b: Vec3): Vec3 => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
export const length = (a: Vec3): number => Math.sqrt(dot(a, a))
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a)
  return l > 1e-9 ? scale(a, 1 / l) : ZERO
}
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => v3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t))
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

export const Q_IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 }

export const qMul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})

export const qNormalize = (q: Quat): Quat => {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }
}

export const qFromAxisAngle = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2)
  const n = normalize(axis)
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(angle / 2) }
}

/** Rotate vector v by unit quaternion q (body → world). */
export const qRotate = (q: Quat, v: Vec3): Vec3 => {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return v3(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  )
}

export const qConjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })

export const qSlerp = (a: Quat, b: Quat, t: number): Quat => {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  let bb = b
  if (cos < 0) {
    cos = -cos
    bb = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }
  }
  if (cos > 0.9995) {
    return qNormalize({ x: lerp(a.x, bb.x, t), y: lerp(a.y, bb.y, t), z: lerp(a.z, bb.z, t), w: lerp(a.w, bb.w, t) })
  }
  const theta = Math.acos(cos)
  const s = Math.sin(theta)
  const wa = Math.sin((1 - t) * theta) / s
  const wb = Math.sin(t * theta) / s
  return { x: a.x * wa + bb.x * wb, y: a.y * wa + bb.y * wb, z: a.z * wa + bb.z * wb, w: a.w * wa + bb.w * wb }
}

export const BODY_FORWARD: Vec3 = v3(1, 0, 0)
export const BODY_UP: Vec3 = v3(0, 1, 0)
export const BODY_RIGHT: Vec3 = v3(0, 0, 1)
