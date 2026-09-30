import { describe, expect, it } from 'vitest'
import { PILOT_NAME_MAX, UNNAMED, cleanName, displayName, pilotNameFrom } from './pilotName'

const graphemeCount = (s: string): number => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)).length

describe('pilot names on the boards', () => {
  it('shows ordinary names as they are', () => {
    expect(displayName('Ada')).toBe('Ada')
    expect(displayName('Zoë ✈')).toBe('Zoë ✈')
    expect(displayName('مسافر الريح')).toBe('مسافر الريح')
  })

  it('keeps markup as literal text, shortened like any long name', () => {
    const shown = displayName('<img src=x onerror=alert(1)>')
    expect(shown).toBe('<img src=x onerror=…')
    expect(graphemeCount(shown)).toBe(PILOT_NAME_MAX)
  })

  it('ellipsizes a 60-character name to 20 characters', () => {
    const long = 'Captain Maximilian Alexander von Stratosphere-Cumulonimbus 3'
    expect(long).toHaveLength(60)
    const shown = displayName(long)
    expect(shown).toBe('Captain Maximilian…')
    expect(graphemeCount(shown)).toBeLessThanOrEqual(PILOT_NAME_MAX)
  })

  it('drops direction overrides and invisible characters', () => {
    expect(displayName('\u202Eyrollam')).toBe('yrollam')
    expect(displayName('Ada\u200B')).toBe('Ada')
    expect(displayName('A\u2066d\u2069a\uFEFF')).toBe('Ada')
    expect(displayName('Ada\uD800')).toBe('Ada')
  })

  it('collapses whitespace and line breaks', () => {
    expect(displayName('  Ada \n\t Lovelace  ')).toBe('Ada Lovelace')
    expect(displayName('Ada  Lovelace')).toBe('Ada Lovelace')
  })

  it('caps piled combining marks so a name cannot paint over its neighbours', () => {
    const shown = displayName('Z' + '\u0336\u0322\u031B\u0316\u0353\u0308\u0300\u0301'.repeat(3) + 'a')
    expect(shown.startsWith('Z')).toBe(true)
    expect(shown.endsWith('a')).toBe(true)
    expect(shown.match(/\p{M}/gu)).toHaveLength(3)
  })

  it('never cuts a character in half', () => {
    expect(displayName('A'.repeat(18) + '🇫🇷🇫🇷🇫🇷')).toBe('A'.repeat(18) + '🇫🇷…')
  })

  it('names a ghost that carries nothing printable', () => {
    expect(displayName('')).toBe(UNNAMED)
    expect(displayName(' \u200B\u202E ')).toBe(UNNAMED)
  })

  it('bounds the work on an absurdly long name', () => {
    expect(displayName('W'.repeat(100_000))).toBe('W'.repeat(19) + '…')
  })
})

describe('pilot name from the Settings field', () => {
  it('trims and collapses what was typed', () => {
    expect(pilotNameFrom('  Ada   Lovelace ')).toBe('Ada Lovelace')
    expect(cleanName('Ada\u202E')).toBe('Ada')
  })

  it('is empty when nothing printable was typed', () => {
    expect(pilotNameFrom('')).toBe('')
    expect(pilotNameFrom('   ')).toBe('')
    expect(pilotNameFrom('\u200B')).toBe('')
  })

  it('keeps at most 20 UTF-16 units, the shell’s own cut, without leaving half an emoji', () => {
    expect(pilotNameFrom('A'.repeat(25))).toBe('A'.repeat(20))
    expect(pilotNameFrom('A'.repeat(19) + '😀')).toBe('A'.repeat(19))
    expect(pilotNameFrom('A'.repeat(18) + '😀')).toBe('A'.repeat(18) + '😀')
    expect(pilotNameFrom('Ada Lovelace Byron Kin')).toBe('Ada Lovelace Byron K')
    expect(pilotNameFrom('Ada Lovelace Byron  K')).toBe('Ada Lovelace Byron K')
  })
})
