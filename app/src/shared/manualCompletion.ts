import type { GoalStatus } from './types'

export function canManuallyMarkAchieved(
  status: GoalStatus | undefined,
  running: boolean
): boolean {
  return status === 'paused' && !running
}
