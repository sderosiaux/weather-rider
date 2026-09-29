import type { HangarModel } from '../../core/presentation'
import type { AircraftSpec, PlayerProgress, Upgrade, UpgradeSlot } from '../../core/types'
import { h } from '../dom'
import { aircraftSilhouette } from '../silhouette'
import {
  SLOT_LABEL,
  SLOT_ORDER,
  applyUpgrades,
  formatChange,
  isUpgradeUnlocked,
  loadoutDiff,
  modifierEffects,
  unlockHint,
} from '../tradeoffs'

export interface HangarCallbacks {
  onEquip(aircraftId: string, upgradeId: string): void
  onUnequip(aircraftId: string, slot: UpgradeSlot): void
  onLivery(aircraftId: string, color: string): void
  onBack(): void
}

export interface HangarMemory {
  aircraftId: string | null
}

const LIVERY_VARS = ['--wr-livery-1', '--wr-livery-2', '--wr-livery-3', '--wr-livery-4', '--wr-livery-5', '--wr-livery-6', '--wr-livery-7', '--wr-livery-8']

const liveryPalette = (): string[] => {
  const cs = getComputedStyle(document.documentElement)
  return LIVERY_VARS.map((v) => cs.getPropertyValue(v).trim()).filter((c) => c.length > 0)
}

const effectChips = (u: Upgrade): HTMLElement => {
  const effects = modifierEffects(u.modifiers)
  if (effects.length === 0) return h('p', 'wr-upg__cosmetic', 'Cosmetic only: flies exactly the same.')
  return h(
    'ul',
    'wr-effects',
    effects.map((e) => h('li', `wr-effect wr-effect--${e.effect}`, h('b', {}, formatChange(e.change)), ' ', e.label.toLowerCase())),
  )
}

