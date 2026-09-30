import type { CreateScreens, Screens } from '../../core/presentation'
import { h } from '../dom'
import { renderBoards } from './boards'
import { renderHangar, type HangarMemory } from './hangar'
import { renderResults } from './results'
import { renderSettings } from './settings'
import { renderTitle, type TitleMemory } from './title'
import { MENU_EVENT } from '../input/stick'
import './screens.css'

export const createScreens: CreateScreens = (root: HTMLElement): Screens => {
  const layer = h('div', { class: 'wr-screens is-hidden' })
  root.appendChild(layer)

  // Selections survive screen changes (title → hangar → title keeps your route and aircraft).
  const titleMemory: TitleMemory = { routeId: null, aircraftId: null, ghostCode: '' }
  const hangarMemory: HangarMemory = { aircraftId: null }
  const TITLE_FOCUS = '.wr-btn--primary'
  let titleFocus = TITLE_FOCUS

  let onEscape: (() => void) | null = null
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && onEscape && !layer.classList.contains('is-hidden')) onEscape()
  }
  window.addEventListener('keydown', onKey)

  const mount = (screen: HTMLElement, focusSelector: string, escape: (() => void) | null): void => {
    // Re-showing the same screen (e.g. hangar after an equip) keeps scroll position and keyboard focus.
    // Menus need a visible cursor, and the next flight must start with the controls released.
    if (document.pointerLockElement) document.exitPointerLock()
    window.dispatchEvent(new Event(MENU_EVENT))
    const sameKind = layer.firstElementChild?.getAttribute('aria-label') === screen.getAttribute('aria-label')
    const old = layer.firstElementChild as HTMLElement | null
    const scroll = sameKind && old ? old.scrollTop : 0
    const innerScroll = sameKind ? (old?.querySelector<HTMLElement>('[data-keep-scroll]')?.scrollTop ?? 0) : 0
    const active = document.activeElement
    const focusKey = sameKind && active instanceof HTMLElement && layer.contains(active) ? active.dataset.key : undefined
    screen.classList.toggle('is-refresh', sameKind)
    layer.dataset.screen = screen.dataset.screen ?? ''
    layer.replaceChildren(screen)
    layer.classList.remove('is-hidden')
    screen.scrollTop = scroll
    const inner = screen.querySelector<HTMLElement>('[data-keep-scroll]')
    if (inner) inner.scrollTop = innerScroll
    onEscape = escape
    const target = focusKey
      ? screen.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)
      : sameKind
        ? null
        : screen.querySelector<HTMLElement>(focusSelector)
    target?.focus({ preventScroll: true })
  }

  return {
    showTitle(daily, progress, aircraft, unlockHints, cb) {
      mount(renderTitle(daily, progress, aircraft, unlockHints, cb, titleMemory), titleFocus, null)
    },
    showResults(model, cb) {
      mount(renderResults(model, cb), '.wr-actions .wr-btn--primary', cb.onMenu)
    },
    showHangar(model, cb) {
      mount(renderHangar(model, cb, hangarMemory), '.wr-pick[aria-pressed="true"]', cb.onBack)
    },
    showBoards(model, cb) {
      // Empty-state shortcuts: onBack leads to the title, which then opens with the route picked or the link field focused.
      const toTitle = (focus: string): void => {
        titleFocus = focus
        cb.onBack()
        titleFocus = TITLE_FOCUS
      }
      const boards = renderBoards(
        model,
        {
          onRace: (entry) => cb.onRace(entry),
          onBack: () => cb.onBack(),
          onChooseRoute: (routeId) => {
            titleMemory.routeId = routeId
            toTitle(TITLE_FOCUS)
          },
          onPasteLink: () => toTitle('#wr-ghost'),
        },
        titleMemory.routeId,
      )
      mount(boards, '.wr-lb__tab[aria-selected="true"]', cb.onBack)
    },
    showSettings(settings, cb) {
      // Not the pilot-name field: focusing a text field on open pops the on-screen keyboard on tablets.
      mount(renderSettings(settings, cb), '.wr-switch__input', cb.onBack)
    },
    dispose() {
      window.removeEventListener('keydown', onKey)
      layer.remove()
    },
    hide() {
      layer.classList.add('is-hidden')
      layer.replaceChildren()
      onEscape = null
    },
  }
}
