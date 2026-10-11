// Tests and sandbox only: TerrainParams for the real daily routes, the way the shell builds them
// (meta owns the production mapping, terrainParamsFor).
import { hashInts, hashString } from '../core/rng'
import type { DailyWeather, Route, TerrainParams } from '../core/types'
import { dailyWeatherFor, routeBounds } from '../meta'

export function paramsFor(daily: DailyWeather, route: Route): TerrainParams {
  return {
    seed: hashInts(daily.seed, hashString(route.id), 0x7e55),
    ...routeBounds(route),
    start: route.start,
    gate: route.gate,
    departureName: route.from,
    arrivalName: route.to,
    startAlt: route.start.y,
    gateMinAlt: route.gateMinAlt,
  }
}

/** Every route of days [first, first + count). */
export function dailyParams(first: number, count: number): { day: number; route: Route; params: TerrainParams }[] {
  const out: { day: number; route: Route; params: TerrainParams }[] = []
  for (let day = first; day < first + count; day++) {
    const daily = dailyWeatherFor(day)
    for (const route of daily.routes) out.push({ day, route, params: paramsFor(daily, route) })
  }
  return out
}
