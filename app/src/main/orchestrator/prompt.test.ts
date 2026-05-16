import { describe, expect, it } from 'vitest'

import {
  __test,
  DIGEST_END_SENTINEL,
  detectRateLimit,
  extractBlockJudgeReason,
  extractBlockJudgeVerdict,
  extractBlockSummary,
  extractCheckerResult,
  extractCompressedDigest,
  extractCriticFlags,
  extractDigestUpdate,
  extractJudgeVerdict,
  extractPlan,
  extractUserReplies,
  hasGoalAchievedToken,
  lintDigestSections
} from './prompt'

describe('extractDigestUpdate', () => {
  it('正常系: digest-update タグの中身を改行付きで返す', () => {
    const stdout = [
      '作業ログ',
      '<digest-update>',
      '## サブタスク',
      '- [x] 完了',
      '</digest-update>',
      ''
    ].join('\n')
    const result = extractDigestUpdate(stdout)
    expect(result).toBe('## サブタスク\n- [x] 完了\n')
  })

  it('正常系（マルチライン）: 複数行・空行を含む内部本文を保持する', () => {
    const stdout = `noise
<digest-update>
## A

## B
- foo
- bar

</digest-update>
trailing`
    const result = extractDigestUpdate(stdout)
    expect(result).toBe('## A\n\n## B\n- foo\n- bar\n')
  })

  it('正常系: 同じタグが複数あるときは **最後の** ひとつを抽出する (last-match)', () => {
    // partial output 耐性: 中断ターン由来の不完全な digest が先行しても、
    // 最終的に書かれた完成版を採用する。
    const stdout = '<digest-update>first</digest-update>\n<digest-update>second</digest-update>'
    const result = extractDigestUpdate(stdout)
    expect(result).toBe('second\n')
  })

  it('正常系: sentinel 付きで出力された digest も問題なく抽出できる', () => {
    const stdout = [
      '<digest-update>',
      '## A',
      '- foo',
      '</digest-update>',
      DIGEST_END_SENTINEL
    ].join('\n')
    const result = extractDigestUpdate(stdout)
    expect(result).toBe('## A\n- foo\n')
  })

  it('異常系（タグ無し）: null を返す', () => {
    expect(extractDigestUpdate('普通の出力で digest はありません')).toBeNull()
  })

  it('異常系（空文字列）: null を返す', () => {
    expect(extractDigestUpdate('')).toBeNull()
  })

  it('異常系（不正フォーマット: 閉じタグ無し）: null を返す', () => {
    const stdout = '<digest-update>未完了'
    expect(extractDigestUpdate(stdout)).toBeNull()
  })

  it('異常系（不正フォーマット: 閉じタグだけ）: null を返す', () => {
    expect(extractDigestUpdate('途中</digest-update>')).toBeNull()
  })
})

describe('extractCheckerResult', () => {
  const validJson = {
    schema_version: 1,
    milestones: [
      { id: 'M1', label: 'build', status: 'pass' },
      { id: 'M2', label: 'tests', status: 'fail' }
    ],
    evidence: '1/2 milestones passed',
    passed_count: 1,
    total_count: 2
  }

  it('正常系: 有効な JSON ブロックをパースして返す', () => {
    const stdout = `something\n<checker-result>\n${JSON.stringify(validJson)}\n</checker-result>\n`
    const r = extractCheckerResult(stdout)
    expect(r).not.toBeNull()
    expect(r?.passed_count).toBe(1)
    expect(r?.milestones).toHaveLength(2)
    expect(r?.milestones[0].status).toBe('pass')
  })

  it('正常系: 複数 <checker-result> がある場合は最後を採用', () => {
    const old = { ...validJson, passed_count: 0 }
    const stdout = `<checker-result>${JSON.stringify(old)}</checker-result>\nlater\n<checker-result>${JSON.stringify(validJson)}</checker-result>`
    const r = extractCheckerResult(stdout)
    expect(r?.passed_count).toBe(1)
  })

  it('異常系: 不正 JSON は null', () => {
    const stdout = '<checker-result>{not json</checker-result>'
    expect(extractCheckerResult(stdout)).toBeNull()
  })

  it('異常系: schema_version が 1 以外は null (forward-compat)', () => {
    const future = { ...validJson, schema_version: 2 }
    const stdout = `<checker-result>${JSON.stringify(future)}</checker-result>`
    expect(extractCheckerResult(stdout)).toBeNull()
  })

  it('異常系: 必須フィールド欠損は null', () => {
    const broken = { schema_version: 1, milestones: [] } // evidence/counts なし
    const stdout = `<checker-result>${JSON.stringify(broken)}</checker-result>`
    expect(extractCheckerResult(stdout)).toBeNull()
  })

  it('境界: milestones が空配列でも合法', () => {
    const minimal = {
      schema_version: 1,
      milestones: [],
      evidence: 'overall pass',
      passed_count: 0,
      total_count: 0
    }
    const stdout = `<checker-result>${JSON.stringify(minimal)}</checker-result>`
    const r = extractCheckerResult(stdout)
    expect(r).not.toBeNull()
    expect(r?.milestones).toEqual([])
  })

  it('境界: タグ自体が無ければ null', () => {
    expect(extractCheckerResult('普通の checker.sh 出力で JSON 無し')).toBeNull()
  })

  it('境界: milestones 内の status が異常値なら null', () => {
    const bad = {
      ...validJson,
      milestones: [{ id: 'M1', label: 'x', status: 'unknown' }]
    }
    const stdout = `<checker-result>${JSON.stringify(bad)}</checker-result>`
    expect(extractCheckerResult(stdout)).toBeNull()
  })
})