export const renderHangar = (model: HangarModel, cb: HangarCallbacks, memory: HangarMemory): HTMLElement => {
  // Local copy so equips and livery changes show immediately, before the game re-renders us.
  let progress: PlayerProgress = model.progress
  const unlockedAircraft = new Set(progress.unlockedAircraft)
  const initial =
    model.aircraft.find((a) => a.id === memory.aircraftId) ??
    model.aircraft.find((a) => unlockedAircraft.has(a.id)) ??
    model.aircraft[0]
  if (!initial) {
    const back = h('button', { class: 'wr-btn wr-btn--quiet', type: 'button' }, 'Back')
    back.addEventListener('click', () => cb.onBack())
    return h('section', { class: 'wr-screen wr-hangar', 'aria-label': 'Hangar' }, h('div', 'wr-sheet', h('p', {}, 'The hangar is empty. Fly a route to earn your first aircraft.'), back))
  }
  let selected: AircraftSpec = initial
  memory.aircraftId = selected.id

  const gallery = h('div', { class: 'wr-gallery', role: 'group', 'aria-label': 'Aircraft' })
  const detail = h('div', 'wr-hangar__detail')

  const liveryOf = (id: string): string => progress.livery[id] ?? `var(${LIVERY_VARS[0]})`
  const equippedIds = (id: string): readonly string[] => progress.loadouts[id] ?? []

  const renderGallery = (): void => {
    gallery.replaceChildren(
      ...model.aircraft.map((a) => {
        const locked = !unlockedAircraft.has(a.id)
        const tile = h(
          'button',
          {
            class: `wr-trophy${locked ? ' is-locked' : ''}`,
            type: 'button',
            'data-key': `a:${a.id}`,
            'aria-pressed': String(a.id === selected.id),
          },
          h('span', 'wr-trophy__plinth', aircraftSilhouette(a.class, liveryOf(a.id))),
          h('span', 'wr-trophy__name', a.name),
          h('span', 'wr-trophy__meta', locked ? (model.unlockHints[a.id] ?? 'Not yet earned') : a.class),
        )
        tile.addEventListener('click', () => {
          selected = a
          memory.aircraftId = a.id
          render()
        })
        return tile
      }),
    )
  }

  const renderDetail = (): void => {
    const a = selected
    const owned = unlockedAircraft.has(a.id)
    const equipped = model.upgrades.filter((u) => equippedIds(a.id).includes(u.id))
    const effective = applyUpgrades(a, equipped)
    const diff = loadoutDiff(a, effective)

    const stockOption = (a: AircraftSpec, slot: UpgradeSlot, owned: boolean): HTMLElement => {
      const on = !model.upgrades.some((u) => u.slot === slot && equippedIds(a.id).includes(u.id))
      const card = h(
        'button',
        {
          class: `wr-upg wr-upg--stock${on ? ' is-on' : ''}`,
          type: 'button',
          'data-key': `stock:${slot}`,
          'aria-pressed': String(on),
          disabled: !owned,
        },
        h('span', 'wr-upg__head', h('span', 'wr-upg__name', 'Stock'), on ? h('span', 'wr-upg__tag', 'Fitted') : null),
        h('span', 'wr-upg__desc', 'As the factory built it. The baseline every upgrade is measured against.'),
      )
      card.addEventListener('click', () => {
        if (!owned || on) return
        const kept = equippedIds(a.id).filter((id) => model.upgrades.find((x) => x.id === id)?.slot !== slot)
        progress = { ...progress, loadouts: { ...progress.loadouts, [a.id]: kept } }
        cb.onUnequip(a.id, slot)
        render()
      })
      return card
    }

    const slots = SLOT_ORDER.map((slot) => {
      const options = model.upgrades.filter((u) => u.slot === slot)
      if (options.length === 0) return null
      return h(
        'div',
        'wr-slot',
        h('h3', 'wr-slot__name', SLOT_LABEL[slot]),
        h(
          'div',
          'wr-slot__options',
          stockOption(a, slot, owned),
          options.map((u) => {
            const available = isUpgradeUnlocked(u, progress)
            const on = equippedIds(a.id).includes(u.id)
            const hint = available ? null : unlockHint(u.unlock, progress)
            const card = h(
              'button',
              {
                class: `wr-upg${on ? ' is-on' : ''}${available ? '' : ' is-locked'}`,
                type: 'button',
                'data-key': `u:${u.id}`,
                'aria-pressed': String(on),
                disabled: !available || !owned,
              },
              h('span', 'wr-upg__head', h('span', 'wr-upg__name', u.name), on ? h('span', 'wr-upg__tag', 'Fitted') : null),
              u.description ? h('span', 'wr-upg__desc', u.description) : null,
              effectChips(u),
              hint ? h('span', 'wr-upg__lock', hint) : null,
            )
            card.addEventListener('click', () => {
              if (!available || !owned || on) return
              const kept = equippedIds(a.id).filter((id) => model.upgrades.find((x) => x.id === id)?.slot !== u.slot)
              progress = { ...progress, loadouts: { ...progress.loadouts, [a.id]: [...kept, u.id] } }
              cb.onEquip(a.id, u.id)
              render()
            })
            return card
          }),
        ),
      )
    })

    const palette = liveryPalette()
    const current = progress.livery[a.id] ?? palette[0]
    const swatches = palette.map((color, i) => {
      const sw = h('button', {
        class: 'wr-swatch',
        type: 'button',
        'data-key': `s:${i}`,
        'aria-pressed': String(current === color),
        'aria-label': `Livery color ${i + 1}`,
        disabled: !owned,
      })
      sw.style.setProperty('--wr-swatch', `var(${LIVERY_VARS[i]})`)
      sw.addEventListener('click', () => {
        progress = { ...progress, livery: { ...progress.livery, [a.id]: color } }
        cb.onLivery(a.id, color)
        render()
      })
      return sw
    })

    detail.replaceChildren(
      h(
        'div',
        'wr-hangar__fit',
        h('h2', 'wr-sheet__title', owned ? `Fit out the ${a.name}` : `${a.name} is not in your hangar yet`),
        owned
          ? null
          : h(
              'p',
              'wr-hangar__locked-note',
              model.unlockHints[a.id] ? `To earn it: ${model.unlockHints[a.id]}. ` : '',
              'You can already study its upgrades.',
            ),
        slots,
      ),
      h(
        'aside',
        'wr-hangar__sheet',
        h('h2', 'wr-sheet__title', 'Against the stock aircraft'),
        h('p', 'wr-hangar__rule', 'Every upgrade is a tradeoff. It moves a compromise; it never adds raw power.'),
        diff.length === 0
          ? h('p', 'wr-hangar__empty', 'Stock configuration. Fit an upgrade to see what it gives and what it costs.')
          : h(
              'table',
              'wr-diff',
              h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Stock'), h('th', {}, 'Fitted'), h('th', {}, ''))),
              h(
                'tbody',
                {},
                diff.map((r) =>
                  h(
                    'tr',
                    `wr-diff__row wr-diff__row--${r.effect}`,
                    h('th', { scope: 'row' }, r.label),
                    h('td', {}, r.base),
                    h('td', {}, r.value),
                    h('td', 'wr-diff__chg', formatChange(r.change)),
                  ),
                ),
              ),
            ),
        h('div', 'wr-legend', h('span', 'wr-legend__benefit', 'gives'), h('span', 'wr-legend__cost', 'costs'), h('span', 'wr-legend__trait', 'changes the feel')),
        h('h2', 'wr-sheet__title', 'Livery'),
        h('div', { class: 'wr-swatches', role: 'group', 'aria-label': 'Livery color' }, swatches),
      ),
    )
  }

  const render = (): void => {
    // Re-rendering replaces nodes; keep keyboard focus on the same control.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : undefined
    renderGallery()
    renderDetail()
    if (focused) screen.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  }

  const back = h('button', { class: 'wr-btn wr-btn--quiet', type: 'button' }, 'Back to menu')
  back.addEventListener('click', () => cb.onBack())

  const screen = h(
    'section',
    { class: 'wr-screen wr-hangar', 'aria-label': 'Hangar' },
    h('header', 'wr-hangar__header', h('h1', 'wr-hangar__title', 'Hangar'), back),
    gallery,
    h('div', 'wr-sheet wr-hangar__body', detail),
  )
  render()
  return screen
}
