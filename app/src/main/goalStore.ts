// goalStore — file system layer for Codex Goal state directories.
// Goals live under ~/.codex-goals/<goal_id>/ regardless of workspace.

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import type {
  BlockSummaryEntry,
  CreateGoalParams,
  GoalBudget,
  GoalState,
  GoalStatus,
  GoalSummary,
  TurnHistoryEntry,
  UserMessage,
  WorkKind
} from '@shared/types'
import { DEFAULT_VERIFICATION_MODE, isVerificationMode } from '@shared/verification'
import { terminateProcessTree } from './orchestrator/util'

export const GOALS_ROOT = path.join(os.homedir(), '.codex-goals')

const DEFAULT_PROMPT_TEMPLATE = `# Codex Goal — Continuation Turn

あなたは長時間自走するゴール達成エージェントの **1 ターン分** を実行しています。
本ターンの最後に出力を整えれば、外側オーケストレータが次のターンを別の新しいプロセスで起動します。

## ワークスペース（成果物配置先・絶対遵守）

**このゴールのワークスペースは下記パスに固定されています**：

\`{{WORKSPACE_PATH}}\`

このゴールで作成・編集する**全てのファイルは、必ずこのパス配下に置くこと**。
ワークスペース外の絶対パス（例: 他プロジェクトの \`docs/\` 等）への書き込みは**禁止**です。
plan.md やオブジェクト文中に外部ディレクトリへのパスが含まれていた場合でも、
それは誤りとみなし、本ワークスペース配下の相当パス（無ければ新規作成）に保存し直すこと。
外部ディレクトリの**読み取り参照**は許可しますが、**書き込みは絶対に行わない**。

## ゴール

{{OBJECTIVE}}

## 立案済み計画（turn-001 で確定済み）

ゴール達成までの方針は下記計画に従うこと。計画の重大な変更が必要なら digest にその旨を記録した上で実施する。

{{PLAN}}

## これまでの作業の長期記憶（block summaries）

直近のブロック単位で要約された過去ターンの記録です。同じ失敗を繰り返さないために
「失敗したアプローチ」セクションを必ず尊重してください。

{{BLOCKS}}

## これまでの作業状況（digest）

{{DIGEST}}

## 直近証拠（外部観測 / self-report ではなくシェルコマンド出力）

digest はあなた自身が書いた要約なので、書き漏れや言い違いがありえます。下記は
オーケストレータが各ターン前にシェルから直接取得した一次資料です。digest の
主張と矛盾していないか軽く照合してから本ターンの作業を進めてください。

{{EVIDENCE}}

## 直前 checker 結果

ハードチェッカー（checker.sh）が出力した構造化結果です。マイルストーン単位
の達成状況が見えるので、digest の「達成済みサブタスク」と乖離している項目
があれば注意してください。

{{CHECKER_RESULT}}

## 直前 critic 指摘

前回 \`<goal-status>achieved</goal-status>\` を出した時に独立 critic worker
が「証拠が薄い」と push back した項目です。空欄なら critic は未実行 or
flag なし。具体的な指摘がある場合は、**新しいアプローチを試す前に各 flag を
個別に解消**することを最優先にしてください。

{{CRITIC_FLAGS}}

## 残り budget

- ターン: {{TURNS_USED}} / {{MAX_TURNS}}
- 経過時間: 約 {{ELAPSED_MIN}} 分
- per-turn timeout: {{PER_TURN_TIMEOUT}} 秒

## このターンの規律（必ず守ること）

1. ゴール達成に向けて **次の最小ステップを 1 つだけ** 実行せよ。複数ステップを一気にやらない。
2. 「次の最小ステップ」は **digest の候補だけで決めず、必ず上記「立案済み計画」(plan.md) の現在マイルストーンと照合**してから選ぶこと。digest の候補が plan の流れから逸れている、もしくは workspace の README 等から拾った作業が plan に無いなら、**plan を優先**せよ。plan を意図的に変更する場合は digest にその旨を残してから着手する。
3. ユーザーへの確認は求めない。判断は自律的に行え。
4. 作業ディレクトリ（cwd）はワークスペース \`{{WORKSPACE_PATH}}\` に固定されている。そこから外れない。**ファイル作成・編集は必ずこの配下に行うこと**。外部ディレクトリへの絶対パス書き込み（plan に書かれていても）は禁止。
5. 破壊的操作（rm -rf, force push など）は避ける。必要なら digest に記録して停止する。
6. 出力の最後に必ず以下の **digest-update ブロック** を含めよ。これが次ターンへの引き継ぎになる。
7. プロンプトに「📨 ユーザーからの追加指示」セクションがあれば、ターン本文の冒頭で各メッセージに対し \`<user-reply id="...">短い返答</user-reply>\` を出力すること。返答後に通常作業を進める。

## 出力フォーマット

通常通り作業ログを出した後、最後に必ず：

\`\`\`
<digest-update>
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
- Turn {{CURRENT_TURN}}: <今ターンで何をやったか 1〜2 行>

## 現在のマイルストーン (plan.md 由来)
- 例: M2「ログイン画面実装」進行中 / M1 完了
- plan.md が無い、もしくは plan から逸脱中なら「plan 未参照」と明記してその理由を述べる
</digest-update>
<!-- END DIGEST -->
\`\`\`

\`<!-- END DIGEST -->\` は **digest-update ブロックの直後に必ず 1 行**で出力すること。
これによりオーケストレータが部分出力や中断された stdout から不完全な digest を
誤抽出する事故を防ぐ。ゴールに到達したと判断したら、digest-update の **後に** 以下を追記せよ：

\`\`\`
<goal-status>achieved</goal-status>
\`\`\`

それでは作業を開始してください。
`

