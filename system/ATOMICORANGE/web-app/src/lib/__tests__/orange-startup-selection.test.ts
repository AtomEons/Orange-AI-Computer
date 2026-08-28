import { describe, expect, it } from 'vitest'
import { shouldClearStartupModelSelection } from '../orange-startup-selection'

describe('Atomic Orange startup selection', () => {
  it('preserves OrangeBrain when local model preload is disabled', () => {
    expect(shouldClearStartupModelSelection(false, 'orangebrain')).toBe(false)
  })

  it('still clears an ordinary local model when preload is disabled', () => {
    expect(shouldClearStartupModelSelection(false, 'llamacpp-upstream')).toBe(
      true
    )
  })

  it('preserves every selected provider when preload is enabled', () => {
    expect(shouldClearStartupModelSelection(true, 'llamacpp-upstream')).toBe(
      false
    )
  })
})
