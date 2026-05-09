// Prompt rendering for main turns, block summaries, and judge worker.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { CheckerResult, GoalBudget, GoalState, UserMessage } from '@shared/types'

import { goalDir } from './util'

interface BuildPromptArgs {
  state: GoalState
  budget: GoalBudget
  turnId: string
  turnNum: number
  // Phase 4.2 C3: when the previous turn(s) ended with an anomaly
  // (TIMEOUT/HANG/ABORTED/FAIL*), runner sets this to the running counter so
  // we can prepend a FALLBACK MODE warning that nudges the worker to stop
  // repeating the failing approach. 0 means "healthy" — no banner injected.
  consecutiveAnomalies?: number
  // Phase 4.3: queued user-typed directives to inject at the very top of the
  // prompt. Already-consumed messages should NOT be passed (caller filters).
  userMessages?: UserMessage[]
  // PR-C: external-observation evidence (git status/diff stat, checker.log
  // tail, prior-turn stdout tail) collected by runner.collectEvidence and
  // injected via {{EVIDENCE}}. Optional: legacy goals using the older
  // prompt-template (no {{EVIDENCE}} placeholder) silently ignore it.
  evidence?: string
  // PR-D: structured result from the most recent checker.sh run, parsed by
  // extractCheckerResult. Injected via {{CHECKER_RESULT}} so the next turn
  // can read which milestones failed without re-running the checker. null
  // when the checker hasn't run yet, didn't emit a JSON block, or this is
  // turn 1.
  lastCheckerResult?: CheckerResult | null
  // PR-E: list of `<critic-flags>` items raised by the judge worker on the
  // previous achievement attempt. Empty when no judge has run yet OR when
  // the critic accepted achievement. Injected via {{CRITIC_FLAGS}} so the
  // worker can address each specific gap.
  lastCriticFlags?: string[]
}

// Phase 4.3: render queued user directives as the highest-priority section.
// Placed above objective / fallback banner / template body so the worker can
// see and obey them before doing anything else.
// Phase 4.4: include each message's id and ask the worker to emit a
// <user-reply id="..."> block per message so the app can show a reply log.
function buildUserMessagesSection(messages: UserMessage[]): string {
  if (messages.length === 0) return ''
  const lines: string[] = [
    '## 📨 ユーザーからの追加指示（最優先）',
    '',
    'ユーザーがアプリ経由で以下の追加指示を送信しました。**これを最優先で考慮**してください。',
    '指示が現在の作業方針と矛盾する場合は、ユーザーの追加指示を優先し、digest を更新してから新方針に切り替えること。',
    ''
  ]
  for (const m of messages) {
    const indented = m.text.replace(/\n/g, '\n  ')
    lines.push(`- id=\`${m.id}\` [${m.ts}] ${indented}`)
  }
  lines.push('')
  lines.push('### 返答（必須）')
  lines.push('')
  lines.push(
    'ターン本文の冒頭で、各メッセージに対し**短い返答**を以下のフォーマットで出力してください。'
  )
  lines.push(
    '質問への回答 / 現状報告 / 指示の確認 / 受領通知 などを 1〜3 文程度で。実作業はその返答の後に進めてください。'
  )
  lines.push('')
  lines.push('```')
  lines.push('<user-reply id="msg-xxxxxx">')
  lines.push('（このメッセージへの簡潔な返答）')
  lines.push('</user-reply>')
  lines.push('```')
  lines.push('')
  lines.push('id は上の箇条書きで指定された値を**そのままコピー**して使うこと。')
  lines.push('')
  return lines.join('\n')
}

// Phase 4.4: extract <user-reply id="..."> blocks. Returns a map from message
// id → reply text. Tolerates duplicate blocks for the same id (last wins) and
// extra whitespace inside the tag.
export function extractUserReplies(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /<user-reply\s+id="([^"]+)"\s*>([\s\S]*?)<\/user-reply>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stdout)) !== null) {
    const id = m[1]
    const body = m[2].replace(/^\n+/, '').replace(/\n+$/, '').trim()
    if (body.length > 0) out.set(id, body)
  }
  return out
}

// Maximum number of consecutive anomalies before the runner gives up. Mirrors
// the constant in runner.ts; kept here so the banner can mention it.
const FALLBACK_MAX_CONSECUTIVE = 3

