// Codex-backed interactive planning session.
//
// Codex CLI does not expose a Claude-style `--permission-mode plan` flag, but
// it can run non-interactively and then continue the same thread with
// `codex exec resume <thread_id>`. We use that as the planning transport:
// the plan phase is read-only, each user message resumes the same Codex thread,
// and the approved `<plan>...</plan>` is persisted before the normal runner
// starts.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

import type { PlanChatMessage, PlanEvent, PlanSessionStatus } from '@shared/types'

import * as goalStore from './goalStore'
import { detectCodexBin } from './orchestrator/runTurn'
import { goalDir, isoNow, terminateProcessTree } from './orchestrator/util'
import { getSettings } from './settings'

type PlanEventListener = (event: PlanEvent) => void

interface InternalSession {
  goalId: string
  workspacePath: string
  threadId: string | null
  history: PlanChatMessage[]
  pendingPlan: string | null
  stdoutBuffer: string
  currentAssistantText: string
  awaitingResult: boolean
  currentProc: ChildProcessWithoutNullStreams | null
  exitReason: 'approved' | 'aborted' | null
}

const sessions = new Map<string, InternalSession>()
const listeners = new Set<PlanEventListener>()
const STDOUT_BUFFER_LIMIT = 8 * 1024 * 1024

export function onPlanEvent(listener: PlanEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getStatus(goalId: string): PlanSessionStatus {
  const sess = sessions.get(goalId)
  if (!sess) {
    return { goalId, active: false, sessionId: null, history: [], pendingPlan: null }
  }
  return {
    goalId,
    active: true,
    sessionId: sess.threadId,
    history: [...sess.history],
    pendingPlan: sess.pendingPlan
  }
}

export async function start(goalId: string, objective: string): Promise<PlanSessionStatus> {
  if (sessions.has(goalId)) {
    throw new Error(`plan session already active for ${goalId}`)
  }

  const summary = await goalStore.getGoal(goalId)
  if (!summary) throw new Error(`goal not found: ${goalId}`)

  const sess: InternalSession = {
    goalId,
    workspacePath: summary.state.workspace_path,
    threadId: null,
    history: [],
    pendingPlan: null,
    stdoutBuffer: '',
    currentAssistantText: '',
    awaitingResult: false,
    currentProc: null,
    exitReason: null
  }
  sessions.set(goalId, sess)
  emit({ type: 'session-started', goalId, sessionId: null, ts: isoNow() })

  void runCodexPlanTurn(sess, buildSeedMessage(objective, sess.workspacePath)).catch((err) => {
    handleTurnError(sess, err)
  })

  return getStatus(goalId)
}

export async function sendMessage(goalId: string, text: string): Promise<void> {
  const sess = sessions.get(goalId)
  if (!sess) throw new Error(`no active plan session for ${goalId}`)
  if (sess.awaitingResult) {
    throw new Error('previous turn still in progress — wait for the assistant to finish')
  }
  const userText = text.trim()
  if (!userText) return
  sess.history.push({ role: 'user', text: userText, ts: isoNow() })
  void runCodexPlanTurn(sess, buildFollowupMessage(userText)).catch((err) => {
    handleTurnError(sess, err)
  })
}

export async function approve(goalId: string, override?: string): Promise<string> {
  const sess = sessions.get(goalId)
  if (!sess) throw new Error(`no active plan session for ${goalId}`)
  const plan = override ?? sess.pendingPlan
  if (!plan || plan.trim().length === 0) {
    throw new Error('no plan available to approve')
  }

  await fs.writeFile(path.join(goalDir(goalId), 'plan.md'), plan.trim() + '\n', 'utf8')
  await goalStore.setStatus(goalId, 'pending', 'planning')

  sess.pendingPlan = plan
  await abortInternal(sess, 'approved')
  return plan
}

export async function abort(goalId: string): Promise<boolean> {
  const sess = sessions.get(goalId)
  if (!sess) return false
  await goalStore.setStatus(goalId, 'pending', 'planning')
  await abortInternal(sess, 'aborted')
  return true
}

export function abortAll(): void {
  for (const sess of Array.from(sessions.values())) {
    if (sess.exitReason) continue
    sess.exitReason = 'aborted'
    const pid = sess.currentProc?.pid
    if (typeof pid === 'number') {
      void terminateProcessTree(pid, 'SIGKILL')
    }
    void goalStore.setStatus(sess.goalId, 'pending', 'planning').catch(() => {})
    sessions.delete(sess.goalId)
  }
}

function emit(event: PlanEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // listener bugs must not crash the session
    }
  }
}

