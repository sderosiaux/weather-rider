import type { Settings } from '../../core/presentation'
import { h } from '../dom'
import { PILOT_NAME_MAX } from './pilotName'
import {
  levelFromPercent,
  percent,
  restoreDefaults,
  sameSettings,
  withLevel,
  withPilotName,
  withSwitch,
  type LevelKey,
  type SwitchKey,
} from './settingsModel'

export interface SettingsCallbacks {
  onChange(settings: Settings): void
  onBack(): void
}

/** Every edit applies immediately (the live sky behind the panel is the preview); the name applies when you leave the field or press Enter. */
export const renderSettings = (initial: Settings, cb: SettingsCallbacks): HTMLElement => {
  let current = initial
  const syncers: (() => void)[] = []

  const commit = (next: Settings): void => {
    if (sameSettings(next, current)) return
    current = next
    for (const s of syncers) s()
    cb.onChange(next)
  }

  const toggle = (key: SwitchKey, label: string, help: string): HTMLElement => {
    const id = `wr-set-${key}`
    const box = h('input', { type: 'checkbox', class: 'wr-switch__input', id, 'data-key': id })
    syncers.push(() => {
      box.checked = current[key]
    })
    box.addEventListener('change', () => commit(withSwitch(current, key, box.checked)))
    return h(
      'label',
      { class: 'wr-switch wr-setting', for: id },
      box,
      h('span', 'wr-switch__track', h('span', 'wr-switch__thumb')),
      h('span', 'wr-switch__text', h('b', {}, label), h('span', {}, help)),
    )
  }

  const level = (key: LevelKey, label: string, help: string): HTMLElement => {
    const id = `wr-set-${key}`
    const out = h('output', { class: 'wr-level__value', for: id })
    const range = h('input', { type: 'range', class: 'wr-level__range', id, min: 0, max: 100, step: 5, 'data-key': id })
    const sync = (): void => {
      const pct = Math.round(current[key] * 100)
      range.value = String(pct)
      range.style.setProperty('--wr-level', `${pct}%`)
      out.textContent = percent(current[key])
    }
    syncers.push(sync)
    range.addEventListener('input', () => commit(withLevel(current, key, levelFromPercent(range.value))))
    return h(
      'div',
      'wr-level wr-setting',
      h('div', 'wr-level__head', h('label', { for: id }, label), out),
      range,
      h('p', 'wr-level__help', help),
    )
  }

  const pilotName = (): HTMLElement => {
    const id = 'wr-set-pilotName'
    const input = h('input', {
      class: 'wr-field__input',
      type: 'text',
      id,
      maxlength: PILOT_NAME_MAX,
      autocomplete: 'nickname',
      spellcheck: 'false',
      enterkeyhint: 'done',
      'aria-describedby': `${id}-help`,
      'data-key': id,
    })
    const status = h('span', { class: 'wr-name__status', role: 'status', 'aria-live': 'polite' })
    const say = (text: string, state: 'ok' | 'warn' | ''): void => {
      status.textContent = text
      status.dataset.state = state
    }
    syncers.push(() => {
      input.value = current.pilotName
    })
    // Commit on Enter or leaving the field (change), never per keystroke: the name is stamped into ghosts.
    const commitName = (): void => {
      const next = withPilotName(current, input.value)
      if (!next) {
        input.value = current.pilotName
        say('Can’t be empty', 'warn')
      } else if (next.pilotName === current.pilotName) {
        input.value = current.pilotName
      } else {
        commit(next)
        say('Saved', 'ok')
      }
    }
    input.addEventListener('change', commitName)
    input.addEventListener('input', () => say('', ''))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitName()
      // First Esc undoes an unsaved edit; the next one closes Settings as usual.
      if (e.key === 'Escape' && input.value !== current.pilotName) {
        e.stopPropagation()
        input.value = current.pilotName
      }
    })
    return h(
      'div',
      'wr-name wr-setting',
      h('div', 'wr-name__head', h('label', { for: id }, 'Pilot name'), status),
      input,
      h('p', { class: 'wr-name__help', id: `${id}-help` }, 'Shown on your shared ghosts and on today’s boards.'),
    )
  }

  const reset = h('button', { class: 'wr-btn wr-btn--quiet wr-btn--sm', type: 'button' }, 'Restore defaults')
  reset.addEventListener('click', () => commit(restoreDefaults(current)))
  const back = h('button', { class: 'wr-btn wr-btn--primary', type: 'button' }, 'Done')
  back.addEventListener('click', () => cb.onBack())

  const screen = h(
    'section',
    { class: 'wr-screen wr-settings', 'aria-label': 'Settings', 'data-screen': 'settings' },
    h(
      'div',
      'wr-sheet wr-settings__panel',
      h('h1', 'wr-settings__title', 'Settings'),
      pilotName(),
      h('h2', 'wr-sheet__title', 'Flying'),
      toggle('invertPitch', 'Invert pitch', 'Pull back (mouse down, S, stick back) to climb, like a real yoke. Off: push toward the top of the screen to climb.'),
      toggle('coaching', 'Coaching', 'Short in-flight tips on reading the sky. Each one retires once you’ve shown you know it.'),
      h('h2', 'wr-sheet__title', 'Sky'),
      level('flowIntensity', 'Wind particles', 'How visible the air currents are. The sky behind this panel shows the change. Lower it if the motion feels busy.'),
      h('h2', 'wr-sheet__title', 'Sound'),
      level('volume', 'Volume', 'Wind, engines and the weather around you.'),
      h('div', 'wr-actions', reset, back),
    ),
  )
  for (const s of syncers) s()
  return screen
}
