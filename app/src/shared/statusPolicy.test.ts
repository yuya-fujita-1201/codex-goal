import { describe, expect, it } from 'vitest'

import {
  getRunnerActivationTransition,
  shouldRunnerStopImmediately
} from './statusPolicy'

describe('runner status policy', () => {
  it('allows blocked goals to be activated again by an explicit start', () => {
    expect(getRunnerActivationTransition('blocked')).toEqual({
      patch: { status: 'active', next_resume_at: null },
      logMessage: 'Status: blocked -> active (manual recovery)'
    })
    expect(shouldRunnerStopImmediately('blocked')).toBe(false)
  })

  it('keeps irreversible terminal statuses stopped', () => {
    expect(shouldRunnerStopImmediately('achieved')).toBe(true)
    expect(shouldRunnerStopImmediately('abandoned')).toBe(true)
    expect(shouldRunnerStopImmediately('budget_exhausted')).toBe(true)
  })

  it('preserves existing pending and paused activation paths', () => {
    expect(getRunnerActivationTransition('pending')).toEqual({
      patch: { status: 'active' },
      logMessage: 'Status: pending -> active'
    })
    expect(getRunnerActivationTransition('paused')).toEqual({
      patch: { status: 'active', next_resume_at: null },
      logMessage: 'Status: paused -> active'
    })
  })
})
