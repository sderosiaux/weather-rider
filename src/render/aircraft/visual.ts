// Player aircraft: airframe, spinning props, nav lights, contrails.
import * as THREE from 'three'
import type { AircraftSpec, AircraftState } from '../../core/types'
import type { AtmosphereUniforms } from '../atmosphere'
import { createRibbon, type Ribbon } from '../ribbon'
import { buildAircraft, type AircraftModel } from './models'

const CONTRAIL_CAPACITY = 180
const CONTRAIL_STEP_S = 0.25
/** Contrails form in cold air aloft. */
const CONTRAIL_MIN_ALT = 6500
const CONTRAIL_FULL_ALT = 8500

export interface AircraftVisual {
  readonly group: THREE.Group
  /** Everything world-space (contrails) that must not inherit the aircraft transform. */
  readonly worldObjects: THREE.Object3D
  set(spec: AircraftSpec, livery: string): void
  update(state: AircraftState, time: number, dtReal: number): void
  /** Place the airframe freely (hangar showcase): props and lights animate, no contrails. */
  pose(position: THREE.Vector3, orientation: THREE.Quaternion, time: number, dtReal: number): void
  /** 0..1 fade for airframe swaps; the aircraft pass draws it on top, so blending is safe. */
  setOpacity(opacity: number): void
  readonly model: AircraftModel | null
  setPixelAngle(a: number): void
  dispose(): void
}

interface Trail {
  readonly ribbon: Ribbon
  readonly points: Float32Array
  readonly stamps: Float32Array
  count: number
}