// turn-001 banner: forces the worker into plan-only mode. Reused for any
// future "first turn" reset. Kept here so tests can assert on it.
function buildPlanBanner(): string {
  return [
    '## 🧭 計画立案ターン（最重要・実装ターンの規律より優先）',
    '',
    'これは **ターン 001 = 計画立案フェーズ** です。本ターンでは **実装を一切行わず**、',
    'ゴール達成までの計画を立てることに専念してください。',
    '',
    '### このターンの強い制約',
    '',
    '1. **ファイルの新規作成・編集・削除を一切行わない**。Write / Edit / NotebookEdit ツールは使用禁止。',
    '2. **シェルコマンドは読み取り系のみ**（ls / cat / grep / find / head / tail / git log 等）。 ビルド・テスト・パッケージインストール・破壊的操作は禁止。',
    '3. ワークスペースの構造、既存コード、関連ドキュメント、`memo.md` 等の入力資料を必要なだけ調査してよい。',
    '4. 調査結果に基づき、ゴール達成までの **計画** を立てる。後続ターンが「次の最小ステップを1つずつ」消化していけるレベルで分解すること。',
    '5. **`<goal-status>achieved</goal-status>` を絶対に出力しない。** 計画立案だけではゴール達成ではない。',
    '',
    '### 出力フォーマット（必須）',
    '',
    '通常の作業ログ・調査結果を出した後、最後に **必ず** 以下の `<plan>` タグを出力すること:',
    '',
    '```',
    '<plan>',
    '## 全体方針',
    '（1〜3 段落で「何をどう作るか」「技術スタック・主要設計」「制約・前提」を述べる）',
    '',
    '## 達成までのマイルストーン',
    '1. M1: ...',
    '2. M2: ...',
    '3. M3: ...',
    '（必要なだけ。各マイルストーンは目安 3〜10 ターンで終わる粒度）',
    '',
    '## 各マイルストーンの作業ステップ',
    '### M1: ...',
    '- step 1: ...',
    '- step 2: ...',
    '',
    '### M2: ...',
    '- step 1: ...',
    '',
    '## 既知のリスク・想定される困難',
    '- ...',
    '',
    '## 検証方法（ゴール達成判定）',
    '- ...',
    '</plan>',
    '```',
    '',
    'その後、通常通り `<digest-update>` も出力すること。digest の「達成済みサブタスク」に `[x] turn-001: 計画立案完了` を含めること。',
    ''
  ].join('\n')
}

function buildFallbackBanner(consecutive: number): string {
  return [
    '## ⚠️ FALLBACK MODE（直前ターンが異常終了）',
    '',
    `直前 ${consecutive} 回連続でターンが異常終了 (TIMEOUT / HANG / ABORTED / FAIL) しています。`,
    `あと ${Math.max(0, FALLBACK_MAX_CONSECUTIVE - consecutive)} 回失敗するとゴールは "blocked" 状態に倒れます。`,
    '',
    '### このターンの強い制約',
    '- 直前と**同じアプローチを繰り返さない**こと。`digest.md` の「試したアプローチと失敗理由」を読み返し、別経路を選ぶ。',
    '- **最小限の安全な作業**のみ実施。新規実装・大規模変更・長時間ブラウザ操作・重い build / test は禁止。',
    '- 破壊的操作（`rm -rf`, force push, DB 変更, プロセス kill 等）は**絶対禁止**。',
    '- 行き詰まりが続くなら、**作業を行わず `digest-update` を更新するだけでも可**。失敗理由と次の最小ステップ候補を整理して停止する判断を優先する。',
    '- 外部ツール（dev-browser など）の応答待ちで前ターンが TIMEOUT した可能性が高いなら、本ターンではツール呼び出しを 1 回未満に抑える。',
    ''
  ].join('\n')
}

const MAX_BLOCKS_INCLUDED = 6 // include only the most recent N blocks in main prompt

async function readBlocksDigest(goalId: string): Promise<string> {
  const blocksDir = path.join(goalDir(goalId), 'history', 'blocks')
  let entries: string[]
  try {
    entries = await fs.readdir(blocksDir)
  } catch {
    return ''
  }
  const blockFiles = entries
    .filter((f) => /^block-\d+\.md$/.test(f))
    .sort()
    .slice(-MAX_BLOCKS_INCLUDED)
  if (blockFiles.length === 0) return ''
  const parts: string[] = []
  for (const f of blockFiles) {
    try {
      const content = await fs.readFile(path.join(blocksDir, f), 'utf8')
      parts.push(`### ${f}\n${content.trim()}`)
    } catch {
      // skip
    }
  }
  return parts.join('\n\n')
}