function buildSeedMessage(objective: string, workspacePath?: string): string {
  const lines = [
    'You are Codex running in an interactive planning phase for Codex Goal.',
    '',
    'Important constraints:',
    '- This phase is planning only. Do not edit, create, delete, install, run builds, or perform destructive actions.',
    '- You may inspect the workspace with read-only commands if it helps you plan.',
    '- Ask concise clarifying questions when the goal is ambiguous.',
    '- Continue the discussion naturally across turns.',
    '- When you have enough information, output the final plan inside a single <plan>...</plan> block.',
    '- The plan should be concrete enough for a later autonomous Codex runner to execute.',
    '- Write user-facing text in Japanese unless the user explicitly asks otherwise.'
  ]
  // codex プロセスはこの workspacePath を cwd として起動されているので、
  // 通常はツールがそのまま正しいルートを見る。ただし会話初期で「ここはどこ？」
  // と Codex 自身が言うケースを潰し、加えて成果物配置先がワークスペース外に
  // ずれる事故を防ぐため、プロンプトでも明示する。
  if (workspacePath && workspacePath.length > 0) {
    lines.push(
      '',
      `Your current working directory (project root) is: ${workspacePath}`,
      'Treat this path as the project the user wants to plan for.',
      '',
      '## Hard rule for the plan output (absolute)',
      '',
      `All deliverables produced by following this plan MUST be placed under \`${workspacePath}\`.`,
      'When the plan describes a directory layout or file path, write those paths',
      `as relative to \`${workspacePath}\`, or as absolute paths whose prefix is exactly \`${workspacePath}\`.`,
      'NEVER point the plan at another project directory (e.g. a different repo under',
      '`~/Projects/`, another `docs/` folder, etc.) as the destination for new files.',
      'Even if the user goal text mentions another product/project name as context',
      "(e.g. \"Salesforce\", \"frontend\"), that's contextual information — not a save",
      'location. Always anchor the save location to the workspace path above.',
      'Reading from external directories is allowed; writing to them is forbidden.'
    )
  }
  lines.push(
    '',
    'Required final plan format:',
    '<plan>',
    '## 全体方針',
    '...',
    '',
    '## マイルストーン',
    '1. ...',
    '',
    '## 実行ステップ',
    '- ...',
    '',
    '## 検証方法',
    '- ...',
    '',
    '## リスク・確認事項',
    '- ...',
    '</plan>',
    '',
    '<goal>',
    objective.trim(),
    '</goal>'
  )
  return lines.join('\n')
}

function buildFollowupMessage(text: string): string {
  return [
    text,
    '',
    'Reminder: stay in planning mode. If the plan is ready for user approval, include the complete final plan in <plan>...</plan>. Otherwise ask the next concise question or explain the planning tradeoff.'
  ].join('\n')
}

async function runCodexPlanTurn(sess: InternalSession, promptText: string): Promise<void> {
  const codexBin = await detectCodexBin()
  if (!codexBin) throw new Error('codex CLI binary not found')

  const settings = await getSettings()
  const baseArgs = [
    '-a',
    'never',
    '--sandbox',
    'read-only',
    '--model',
    settings.default_model,
    '-C',
    sess.workspacePath,
    'exec'
  ]
  const args = sess.threadId
    ? [...baseArgs, 'resume', '--json', '--skip-git-repo-check', sess.threadId, '-']
    : [...baseArgs, '--json', '--skip-git-repo-check', '-']

  const isWinBatch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin)
  const spawnExec = isWinBatch ? 'cmd.exe' : codexBin
  const spawnArgs = isWinBatch ? ['/c', codexBin, ...args] : args

  sess.awaitingResult = true
  sess.currentAssistantText = ''
  sess.stdoutBuffer = ''

  const child = spawn(spawnExec, spawnArgs, {
    cwd: sess.workspacePath,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  sess.currentProc = child

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => handleStdoutChunk(sess, chunk))

  let stderrText = ''
  let stdinError: Error | null = null
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
  })

  child.stdin.on('error', (err) => {
    stdinError = err instanceof Error ? err : new Error(String(err))
  })
  try {
    child.stdin.end(promptText)
  } catch (err) {
    stdinError = err instanceof Error ? err : new Error(String(err))
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('close', (code) => resolve(code))
    child.on('error', reject)
  })

  if (sess.currentProc === child) sess.currentProc = null

  if (stdinError && !sess.exitReason) {
    throw new Error(`codex plan stdin error: ${stdinError.message}`)
  }

  if (exitCode !== 0 && !sess.exitReason) {
    throw new Error(stderrText.trim() || `codex plan turn failed with exit code ${exitCode ?? '?'}`)
  }
}

