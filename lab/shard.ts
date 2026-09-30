// Parallel lab: vitest runs each lab/shards/*.lab.ts file in its own worker. Every shard flies a slice of
// the (day, route) units and drops its rows in lab/reports/.cache; balance.lab.ts waits for all shards of
// the same vitest run (same parent pid) and writes the report. Always run the whole `pnpm lab`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ghostCodec } from '../src/scoring'
import { PILOTS, runMatrix, type FlightRow } from './matrix'

/** WORLD WEATHER #272 = 2026-09-29, the day this lab was first run. Fixed so reruns are comparable. */
export const FIRST_DAY = 272
export const DAYS = Number(process.env.LAB_DAYS ?? 14)
export const SHARDS = 12
export const CACHE = 'lab/reports/.cache'

export const labDays = (): number[] => Array.from({ length: DAYS }, (_, i) => FIRST_DAY + i)

export interface ShardFile {
  readonly run: number
  readonly shard: number
  readonly wallS: number
  readonly rows: FlightRow[]
  /** Fastest surfer flight per `${day}:${tier}` in this shard, ghost-encoded. */
  readonly ghosts: Record<string, { row: FlightRow; code: string }>
  /** Set when the shard crashed. */
  readonly error?: string
}

export const shardPath = (k: number): string => `${CACHE}/shard-${k}.json`

export function runShard(k: number): void {
  try {
    flyShard(k)
  } catch (err) {
    // Tell the waiting report right away instead of letting it time out.
    mkdirSync(CACHE, { recursive: true })
    writeFileSync(shardPath(k), JSON.stringify({ run: process.ppid, shard: k, error: String((err as Error).stack ?? err) }))
    throw err
  }
}

function flyShard(k: number): void {
  const result = runMatrix(labDays(), PILOTS, undefined, (di, ti) => (di * 3 + ti) % SHARDS === k)
  const ghosts: ShardFile['ghosts'] = {}
  for (const [key, g] of result.ghosts) ghosts[key] = { row: g.row, code: ghostCodec.encode(g.ghost) }
  mkdirSync(CACHE, { recursive: true })
  const file: ShardFile = { run: process.ppid, shard: k, wallS: result.wallS, rows: result.rows, ghosts }
  writeFileSync(shardPath(k), JSON.stringify(file))
}

/** Shard k of the current vitest run, or null while it is still flying. */
export function readShard(k: number): ShardFile | null {
  if (!existsSync(shardPath(k))) return null
  try {
    const f = JSON.parse(readFileSync(shardPath(k), 'utf8')) as ShardFile
    return f.run === process.ppid ? f : null
  } catch {
    return null
  }
}