describe('extractCriticFlags', () => {
  it('正常系: bullet list を flags 配列として返す', () => {
    const stdout = `<judge-reason>weak evidence</judge-reason>
<critic-flags>
- M3 完了とあるが対応するファイルが見つからない
- npm test が実行されていない
</critic-flags>
<judge-verdict>not_yet</judge-verdict>`
    const flags = extractCriticFlags(stdout)
    expect(flags).toHaveLength(2)
    expect(flags[0]).toContain('M3')
    expect(flags[1]).toContain('npm test')
  })

  it('正常系: 空タグ (critic が flag 無し) は空配列', () => {
    const stdout = '<critic-flags></critic-flags><judge-verdict>achieved</judge-verdict>'
    expect(extractCriticFlags(stdout)).toEqual([])
  })

  it('境界: タグ自体が無い (旧 judge worker) も空配列', () => {
    const stdout = '<judge-verdict>achieved</judge-verdict>'
    expect(extractCriticFlags(stdout)).toEqual([])
  })

  it('境界: bullet 以外の行 (散文) はスキップ', () => {
    const stdout = `<critic-flags>
以下の点が気になります:
- 一つ目の指摘
ただし全体としては良い。
* 二つ目の指摘 (* style bullet)
</critic-flags>`
    const flags = extractCriticFlags(stdout)
    expect(flags).toEqual(['一つ目の指摘', '二つ目の指摘 (* style bullet)'])
  })
})

describe('lintDigestSections', () => {
  const fullDigest = [
    '## 達成済みサブタスク',
    '- [x] M1',
    '',
    '## 試したアプローチと失敗理由',
    '- 失敗 X: 理由',
    '',
    '## 未解決ブロッカー',
    '- なし',
    ''
  ].join('\n')

  it('正常系: 必須セクションが両方とも維持されていれば warning なし', () => {
    expect(lintDigestSections(fullDigest, fullDigest)).toEqual([])
  })

  it('異常系: 「試したアプローチと失敗理由」が消えると warning 1 件', () => {
    const next = fullDigest.replace(/## 試したアプローチと失敗理由[\s\S]*?(?=\n## )/, '')
    const warnings = lintDigestSections(fullDigest, next)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/試したアプローチと失敗理由/)
  })

  it('異常系: 必須セクション両方が消えると warning 2 件', () => {
    const next = '## 達成済みサブタスク\n- [x] M1\n'
    const warnings = lintDigestSections(fullDigest, next)
    expect(warnings).toHaveLength(2)
  })

  it('境界: prev が空文字列なら warning なし (初回ターン)', () => {
    expect(lintDigestSections('', fullDigest)).toEqual([])
  })

  it('境界: prev に元々無いセクションなら消えても warning なし', () => {
    const minimal = '## 達成済みサブタスク\n- [x] M1\n'
    expect(lintDigestSections(minimal, '## 達成済みサブタスク\n')).toEqual([])
  })
})

