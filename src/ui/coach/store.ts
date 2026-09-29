// What the coach remembers about the pilot, in the UI's own localStorage key.
import { PRIORITY, type HintId } from './coach'

export const COACH_KEY = 'weather-rider.ui.coach'

export interface CoachMemory {
  readonly version: 1
  readonly enabled: boolean
  readonly retired: readonly HintId[]
  /** Progress toward the jet stream lesson, which is cumulative across flights. */
  readonly jetRideS: number
}

export const DEFAULT_MEMORY: CoachMemory = { version: 1, enabled: true, retired: [], jetRideS: 0 }

const isHint = (x: unknown): x is HintId => typeof x === 'string' && (PRIORITY as readonly string[]).includes(x)

/** Anything unreadable (other version, hand-edited, truncated) starts over rather than half-applying. */
export const parseMemory = (raw: string | null): CoachMemory => {
  if (raw === null) return DEFAULT_MEMORY
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return DEFAULT_MEMORY
    const o = v as Record<string, unknown>
    if (o.version !== 1 || typeof o.enabled !== 'boolean' || !Array.isArray(o.retired) || !o.retired.every(isHint)) return DEFAULT_MEMORY
    const jet = typeof o.jetRideS === 'number' && Number.isFinite(o.jetRideS) && o.jetRideS >= 0 ? o.jetRideS : 0
    return { version: 1, enabled: o.enabled, retired: [...new Set(o.retired)], jetRideS: jet }
  } catch {
    return DEFAULT_MEMORY
  }
}

type KV = Pick<Storage, 'getItem' | 'setItem'>

const safeStorage = (): KV | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const loadMemory = (storage: KV | null = safeStorage()): CoachMemory => {
  try {
    return parseMemory(storage?.getItem(COACH_KEY) ?? null)
  } catch {
    return DEFAULT_MEMORY
  }
}

export const saveMemory = (m: CoachMemory, storage: KV | null = safeStorage()): void => {
  try {
    storage?.setItem(COACH_KEY, JSON.stringify(m))
  } catch {
    // Private mode / quota: coaching still works for this session.
  }
}