export async function buildPrompt(args: BuildPromptArgs): Promise<string> {
  const dir = goalDir(args.state.goal_id)
  const tmpl = await fs.readFile(path.join(dir, 'prompt-template.md'), 'utf8')
  const objective = await fs.readFile(path.join(dir, 'objective.md'), 'utf8').catch(() => '')
  const digest = await fs.readFile(path.join(dir, 'digest.md'), 'utf8').catch(() => '')
  const blocks = await readBlocksDigest(args.state.goal_id)
  const plan = await fs.readFile(path.join(dir, 'plan.md'), 'utf8').catch(() => '')

  const elapsedMin = Math.max(
    0,
    Math.round((Date.now() - new Date(args.state.created_at).getTime()) / 60000)
  )

  const planSection = plan.trim()
    ? plan.trim()
    : args.turnNum === 1
      ? '（このターン (turn-001) で計画を立案します）'
      : '（plan.md が未作成 — turn-001 の計画立案が不完全だった可能性。本ターン冒頭で簡易計画を立て直してから着手すること）'

  const subs: Record<string, string> = {
    '{{OBJECTIVE}}': objective.trim(),
    '{{DIGEST}}': digest.trim(),
    '{{BLOCKS}}': blocks.trim() || '（まだ block summary はありません）',
    '{{PLAN}}': planSection,
    '{{TURNS_USED}}': String(args.turnNum),
    '{{MAX_TURNS}}': String(args.budget.max_turns),
    '{{ELAPSED_MIN}}': String(elapsedMin),
    '{{PER_TURN_TIMEOUT}}': String(args.budget.per_turn_timeout_seconds),
    '{{CURRENT_TURN}}': args.turnId,
    '{{EVIDENCE}}': args.evidence?.trim() || '（直近証拠の収集に失敗、または初回ターン）',
    '{{CHECKER_RESULT}}': formatCheckerResultForPrompt(args.lastCheckerResult),
    '{{CRITIC_FLAGS}}': formatCriticFlagsForPrompt(args.lastCriticFlags)
  }

  let out = tmpl
  for (const [k, v] of Object.entries(subs)) {
    out = out.split(k).join(v)
  }
  // turn-001 only: prepend the plan banner so the worker stays read-only and
  // emits a <plan> tag instead of starting implementation.
  if (args.turnNum === 1) {
    out = buildPlanBanner() + '\n' + out
  }
  if (args.consecutiveAnomalies && args.consecutiveAnomalies > 0) {
    out = buildFallbackBanner(args.consecutiveAnomalies) + '\n' + out
  }
  // Phase 4.3: user messages take absolute priority — prepend AFTER the
  // fallback banner so they sit at the very top of the prompt.
  if (args.userMessages && args.userMessages.length > 0) {
    out = buildUserMessagesSection(args.userMessages) + '\n' + out
  }
  return out
}

// Exported for unit tests so the helpers can be asserted without constructing
// a full GoalState/GoalBudget.
export const __test = { buildFallbackBanner, buildUserMessagesSection, buildPlanBanner }

/**
 * Sentinel emitted by Codex *immediately after* `</digest-update>` so we can
 * disambiguate the real terminal block from any partial / quoted occurrence
 * earlier in the turn (e.g. tool output that echoes the tag, or a worker that
 * crashed mid-stream and re-tried). Combined with last-match scanning, this
 * gives us two layers of robustness against false positives.
 */
export const DIGEST_END_SENTINEL = '<!-- END DIGEST -->'

/**
 * Extract the **last** `<digest-update>...</digest-update>` block in the
 * turn's stdout. Last-match (rather than first-match) is intentional: if the
 * worker emits a partial block early — interrupted thought, tool output that
 * happens to echo the tag, mid-turn crash and retry — we always want the
 * final, completed digest as the source of truth. The sentinel
 * `<!-- END DIGEST -->` is checked but not required, so existing goals using
 * the older prompt template (no sentinel) still parse correctly.
 */
