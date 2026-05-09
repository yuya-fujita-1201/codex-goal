import { describe, expect, it } from 'vitest'

import {
  decideAchievementVerification,
  effectiveVerificationMode
} from './verification'

describe('effectiveVerificationMode', () => {
  it('defaults new and legacy goals to smart verification', () => {
    expect(effectiveVerificationMode({})).toBe('smart')
    expect(effectiveVerificationMode({ checker_required: false })).toBe('smart')
  })

  it('maps legacy checker_required goals to strict verification', () => {
    expect(effectiveVerificationMode({ checker_required: true })).toBe('strict')
  })

  it('honors explicit verification_mode over legacy checker_required', () => {
    expect(effectiveVerificationMode({ verification_mode: 'smart', checker_required: true })).toBe(
      'smart'
    )
    expect(effectiveVerificationMode({ verification_mode: 'off', checker_required: true })).toBe(
      'off'
    )
  })
})

describe('decideAchievementVerification', () => {
  it('accepts achievement when checker passes', () => {
    expect(decideAchievementVerification('smart', 'pass').action).toBe('achieved')
    expect(decideAchievementVerification('strict', 'pass').action).toBe('achieved')
  })

  it('uses judge as the fallback in smart mode', () => {
    expect(decideAchievementVerification('smart', 'fail').action).toBe('needs_judge')
    expect(decideAchievementVerification('smart', 'placeholder_checker').action).toBe(
      'needs_judge'
    )
    expect(decideAchievementVerification('smart', 'fail', 'achieved').action).toBe('achieved')
    expect(decideAchievementVerification('smart', 'fail', 'not_yet').action).toBe('rejected')
  })

  it('does not allow strict mode to pass without a real checker pass', () => {
    expect(decideAchievementVerification('strict', 'fail').action).toBe('rejected')
    expect(decideAchievementVerification('strict', 'no_checker').action).toBe('rejected')
  })

  it('falls back to judge when strict mode only has the bundled sample checker', () => {
    expect(decideAchievementVerification('strict', 'placeholder_checker').action).toBe(
      'needs_judge'
    )
    expect(decideAchievementVerification('strict', 'placeholder_checker', 'achieved').action).toBe(
      'achieved'
    )
  })

  it('accepts worker achievement directly when verification is off', () => {
    expect(decideAchievementVerification('off', 'fail').action).toBe('achieved')
    expect(decideAchievementVerification('off', 'no_checker').action).toBe('achieved')
  })
})
