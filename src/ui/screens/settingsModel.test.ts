import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../core/presentation'
import { clampLevel, levelFromPercent, percent, sameSettings, withLevel, withSwitch } from './settingsModel'

describe('settings edits', () => {
  it('clamps and snaps levels to 5% steps', () => {
    expect(clampLevel(1.4)).toBe(1)
    expect(clampLevel(-0.2)).toBe(0)
    expect(clampLevel(0.333)).toBe(0.35)
    expect(clampLevel(0.61)).toBe(0.6)
    expect(clampLevel(Number.NaN)).toBe(0)
  })

  it('reads range input strings', () => {
    expect(levelFromPercent('75')).toBe(0.75)
    expect(levelFromPercent('')).toBe(0)
    expect(levelFromPercent('250')).toBe(1)
    expect(levelFromPercent('abc')).toBe(0)
  })

  it('formats as whole percent', () => {
    expect(percent(0.8)).toBe('80%')
    expect(percent(0.051)).toBe('5%')
  })

  it('edits one field and leaves the rest untouched', () => {
    const s = withLevel(DEFAULT_SETTINGS, 'flowIntensity', 0.42)
    expect(s).toEqual({ ...DEFAULT_SETTINGS, flowIntensity: 0.4 })
    expect(withSwitch(s, 'invertPitch', true)).toEqual({ ...s, invertPitch: true })
    expect(DEFAULT_SETTINGS.flowIntensity).toBe(1)
  })

  it('compares settings by value', () => {
    expect(sameSettings(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(true)
    expect(sameSettings(DEFAULT_SETTINGS, withSwitch(DEFAULT_SETTINGS, 'coaching', false))).toBe(false)
  })
})