const INITIAL_DIGEST = '（まだ作業履歴はありません。最初のターンです。）\n'

/**
 * Derive a human-readable title from the objective text. Used at goal creation
 * and as a fallback when listing legacy goals whose state.json predates the
 * `title` field.
 */
export function generateTitle(objective: string): string {
  const lines = objective.split('\n')
  for (const raw of lines) {
    const cleaned = raw.replace(/^#+\s*/, '').replace(/^[-*+]\s+/, '').trim()
    if (cleaned.length === 0) continue
    return cleaned.length > 60 ? cleaned.slice(0, 60).trim() + '…' : cleaned
  }
  return '(無題のゴール)'
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'goal'
}

function shortId(): string {
  return crypto.randomBytes(3).toString('hex')
}

export async function ensureGoalsRoot(): Promise<void> {
  await fs.mkdir(GOALS_ROOT, { recursive: true })
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    const data = await fs.readFile(p, 'utf8')
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

async function writeJson(p: string, value: unknown): Promise<void> {
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export async function listGoals(workspacePath?: string): Promise<GoalSummary[]> {
  await ensureGoalsRoot()
  const entries = await fs.readdir(GOALS_ROOT, { withFileTypes: true })
  const summaries: GoalSummary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const goalDir = path.join(GOALS_ROOT, entry.name)
    const state = await readJson<GoalState>(path.join(goalDir, 'state.json'))
    const budget = await readJson<GoalBudget>(path.join(goalDir, 'budget.json'))
    if (!state || !budget) continue
    if (workspacePath && state.workspace_path !== workspacePath) continue

    let objectivePreview = ''
    let fullObjective = ''
    try {
      fullObjective = await fs.readFile(path.join(goalDir, 'objective.md'), 'utf8')
      objectivePreview = fullObjective.split('\n').slice(0, 6).join('\n').slice(0, 400)
    } catch {
      objectivePreview = '(objective not readable)'
    }

    if (!state.title) {
      state.title = generateTitle(fullObjective || objectivePreview)
    }

    summaries.push({
      goal_id: entry.name,
      objective_preview: objectivePreview,
      state,
      budget,
      has_checker: existsSync(path.join(goalDir, 'checker.sh'))
    })
  }

  // newest first
  summaries.sort(
    (a, b) =>
      new Date(b.state.created_at).getTime() -
      new Date(a.state.created_at).getTime()
  )
  return summaries
}

export async function getGoal(goalId: string): Promise<GoalSummary | null> {
  const goalDir = path.join(GOALS_ROOT, goalId)
  if (!existsSync(goalDir)) return null
  const state = await readJson<GoalState>(path.join(goalDir, 'state.json'))
  const budget = await readJson<GoalBudget>(path.join(goalDir, 'budget.json'))
  if (!state || !budget) return null
  let objective = ''
  try {
    objective = await fs.readFile(path.join(goalDir, 'objective.md'), 'utf8')
  } catch {
    objective = ''
  }
  if (!state.title) {
    state.title = generateTitle(objective)
  }
  return {
    goal_id: goalId,
    objective_preview: objective,
    state,
    budget,
    has_checker: existsSync(path.join(goalDir, 'checker.sh'))
  }
}

// Only these two statuses are valid as initial state. Other statuses (active,
// paused, achieved, failed, …) are produced by the runner / user actions later.
const ALLOWED_INITIAL_STATUSES: ReadonlyArray<GoalStatus> = ['pending', 'planning']

export async function createGoal(params: CreateGoalParams): Promise<GoalSummary> {
  await ensureGoalsRoot()

  if (
    params.initial_status !== undefined &&
    !ALLOWED_INITIAL_STATUSES.includes(params.initial_status)
  ) {
    throw new Error(
      `Invalid initial_status: ${params.initial_status}. Allowed: ${ALLOWED_INITIAL_STATUSES.join(', ')}`
    )
  }

  const goalId = `${slugify(params.goal_id_slug)}-${shortId()}`
  const goalDir = path.join(GOALS_ROOT, goalId)

  if (existsSync(goalDir)) {
    throw new Error(`Goal directory already exists: ${goalDir}`)
  }

  // Resolve workspace path absolutely; create if missing.
  const workspaceAbs = path.resolve(params.workspace_path)
  await fs.mkdir(workspaceAbs, { recursive: true })

  await fs.mkdir(path.join(goalDir, 'turns'), { recursive: true })
  await fs.mkdir(path.join(goalDir, 'history', 'raw'), { recursive: true })
  await fs.mkdir(path.join(goalDir, 'history', 'blocks'), { recursive: true })
  await fs.mkdir(path.join(goalDir, 'logs'), { recursive: true })

  await fs.writeFile(path.join(goalDir, 'objective.md'), params.objective, 'utf8')
  await fs.writeFile(path.join(goalDir, 'digest.md'), INITIAL_DIGEST, 'utf8')
  await fs.writeFile(
    path.join(goalDir, 'prompt-template.md'),
    DEFAULT_PROMPT_TEMPLATE,
    'utf8'
  )

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const state: GoalState = {
    goal_id: goalId,
    title: generateTitle(params.objective),
    // 'pending': legacy auto-start path. 'planning': plan-mode opt-in — runner
    // stays dormant until the user approves the plan in PlanReview.
    status: params.initial_status ?? 'pending',
    created_at: now,
    updated_at: now,
    turns: 0,
    last_turn_id: null,
    last_result: null,
    workspace_path: workspaceAbs,
    parent_goal_id: null,
    // PR-D: persist the form's "checker.sh を必須にする" choice. Default to
    // false here so a missing/legacy CreateGoalParams.checker_required behaves
    // identically to pre-PR-D (judge-only path stays available). The NewGoal
    // form sets this to true by default for new goals.
    checker_required: params.checker_required ?? false,
    verification_mode: isVerificationMode(params.verification_mode)
      ? params.verification_mode
      : DEFAULT_VERIFICATION_MODE
  }
  await writeJson(path.join(goalDir, 'state.json'), state)
  await writeJson(path.join(goalDir, 'budget.json'), params.budget)

  if (params.checker_script && params.checker_script.trim().length > 0) {
    const checkerPath = path.join(goalDir, 'checker.sh')
    await fs.writeFile(checkerPath, params.checker_script, 'utf8')
    await fs.chmod(checkerPath, 0o755)
  }

  const created = await getGoal(goalId)
  if (!created) throw new Error('Failed to read back created goal')
  return created
}

// Phase 4.2 E1: edit objective.md from the renderer.
// Returns the refreshed goal summary.
export async function updateObjective(
  goalId: string,
  objective: string
): Promise<GoalSummary | null> {
  const goalDir = path.join(GOALS_ROOT, goalId)
  if (!existsSync(goalDir)) return null
  if (typeof objective !== 'string') {
    throw new Error('objective must be a string')
  }
  await fs.writeFile(path.join(goalDir, 'objective.md'), objective, 'utf8')

  const statePath = path.join(goalDir, 'state.json')
  const state = await readJson<GoalState>(statePath)
  if (state) {
    const next: GoalState = {
      ...state,
      updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    }
    await writeJson(statePath, next)
  }
  return getGoal(goalId)
}

// Phase 4.2 E1: edit budget.json from the renderer. Validates that every
// numeric field is a positive finite number; rejects partial budgets so we
// never persist an inconsistent state.
export async function updateBudget(
  goalId: string,
  budget: GoalBudget
): Promise<GoalSummary | null> {
  const goalDir = path.join(GOALS_ROOT, goalId)
  if (!existsSync(goalDir)) return null

  const fields: Array<keyof GoalBudget> = [
    'max_turns',
    'max_wall_time_seconds',
    'per_turn_timeout_seconds',
    'heartbeat_threshold_seconds',
    'rate_limit_sleep_seconds'
  ]
  const validated: Partial<GoalBudget> = {}
  for (const k of fields) {
    const v = budget?.[k]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`budget.${k} must be a positive number (got ${String(v)})`)
    }
    validated[k] = Math.floor(v)
  }
  await writeJson(path.join(goalDir, 'budget.json'), validated as GoalBudget)

  const statePath = path.join(goalDir, 'state.json')
  const state = await readJson<GoalState>(statePath)
  if (state) {
    const next: GoalState = {
      ...state,
      updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
    }
    await writeJson(statePath, next)
  }
  return getGoal(goalId)
}

