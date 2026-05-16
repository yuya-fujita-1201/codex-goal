import { describe, expect, it } from 'vitest'

import { CRITIC_MODEL_OPTIONS, SUPPORTED_MODELS, isClaudeCriticModel } from './types'

describe('critic model options', () => {
  it('keeps Codex models available for the main worker family', () => {
    const ids = CRITIC_MODEL_OPTIONS.map((m) => m.id)
    for (const model of SUPPORTED_MODELS) {
      expect(ids).toContain(model.id)
    }
  })

  it('adds Claude models as cross-family critic choices', () => {
    const ids = CRITIC_MODEL_OPTIONS.map((m) => m.id)
    expect(ids).toContain('claude-opus-4-7')
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-haiku-4-5-20251001')
  })

  it('classifies only exact Claude critic ids as Claude-routed workers', () => {
    expect(isClaudeCriticModel('claude-sonnet-4-6')).toBe(true)
    expect(isClaudeCriticModel('gpt-5.5')).toBe(false)
    expect(isClaudeCriticModel('')).toBe(false)
    expect(isClaudeCriticModel(undefined)).toBe(false)
  })
})