describe('extractBlockSummary', () => {
  it('正常系: block-summary タグの中身を改行付きで返す', () => {
    const stdout = '<block-summary>\n## このブロックで試したこと\n- foo\n</block-summary>'
    const result = extractBlockSummary(stdout)
    expect(result).toBe('## このブロックで試したこと\n- foo\n')
  })

  it('正常系（マルチライン）: 空行・複数セクションを保持する', () => {
    const stdout = `<block-summary>
## A
- a1

## B
- b1
- b2
</block-summary>`
    const result = extractBlockSummary(stdout)
    expect(result).toBe('## A\n- a1\n\n## B\n- b1\n- b2\n')
  })

  it('異常系（タグ無し）: null を返す', () => {
    expect(extractBlockSummary('plain text without tags')).toBeNull()
  })

  it('異常系（空文字列）: null を返す', () => {
    expect(extractBlockSummary('')).toBeNull()
  })

  it('異常系（不正フォーマット: 閉じタグ無し）: null を返す', () => {
    expect(extractBlockSummary('<block-summary>incomplete')).toBeNull()
  })

  it('異常系（不正フォーマット: 別タグ）: null を返す', () => {
    expect(extractBlockSummary('<digest-update>x</digest-update>')).toBeNull()
  })
})

describe('extractCompressedDigest', () => {
  it('正常系: compressed-digest タグの中身を改行付きで返す', () => {
    const stdout = '<compressed-digest>\n## サブタスク\n- [x] 完了\n</compressed-digest>'
    const result = extractCompressedDigest(stdout)
    expect(result).toBe('## サブタスク\n- [x] 完了\n')
  })

  it('正常系（マルチライン）: 空行・複数セクションを保持する', () => {
    const stdout = `prefix
<compressed-digest>
## A
- a1

## B
- b1
</compressed-digest>
suffix`
    const result = extractCompressedDigest(stdout)
    expect(result).toBe('## A\n- a1\n\n## B\n- b1\n')
  })

  it('正常系: 同じタグが複数あるときは最初のひとつだけを抽出する', () => {
    const stdout =
      '<compressed-digest>first</compressed-digest>\n<compressed-digest>second</compressed-digest>'
    expect(extractCompressedDigest(stdout)).toBe('first\n')
  })

  it('異常系（タグ無し）: null を返す', () => {
    expect(extractCompressedDigest('plain digest text')).toBeNull()
  })

  it('異常系（空文字列）: null を返す', () => {
    expect(extractCompressedDigest('')).toBeNull()
  })

  it('異常系（不正フォーマット: 閉じタグ無し）: null を返す', () => {
    expect(extractCompressedDigest('<compressed-digest>incomplete')).toBeNull()
  })

  it('異常系（不正フォーマット: 別タグ）: null を返す', () => {
    expect(extractCompressedDigest('<digest-update>x</digest-update>')).toBeNull()
  })
})

describe('extractJudgeVerdict', () => {
  it("正常系: 'achieved' を抽出する", () => {
    expect(extractJudgeVerdict('<judge-verdict>achieved</judge-verdict>')).toBe('achieved')
  })

  it("正常系: 'not_yet' を抽出する", () => {
    expect(extractJudgeVerdict('<judge-verdict>not_yet</judge-verdict>')).toBe('not_yet')
  })

  it('正常系（マルチライン文書中）: judge-reason の後に置かれた verdict を抽出する', () => {
    const stdout = `<judge-reason>
理由を述べる。
</judge-reason>

<judge-verdict>achieved</judge-verdict>
`
    expect(extractJudgeVerdict(stdout)).toBe('achieved')
  })

  it('正常系: タグ内の前後空白を許容する', () => {
    expect(extractJudgeVerdict('<judge-verdict>  not_yet  </judge-verdict>')).toBe('not_yet')
  })

  it('異常系（タグ無し）: null を返す', () => {
    expect(extractJudgeVerdict('judge result: achieved')).toBeNull()
  })

  it('異常系（空文字列）: null を返す', () => {
    expect(extractJudgeVerdict('')).toBeNull()
  })

  it('異常系（不正な値）: null を返す', () => {
    expect(extractJudgeVerdict('<judge-verdict>maybe</judge-verdict>')).toBeNull()
  })

  it('異常系（不正フォーマット: 閉じタグ無し）: null を返す', () => {
    expect(extractJudgeVerdict('<judge-verdict>achieved')).toBeNull()
  })

  it('正常系（マルチラインで verdict 値が改行で囲まれる）: 値を抽出する', () => {
    // \s* matches newlines, so this is allowed by the current regex.
    const stdout = '<judge-verdict>\nachieved\n</judge-verdict>'
    expect(extractJudgeVerdict(stdout)).toBe('achieved')
  })

  it('異常系（不正フォーマット: 値の前に文字が混入）: null を返す', () => {
    expect(extractJudgeVerdict('<judge-verdict>x achieved</judge-verdict>')).toBeNull()
  })
})