export function createAircraftVisual(atmosphere: AtmosphereUniforms, glow: THREE.Texture): AircraftVisual {
  const group = new THREE.Group()
  const worldObjects = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.15, side: THREE.DoubleSide })
  let mesh: THREE.Mesh | null = null
  let model: AircraftModel | null = null
  const props: THREE.Object3D[] = []
  const disposables: { dispose(): void }[] = []

  const propDiscMat = new THREE.MeshBasicMaterial({ color: 0x20242a, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide })
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.6, flatShading: true })

  const navGeo = new THREE.BufferGeometry()
  const navMat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  const nav = new THREE.Points(navGeo, navMat)
  const strobeGeo = new THREE.BufferGeometry()
  const strobeMat = new THREE.PointsMaterial({ size: 16, sizeAttenuation: false, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  const strobes = new THREE.Points(strobeGeo, strobeMat)
  nav.renderOrder = strobes.renderOrder = 40
  nav.frustumCulled = strobes.frustumCulled = false
  group.add(nav, strobes)

  const trails: Trail[] = [0, 1].map(() => ({
    ribbon: createRibbon(atmosphere, CONTRAIL_CAPACITY + 1, {
      color: new THREE.Color(1, 1, 1), opacity: 0.55, halfWidth: 1.5, growth: 0.45, life: CONTRAIL_CAPACITY * CONTRAIL_STEP_S,
      minPx: 0.6, ink: 1, haze: 1, lit: true, nearFade: 350,
    }),
    points: new Float32Array((CONTRAIL_CAPACITY + 1) * 3),
    stamps: new Float32Array(CONTRAIL_CAPACITY + 1),
    count: 0,
  }))
  for (const t of trails) worldObjects.add(t.ribbon.mesh)
  let lastDrop = -Infinity
  const lastPos = new THREE.Vector3()

  const clearAirframe = (): void => {
    if (mesh) {
      group.remove(mesh)
      mesh.geometry.dispose()
    }
    for (const p of props) group.remove(p)
    props.length = 0
    for (const d of disposables) d.dispose()
    disposables.length = 0
  }

  const q = new THREE.Quaternion()
  const tmp = new THREE.Vector3()

  const pushTrail = (tr: Trail, p: THREE.Vector3, stamp: number, replaceHead: boolean): void => {
    if (replaceHead && tr.count > 0) {
      p.toArray(tr.points, (tr.count - 1) * 3)
      tr.stamps[tr.count - 1] = stamp
      return
    }
    if (tr.count >= CONTRAIL_CAPACITY) {
      tr.points.copyWithin(0, 3)
      tr.stamps.copyWithin(0, 1)
      tr.count--
    }
    p.toArray(tr.points, tr.count * 3)
    tr.stamps[tr.count] = stamp
    tr.count++
  }

  const animate = (time: number, dtReal: number, throttle: number): void => {
    for (const p of props) {
      const s = p.getObjectByName('spinner')
      if (s) s.rotation.x += dtReal * 55 * (0.4 + throttle)
    }
    // Strobes: double white flash on the wingtips, slower red beacon.
    const ph = time % 1.3
    const strobe = ph < 0.05 || (ph > 0.14 && ph < 0.19) ? 1 : 0
    const beacon = time % 1.0 < 0.12 ? 1 : 0
    const colors = strobeGeo.getAttribute('color') as THREE.BufferAttribute | undefined
    if (colors) {
      colors.setXYZ(0, 3 * strobe, 3 * strobe, 3 * strobe)
      colors.setXYZ(1, 3 * strobe, 3 * strobe, 3 * strobe)
      colors.setXYZ(2, 3 * beacon, 0.15 * beacon, 0.1 * beacon)
      colors.needsUpdate = true
    }
  }

  return {
    group,
    worldObjects,
    get model() {
      return model
    },
    set(spec, livery) {
      clearAirframe()
      model = buildAircraft(spec.class, spec.lengthM, livery)
      mesh = new THREE.Mesh(model.geometry, material)
      group.add(mesh)
      for (const p of model.props) {
        const hub = new THREE.Group()
        hub.position.copy(p.pos)
        const disc = new THREE.Mesh(new THREE.CircleGeometry(p.radius, 24), propDiscMat)
        disc.rotation.y = Math.PI / 2
        const blades = new THREE.Mesh(new THREE.BoxGeometry(p.radius * 0.015, p.radius * 2, p.radius * 0.06), bladeMat)
        const blades2 = blades.clone()
        blades2.rotation.x = Math.PI / 2
        const spinner = new THREE.Group()
        spinner.add(blades, blades2)
        spinner.name = 'spinner'
        hub.add(disc, spinner)
        group.add(hub)
        props.push(hub)
        disposables.push(disc.geometry, blades.geometry)
      }
      const red = new THREE.Color(3, 0.15, 0.1)
      const green = new THREE.Color(0.1, 3, 0.5)
      const white = new THREE.Color(3, 3, 3)
      navGeo.setAttribute('position', new THREE.Float32BufferAttribute([...model.navLeft.toArray(), ...model.navRight.toArray(), ...model.navTail.toArray()], 3))
      navGeo.setAttribute('color', new THREE.Float32BufferAttribute([...red.toArray(), ...green.toArray(), ...white.toArray()], 3))
      strobeGeo.setAttribute('position', new THREE.Float32BufferAttribute([...model.navLeft.toArray(), ...model.navRight.toArray(), ...model.beacon.toArray()], 3))
      strobeGeo.setAttribute('color', new THREE.Float32BufferAttribute([...white.toArray(), ...white.toArray(), ...red.toArray()], 3))
      for (const t of trails) t.count = 0
    },
    pose(position, orientation, time, dtReal) {
      group.position.copy(position)
      group.quaternion.copy(orientation)
      animate(time, dtReal, 0.6)
      for (const t of trails) t.ribbon.mesh.visible = false
    },
    setOpacity(opacity) {
      const o = Math.min(1, Math.max(0, opacity))
      // Depth writes stay on while fading: the airframe's own inner faces must not show through.
      for (const m of [material, bladeMat]) {
        m.opacity = o
        m.transparent = o < 0.999
      }
      propDiscMat.opacity = 0.1 * o
      navMat.opacity = strobeMat.opacity = o
      group.visible = o > 0.001
    },
    update(state, time, dtReal) {
      group.position.set(state.pos.x, state.pos.y, state.pos.z)
      group.quaternion.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w)
      animate(time, dtReal, state.throttle)

      if (!model) return
      const teleported = lastPos.distanceToSquared(group.position) > 2000 * 2000
      lastPos.copy(group.position)
      if (teleported) for (const t of trails) t.count = 0
      const alt = state.pos.y
      const k = THREE.MathUtils.smoothstep(alt, CONTRAIL_MIN_ALT, CONTRAIL_FULL_ALT) * (0.5 + 0.5 * state.throttle)
      const drop = time - lastDrop >= CONTRAIL_STEP_S
      if (drop) lastDrop = time
      q.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w)
      const sources = model.exhausts.slice(0, 2)
      trails.forEach((tr, i) => {
        const src = sources[i]
        if (!src) return
        tmp.copy(src).applyQuaternion(q).add(group.position)
        pushTrail(tr, tmp, time, !drop)
        tr.ribbon.set(tr.points, tr.stamps, tr.count)
        tr.ribbon.setTime(time, 0)
        tr.ribbon.setOpacity(0.6 * k)
        tr.ribbon.mesh.visible = k > 0.01 && tr.count > 1
      })
    },
    setPixelAngle(a) {
      for (const t of trails) t.ribbon.setPixelAngle(a)
    },
    dispose() {
      clearAirframe()
      model?.geometry.dispose()
      material.dispose()
      propDiscMat.dispose()
      bladeMat.dispose()
      navGeo.dispose()
      navMat.dispose()
      strobeGeo.dispose()
      strobeMat.dispose()
      for (const t of trails) t.ribbon.dispose()
    },
  }
}