function handleTurnError(sess: InternalSession, err: unknown): void {
  sess.awaitingResult = false
  sess.currentProc = null
  const message = err instanceof Error ? err.message : String(err)
  emit({ type: 'error', goalId: sess.goalId, message, ts: isoNow() })
  emit({ type: 'turn-complete', goalId: sess.goalId, ts: isoNow() })
}

function handleStdoutChunk(sess: InternalSession, chunk: string): void {
  sess.stdoutBuffer += chunk
  if (sess.stdoutBuffer.length > STDOUT_BUFFER_LIMIT) {
    sess.stdoutBuffer = ''
    handleTurnError(sess, new Error(`stdout buffer overflow (>${STDOUT_BUFFER_LIMIT} bytes without newline)`))
    return
  }

  let newlineIdx = sess.stdoutBuffer.indexOf('\n')
  while (newlineIdx >= 0) {
    const line = sess.stdoutBuffer.slice(0, newlineIdx).trim()
    sess.stdoutBuffer = sess.stdoutBuffer.slice(newlineIdx + 1)
    if (line.length > 0) {
      try {
        handleCodexEvent(sess, JSON.parse(line) as CodexEvent)
      } catch {
        // ignore malformed banner/noise lines
      }
    }
    newlineIdx = sess.stdoutBuffer.indexOf('\n')
  }
}

type CodexEvent =
  | { type: 'thread.started'; thread_id?: string }
  | { type: 'turn.started' }
  | { type: 'item.completed'; item?: { type?: string; text?: string } }
  | { type: 'turn.completed'; usage?: unknown }
  | { type: string }

function handleCodexEvent(sess: InternalSession, evt: CodexEvent): void {
  if (evt.type === 'thread.started') {
    const started = evt as Extract<CodexEvent, { type: 'thread.started' }>
    const id = typeof started.thread_id === 'string' ? started.thread_id : null
    if (id && sess.threadId !== id) {
      sess.threadId = id
      emit({ type: 'session-started', goalId: sess.goalId, sessionId: id, ts: isoNow() })
    }
    return
  }

  if (evt.type === 'item.completed') {
    const completed = evt as Extract<CodexEvent, { type: 'item.completed' }>
    if (completed.item?.type !== 'agent_message') return
    const text = typeof completed.item?.text === 'string' ? completed.item.text : ''
    if (!text) return
    sess.currentAssistantText += text
    emit({ type: 'assistant-text', goalId: sess.goalId, text, ts: isoNow() })
    const plan = extractPlan(text) ?? extractPlan(sess.currentAssistantText)
    if (plan !== null) {
      sess.pendingPlan = plan
      emit({ type: 'plan-ready', goalId: sess.goalId, plan, ts: isoNow() })
    }
    return
  }

  if (evt.type === 'turn.completed') {
    sess.awaitingResult = false
    if (sess.currentAssistantText.trim().length > 0) {
      sess.history.push({
        role: 'assistant',
        text: sess.currentAssistantText,
        ts: isoNow()
      })
      sess.currentAssistantText = ''
    }
    emit({ type: 'assistant-message-complete', goalId: sess.goalId, ts: isoNow() })
    emit({ type: 'turn-complete', goalId: sess.goalId, ts: isoNow() })
  }
}

function extractPlan(text: string): string | null {
  const matches = [...text.matchAll(/<plan>([\s\S]*?)<\/plan>/g)]
  const last = matches.at(-1)
  if (!last) return null
  const body = last[1].trim()
  return body.length > 0 ? body : ''
}

async function abortInternal(
  sess: InternalSession,
  reason: 'approved' | 'aborted'
): Promise<void> {
  if (sess.exitReason) return
  sess.exitReason = reason
  sessions.delete(sess.goalId)

  const pid = sess.currentProc?.pid
  if (typeof pid === 'number') {
    await terminateProcessTree(pid, 'SIGTERM')
  }
  sess.currentProc = null

  emit({ type: 'session-ended', goalId: sess.goalId, reason, ts: isoNow() })
}

export const __test = {
  buildSeedMessage,
  buildFollowupMessage,
  extractPlan,
  handleStdoutChunk,
  handleCodexEvent,
  sessions
}
