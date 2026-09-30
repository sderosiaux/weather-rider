import type { BoardKind, BoardsModel } from '../../core/presentation'
import type { LeaderboardEntry, Route } from '../../core/types'
import { h } from '../dom'
import { boardName } from '../tradeoffs'
import { BOARD_ORDER, boardRows, openingRoute, runCount, runsLabel, type BoardRow } from './boardsModel'
import { severityChip } from './title'

export interface BoardsCallbacks {
  onRace(entry: LeaderboardEntry): void
  onBack(): void
  /** Empty-state shortcuts to the title: that route picked, or the friend's-link field focused. */
  onChooseRoute(routeId: string): void
  onPasteLink(): void
}

const BOARD_BLURB: Record<BoardKind, string> = {
  smooth: 'Calm cabin, no severe turbulence',
  speed: 'Fastest to the gate',
  eco: 'Least fuel burned',
}

// Pilot names are other people's text (from their ghost codes): they only ever enter the DOM as text nodes
// through h(), never as markup or attribute values. Ids and data-keys are built from indexes.
const row = (r: BoardRow, key: string, onRace: (entry: LeaderboardEntry) => void): HTMLElement => {
  const race = h(
    'button',
    { class: 'wr-lb__race', type: 'button', 'data-key': key },
    'Race',
    h('span', 'wr-sr', r.you ? ' your run' : [' ', h('bdi', {}, r.name)]),
  )
  race.addEventListener('click', () => onRace(r.entry))
  return h(
    'li',
    `wr-lb__row${r.rank === 1 ? ' is-lead' : ''}${r.you ? ' is-you' : ''}`,
    h('span', 'wr-lb__rank', String(r.rank)),
    h('span', 'wr-lb__who', h('bdi', 'wr-lb__pilot', r.name), r.you ? h('span', 'wr-lb__you', 'You') : null),
    h('span', 'wr-lb__score', r.score),
    race,
  )
}

export const renderBoards = (model: BoardsModel, cb: BoardsCallbacks, preferredRouteId: string | null): HTMLElement => {
  const routes = model.daily.routes
  let route: Route = openingRoute(model, preferredRouteId)
  const panel = h('div', { class: 'wr-lb__panel', role: 'tabpanel', id: 'wr-lb-panel' })

  const board = (r: Route, b: BoardKind): HTMLElement => {
    const rows = boardRows(model, r.id, b)
    return h(
      'section',
      { class: 'wr-lb__board', 'aria-labelledby': `wr-lb-${b}` },
      h('h2', { class: 'wr-lb__board-name', id: `wr-lb-${b}` }, boardName(b)),
      h('p', 'wr-lb__blurb', BOARD_BLURB[b]),
      rows.length === 0
        ? h('p', 'wr-lb__none', `No ${boardName(b)} score on ${r.label} yet.`)
        : h('ol', 'wr-lb__rows', rows.map((x, i) => row(x, `race:${b}:${i}`, cb.onRace))),
    )
  }

  const emptyRoute = (r: Route): HTMLElement => {
    const choose = h('button', { class: 'wr-btn wr-btn--primary', type: 'button' }, `Choose ${r.label}`)
    choose.addEventListener('click', () => cb.onChooseRoute(r.id))
    const paste = h('button', { class: 'wr-btn wr-btn--quiet', type: 'button' }, 'Paste a friend’s link')
    paste.addEventListener('click', () => cb.onPasteLink())
    return h(
      'div',
      'wr-lb__empty',
      h('h2', 'wr-lb__empty-title', `No runs on ${r.label} yet today`),
      h('p', {}, `Fly ${r.label} to set the first score.`),
      h('p', {}, 'Paste a friend’s link on the title to race them.'),
      h('div', 'wr-lb__empty-actions', choose, paste),
    )
  }

  const tabs = routes.map((r, i) => {
    const tab = h(
      'button',
      { class: 'wr-lb__tab', type: 'button', role: 'tab', id: `wr-lb-tab-${i}`, 'aria-controls': 'wr-lb-panel', 'data-key': `tab:${i}` },
      h('span', 'wr-lb__tab-label', r.label),
      severityChip(r.severity),
      h('span', 'wr-lb__tab-runs', runsLabel(runCount(model.boards[r.id]))),
    )
    tab.addEventListener('click', () => select(r))
    return tab
  })

  const select = (r: Route): void => {
    route = r
    const at = routes.indexOf(r)
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === at))
      tab.tabIndex = i === at ? 0 : -1
    })
    panel.setAttribute('aria-labelledby', `wr-lb-tab-${at}`)
    panel.replaceChildren(
      runCount(model.boards[r.id]) === 0 ? emptyRoute(r) : h('div', 'wr-lb__boards', BOARD_ORDER.map((b) => board(r, b))),
    )
  }

  // Tabs pattern: arrows, Home and End move between routes and show them; Tab goes on into the boards.
  const tablist = h('div', { class: 'wr-lb__tabs', role: 'tablist', 'aria-label': 'Route' }, tabs)
  tablist.addEventListener('keydown', (e) => {
    const at = routes.indexOf(route)
    const n = routes.length
    const to = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null
    if (to === null) return
    e.preventDefault()
    select(routes[to]!)
    tabs[to]!.focus()
  })

  const back = h('button', { class: 'wr-btn wr-btn--quiet', type: 'button' }, 'Back to menu')
  back.addEventListener('click', () => cb.onBack())

  const screen = h(
    'section',
    { class: 'wr-screen wr-lb', 'aria-label': 'Today’s boards', 'data-screen': 'boards' },
    h(
      'div',
      'wr-sheet wr-lb__sheet',
      h(
        'header',
        'wr-lb__head',
        h('div', {}, h('p', 'wr-lb__daily', `WORLD WEATHER #${model.daily.number}`), h('h1', 'wr-lb__title', 'Today’s boards')),
        back,
      ),
      tablist,
      panel,
      h('p', 'wr-lb__local', 'Your runs and the friends’ ghosts you’ve raced, on this device.'),
    ),
  )
  select(route)
  return screen
}