describe('hasGoalAchievedToken', () => {
  it('正常系: タグがあれば true', () => {
    expect(hasGoalAchievedToken('<goal-status>achieved</goal-status>')).toBe(true)
  })

  it('正常系: 前後空白を許容する', () => {
    expect(hasGoalAchievedToken('<goal-status>  achieved  </goal-status>')).toBe(true)
  })

  it('正常系（マルチライン中の埋め込み）: 文中にあれば true', () => {
    const stdout = `通常のログ
<digest-update>
...
</digest-update>
<goal-status>achieved</goal-status>
末尾`
    expect(hasGoalAchievedToken(stdout)).toBe(true)
  })

  it('異常系（タグ無し）: false', () => {
    expect(hasGoalAchievedToken('goal achieved!')).toBe(false)
  })

  it('異常系（空文字列）: false', () => {
    expect(hasGoalAchievedToken('')).toBe(false)
  })

  it('異常系（別の値）: false', () => {
    expect(hasGoalAchievedToken('<goal-status>not_yet</goal-status>')).toBe(false)
  })

  it('異常系（不正フォーマット: 閉じタグ無し）: false', () => {
    expect(hasGoalAchievedToken('<goal-status>achieved')).toBe(false)
  })

  it('正常系（マルチラインで achieved が改行で囲まれる）: true', () => {
    // \s* matches newlines too.
    expect(hasGoalAchievedToken('<goal-status>\nachieved\n</goal-status>')).toBe(true)
  })

  it('異常系（不正フォーマット: 値の前に文字が混入）: false', () => {
    expect(hasGoalAchievedToken('<goal-status>x achieved</goal-status>')).toBe(false)
  })
})

describe('detectRateLimit', () => {
  it('正常系: "5-hour usage limit" を検出する', () => {
    const text =
      'Error: You have reached the 5-hour usage limit. Please try again later.'
    expect(detectRateLimit(text)).not.toBeNull()
  })

  it('正常系: "5 hour window will reset" を検出する', () => {
    expect(detectRateLimit('your 5 hour window will reset at 12:00 UTC')).not.toBeNull()
  })

  it('正常系: 単独 "usage limit" を検出する', () => {
    expect(detectRateLimit('Claude responded: usage limit reached')).not.toBeNull()
  })

  it('正常系: "rate limited ... reset" を検出する', () => {
    expect(detectRateLimit('You are rate limited; window will reset soon.')).not.toBeNull()
  })

  it('正常系: "rate limit reached" を検出する', () => {
    expect(detectRateLimit('Codex error: rate limit reached. Try again later.')).not.toBeNull()
  })

  it('正常系: "quota exceeded" を検出する', () => {
    expect(detectRateLimit('quota exceeded for this organization')).not.toBeNull()
  })

  it('正常系: "try again in 5 hours" を検出する', () => {
    expect(detectRateLimit('Please try again in 5 hours.')).not.toBeNull()
  })

  it('正常系: 大文字小文字を無視する', () => {
    expect(detectRateLimit('USAGE LIMIT')).not.toBeNull()
  })

  it('異常系: 空文字列は null', () => {
    expect(detectRateLimit('')).toBeNull()
  })

  it('異常系: 通常の作業ログには反応しない', () => {
    const text =
      '[INFO] turn-001 finished. digest updated. files changed: 3'
    expect(detectRateLimit(text)).toBeNull()
  })

  it('異常系: "rate" 単独では検出しない（誤検知防止）', () => {
    expect(detectRateLimit('the conversion rate is 1.2')).toBeNull()
  })

  it('異常系: "5 hour" 単独でリミット文脈なしなら検出しない', () => {
    expect(detectRateLimit('the meeting takes 5 hours of focused work')).toBeNull()
  })
})

describe('buildFallbackBanner (C3)', () => {
  it('正常系: 連続回数を本文に埋め込む', () => {
    const out = __test.buildFallbackBanner(2)
    expect(out).toContain('FALLBACK MODE')
    expect(out).toContain('直前 2 回連続')
  })

  it('正常系: 残り失敗回数を計算して表示する (3 - n)', () => {
    expect(__test.buildFallbackBanner(1)).toContain('あと 2 回失敗するとゴール')
    expect(__test.buildFallbackBanner(2)).toContain('あと 1 回失敗するとゴール')
  })

  it('正常系: 強い禁止事項（破壊的操作禁止 / 同じアプローチ禁止）を含む', () => {
    const out = __test.buildFallbackBanner(2)
    expect(out).toContain('同じアプローチを繰り返さない')
    expect(out).toContain('破壊的操作')
    expect(out).toContain('絶対禁止')
  })

  it('境界値: consecutive >= 3 でも 0 を下回らない（残り回数表示）', () => {
    const out = __test.buildFallbackBanner(5)
    // 3 - 5 = -2 だが Math.max(0, ...) で 0 にクランプされる
    expect(out).toContain('あと 0 回失敗するとゴール')
  })
})

