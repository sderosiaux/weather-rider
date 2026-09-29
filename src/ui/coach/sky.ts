import type { FlightScore } from '../../core/types'

/** Below this share the sky gave nothing worth naming. */
const NOTABLE_UTILIZATION = 5

/** One line on what the sky gave or cost this flight. */
export const skyLine = (score: Pick<FlightScore, 'weatherUtilization' | 'severeTurbulenceS'>): string => {
  const u = Math.round(score.weatherUtilization)
  const sev = Math.round(score.severeTurbulenceS)
  const gave = u >= NOTABLE_UTILIZATION
  if (gave && sev > 0) return `The sky carried ${u}% of your energy, and cost ${sev} s in severe turbulence.`
  if (gave) return `The sky carried ${u}% of your energy, without a second of severe turbulence.`
  if (sev > 0) return `${sev} s in severe turbulence, and almost nothing back from the sky.`
  return 'The engines did all the work. Rising air and jet streams are free energy.'
}
