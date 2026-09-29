import { describe, expect, it } from 'vitest'
import { parseShareHash, shareUrl } from './share'

const CODE = 'eJx+ab/c=d_e-f'

describe('shareUrl / parseShareHash', () => {
  it('round-trips through the fragment, including base64 + / = characters', () => {
    const url = shareUrl('https://weather-rider.app/play?x=1#old', CODE)
    expect(url.startsWith('https://weather-rider.app/play?x=1#g=')).toBe(true)
    expect(url).not.toContain('#old')
    expect(parseShareHash(new URL(url).hash)).toBe(CODE)
    expect(parseShareHash(url)).toBe(CODE)
  })

  it('accepts a raw code, trimmed', () => {
    expect(parseShareHash(`  ${CODE}\n`)).toBe(CODE)
    expect(parseShareHash(`g=${encodeURIComponent(CODE)}`)).toBe(CODE)
  })

  it('finds g among other fragment params', () => {
    expect(parseShareHash('#foo=1&g=abc&bar=2')).toBe('abc')
  })

  it.each(['', '   ', '#', '#g=', '#other=1', 'https://weather-rider.app/', 'two words', '#g=%E0%A4%A'])('rejects %j', (input) => {
    expect(parseShareHash(input)).toBeNull()
  })
})
