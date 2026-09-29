// Pure display helpers shared by HUD and screens.
import { SEVERE_TURBULENCE } from '../core/constants'
import type { WeatherFeatureKind } from '../core/types'

const THIN_SPACE = ' '
const MINUS = '−'

/** 32400 → "32 400" (thin-space grouping reads well at small sizes). */
export const groupThousands = (n: number): string => {
  const r = Math.round(n)
  const s = Math.abs(r).toString().replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE)
  return r < 0 ? MINUS + s : s
}

/** Signed with a true minus sign; zero has no sign. */
export const signed = (n: number, digits = 0): string => {
  const f = Math.abs(n).toFixed(digits)
  if (Number(f) === 0) return f
  return (n > 0 ? '+' : MINUS) + f
}

/** Displayed ("real") flight time. 17460 → "4h51", 2700 → "45 min", 42 → "0 min". */
export const flightTime = (s: number): string => {
  const total = Math.max(0, Math.floor(s / 60))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m} min`
}

/** Ghost delta: + = you are ahead. */
export const ghostDelta = (s: number): { text: string; state: 'ahead' | 'behind' | 'level' } => {
  const rounded = Math.round(s * 10) / 10
  if (rounded === 0) return { text: '0.0 s', state: 'level' }
  return { text: `${signed(rounded, 1)} s`, state: rounded > 0 ? 'ahead' : 'behind' }
}

export type SeverityBucket = 'calm' | 'moderate' | 'extreme'
export const severityBucket = (severity: number): SeverityBucket =>
  severity < 0.34 ? 'calm' : severity < 0.67 ? 'moderate' : 'extreme'

export type TurbulenceLevel = 'smooth' | 'light' | 'moderate' | 'severe'
export const turbulenceLevel = (t: number): TurbulenceLevel =>
  t >= SEVERE_TURBULENCE ? 'severe' : t >= 0.4 ? 'moderate' : t >= 0.15 ? 'light' : 'smooth'

const FEATURE_LABEL: Record<WeatherFeatureKind, string> = {
  storm: 'storm cell',
  updraft: 'updraft',
  downdraft: 'downdraft',
  thermal: 'thermal',
  jetstream: 'jet stream',
  shear: 'wind shear',
  wake: 'wake turbulence',
}
export const featureLabel = (kind: WeatherFeatureKind): string => FEATURE_LABEL[kind]

export type RecordState = 'first' | 'record' | 'tie' | 'below'
export const recordState = (value: number, previous: number | null): RecordState =>
  previous === null ? 'first' : value > previous ? 'record' : value === previous ? 'tie' : 'below'

/** Share link: the ghost rides in the hash so it never reaches a server. */
export const shareUrl = (origin: string, pathname: string, ghostCode: string): string =>
  `${origin}${pathname}#g=${ghostCode}`

/** Wrap an angle to (-180, 180]. */
export const wrapDeg = (deg: number): number => {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180
  return d === -180 ? 180 : d
}
