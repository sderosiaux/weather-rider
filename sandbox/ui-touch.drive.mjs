// Real-game touch check, no dependencies. Drives the running dev server through the Chrome DevTools Protocol
// with genuine multi-touch (Input.dispatchTouchEvent → PointerEvents with pointerType 'touch'), samples the
// live AircraftState (window.__wr.session), checks the layer against the HUD instruments, saves screenshots.
//
//   pnpm dev --port 5210 --strictPort
//   agent-browser --session ui-touch open about:blank
//   node sandbox/ui-touch.drive.mjs "$(agent-browser --session ui-touch get cdp-url)" [http://localhost:5210]
//
// Exits non-zero when a check fails.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [wsUrl, base = 'http://localhost:5210'] = process.argv.slice(2)
if (!wsUrl) throw new Error('usage: node sandbox/ui-touch.drive.mjs <browser ws url> [base url]')
const here = dirname(fileURLToPath(import.meta.url))
const SIZES = [
  [1024, 768],
  [1180, 820],
  [1366, 1024],
]

// ── CDP plumbing ─────────────────────────────────────────────────────────────
const ws = new WebSocket(wsUrl)
const pending = new Map()
let nextId = 1
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data)
  // A crashed or detached tab explains a later "Session with given id not found".
  if (msg.method === 'Target.targetCrashed' || msg.method === 'Target.detachedFromTarget') console.log(msg.method, JSON.stringify(msg.params))
  const p = msg.id !== undefined && pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`))
  else p.resolve(msg.result)
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, method })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })

await send('Target.setDiscoverTargets', { discover: true })
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const page = (method, params) => send(method, params, sessionId)
await page('Page.enable')
await page('Runtime.enable')

const js = async (expression) => {
  const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}… → ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
/** Poll a page expression until it is truthy; returns its value and how long it took. */
const until = async (expression, timeoutMs = 4000) => {
  const t0 = Date.now()
  for (;;) {
    const v = await js(expression)
    if (v) return { value: v, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { value: null, ms: Date.now() - t0 }
    await pause(50)
  }
}

// ── Fingers: start/move list every finger down (CDP diffs them); touchEnd lists the finger that lifts ─────
const fingers = new Map()
const point = (id, p) => ({ id, x: p.x, y: p.y, radiusX: 11, radiusY: 11, force: 1 })
const emit = (type) => page('Input.dispatchTouchEvent', { type, touchPoints: [...fingers].map(([id, p]) => point(id, p)) })
const down = async (id, p) => {
  fingers.set(id, p)
  await emit('touchStart')
}
/** Moves several fingers together, each event carrying all of them. */
const drag = async (moves, steps = 14) => {
  const from = new Map(moves.map(([id]) => [id, fingers.get(id)]))
  for (let i = 1; i <= steps; i++) {
    for (const [id, to] of moves) {
      const f = from.get(id)
      fingers.set(id, { x: f.x + ((to.x - f.x) * i) / steps, y: f.y + ((to.y - f.y) * i) / steps })
    }
    await emit('touchMove')
    await pause(16) // a thumb's pace, one move per frame
  }
}
const key = async (code, k) => {
  await page('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code })
  await page('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code })
}
const lift = async (id) => {
  const p = fingers.get(id)
  fingers.delete(id)
  await page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [point(id, p)] })
}

// ── Page probes ─────────────────────────────────────────────────────────────
const STATE = `(() => { const s = window.__wr.session.state(); return { t: s.t, throttle: s.throttle, angVel: s.angVel, bankDeg: Math.asin(Math.max(-1, Math.min(1, 2 * (s.orientation.w * s.orientation.x - s.orientation.y * s.orientation.z)))) * 180 / Math.PI } })()`
const GEOMETRY = `(() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height } }
  const one = (s) => box(document.querySelector(s))
  return { home: one('.wr-touch__home'), track: one('.wr-touch__track'), rail: one('.wr-touch__rail'), pads: [...document.querySelectorAll('.wr-touch__pad')].map(box) }
})()`
// Visible parts of the touch layer vs HUD instrument panels (and the always-on hint/readouts).
const OVERLAP = `(() => {
  const box = (e) => e.getBoundingClientRect()
  const on = (e) => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01 && e.getBoundingClientRect().width > 0 }
  const layerOn = document.querySelector('.wr-touch')?.classList.contains('is-on')
  const parts = [...document.querySelectorAll('.wr-touch__home, .wr-touch__ring, .wr-touch__pad, .wr-touch__track, .wr-touch__tag')].filter(on)
  const panels = [...document.querySelectorAll('.wr-hud__panel')].filter(on)
  const hit = []
  for (const p of parts) for (const q of panels) {
    const a = box(p), b = box(q)
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hit.push(p.className + ' × ' + q.className)
  }
  return { layerOn, parts: parts.length, panels: panels.length, hit }
})()`

const failures = []
const check = (ok, what) => {
  if (!ok) failures.push(what)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

for (const [width, height] of SIZES) {
  const tag = `${width}x${height}`
  console.log(`\n── ${tag}`)
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page('Page.navigate', { url: `${base}/?fly=0&aircraft=turboprop` })
  const ready = await until(`!!(window.__wr && window.__wr.session && window.__wr.session.state().t > 0.5)`, 15000)
  check(ready.value === true, `flight running (${ready.ms} ms)`)

  const before = await js(STATE)
  const g = await js(GEOMETRY)
  const modeBefore = await js(`document.documentElement.dataset.wrStick`)
  check(modeBefore === 'disarmed', `before any touch the stick mode is 'disarmed' (got ${modeBefore})`)
  const layerBefore = await js(`document.querySelector('.wr-touch').classList.contains('is-on')`)
  check(!layerBefore, 'touch layer hidden before the first touch')

  // First touch: a tap on the resting stick reveals the controls and commands nothing.
  const R = g.home.w / 2
  const stick = { x: g.home.left + R, y: g.home.top + g.home.h / 2 }
  await down(1, stick)
  await lift(1)
  const shown = await until(`document.querySelector('.wr-touch').classList.contains('is-on')`, 1000)
  check(shown.value === true, 'a first tap in flight shows the touch controls')
  const mode = await js(`[document.documentElement.dataset.wrStick, document.pointerLockElement === null]`)
  check(mode[0] === 'touch', `stick mode is 'touch' once a finger touched (got ${mode[0]})`)
  check(mode[1], 'no pointer lock requested by the tap')
  const hintGone = await until(`getComputedStyle(document.querySelector('.wr-hud__take')).opacity < 0.05`, 2000)
  check(hintGone.value === true, '"take the controls" hint gone once touch flies')

  // Yaw pad from level flight: nose right ⇒ body angVel.y goes negative (core/types.ts convention).
  const pad = (await js(GEOMETRY)).pads[1]
  const yaw0 = (await js(STATE)).angVel.y
  await down(3, { x: pad.left + pad.w / 2, y: pad.top + pad.h / 2 })
  const yawed = await until(`document.querySelectorAll('.wr-touch__pad')[1].classList.contains('is-held') && (${STATE}).angVel.y < ${yaw0 - 0.04}`, 3000)
  check(yawed.value === true, `right yaw pad yaws the nose right: angVel.y ${yaw0.toFixed(3)} → ${(await js(STATE)).angVel.y.toFixed(3)} rad/s`)
  await lift(3)

  // Two thumbs at once: stick full right, throttle lever down 30 % of its track (= 0.30 of the range).
  const lever = { x: g.track.left + g.track.w / 2, y: g.rail.top + g.rail.h * 0.4 }
  const thr0 = (await js(STATE)).throttle
  await down(1, stick)
  await down(2, lever)
  await drag([
    [1, { x: stick.x + R, y: stick.y }],
    [2, { x: lever.x, y: lever.y + g.rail.h * 0.3 }],
  ])
  const rolled = await until(`(${STATE}).bankDeg > 15`, 5000)
  const held = await js(STATE)
  check(rolled.value === true, `stick drag right banks right: ${before.bankDeg.toFixed(1)}° → ${held.bankDeg.toFixed(1)}° (roll rate ${held.angVel.x.toFixed(2)} rad/s) after ${rolled.ms} ms`)
  const target = thr0 - 0.3
  const spooled = await until(`Math.abs((${STATE}).throttle - ${target}) < 0.015`, 5000)
  const thr = await js(STATE)
  const readout = await js(`document.querySelector('.wr-touch__value').textContent`)
  check(spooled.value === true, `throttle lever down 30 % of the track, stick still held: throttle ${thr0.toFixed(2)} → ${thr.throttle.toFixed(2)} (lever reads ${readout}, expected ${Math.round(target * 100)}%)`)

  const overlapHeld = await js(OVERLAP)
  check(overlapHeld.layerOn && overlapHeld.panels >= 6 && overlapHeld.hit.length === 0, `no control over an instrument while held (${overlapHeld.parts} parts vs ${overlapHeld.panels} panels) ${overlapHeld.hit.join(', ')}`)
  const shot = await page('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(here, `ui-touch-${tag}.png`), Buffer.from(shot.data, 'base64'))

  // Lift the stick thumb only: roll command back to neutral, the lever stays in hand.
  await lift(1)
  const settled = await until(`Math.abs((${STATE}).angVel.x) < 0.1`, 5000)
  check(settled.value === true, `lifting the stick thumb stops the roll (${settled.ms} ms), lever still held: ${await js(`document.querySelector('.wr-touch__throttle').classList.contains('is-held')`)}`)
  const kept = (await js(STATE)).throttle
  await lift(2)
  await pause(600)
  const after = (await js(STATE)).throttle
  check(Math.abs(after - kept) < 0.015 && Math.abs(after - target) < 0.015, `throttle persists after lifting the thumb (${kept.toFixed(2)} → ${after.toFixed(2)})`)

  const overlapIdle = await js(OVERLAP)
  check(overlapIdle.layerOn && overlapIdle.hit.length === 0, `no control over an instrument at rest ${overlapIdle.hit.join(', ')}`)
  if (width === 1180) {
    const rest = await page('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(here, `ui-touch-${tag}-rest.png`), Buffer.from(rest.data, 'base64'))
  }

  if (width === 1024) {
    // Switching devices: a flight key hands the controls to the keyboard, the next touch takes them back.
    await key('KeyW', 'w')
    const keysMode = await until(`!document.querySelector('.wr-touch').classList.contains('is-on') && document.documentElement.dataset.wrStick === 'keys'`, 1000)
    check(keysMode.value === true, 'a flight key hides the touch layer (stick mode keys)')
    await down(1, stick)
    await lift(1)
    const back = await until(`document.querySelector('.wr-touch').classList.contains('is-on') && document.documentElement.dataset.wrStick === 'touch'`, 1000)
    check(back.value === true, 'the next touch brings the touch layer back')
  }

  // A menu (Escape → title) hides the layer and lets go.
  await key('Escape', 'Escape')
  const hidden = await until(`!document.querySelector('.wr-touch').classList.contains('is-on')`, 2000)
  check(hidden.value === true, 'menu hides the touch layer')

  if (width === 1024) {
    // Next flight from the title: touch is still the pilot's device, the controls are there from the start.
    await js(`document.querySelector('.wr-screens .wr-btn--primary').click()`)
    const again = await until(`window.__wr.session.state().t > 0.2 && document.querySelector('.wr-touch').classList.contains('is-on')`, 5000)
    check(again.value === true, 'next flight shows the touch controls without a new first touch')

    // Hybrid laptop: a mouse click takes the pointer (touch layer steps aside), a touch gives it back.
    const click = { x: width * 0.6, y: height * 0.35, button: 'left', clickCount: 1 }
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: click.x, y: click.y })
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', ...click })
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click })
    const armed = await until(`document.pointerLockElement !== null && document.documentElement.dataset.wrStick === 'armed' && !document.querySelector('.wr-touch').classList.contains('is-on')`, 2000)
    check(armed.value === true, 'a mouse click still takes pointer lock and hides the touch layer')
    await down(1, stick)
    await lift(1)
    const released = await until(`document.pointerLockElement === null && document.documentElement.dataset.wrStick === 'touch' && document.querySelector('.wr-touch').classList.contains('is-on')`, 2000)
    check(released.value === true, 'a touch releases the mouse pointer lock and brings the touch layer back')
  }
}

await send('Target.closeTarget', { targetId })
ws.close()
console.log(failures.length === 0 ? '\nall touch checks passed' : `\n${failures.length} failed`)
process.exit(failures.length === 0 ? 0 : 1)
