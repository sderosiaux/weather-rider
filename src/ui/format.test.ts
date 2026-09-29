import { describe, expect, it } from 'vitest'
import {
  flightTime,
  ghostDelta,
  groupThousands,
  humanizeId,
  recordState,
  severityBucket,
  shareUrl,
  signed,
  turbulenceLevel,
  wrapDeg,
} from './format'

describe('format', () => {
  it('groups thousands with thin spaces and a real minus', () => {
    expect(groupThousands(32400)).toBe('32 400')
    expect(groupThousands(950)).toBe('950')
    expect(groupThousands(-1250.4)).toBe('−1 250')
  })

  it('signs numbers without "-0"', () => {
    expect(signed(1200)).toBe('+1200')
    expect(signed(-3.14, 1)).toBe('−3.1')
    expect(signed(-0.01, 1)).toBe('0.0')
  })

  it('formats the displayed flight time like the spec (4h51)', () => {
    expect(flightTime(4 * 3600 + 51 * 60 + 30)).toBe('4h51')
    expect(flightTime(3600 + 5 * 60)).toBe('1h05')
    expect(flightTime(45 * 60)).toBe('45 min')
    expect(flightTime(-5)).toBe('0 min')
  })

  it('ghost delta: positive = ahead', () => {
    expect(ghostDelta(12.44)).toEqual({ text: '+12.4 s', state: 'ahead' })
    expect(ghostDelta(-3.06).state).toBe('behind')
    expect(ghostDelta(0.02)).toEqual({ text: '0.0 s', state: 'level' })
  })

  it('buckets severity and turbulence', () => {
    expect(severityBucket(0.1)).toBe('calm')
    expect(severityBucket(0.5)).toBe('moderate')
    expect(severityBucket(0.9)).toBe('extreme')
    expect(turbulenceLevel(0.05)).toBe('smooth')
    expect(turbulenceLevel(0.7)).toBe('severe')
    expect(turbulenceLevel(0.5)).toBe('moderate')
  })

  it('compares against previous best (higher = better)', () => {
    expect(recordState(800, null)).toBe('first')
    expect(recordState(800, 700)).toBe('record')
    expect(recordState(700, 700)).toBe('tie')
    expect(recordState(600, 700)).toBe('below')
  })

  it('builds the share link with the ghost in the hash', () => {
    expect(shareUrl('https://x.io', '/play/', 'abc')).toBe('https://x.io/play/#g=abc')
  })

  it('humanizes ids and wraps angles', () => {
    expect(humanizeId('narrowbody-a320')).toBe('Narrowbody A320')
    expect(wrapDeg(190)).toBe(-170)
    expect(wrapDeg(-180)).toBe(180)
    expect(wrapDeg(45)).toBe(45)
  })
})