export function extractDigestUpdate(stdout: string): string | null {
  const re = /<digest-update>([\s\S]+?)<\/digest-update>/g
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = re.exec(stdout)) !== null) {
    last = match
  }
  if (!last) return null
  return last[1].replace(/^\n+/, '').replace(/\n+$/, '') + '\n'
}

/**
 * Section headings that must persist across digest revisions. If a previous
 * digest had one of these and the new digest dropped it entirely, that's
 * almost always a regression — the worker forgot to carry forward failure
 * memory or open blockers. The linter doesn't fail the turn (the digest is
 * still saved); it just emits warnings so the orchestrator log surfaces the
 * regression and the operator can spot it.
 *
 * Only headings that *should monotonically grow or stay* are tracked here.
 * "達成済みサブタスク" is intentionally excluded because checking off and
 * collapsing items is normal — too noisy to warn on.
 */
const REQUIRED_DIGEST_SECTIONS = [
  '## 試したアプローチと失敗理由',
  '## 未解決ブロッカー'
] as const

export function lintDigestSections(prev: string, next: string): string[] {
  if (!prev) return []
  const warnings: string[] = []
  for (const heading of REQUIRED_DIGEST_SECTIONS) {
    if (prev.includes(heading) && !next.includes(heading)) {
      warnings.push(
        `digest linter: section "${heading}" disappeared between turns — possible silent loss of failure memory or blockers`
      )
    }
  }
  return warnings
}

/**
 * PR-D: parse the optional `<checker-result>JSON</checker-result>` block
 * checker.sh may emit at the end of stdout. Last-match scanning + tolerant
 * JSON parsing — a malformed block returns null, never throws. Validates
 * just enough fields to make the result safe to forward into the next
 * turn's prompt; unknown fields are preserved by structural typing on the
 * caller side (we only return values we explicitly recognized).
 *
 * Returns null when:
 *   - no <checker-result> tag is present (checker doesn't opt into JSON)
 *   - schema_version != 1 (forward-compat — older runner refuses unknown)
 *   - JSON parse fails
 *   - required shape is missing (milestones array, evidence string, counts)
 *
 * The exit code remains the authoritative pass/fail signal — this JSON
 * is purely *additional* observability for the next turn's worker.
 */
export function extractCheckerResult(stdout: string): CheckerResult | null {
  const re = /<checker-result>([\s\S]+?)<\/checker-result>/g
  let last: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = re.exec(stdout)) !== null) last = match
  if (!last) return null
  let raw: unknown
  try {
    raw = JSON.parse(last[1].trim())
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.schema_version !== 1) return null
  if (!Array.isArray(o.milestones)) return null
  if (typeof o.evidence !== 'string') return null
  if (typeof o.passed_count !== 'number' || typeof o.total_count !== 'number') return null
  const milestones: CheckerResult['milestones'] = []
  for (const m of o.milestones) {
    if (typeof m !== 'object' || m === null) return null
    const mm = m as Record<string, unknown>
    if (
      typeof mm.id !== 'string' ||
      typeof mm.label !== 'string' ||
      (mm.status !== 'pass' && mm.status !== 'fail' && mm.status !== 'skip')
    ) {
      return null
    }
    milestones.push({ id: mm.id, label: mm.label, status: mm.status })
  }
  return {
    schema_version: 1,
    milestones,
    evidence: o.evidence,
    passed_count: o.passed_count,
    total_count: o.total_count
  }
}

/**
 * PR-E: format the previous critic's flags for {{CRITIC_FLAGS}}. Empty
 * list (or undefined) becomes a neutral notice — we don't want to imply
 * "the critic approved" when in reality no critic has run yet, but we
 * also don't want to force the worker to read a noisy "no flags" banner
 * every turn. Non-empty list becomes a bullet list the worker is told
 * to address.
 */
function formatCriticFlagsForPrompt(flags: string[] | undefined): string {
  if (!flags || flags.length === 0) {
    return '（前回 critic は flag を上げていない / 未実行）'
  }
  const lines = ['**critic がフラグを立てた点（必ず対処してから再度達成主張すること）**:', '']
  for (const f of flags) lines.push(`- ${f}`)
  return lines.join('\n')
}

