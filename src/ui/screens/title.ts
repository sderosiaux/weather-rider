import type { TitleCallbacks, UnlockHints } from '../../core/presentation'
import type { AircraftSpec, DailyWeather, PlayerProgress, Route } from '../../core/types'
import { h } from '../dom'
import { groupThousands, severityBucket } from '../format'
import { aircraftSilhouette } from '../silhouette'
import { loadMemory, saveMemory } from '../coach/store'
import { boardName } from '../tradeoffs'

export interface TitleMemory {
  routeId: string | null
  aircraftId: string | null
  ghostCode: string
}

const SEVERITY_TEXT = { calm: 'Calm', moderate: 'Moderate', extreme: 'Extreme' } as const

const liveryFill = (progress: PlayerProgress, id: string): string => progress.livery[id] ?? 'var(--wr-livery-1)'

const kbd = (...keys: string[]): HTMLElement[] => keys.map((k) => h('kbd', {}, k))

const coachingToggle = (): HTMLElement => {
  const box = h('input', { type: 'checkbox', class: 'wr-switch__input', id: 'wr-coaching' })
  box.checked = loadMemory().enabled
  box.addEventListener('change', () => saveMemory({ ...loadMemory(), enabled: box.checked }))
  return h(
    'label',
    { class: 'wr-switch', for: 'wr-coaching' },
    box,
    h('span', 'wr-switch__track', h('span', 'wr-switch__thumb')),
    h('span', 'wr-switch__text', h('b', {}, 'Coaching'), h('span', {}, 'Short in-flight tips on reading the sky. Each one retires once you’ve shown you know it.')),
  )
}

const cheatsheet = (): HTMLElement =>
  h(
    'details',
    'wr-cheats',
    h('summary', {}, 'Controls'),
    coachingToggle(),
    h(
      'dl',
      'wr-cheats__grid',
      h('dt', {}, 'Pitch'), h('dd', {}, kbd('W', 'S'), ' or ', kbd('↑', '↓')),
      h('dt', {}, 'Roll'), h('dd', {}, kbd('A', 'D'), ' or ', kbd('←', '→')),
      h('dt', {}, 'Yaw'), h('dd', {}, kbd('Q', 'E')),
      h('dt', {}, 'Throttle'), h('dd', {}, kbd('Shift', 'Ctrl'), ' or ', kbd('R', 'F'), ', mouse wheel'),
      h('dt', {}, 'Mouse'), h('dd', {}, 'Steer by moving away from the center. Click to capture the pointer, ', kbd('Esc'), ' to release.'),
      h('dt', {}, 'Gamepad'), h('dd', {}, 'Left stick flies, triggers yaw, right stick sets power.'),
    ),
  )

const intro = (progress: PlayerProgress): HTMLElement => {
  if (progress.flights === 0)
    return h(
      'div',
      'wr-title__intro is-first',
      h('p', 'wr-title__intro-lead', 'Your first flight.'),
      h(
        'p',
        {},
        'Take the calm route in the turboprop. Rising air on the flank of a storm lifts you for free; the dark core shakes your passengers. Cross the gate at the end of the route inside its altitude window.',
      ),
    )
  const b = progress.best
  return h(
    'div',
    'wr-title__intro',
    h('p', 'wr-title__intro-lead', `Welcome back, ${progress.pilot}.`),
    h(
      'ul',
      'wr-title__bests',
      h('li', {}, h('span', {}, 'Flights'), h('b', {}, String(progress.flights))),
      h('li', {}, h('span', {}, boardName('smooth')), h('b', {}, String(Math.round(b.smooth)))),
      h('li', {}, h('span', {}, boardName('speed')), h('b', {}, String(Math.round(b.speed)))),
      h('li', {}, h('span', {}, boardName('eco')), h('b', {}, String(Math.round(b.eco)))),
    ),
  )
}

/** Accept a pasted link or a bare code; hand it over untouched once it looks like something. */
const readGhostInput = (raw: string): string | null => {
  const t = raw.trim()
  return t.length > 0 ? t : null
}