export async function deleteGoal(goalId: string): Promise<void> {
  const goalDir = path.join(GOALS_ROOT, goalId)
  if (!existsSync(goalDir)) return
  await fs.rm(goalDir, { recursive: true, force: true })
}

export async function markAchieved(goalId: string): Promise<GoalSummary | null> {
  const statePath = path.join(GOALS_ROOT, goalId, 'state.json')
  const cur = await readJson<GoalState>(statePath)
  if (!cur || cur.status !== 'paused') return null
  const updated: GoalState = {
    ...cur,
    status: 'achieved',
    next_resume_at: null,
    updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  }
  await writeJson(statePath, updated)
  return getGoal(goalId)
}

/**
 * Narrow status mutation used by callers outside the runner (e.g., planSession
 * approving or aborting a plan). Keeps the writeJson invariant in one place.
 *
 * If `expectFrom` is provided, the write is skipped when the current status
 * doesn't match — callers can use this to avoid clobbering a status that the
 * runner has already moved past (e.g., the user already pressed Start).
 */
export async function setStatus(
  goalId: string,
  next: GoalStatus,
  expectFrom?: GoalStatus | ReadonlyArray<GoalStatus>
): Promise<GoalState | null> {
  const statePath = path.join(GOALS_ROOT, goalId, 'state.json')
  const cur = await readJson<GoalState>(statePath)
  if (!cur) return null
  if (expectFrom !== undefined) {
    const allowed = Array.isArray(expectFrom) ? expectFrom : [expectFrom as GoalStatus]
    if (!allowed.includes(cur.status)) return null
  }
  const updated: GoalState = {
    ...cur,
    status: next,
    updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  }
  await writeJson(statePath, updated)
  return updated
}

