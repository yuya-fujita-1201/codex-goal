import { describe, expect, it } from 'vitest'

import { canManuallyMarkAchieved } from './manualCompletion'

describe('canManuallyMarkAchieved', () => {
  it('allows a paused non-running goal to be manually completed', () => {
    expect(canManuallyMarkAchieved('paused', false)).toBe(true)
  })

  it('does not allow manual completion while a runner is active', () => {
    expect(canManuallyMarkAchieved('paused', true)).toBe(false)
  })

  it('does not allow manual completion from non-paused states', () => {
    expect(canManuallyMarkAchieved('active', false)).toBe(false)
    expect(canManuallyMarkAchieved('pending', false)).toBe(false)
    expect(canManuallyMarkAchieved('achieved', false)).toBe(false)
    expect(canManuallyMarkAchieved('abandoned', false)).toBe(false)
  })
})
