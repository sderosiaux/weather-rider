// Pure edits on Settings: sliders produce clean, bounded values whatever the DOM hands us.
import type { Settings } from '../../core/presentation'

export type LevelKey = 'volume' | 'flowIntensity'
export type SwitchKey = 'invertPitch' | 'coaching'

/** Slider granularity: 5% steps read as whole percentages and don't spam the shell with float noise. */
export const LEVEL_STEP = 0.05

export const clampLevel = (v: number): number => {
  if (!Number.isFinite(v)) return 0
  const snapped = Math.round(v / LEVEL_STEP) * LEVEL_STEP
  return Math.min(1, Math.max(0, Math.round(snapped * 100) / 100))
}

/** Range inputs give 0..100 strings. */
export const levelFromPercent = (raw: string): number => clampLevel(Number(raw) / 100)

export const percent = (v: number): string => `${Math.round(clampLevel(v) * 100)}%`

export const withLevel = (s: Settings, key: LevelKey, v: number): Settings => ({ ...s, [key]: clampLevel(v) })

export const withSwitch = (s: Settings, key: SwitchKey, on: boolean): Settings => ({ ...s, [key]: on })

export const sameSettings = (a: Settings, b: Settings): boolean =>
  a.invertPitch === b.invertPitch && a.coaching === b.coaching && a.volume === b.volume && a.flowIntensity === b.flowIntensity