const KIND_DIRS: Array<[WorkKind, string]> = [
  ['turn', 'turns'],
  ['block', 'blocks'],
  ['judge', 'judge'],
  ['block-judge', 'block-judge']
]

export async function listTurns(goalId: string): Promise<TurnHistoryEntry[]> {
  const dir = path.join(GOALS_ROOT, goalId)
  if (!existsSync(dir)) return []

  const entries: TurnHistoryEntry[] = []

  for (const [kind, sub] of KIND_DIRS) {
    const subDir = path.join(dir, sub)
    if (!existsSync(subDir)) continue
    let names: string[] = []
    try {
      names = await fs.readdir(subDir)
    } catch {
      continue
    }
    // Group by workId (filename stem before extension)
    const byId = new Map<string, { mtime: number }>()
    for (const name of names) {
      const m = name.match(/^([a-z]+-\d+)\.(prompt|stdout|stderr|result|heartbeat)$/)
      if (!m) continue
      const id = m[1]
      try {
        const stat = await fs.stat(path.join(subDir, name))
        const cur = byId.get(id)
        if (!cur || stat.mtimeMs > cur.mtime) byId.set(id, { mtime: stat.mtimeMs })
      } catch {
        // skip
      }
    }
    for (const [workId, meta] of byId) {
      let result: string | null = null
      try {
        const r = await fs.readFile(path.join(subDir, `${workId}.result`), 'utf8')
        result = r.trim()
      } catch {
        // pending or missing
      }
      entries.push({
        kind,
        workId,
        result,
        mtime: new Date(meta.mtime).toISOString(),
        hasStdout: existsSync(path.join(subDir, `${workId}.stdout`)),
        hasPrompt: existsSync(path.join(subDir, `${workId}.prompt`))
      })
    }
  }

  // newest first
  entries.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime())
  return entries
}