describe('buildUserMessagesSection (Phase 4.3)', () => {
  it('正常系: 単一メッセージを箇条書き 1 行で出力する', () => {
    const out = __test.buildUserMessagesSection([
      { id: 'm1', ts: '2026-05-06T01:00:00Z', text: 'use /tmp instead', consumed_at_turn: null }
    ])
    expect(out).toContain('## 📨 ユーザーからの追加指示（最優先）')
    expect(out).toContain('最優先で考慮')
    expect(out).toContain('[2026-05-06T01:00:00Z] use /tmp instead')
  })

  it('正常系: 複数メッセージは投稿順に並ぶ（caller order respected）', () => {
    const out = __test.buildUserMessagesSection([
      { id: 'm1', ts: '2026-05-06T01:00:00Z', text: 'first', consumed_at_turn: null },
      { id: 'm2', ts: '2026-05-06T01:01:00Z', text: 'second', consumed_at_turn: null }
    ])
    const i1 = out.indexOf('first')
    const i2 = out.indexOf('second')
    expect(i1).toBeGreaterThan(-1)
    expect(i2).toBeGreaterThan(i1)
  })

  it('正常系: 改行を含むメッセージは 2 行目以降がインデントされる', () => {
    const out = __test.buildUserMessagesSection([
      { id: 'm1', ts: '2026-05-06T01:00:00Z', text: 'line1\nline2', consumed_at_turn: null }
    ])
    expect(out).toContain('line1\n  line2')
  })

  it('境界値: 空配列のとき空文字列を返す（注入されない）', () => {
    expect(__test.buildUserMessagesSection([])).toBe('')
  })
})

describe('extractUserReplies (Phase 4.4)', () => {
  it('正常系: 単一の <user-reply id="..."> を抽出する', () => {
    const stdout = `
Some preamble.
<user-reply id="msg-abc123">
現在 turn-005 を実行中です。
</user-reply>
And then more work...
`
    const out = extractUserReplies(stdout)
    expect(out.size).toBe(1)
    expect(out.get('msg-abc123')).toBe('現在 turn-005 を実行中です。')
  })

  it('正常系: 複数の reply を id ごとにマップする', () => {
    const stdout = `
<user-reply id="msg-aaa">回答 1</user-reply>
intermediate work
<user-reply id="msg-bbb">
回答 2
（複数行）
</user-reply>
`
    const out = extractUserReplies(stdout)
    expect(out.size).toBe(2)
    expect(out.get('msg-aaa')).toBe('回答 1')
    expect(out.get('msg-bbb')).toBe('回答 2\n（複数行）')
  })

  it('正常系: 同じ id の重複ブロックは最後の値で上書き', () => {
    const stdout = `
<user-reply id="msg-x">first</user-reply>
<user-reply id="msg-x">second (final)</user-reply>
`
    expect(extractUserReplies(stdout).get('msg-x')).toBe('second (final)')
  })

  it('境界値: 中身が空白だけの reply は無視する', () => {
    const stdout = `<user-reply id="msg-empty">   \n  </user-reply>`
    expect(extractUserReplies(stdout).size).toBe(0)
  })

  it('異常系: タグが無い stdout は空 Map', () => {
    expect(extractUserReplies('just regular work output').size).toBe(0)
  })

  it('異常系: 閉じタグが無い場合は抽出しない', () => {
    expect(extractUserReplies('<user-reply id="msg-x">no close').size).toBe(0)
  })

  it('異常系: id 属性が無い <user-reply> は抽出しない', () => {
    expect(extractUserReplies('<user-reply>orphan</user-reply>').size).toBe(0)
  })
})

