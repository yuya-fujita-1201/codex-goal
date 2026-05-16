import { describe, expect, it } from 'vitest'

import { __test } from './runTurn'

describe('buildCodexExecArgs', () => {
  it('passes the selected model to normal Codex turns', () => {
    const args = __test.buildCodexExecArgs({
      modelId: 'gpt-5.4',
      sandbox: 'danger-full-access',
      workspace: '/tmp/workspace'
    })

    expect(args).toEqual([
      '-a',
      'never',
      '--model',
      'gpt-5.4',
      '--sandbox',
      'danger-full-access',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/workspace',
      '-'
    ])
  })

  it('keeps Codex judge-like workers read-only while still honoring the model setting', () => {
    const args = __test.buildCodexExecArgs({
      modelId: 'gpt-5.3-codex',
      sandbox: 'read-only',
      workspace: '/tmp/workspace'
    })

    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.3-codex')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
  })
})
