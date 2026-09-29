import { describe, expect, it } from 'vitest'
import { NEUTRAL_FRAME } from './mix'
import { createAudio } from './index'

describe('createAudio without Web Audio (node, SSR, blocked context)', () => {
  it('every method is a safe no-op, and dispose is idempotent', () => {
    const a = createAudio()
    expect(() => {
      a.update(NEUTRAL_FRAME, 1 / 60)
      a.setScene('flight')
      a.cue('arrived')
      a.setVolume(0.3)
      a.resume()
      a.dispose()
      a.dispose()
      a.resume()
    }).not.toThrow()
  })
})
