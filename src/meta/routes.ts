// Real city pairs, flavour only: the game never simulates the globe, it lays each route
// out in its own flat space (SPEC §10) and rescales time for display.

interface Airport {
  readonly lat: number
  readonly lon: number
}

const AIRPORTS: Readonly<Record<string, Airport>> = {
  AKL: { lat: -37.0082, lon: 174.785 },
  ANC: { lat: 61.1743, lon: -149.9963 },
  BKK: { lat: 13.69, lon: 100.7501 },
  BOG: { lat: 4.7016, lon: -74.1469 },
  CDG: { lat: 49.0097, lon: 2.5479 },
  CPT: { lat: -33.9715, lon: 18.6021 },
  DEL: { lat: 28.5562, lon: 77.1 },
  DXB: { lat: 25.2532, lon: 55.3657 },
  EZE: { lat: -34.8222, lon: -58.5358 },
  FRA: { lat: 50.0379, lon: 8.5622 },
  GRU: { lat: -23.4356, lon: -46.4731 },
  HKG: { lat: 22.308, lon: 113.9185 },
  HND: { lat: 35.5494, lon: 139.7798 },
  HNL: { lat: 21.3187, lon: -157.9225 },
  ICN: { lat: 37.4602, lon: 126.4407 },
  IST: { lat: 41.2753, lon: 28.7519 },
  JFK: { lat: 40.6413, lon: -73.7781 },
  JNB: { lat: -26.1392, lon: 28.246 },
  KEF: { lat: 63.985, lon: -22.6056 },
  LAX: { lat: 33.9416, lon: -118.4085 },
  LHR: { lat: 51.47, lon: -0.4543 },
  LIS: { lat: 38.7813, lon: -9.1359 },
  MAD: { lat: 40.4983, lon: -3.5676 },
  MEX: { lat: 19.4361, lon: -99.0719 },
  NRT: { lat: 35.772, lon: 140.3929 },
  ORD: { lat: 41.9742, lon: -87.9073 },
  SFO: { lat: 37.6213, lon: -122.379 },
  SIN: { lat: 1.3644, lon: 103.9915 },
  SYD: { lat: -33.9399, lon: 151.1753 },
  YVR: { lat: 49.1967, lon: -123.1815 },
}

const PAIRS: readonly (readonly [string, string])[] = [
  ['JFK', 'LIS'], ['LHR', 'JFK'], ['NRT', 'SFO'], ['SYD', 'AKL'], ['CDG', 'DXB'], ['SIN', 'SYD'],
  ['LAX', 'HNL'], ['GRU', 'JNB'], ['FRA', 'ORD'], ['HKG', 'YVR'], ['MEX', 'MAD'], ['EZE', 'CPT'],
  ['KEF', 'JFK'], ['ICN', 'ANC'], ['DEL', 'LHR'], ['BOG', 'MAD'], ['IST', 'BKK'], ['HND', 'HKG'],
  ['SFO', 'SIN'], ['DXB', 'JNB'], ['LHR', 'SIN'], ['LAX', 'SYD'], ['CDG', 'GRU'], ['ANC', 'NRT'],
]

export interface CatalogRoute {
  readonly from: string
  readonly to: string
  /** Great-circle distance, rounded to the km so every JS engine agrees on it. */
  readonly realDistanceKm: number
}

const EARTH_RADIUS_KM = 6371.0088

function greatCircleKm(a: Airport, b: Airport): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export const ROUTE_CATALOG: readonly CatalogRoute[] = PAIRS.map(([from, to]) => {
  const a = AIRPORTS[from]
  const b = AIRPORTS[to]
  if (!a || !b) throw new Error(`route catalog: unknown airport in ${from}-${to}`)
  return { from, to, realDistanceKm: Math.round(greatCircleKm(a, b)) }
})