/**
 * Format a CheckerResult into a human-readable Markdown block for inclusion
 * in the next turn's prompt via {{CHECKER_RESULT}}. Returns a fallback
 * notice when no result is available so the placeholder never leaves a
 * dangling literal `{{CHECKER_RESULT}}` in the rendered prompt.
 */
function formatCheckerResultForPrompt(result: CheckerResult | null | undefined): string {
  if (!result) return '（前回 checker は未実行 / JSON 出力なし）'
  const header = `${result.passed_count} / ${result.total_count} milestones passed`
  const lines: string[] = [header]
  if (result.milestones.length > 0) {
    lines.push('')
    for (const m of result.milestones) {
      const icon = m.status === 'pass' ? '✅' : m.status === 'fail' ? '❌' : '⏭️'
      lines.push(`- ${icon} ${m.id}: ${m.label}`)
    }
  }
  if (result.evidence.trim()) {
    lines.push('', `evidence: ${result.evidence.trim()}`)
  }
  return lines.join('\n')
}

// turn-001 emits the plan inside <plan>...</plan>. Same parser shape as
// extractDigestUpdate so existing patterns hold.
export function extractPlan(stdout: string): string | null {
  const m = stdout.match(/<plan>([\s\S]*?)<\/plan>/)
  if (!m) return null
  return m[1].replace(/^\n+/, '').replace(/\n+$/, '') + '\n'
}

export function hasGoalAchievedToken(stdout: string): boolean {
  return /<goal-status>\s*achieved\s*<\/goal-status>/.test(stdout)
}

// ---------- Block summarizer ----------

interface BuildBlockPromptArgs {
  goalId: string
  blockId: string
  fromTurn: number
  toTurn: number
}

const BLOCK_PROMPT_TEMPLATE = `# Block Summary Worker

あなたは長時間自走するゴール達成エージェントの **ブロック要約 worker** です。
本タスクは{{FROM}}〜{{TO}}ターン分の生ログを読んで、
後続ターンが効率よく状況把握できる**圧縮された要約**を作成することです。

## ゴール

{{OBJECTIVE}}

## 圧縮対象のターン出力

{{TURNS_RAW}}

## 規律

- 純粋な要約タスク。新たに作業を行わない。
- 失われると致命的な情報（**試して失敗したアプローチ**、**ファイル状態**、
  **未解決ブロッカー**、**達成済みサブタスク**）は必ず保持。
- 推測や創作を含めない。ターン出力に書かれていない事実を作らない。
- 出力は <block-summary> タグで囲まれた構造化マークダウンのみ。前置き・末尾文不要。

## 出力フォーマット（必須）

<block-summary>
## このブロックで試したこと
- ...

## 主な発見・決定
- ...

## ファイル変更
- ...

## 失敗したアプローチ（再試行禁止）
- ...

## ブロック終了時点のステータス
- ...

## 未解決ブロッカー
- ...
</block-summary>
`

export async function buildBlockPrompt(args: BuildBlockPromptArgs): Promise<string> {
  const dir = goalDir(args.goalId)
  const objective = await fs.readFile(path.join(dir, 'objective.md'), 'utf8').catch(() => '')
  const rawParts: string[] = []
  for (let i = args.fromTurn; i <= args.toTurn; i++) {
    const id = `turn-${String(i).padStart(3, '0')}`
    const stdoutPath = path.join(dir, 'turns', `${id}.stdout`)
    try {
      const stdout = await fs.readFile(stdoutPath, 'utf8')
      // Trim each turn's stdout to a manageable size
      const trimmed = stdout.length > 8000 ? stdout.slice(0, 4000) + '\n...[省略]...\n' + stdout.slice(-3500) : stdout
      rawParts.push(`### ${id}\n\`\`\`\n${trimmed}\n\`\`\``)
    } catch {
      rawParts.push(`### ${id}\n(読み込みエラー)`)
    }
  }
  const subs: Record<string, string> = {
    '{{OBJECTIVE}}': objective.trim(),
    '{{FROM}}': String(args.fromTurn),
    '{{TO}}': String(args.toTurn),
    '{{TURNS_RAW}}': rawParts.join('\n\n')
  }
  let out = BLOCK_PROMPT_TEMPLATE
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v)
  return out
}