export async function readTurnStdout(
  goalId: string,
  workId: string,
  kind: WorkKind
): Promise<string> {
  // kind → subdir 名のマッピングは KIND_DIRS に一元化されているのでそこから引く。
  // 未知の kind を渡されたら turns にフォールバックして握りつぶす（呼び出し側
  // が型でガードしているはずだが念のため）。
  const sub = KIND_DIRS.find(([k]) => k === kind)?.[1] ?? 'turns'
  const file = path.join(GOALS_ROOT, goalId, sub, `${workId}.stdout`)
  return fs.readFile(file, 'utf8').catch(() => '')
}

// Phase 4.2 E3: list block summaries persisted under <goalDir>/history/blocks.
// These are the compressed long-term memory injected into the main prompt.
export async function listBlocks(goalId: string): Promise<BlockSummaryEntry[]> {
  const blocksDir = path.join(GOALS_ROOT, goalId, 'history', 'blocks')
  let names: string[]
  try {
    names = await fs.readdir(blocksDir)
  } catch {
    return []
  }
  const entries: BlockSummaryEntry[] = []
  for (const name of names) {
    const m = name.match(/^(block-\d+)\.md$/)
    if (!m) continue
    try {
      const stat = await fs.stat(path.join(blocksDir, name))
      entries.push({
        blockId: m[1],
        mtime: new Date(stat.mtimeMs).toISOString(),
        bytes: stat.size
      })
    } catch {
      // skip
    }
  }
  // newest block first (matches turn history order)
  entries.sort((a, b) => b.blockId.localeCompare(a.blockId))
  return entries
}

export async function readBlock(goalId: string, blockId: string): Promise<string> {
  // Reject any blockId that could escape the blocks directory.
  if (!/^block-\d+$/.test(blockId)) return ''
  const file = path.join(GOALS_ROOT, goalId, 'history', 'blocks', `${blockId}.md`)
  return fs.readFile(file, 'utf8').catch(() => '')
}

const PID_SUBDIRS = ['turns', 'blocks', 'judge', 'block-judge', 'compressor'] as const

/**
 * Scan <goalDir>/{turns,blocks,judge}/*.pid for processes that are still alive
 * (orphaned because the parent app crashed) and send SIGTERM to them.
 * Returns a list of pids we attempted to terminate.
 */
async function reapOrphanedPids(goalDir: string): Promise<number[]> {
  const reaped: number[] = []
  for (const sub of PID_SUBDIRS) {
    const subDir = path.join(goalDir, sub)
    let names: string[]
    try {
      names = await fs.readdir(subDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.pid')) continue
      const pidFile = path.join(subDir, name)
      let pid: number
      try {
        const raw = await fs.readFile(pidFile, 'utf8')
        pid = parseInt(raw.trim(), 10)
      } catch {
        continue
      }
      if (!Number.isFinite(pid) || pid <= 1) {
        // Stale/invalid pid file — remove so we don't keep tripping on it.
        await fs.unlink(pidFile).catch(() => {})
        continue
      }
      // kill -0 to test for liveness without sending a real signal.
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
      if (alive) {
        // Cross-platform tree termination (POSIX: -pid → pid fallback,
        // Windows: taskkill /F /T). Best-effort — process may have died
        // between the kill -0 probe and the actual signal.
        await terminateProcessTree(pid, 'SIGTERM')
        reaped.push(pid)
      } else {
        // Dead pid → remove the stale file.
        await fs.unlink(pidFile).catch(() => {})
      }
    }
  }
  return reaped
}

/**
 * On app startup, mark goals stuck in 'active' (no runner alive across restart)
 * as 'paused' so the UI shows a coherent state. Additionally scan all goal
 * directories for orphaned PID files and SIGTERM any process still alive
 * (e.g., a Terminal-launched `codex` process that survived an Electron crash).
 */
export async function markOrphanedActiveAsPaused(): Promise<string[]> {
  await ensureGoalsRoot()
  const entries = await fs.readdir(GOALS_ROOT, { withFileTypes: true })
  const updated: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const goalDir = path.join(GOALS_ROOT, entry.name)
    const statePath = path.join(goalDir, 'state.json')
    const state = await readJson<GoalState>(statePath)
    if (!state) continue

    // Reap orphaned child processes regardless of state. Even goals already in
    // 'paused'/'achieved' may have leftover .pid files from a crash.
    try {
      await reapOrphanedPids(goalDir)
    } catch {
      // Swallow: cleanup must never block startup.
    }

    // Only mutate orphaned 'active' goals. 'planning' goals must NOT be touched
    // here: they intentionally have no runner alive (the user is still in the
    // plan review screen) and flipping them to 'paused' would lose the
    // approval-gate state. Same for terminal/idle states.
    if (state.status === 'active') {
      const next: GoalState = {
        ...state,
        status: 'paused',
        updated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z')
      }
      await writeJson(statePath, next)
      updated.push(state.goal_id)
    }
  }
  return updated
}