describe('extractPlan', () => {
  it('正常系: plan タグの中身を改行付きで返す', () => {
    const stdout = [
      '調査ログ...',
      '<plan>',
      '## 全体方針',
      'Flutter で実装する',
      '',
      '## マイルストーン',
      '1. M1: 雛形',
      '</plan>',
      ''
    ].join('\n')
    expect(extractPlan(stdout)).toBe(
      '## 全体方針\nFlutter で実装する\n\n## マイルストーン\n1. M1: 雛形\n'
    )
  })

  it('正常系: 同じタグが複数あるときは最初のひとつだけを抽出する', () => {
    const stdout = '<plan>first</plan>\n<plan>second</plan>'
    expect(extractPlan(stdout)).toBe('first\n')
  })

  it('異常系（タグ無し）: null を返す', () => {
    expect(extractPlan('普通の出力で plan はありません')).toBeNull()
  })

  it('異常系（閉じタグ無し）: null を返す', () => {
    expect(extractPlan('<plan>未完了')).toBeNull()
  })
})

describe('buildPlanBanner (turn-001 only)', () => {
  it('計画立案フェーズの宣言と <plan> タグの出力指示を含む', () => {
    const banner = __test.buildPlanBanner('/tmp/ws')
    expect(banner).toContain('計画立案ターン')
    expect(banner).toContain('実装を一切行わず')
    expect(banner).toContain('<plan>')
    expect(banner).toContain('</plan>')
    // 達成宣言の禁止が明示されていること
    expect(banner).toContain('<goal-status>achieved</goal-status>')
  })

  it('成果物配置先をワークスペース配下に限定する禁止条項を含む', () => {
    const banner = __test.buildPlanBanner('/Users/x/projects/my-ws')
    expect(banner).toContain('/Users/x/projects/my-ws')
    expect(banner).toMatch(/ワークスペース.*配下に限る/)
    expect(banner).toContain('他プロジェクト')
  })
})

describe('extractBlockJudgeVerdict', () => {
  it('continue verdict を返す', () => {
    const stdout = [
      '前文...',
      '<block-judge-verdict>continue</block-judge-verdict>',
      ''
    ].join('\n')
    expect(extractBlockJudgeVerdict(stdout)).toBe('continue')
  })

  it('should_stop verdict を返す', () => {
    const stdout = '<block-judge-verdict>should_stop</block-judge-verdict>'
    expect(extractBlockJudgeVerdict(stdout)).toBe('should_stop')
  })

  it('goal_drift verdict を返す', () => {
    const stdout = '<block-judge-verdict>goal_drift</block-judge-verdict>'
    expect(extractBlockJudgeVerdict(stdout)).toBe('goal_drift')
  })

  it('タグ周辺の空白を許容する', () => {
    const stdout = '<block-judge-verdict>   continue   </block-judge-verdict>'
    expect(extractBlockJudgeVerdict(stdout)).toBe('continue')
  })

  it('タグが無ければ null を返す', () => {
    expect(extractBlockJudgeVerdict('普通の本文だけ。')).toBeNull()
  })

  it('不正な verdict 値はマッチさせず null を返す', () => {
    const stdout = '<block-judge-verdict>maybe</block-judge-verdict>'
    expect(extractBlockJudgeVerdict(stdout)).toBeNull()
  })

  it('複数タグが出力された場合は最後のものを採用する (last-match)', () => {
    // worker が prompt 内の例示タグを途中で吐いてから本物を最後に書くケース。
    // last-match を採用しているので、最終的に確定した verdict が拾える。
    const stdout = [
      '例示: <block-judge-verdict>continue</block-judge-verdict>',
      '...判断中...',
      '<block-judge-verdict>should_stop</block-judge-verdict>'
    ].join('\n')
    expect(extractBlockJudgeVerdict(stdout)).toBe('should_stop')
  })
})

describe('extractBlockJudgeReason', () => {
  it('reason 本文を trim して返す', () => {
    const stdout = [
      '<block-judge-reason>',
      'M1〜M3 すべて完了済み。',
      'continue する意義が薄い。',
      '</block-judge-reason>'
    ].join('\n')
    expect(extractBlockJudgeReason(stdout)).toBe(
      'M1〜M3 すべて完了済み。\ncontinue する意義が薄い。'
    )
  })

  it('タグが無ければ空文字を返す', () => {
    expect(extractBlockJudgeReason('reason は無い')).toBe('')
  })

  it('複数 reason が出力された場合は最後のものを採用する (last-match)', () => {
    const stdout = [
      '<block-judge-reason>初稿の理由</block-judge-reason>',
      '<block-judge-reason>最終的な理由</block-judge-reason>'
    ].join('\n')
    expect(extractBlockJudgeReason(stdout)).toBe('最終的な理由')
  })
})
