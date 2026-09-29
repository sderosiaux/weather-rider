import type { ResultsModel } from '../../core/presentation'
import { h } from '../dom'
import { flightTime, recordState, shareUrl, type RecordState } from '../format'
import { skyLine } from '../coach/sky'
import { boardName } from '../tradeoffs'

const HEADLINE = {
  flying: (to: string) => `En route to ${to}`,
  arrived: (to: string) => `Arrived at ${to}`,
  crashed: () => 'Crashed',
  overstressed: () => 'Airframe overstressed',
} as const

const SUBLINE = {
  flying: 'Flight in progress.',
  arrived: 'Wheels down through the gate.',
  crashed: 'The ground came too soon. The sky is the same all day: try another line.',
  overstressed: 'The airframe took more load than it was built for. Ride the currents, don’t fight them.',
} as const

const RECORD_TEXT: Record<RecordState, (prev: number | null) => string> = {
  first: () => 'First score on this board',
  record: (p) => `New record · previous ${Math.round(p ?? 0)}`,
  tie: (p) => `Matches your best ${Math.round(p ?? 0)}`,
  below: (p) => `Your best ${Math.round(p ?? 0)}`,
}

const stat = (label: string, value: string, tone: 'plain' | 'good' | 'warn' = 'plain'): HTMLElement =>
  h('div', `wr-stat wr-stat--${tone}`, h('dt', {}, label), h('dd', {}, value))

const copy = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export const renderResults = (
  m: ResultsModel,
  cb: { onRetry(): void; onMenu(): void },
): HTMLElement => {
  const s = m.score
  const ok = s.status === 'arrived'

  const boards = (['smooth', 'speed', 'eco'] as const).map((b) => {
    const prev = m.previousBest ? m.previousBest[b] : null
    const state = recordState(s[b], prev)
    return h(
      'li',
      `wr-board${state === 'record' ? ' is-record' : ''}`,
      h('span', 'wr-board__name', boardName(b)),
      h('span', 'wr-board__score', String(Math.round(s[b]))),
      h('span', 'wr-board__prev', RECORD_TEXT[state](prev)),
    )
  })

  const url = shareUrl(location.origin, location.pathname, m.ghostCode)
  const shareStatus = h('p', { class: 'wr-share__status', role: 'status', 'aria-live': 'polite' })
  const fallback = h('input', { class: 'wr-field__input wr-share__fallback', type: 'text', readonly: true, value: url, 'aria-label': 'Share link' })
  const shareBtn = h('button', { class: 'wr-btn wr-btn--primary', type: 'button' }, 'Share: Beat my run')
  shareBtn.addEventListener('click', async () => {
    if (await copy(url)) {
      shareStatus.textContent = 'Link copied. Anyone who opens it races your ghost.'
      shareStatus.dataset.state = 'ok'
    } else {
      shareStatus.textContent = 'Copy blocked by the browser. Copy the link below.'
      shareStatus.dataset.state = 'warn'
      fallback.classList.add('is-on')
      fallback.focus()
      fallback.select()
    }
  })
  const retry = h('button', { class: 'wr-btn wr-btn--quiet', type: 'button' }, 'Fly it again')
  retry.addEventListener('click', () => cb.onRetry())
  const menu = h('button', { class: 'wr-btn wr-btn--quiet', type: 'button' }, 'Back to menu')
  menu.addEventListener('click', () => cb.onMenu())

  const unlocked =
    m.newlyUnlocked.length > 0
      ? h(
          'div',
          'wr-unlocked',
          h('h2', 'wr-sheet__title', 'Unlocked in the hangar'),
          h(
            'ul',
            'wr-unlocked__list',
            m.newlyUnlocked.map((u) =>
              h('li', `wr-unlocked__item wr-unlocked__item--${u.kind}`, h('span', 'wr-unlocked__kind', u.kind === 'aircraft' ? 'New aircraft' : 'Upgrade'), u.name),
            ),
          ),
        )
      : null

  return h(
    'section',
    { class: `wr-screen wr-results wr-results--${s.status}`, 'aria-label': 'Flight results' },
    h(
      'div',
      'wr-sheet wr-results__sheet',
      h('p', 'wr-results__daily', `WORLD WEATHER #${m.dailyNumber} · ${m.route.label} · ${m.aircraft.name}`),
      h('h1', 'wr-results__headline', HEADLINE[s.status](m.route.to)),
      h('p', 'wr-results__sub', SUBLINE[s.status]),
      h(
        'div',
        'wr-results__hero',
        h('div', 'wr-results__time', h('span', {}, flightTime(s.displayTimeS)), h('small', {}, ok ? 'flight time' : 'time flown')),
        h(
          'dl',
          'wr-stats',
          stat('Fuel remaining', `${Math.round(s.fuelRemainingPct)}%`, s.fuelRemainingPct < 10 ? 'warn' : 'plain'),
          stat('Passenger comfort', `${Math.round(s.comfort)}`, s.comfort >= 80 ? 'good' : s.comfort < 50 ? 'warn' : 'plain'),
          stat('Severe turbulence', `${Math.round(s.severeTurbulenceS)} s`, s.severeTurbulenceS === 0 ? 'good' : 'warn'),
          stat('Airframe stress', `${Math.round(s.stress)}`, s.stress >= 70 ? 'warn' : 'plain'),
          stat('Weather utilization', `${Math.round(s.weatherUtilization)}%`, s.weatherUtilization >= 50 ? 'good' : 'plain'),
        ),
      ),
      h('p', 'wr-results__sky', skyLine(s)),
      h('ul', 'wr-boards', boards),
      unlocked,
      h('div', 'wr-share', shareStatus, fallback),
      h('div', 'wr-actions', menu, retry, shareBtn),
    ),
  )
}