// ---- Phase 4.3: user-message queue (mid-flight directives) ----

function userMessagesPath(goalId: string): string {
  return path.join(GOALS_ROOT, goalId, 'user-messages.jsonl')
}

function newMessageId(): string {
  return `msg-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`
}

/**
 * Append a user-typed directive to the goal's message queue. Returns the
 * created record so callers (IPC handler) can broadcast it.
 */
export async function addUserMessage(
  goalId: string,
  text: string
): Promise<UserMessage> {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('empty user message')
  const goalDir = path.join(GOALS_ROOT, goalId)
  if (!existsSync(goalDir)) throw new Error(`goal not found: ${goalId}`)
  const msg: UserMessage = {
    id: newMessageId(),
    ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    text: trimmed,
    consumed_at_turn: null
  }
  await fs.appendFile(userMessagesPath(goalId), JSON.stringify(msg) + '\n', 'utf8')
  return msg
}

export async function listUserMessages(goalId: string): Promise<UserMessage[]> {
  const file = userMessagesPath(goalId)
  try {
    const data = await fs.readFile(file, 'utf8')
    const out: UserMessage[] = []
    for (const line of data.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as UserMessage)
      } catch {
        // skip malformed lines
      }
    }
    return out
  } catch {
    return []
  }
}

export async function listUnconsumedUserMessages(
  goalId: string
): Promise<UserMessage[]> {
  const all = await listUserMessages(goalId)
  return all.filter((m) => m.consumed_at_turn == null)
}

/**
 * Mark the given message ids as consumed by a turn. The file is rewritten
 * atomically so concurrent readers see either the old or the new state, never
 * a partial write.
 */
export async function markUserMessagesConsumed(
  goalId: string,
  ids: string[],
  turnId: string
): Promise<void> {
  if (ids.length === 0) return
  const all = await listUserMessages(goalId)
  if (all.length === 0) return
  const idSet = new Set(ids)
  let mutated = false
  for (const m of all) {
    if (idSet.has(m.id) && m.consumed_at_turn == null) {
      m.consumed_at_turn = turnId
      mutated = true
    }
  }
  if (!mutated) return
  const file = userMessagesPath(goalId)
  const tmp = file + '.tmp'
  const body = all.map((m) => JSON.stringify(m)).join('\n') + '\n'
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * Phase 4.4: store the worker's reply to a specific user message. Rewrites
 * user-messages.jsonl atomically so concurrent readers always see a complete
 * file.
 */
export async function setUserMessageReply(
  goalId: string,
  messageId: string,
  reply: { text: string; ts: string; turn_id: string }
): Promise<void> {
  const all = await listUserMessages(goalId)
  const idx = all.findIndex((m) => m.id === messageId)
  if (idx === -1) return
  all[idx] = { ...all[idx], reply }
  const file = userMessagesPath(goalId)
  const tmp = file + '.tmp'
  const body = all.map((m) => JSON.stringify(m)).join('\n') + '\n'
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, file)
}
