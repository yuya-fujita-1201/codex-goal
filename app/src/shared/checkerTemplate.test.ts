import { describe, expect, it } from 'vitest'

import {
  SAMPLE_CHECKER_TEMPLATE,
  isDefaultSampleCheckerTemplate
} from './checkerTemplate'

describe('isDefaultSampleCheckerTemplate', () => {
  it('detects the bundled sample checker', () => {
    expect(isDefaultSampleCheckerTemplate(SAMPLE_CHECKER_TEMPLATE)).toBe(true)
  })

  it('detects the bundled sample checker with CRLF line endings', () => {
    expect(isDefaultSampleCheckerTemplate(SAMPLE_CHECKER_TEMPLATE.replace(/\n/g, '\r\n'))).toBe(
      true
    )
  })

  it('does not flag a customized checker as the default sample', () => {
    const customized = SAMPLE_CHECKER_TEMPLATE
      .replace('test -f dist/build.js', 'test -f docs/knowledge/index.md')
      .replace('build artifact exists', 'knowledge index exists')

    expect(isDefaultSampleCheckerTemplate(customized)).toBe(false)
  })

  it('does not flag an unrelated checker', () => {
    expect(isDefaultSampleCheckerTemplate('#!/usr/bin/env bash\nnpm test\n')).toBe(false)
  })
})