export function extractBlockSummary(stdout: string): string | null {
  const m = stdout.match(/<block-summary>([\s\S]*?)<\/block-summary>/)
  if (!m) return null
  return m[1].replace(/^\n+/, '').replace(/\n+$/, '') + '\n'
}

// ---------- Judge worker ----------

interface BuildJudgePromptArgs {
  goalId: string
  triggerTurnId: string
}

const JUDGE_PROMPT_TEMPLATE = `# Critic / Judge Worker (independent skeptic)

あなたは独立した **批評 worker (critic)** です。実装ターンとは別の context で起動されており、
**前回までの作業は知りません**。下記の証拠だけを見て、ゴールが**本当に**達成されたかを判定します。

実装エージェントは「達成しました」と過大報告しがちです。あなたの仕事は **疑うこと**。
**「証拠が薄い達成主張」を全部洗い出してください**。証拠が不十分・部分実装・テスト未通過・
ファイルがあるが中身が壊れている・エラーログが残っている等のいずれかが見つかれば、
それを <critic-flags> として列挙し、verdict は **not_yet** を返してください。

完全に確信できる場合（証拠を 1 件以上自分で確認した上で）にのみ、空の <critic-flags></critic-flags>
と <judge-verdict>achieved</judge-verdict> を返すこと。

## ゴール

{{OBJECTIVE}}

## 実装エージェントが提出した digest（自己報告）

{{DIGEST}}

## トリガとなったターンの最終出力（抜粋）

{{TRIGGER_TURN}}

## ワークスペース内の証拠を自分で確認してよい

cwd はワークスペースに固定されている。必要なら ls / cat / git log / cat <file> などで現状を確認すること。
ただし新たな実装は行わず、**判定のための読み取りのみ**に留めること。

## 出力フォーマット（必須）

最後に必ず以下の 3 ブロックをこの順で出力すること。

<judge-reason>
（1〜3 文で根拠を述べる）
</judge-reason>

<critic-flags>
- （証拠が薄い達成主張を 1 行 1 件で列挙。例: M3 完了とあるが対応するファイルが見つからない）
- （疑義がなければこのタグの中は空でよい）
</critic-flags>

<judge-verdict>achieved</judge-verdict>

または

<judge-verdict>not_yet</judge-verdict>
`

export async function buildJudgePrompt(args: BuildJudgePromptArgs): Promise<string> {
  const dir = goalDir(args.goalId)
  const objective = await fs.readFile(path.join(dir, 'objective.md'), 'utf8').catch(() => '')
  const digest = await fs.readFile(path.join(dir, 'digest.md'), 'utf8').catch(() => '')
  const triggerStdoutPath = path.join(dir, 'turns', `${args.triggerTurnId}.stdout`)
  const triggerRaw = await fs.readFile(triggerStdoutPath, 'utf8').catch(() => '')
  // Take only the last portion (where the achievement claim usually is)
  const triggerExcerpt =
    triggerRaw.length > 6000 ? '...[前略]...\n' + triggerRaw.slice(-6000) : triggerRaw
  const subs: Record<string, string> = {
    '{{OBJECTIVE}}': objective.trim(),
    '{{DIGEST}}': digest.trim(),
    '{{TRIGGER_TURN}}': triggerExcerpt
  }
  let out = JUDGE_PROMPT_TEMPLATE
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v)
  return out
}

export function extractJudgeVerdict(stdout: string): 'achieved' | 'not_yet' | null {
  const m = stdout.match(/<judge-verdict>\s*(achieved|not_yet)\s*<\/judge-verdict>/)
  if (!m) return null
  return m[1] as 'achieved' | 'not_yet'
}

export function extractJudgeReason(stdout: string): string {
  const m = stdout.match(/<judge-reason>([\s\S]*?)<\/judge-reason>/)
  return m ? m[1].trim() : ''
}

/**
 * PR-E: extract `<critic-flags>` bullet items from judge stdout. The critic
 * worker emits one line per piece of weak evidence ("M3 claimed done but
 * file missing", etc.). An empty tag (or no flags inside) means the
 * critic found nothing to push back on. Used as a gate alongside the
 * judge verdict: achieved is only honored when both `verdict='achieved'`
 * AND `flags.length === 0` (true unanimity from the skeptic).
 *
 * Returns:
 *   - the parsed bullet list when the tag is present
 *   - [] when the tag is missing entirely (treat as "no flags raised")
 *
 * Bullets accept either `- foo` or `* foo` markdown styles, ignore blank
 * lines, and trim whitespace. Lines that don't start with a bullet are
 * silently skipped (the critic occasionally writes prose between bullets).
 */
