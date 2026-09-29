import type { CreateScreens, Screens } from '../../core/presentation'
import { h } from '../dom'
import { renderHangar, type HangarMemory } from './hangar'
import { renderResults } from './results'
import { renderTitle, type TitleMemory } from './title'
import { MENU_EVENT } from '../input/stick'
import './screens.css'

export const createScreens: CreateScreens = (root: HTMLElement): Screens => {
  const layer = h('div', { class: 'wr-screens is-hidden' })
  root.appendChild(layer)

  // Selections survive screen changes (title → hangar → title keeps your route and aircraft).
  const titleMemory: TitleMemory = { routeId: null, aircraftId: null, ghostCode: '' }
  const hangarMemory: HangarMemory = { aircraftId: null }
  // Results only get ids for unlocks; remember names seen on other screens.
  const names = new Map<string, string>()

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
    const scroll = sameKind ? (layer.firstElementChild as HTMLElement).scrollTop : 0
    const active = document.activeElement
    const focusKey = sameKind && active instanceof HTMLElement && layer.contains(active) ? active.dataset.key : undefined
    screen.classList.toggle('is-refresh', sameKind)
    layer.replaceChildren(screen)
    layer.classList.remove('is-hidden')
    screen.scrollTop = scroll
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
      for (const a of aircraft) names.set(a.id, a.name)
      mount(renderTitle(daily, progress, aircraft, unlockHints, cb, titleMemory), '.wr-btn--primary', null)
    },
    showResults(model, cb) {
      names.set(model.aircraft.id, model.aircraft.name)
      mount(renderResults(model, cb), '.wr-actions .wr-btn--primary', cb.onMenu)
    },
    showHangar(model, cb) {
      for (const a of model.aircraft) names.set(a.id, a.name)
      for (const u of model.upgrades) names.set(u.id, u.name)
      mount(renderHangar(model, cb, hangarMemory), '.wr-trophy[aria-pressed="true"]', cb.onBack)
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
