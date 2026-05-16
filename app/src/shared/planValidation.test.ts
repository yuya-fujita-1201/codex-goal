import { describe, it, expect } from 'vitest'

import { findExternalAbsolutePaths } from './planValidation'

describe('findExternalAbsolutePaths', () => {
  const WS = '/Users/me/Projects/my-ws'

  it('ワークスペース配下のパスは外部扱いしない', () => {
    const plan = [
      '配置先:',
      `- ${WS}/docs/spec.md`,
      `- ${WS}/src/main.ts`
    ].join('\n')
    expect(findExternalAbsolutePaths(plan, WS)).toEqual([])
  })

  it('ワークスペース外の絶対パスを検出する', () => {
    const plan = [
      '設計成果物の配置:',
      '```',
      '/Users/me/Projects/other-repo/docs/',
      '└── README.md',
      '```'
    ].join('\n')
    const result = findExternalAbsolutePaths(plan, WS)
    expect(result).toContain('/Users/me/Projects/other-repo/docs/')
  })

  it('複数の外部パスを検出して重複排除する', () => {
    const plan = [
      `保存先: /Users/me/Projects/other/docs`,
      `参照: /Users/me/Projects/other/docs`,
      `別の場所: /Users/me/Projects/different/files`
    ].join('\n')
    const result = findExternalAbsolutePaths(plan, WS)
    expect(result.sort()).toEqual([
      '/Users/me/Projects/different/files',
      '/Users/me/Projects/other/docs'
    ])
  })

  it('ワークスペース prefix が誤マッチしないようスラッシュ境界で判定する', () => {
    // ws = /Users/me/Projects/my-ws
    // 候補 = /Users/me/Projects/my-ws-evil/foo  → 外部扱いされるべき
    const plan = '/Users/me/Projects/my-ws-evil/foo.md'
    const result = findExternalAbsolutePaths(plan, WS)
    expect(result).toContain('/Users/me/Projects/my-ws-evil/foo.md')
  })

  it('ワークスペース末尾スラッシュを正規化する', () => {
    const plan = `${WS}/foo.md`
    expect(findExternalAbsolutePaths(plan, WS + '/')).toEqual([])
  })

  it('相対パスやコードシンボルは無視する', () => {
    const plan = [
      'src/main.ts を読み込む',
      './docs/spec.md',
      'Foo/Bar クラス',
      'import { x } from "@shared/types"',
      'use std::collections::HashMap;'
    ].join('\n')
    expect(findExternalAbsolutePaths(plan, WS)).toEqual([])
  })

  it('文末のピリオド・カンマを除去する', () => {
    const plan = '保存先は /Users/other/foo.md。詳細は /Users/other/bar, を参照。'
    const result = findExternalAbsolutePaths(plan, WS)
    expect(result).toContain('/Users/other/foo.md')
    expect(result).toContain('/Users/other/bar')
  })

  it('チルダ始まりのパスも検出する', () => {
    const plan = '出力先: ~/Documents/output.md'
    const result = findExternalAbsolutePaths(plan, WS)
    expect(result).toContain('~/Documents/output.md')
  })

  it('Windows 絶対パスを検出する', () => {
    const plan = 'Path: C:\\Users\\other\\docs'
    const result = findExternalAbsolutePaths(plan, WS)
    expect(result.length).toBeGreaterThan(0)
  })

  it('空入力で空配列を返す', () => {
    expect(findExternalAbsolutePaths('', WS)).toEqual([])
    expect(findExternalAbsolutePaths('plan body', '')).toEqual([])
  })

  it('検出件数は 10 件で打ち切る', () => {
    const lines: string[] = []
    for (let i = 0; i < 20; i++) {
      lines.push(`- /Users/other/repo-${i}/file.md`)
    }
    const result = findExternalAbsolutePaths(lines.join('\n'), WS)
    expect(result.length).toBe(10)
  })
})