export function extractCriticFlags(stdout: string): string[] {
  const m = stdout.match(/<critic-flags>([\s\S]*?)<\/critic-flags>/)
  if (!m) return []
  const flags: string[] = []
  for (const line of m[1].split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const bullet = trimmed.match(/^[-*]\s+(.+)$/)
    if (bullet) flags.push(bullet[1].trim())
  }
  return flags
}

// ---------- Digest compressor ----------

interface BuildDigestCompressorPromptArgs {
  goalId: string
}

const DIGEST_COMPRESSOR_TEMPLATE = `# Digest Compressor Worker

あなたは長時間自走するゴール達成エージェントの **digest 圧縮 worker** です。
本タスクは、肥大化した digest.md を読んで、**情報を失わずに**より短く圧縮することです。

## ゴール（参考: 文脈理解のため）

{{OBJECTIVE}}

## 現在の digest.md（圧縮対象）

{{DIGEST}}

## 規律

- 純粋な要約タスク。新たに作業を行わない。ファイルを編集しない。
- 失われると致命的な情報（**達成済みサブタスク**、**試したが失敗したアプローチ**、
  **未解決ブロッカー**、**現在のファイル状態**、**次の最小ステップ候補**）は必ず保持。
- 重複・冗長な記述は統合する。古いターン要約は最新数件だけ残す。
- 推測や創作を含めない。digest に書かれていない事実を作らない。
- 出力は <compressed-digest> タグで囲まれた構造化マークダウンのみ。前置き・末尾文不要。

## 出力フォーマット（必須）

<compressed-digest>
## 達成済みサブタスク
- [x] ...

## 現在のファイル状態スナップショット
- ...

## 試したアプローチと失敗理由
- ...

## 未解決ブロッカー
- ...

## 次の最小ステップ候補
- ...

## 直近ターン要約
- Turn turn-XXX: ...
</compressed-digest>
`

export async function buildDigestCompressorPrompt(
  args: BuildDigestCompressorPromptArgs
): Promise<string> {
  const dir = goalDir(args.goalId)
  const objective = await fs.readFile(path.join(dir, 'objective.md'), 'utf8').catch(() => '')
  const digest = await fs.readFile(path.join(dir, 'digest.md'), 'utf8').catch(() => '')
  const subs: Record<string, string> = {
    '{{OBJECTIVE}}': objective.trim(),
    '{{DIGEST}}': digest.trim()
  }
  let out = DIGEST_COMPRESSOR_TEMPLATE
  for (const [k, v] of Object.entries(subs)) out = out.split(k).join(v)
  return out
}

export function extractCompressedDigest(stdout: string): string | null {
  const m = stdout.match(/<compressed-digest>([\s\S]*?)<\/compressed-digest>/)
  if (!m) return null
  return m[1].replace(/^\n+/, '').replace(/\n+$/, '') + '\n'
}

// ---------- Rate-limit detection (Phase 4.2 A2) ----------

// Patterns emitted when the usage window is exhausted.
// Tested against transcripts but kept conservative to avoid false positives:
// each pattern includes both a generic keyword and a quota-specific keyword.
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b5[\s-]?hour\b[\s\S]{0,80}\b(usage|limit|window|reset)/i,
  /\busage limit\b/i,
  /\brate limit(ed|ing)?\b[\s\S]{0,80}\b(usage|window|reset|tokens?|requests?|quota)/i,
  /\bquota (exceeded|reached)\b/i,
  /\btry again (in|after)\b[\s\S]{0,40}\b(hour|hours|h|min)/i
]

/**
 * Detect whether a turn's stdout/stderr indicates the Codex usage window has
 * been exhausted. Best-effort — we err on the side of false negatives to avoid
 * spuriously pausing a healthy runner. Returns the matched substring (for
 * diagnostics) or null when no pattern matches.
 */
export function detectRateLimit(text: string): string | null {
  if (!text) return null
  for (const re of RATE_LIMIT_PATTERNS) {
    const m = text.match(re)
    if (m) return m[0].slice(0, 160)
  }
  return null
}
