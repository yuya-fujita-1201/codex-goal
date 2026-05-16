import type { GoalState, GoalStatus } from './types'

interface RunnerActivationTransition {
  patch: Partial<GoalState> & { status: GoalStatus }
  logMessage: string
}

export function getRunnerActivationTransition(
  status: GoalStatus | undefined
): RunnerActivationTransition | null {
  if (status === 'pending') {
    return {
      patch: { status: 'active' },
      logMessage: 'Status: pending -> active'
    }
  }
  if (status === 'paused') {
    return {
      patch: { status: 'active', next_resume_at: null },
      logMessage: 'Status: paused -> active'
    }
  }
  if (status === 'blocked') {
    return {
      patch: { status: 'active', next_resume_at: null },
      logMessage: 'Status: blocked -> active (manual recovery)'
    }
  }
  return null
}

export function shouldRunnerStopImmediately(status: GoalStatus): boolean {
  return (
    status === 'achieved' ||
    status === 'abandoned' ||
    status === 'budget_exhausted' ||
    status === 'paused' ||
    status === 'planning'
  )
}
