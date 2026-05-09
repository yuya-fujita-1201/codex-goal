import type { GoalState } from './types'

export type VerificationMode = 'smart' | 'strict' | 'off'
export type CheckerRunOutcome = 'pass' | 'fail' | 'no_checker' | 'placeholder_checker'
export type JudgeVerificationVerdict = 'achieved' | 'not_yet' | 'error'

export const DEFAULT_VERIFICATION_MODE: VerificationMode = 'smart'

export function isVerificationMode(value: unknown): value is VerificationMode {
  return value === 'smart' || value === 'strict' || value === 'off'
}

export function effectiveVerificationMode(
  state: Pick<GoalState, 'verification_mode' | 'checker_required'>
): VerificationMode {
  if (isVerificationMode(state.verification_mode)) return state.verification_mode
  if (state.checker_required === true) return 'strict'
  return DEFAULT_VERIFICATION_MODE
}

export type AchievementVerificationDecision =
  | { action: 'achieved'; reason: string }
  | { action: 'needs_judge'; reason: string }
  | { action: 'rejected'; reason: string }

export function decideAchievementVerification(
  mode: VerificationMode,
  checkerOutcome: CheckerRunOutcome,
  judgeVerdict?: JudgeVerificationVerdict
): AchievementVerificationDecision {
  if (mode === 'off') {
    return { action: 'achieved', reason: 'verification is off' }
  }

  if (checkerOutcome === 'pass') {
    return { action: 'achieved', reason: 'checker passed' }
  }

  if (mode === 'strict' && checkerOutcome === 'placeholder_checker') {
    if (judgeVerdict === 'achieved') {
      return {
        action: 'achieved',
        reason: 'judge confirmed achievement because strict verification only had the bundled sample checker'
      }
    }
    if (judgeVerdict !== undefined) {
      return {
        action: 'rejected',
        reason: `judge verdict was ${judgeVerdict} after placeholder checker in strict mode`
      }
    }
    return {
      action: 'needs_judge',
      reason: 'strict verification cannot use the bundled sample checker as an authoritative gate'
    }
  }

  if (mode === 'strict') {
    return {
      action: 'rejected',
      reason: `strict verification requires checker pass; checker outcome was ${checkerOutcome}`
    }
  }

  if (judgeVerdict === undefined) {
    return {
      action: 'needs_judge',
      reason: `smart verification needs judge because checker outcome was ${checkerOutcome}`
    }
  }

  if (judgeVerdict === 'achieved') {
    return {
      action: 'achieved',
      reason: `judge confirmed achievement after checker outcome ${checkerOutcome}`
    }
  }

  return {
    action: 'rejected',
    reason: `judge verdict was ${judgeVerdict} after checker outcome ${checkerOutcome}`
  }
}