export const renderTitle = (
  daily: DailyWeather,
  progress: PlayerProgress,
  aircraft: readonly AircraftSpec[],
  unlockHints: UnlockHints,
  cb: TitleCallbacks,
  memory: TitleMemory,
): HTMLElement => {
  const unlocked = new Set(progress.unlockedAircraft)
  const byCalm = [...daily.routes].sort((a, b) => a.severity - b.severity)
  let route: Route = daily.routes.find((r) => r.id === memory.routeId) ?? (progress.flights === 0 ? byCalm[0]! : daily.routes[0])
  const firstUnlocked = aircraft.find((a) => unlocked.has(a.id)) ?? null
  let plane: AircraftSpec | null =
    aircraft.find((a) => a.id === memory.aircraftId && unlocked.has(a.id)) ?? firstUnlocked

  // A shared link opened directly lands here with the ghost in the hash.
  if (!memory.ghostCode && location.hash.startsWith('#g=')) memory.ghostCode = location.href

  const flyLabel = h('span')
  const flyBtn = h('button', { class: 'wr-btn wr-btn--primary wr-btn--lg', type: 'button' }, flyLabel)
  const ghostInput = h('input', {
    class: 'wr-field__input',
    type: 'text',
    id: 'wr-ghost',
    placeholder: 'Paste a friend’s link or ghost code',
    autocomplete: 'off',
    spellcheck: 'false',
    value: memory.ghostCode,
  })
  const ghostNote = h('p', 'wr-field__note')

  const routeButtons = daily.routes.map((r) => {
    const sev = severityBucket(r.severity)
    const btn = h(
      'button',
      { class: `wr-route wr-route--${sev}`, type: 'button', 'aria-pressed': 'false' },
      h('span', 'wr-route__label', r.label),
      h('span', 'wr-route__meta', `${groupThousands(r.realDistanceKm)} km`),
      h('span', 'wr-chip wr-chip--' + sev, SEVERITY_TEXT[sev]),
    )
    btn.addEventListener('click', () => {
      route = r
      memory.routeId = r.id
      sync()
    })
    return { r, btn }
  })

  const planeButtons = aircraft.map((a) => {
    const isUnlocked = unlocked.has(a.id)
    const hint = unlockHints[a.id] ?? 'Locked'
    const btn = h(
      'button',
      {
        class: `wr-plane${isUnlocked ? '' : ' is-locked'}`,
        type: 'button',
        'aria-pressed': 'false',
        'aria-disabled': isUnlocked ? null : 'true',
        title: isUnlocked ? a.name : `${a.name}: ${hint}`,
      },
      h('span', 'wr-plane__art', aircraftSilhouette(a.class, liveryFill(progress, a.id))),
      h('span', 'wr-plane__name', a.name),
      h('span', 'wr-plane__hint', isUnlocked ? a.class : hint),
    )
    if (isUnlocked)
      btn.addEventListener('click', () => {
        plane = a
        memory.aircraftId = a.id
        sync()
      })
    return { a, btn }
  })

  const sync = (): void => {
    for (const { r, btn } of routeButtons) btn.setAttribute('aria-pressed', String(r.id === route.id))
    for (const { a, btn } of planeButtons) btn.setAttribute('aria-pressed', String(plane?.id === a.id))
    const ghost = readGhostInput(ghostInput.value)
    flyLabel.textContent = ghost ? `Fly ${route.label} against the ghost` : `Fly ${route.label}`
    ghostNote.textContent = ghost
      ? 'Their run will fly beside you as a ghost.'
      : 'A friend’s run appears as a ghost you can race.'
    flyBtn.disabled = plane === null
  }

  ghostInput.addEventListener('input', () => {
    memory.ghostCode = ghostInput.value
    sync()
  })
  ghostInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') flyBtn.click()
  })
  flyBtn.addEventListener('click', () => {
    if (!plane) return
    cb.onFly(route.id, plane.id, readGhostInput(ghostInput.value))
  })
  const hangarBtn = h('button', { class: 'wr-btn wr-btn--quiet', type: 'button' }, 'Open hangar')
  hangarBtn.addEventListener('click', () => cb.onHangar())

  const screen = h(
    'section',
    { class: 'wr-screen wr-title', 'aria-label': 'Weather Rider', 'data-screen': 'title' },
    h(
      'div',
      'wr-title__hero',
      h('p', 'wr-title__daily', `WORLD WEATHER #${daily.number}`),
      h('h1', 'wr-title__name', 'WEATHER RIDER'),
      h('p', 'wr-title__tagline', '« Turbulence isn’t the enemy. It’s the terrain. »'),
      intro(progress),
      cheatsheet(),
    ),
    h(
      'div',
      'wr-sheet wr-title__panel',
      h('h2', 'wr-sheet__title', 'Today’s routes'),
      h('div', { class: 'wr-routes', role: 'group', 'aria-label': 'Route' }, routeButtons.map((x) => x.btn)),
      h('h2', 'wr-sheet__title', 'Aircraft'),
      h('div', { class: 'wr-planes', role: 'group', 'aria-label': 'Aircraft' }, planeButtons.map((x) => x.btn)),
      h(
        'div',
        'wr-field',
        h('label', { class: 'wr-sheet__title', for: 'wr-ghost' }, 'Beat my run'),
        ghostInput,
        ghostNote,
      ),
      h('div', 'wr-actions', hangarBtn, flyBtn),
    ),
  )
  sync()
  return screen
}
