// Interactive plan-mode session.
//
// The Claude version used a long-lived `claude --permission-mode plan`
// stream-json process. Codex currently has `codex exec --json` for
// non-interactive turns, but this app has not yet verified an equivalent
// long-lived plan-mode stdin protocol. For the Codex MVP, the UI disables
// detailed planning and this module returns a clear error if called.
//
// Phase 2 step 1 (this file): skeleton only — spawn wiring, line-buffered
// stream-json parser, ExitPlanMode detection, type=result turn-complete
// detection, internal session registry. PlanEvent broadcast and the IPC
// handler differential are wired in subsequent steps. Approval persistence
// (writing plan.md, transitioning the goal status) lives in step 2.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { PlanChatMessage, PlanEvent, PlanSessionStatus } from '@shared/types'

import * as goalStore from './goalStore'
import { goalDir, isoNow, terminateProcessTree } from './orchestrator/util'

// ---------------------------------------------------------------------------
// Types — internal to this module
// ---------------------------------------------------------------------------

type PlanEventListener = (event: PlanEvent) => void

interface InternalSession {
  goalId: string
  proc: ChildProcessWithoutNullStreams
  sessionId: string | null
  history: PlanChatMessage[]
  pendingPlan: string | null
  // Buffer for partial stdout chunks between newline boundaries.
  stdoutBuffer: string
  // Accumulator for the assistant's text content within the current turn so
  // the renderer can show streamed text before type=result fires.
  currentAssistantText: string
  // True between sending a user message and seeing type=result. The renderer
  // uses this to show a "送信中…" indicator.
  awaitingResult: boolean
  // Set by approve()/abort() before tearing down the proc so the on('exit')
  // handler can distinguish intentional teardown from a crash. If null at
  // exit time, we treat it as a crash and revert status accordingly.
  exitReason: 'approved' | 'aborted' | null
}

// Module-level registry. One InternalSession per goalId at most.
const sessions = new Map<string, InternalSession>()

// External listeners for PlanEvent. Wired by ipc.ts in step 4 — for now this
// just allows tests / internal callers to observe events.
const listeners = new Set<PlanEventListener>()

// ---------------------------------------------------------------------------
// Public API — lifecycle stubs (step 1 only sketches; step 2 fills in)
// ---------------------------------------------------------------------------

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
    sessionId: sess.sessionId,
    history: [...sess.history],
    pendingPlan: sess.pendingPlan
  }
}

/**
 * The Claude app had a real interactive plan-mode subprocess here. Codex Goal
 * keeps the first self-running turn as a read-only planning turn instead.
 */
export async function start(goalId: string, objective: string): Promise<PlanSessionStatus> {
  void objective
  if (sessions.has(goalId)) {
    throw new Error(`plan session already active for ${goalId}`)
  }
  throw new Error('Codex Goal does not support interactive planning mode yet')
}

export async function sendMessage(goalId: string, text: string): Promise<void> {
  const sess = sessions.get(goalId)
  if (!sess) throw new Error(`no active plan session for ${goalId}`)
  if (sess.awaitingResult) {
    throw new Error('previous turn still in progress — wait for the assistant to finish')
  }
  sess.history.push({ role: 'user', text, ts: isoNow() })
  writeUserMessage(sess, text)
}

/**
 * Approve the current plan: persist it to <goalDir>/plan.md, flip the goal
 * out of 'planning' so the existing runner can pick it up via Runner.Start,
 * and tear down the planning process cleanly.
 *
 * `override` lets the user edit the captured plan before approving. When
 * omitted, the most recent ExitPlanMode plan is used.
 */
export async function approve(goalId: string, override?: string): Promise<string> {
  const sess = sessions.get(goalId)
  if (!sess) throw new Error(`no active plan session for ${goalId}`)
  const plan = override ?? sess.pendingPlan
  if (!plan || plan.trim().length === 0) {
    throw new Error('no plan available to approve')
  }

  // Persist the plan first; only after the file is on disk do we transition
  // status. This way a crash mid-approve leaves the goal in 'planning' so
  // the user can retry instead of starting an empty plan.
  await fs.writeFile(path.join(goalDir(goalId), 'plan.md'), plan, 'utf8')
  await goalStore.setStatus(goalId, 'pending', 'planning')

  sess.pendingPlan = plan
  await abortInternal(sess, 'approved')
  return plan
}

/**
 * Cancel the plan session. Terminates the planning process (escalating to
 * SIGKILL if it doesn't exit on its own) and returns true if a session was
 * actually torn down. The on('exit') handler reverts goal status from
 * 'planning' back to 'pending', so callers (e.g., PlanReview's "✗ キャンセル"
 * button) just need to navigate away; if they want to discard the goal
 * entirely they can additionally call deleteGoal().
 */
export async function abort(goalId: string): Promise<boolean> {
  const sess = sessions.get(goalId)
  if (!sess) return false
  await abortInternal(sess, 'aborted')
  return true
}

/**
 * Best-effort synchronous teardown of every live plan session. Intended for
 * the `before-quit` hook so we don't leave orphaned planning processes —
 * macOS spawns them with detached: true (own process group), so they
 * survive parent termination unless we explicitly group-kill them. Skips
 * the graceful 2s/5s SIGTERM→SIGKILL ladder used by abortInternal because
 * the app is exiting and we have no time to wait. Status revert is
 * dispatched fire-and-forget; markOrphanedActiveAsPaused at next launch
 * picks up anything we miss (except 'planning', which is excluded there
 * — that's why we still attempt the revert here).
 */
export function abortAll(): void {
  for (const sess of Array.from(sessions.values())) {
    if (sess.exitReason) continue
    sess.exitReason = 'aborted'
    const pid = sess.proc.pid
    if (
      pid != null &&
      sess.proc.exitCode === null &&
      sess.proc.signalCode === null
    ) {
      try {
        // POSIX process-group kill (detached: true puts the worker in its own group)
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone — best-effort
        }
      }
    }
    void goalStore.setStatus(sess.goalId, 'pending', 'planning').catch(() => {})
  }
  sessions.clear()
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emit(event: PlanEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // listener bugs must not crash the session
    }
  }
}

function buildSeedMessage(objective: string): string {
  return [
    'You are about to plan how to achieve the following user goal.',
    'Discuss the approach with the user, ask clarifying questions inline as text',
    '(do NOT use the AskUserQuestion tool), and once you have a concrete plan,',
    'invoke the ExitPlanMode tool with the full plan markdown.',
    '',
    '<goal>',
    objective,
    '</goal>'
  ].join('\n')
}

function writeUserMessage(sess: InternalSession, text: string): void {
  const payload = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
  sess.awaitingResult = true
  sess.currentAssistantText = ''
  try {
    sess.proc.stdin.write(JSON.stringify(payload) + '\n')
  } catch (err) {
    sess.awaitingResult = false
    emit({
      type: 'error',
      goalId: sess.goalId,
      message: `failed to write to plan-session stdin: ${(err as Error).message}`,
      ts: isoNow()
    })
  }
}

/**
 * Split incoming stdout on '\n' and JSON.parse each complete line. Partial
 * trailing line is held in the session buffer and prepended to the next
 * chunk. Mirrors the protocol spelled out in plan-mode-cli-verification.md
 * §1–§4.
 */
// 8 MB. Plan-mode stream-json lines are typically <100 KB; this guards
// against a runaway process emitting an unterminated mega-line that
// would otherwise grow the buffer unbounded.
const STDOUT_BUFFER_LIMIT = 8 * 1024 * 1024

function handleStdoutChunk(sess: InternalSession, chunk: string): void {
  sess.stdoutBuffer += chunk
  if (sess.stdoutBuffer.length > STDOUT_BUFFER_LIMIT) {
    emit({
      type: 'error',
      goalId: sess.goalId,
      message: `stdout buffer overflow (>${STDOUT_BUFFER_LIMIT} bytes without newline) — aborting plan session`,
      ts: isoNow()
    })
    sess.stdoutBuffer = ''
    void abortInternal(sess, 'aborted')
    return
  }
  let newlineIdx = sess.stdoutBuffer.indexOf('\n')
  while (newlineIdx >= 0) {
    const line = sess.stdoutBuffer.slice(0, newlineIdx).trim()
    sess.stdoutBuffer = sess.stdoutBuffer.slice(newlineIdx + 1)
    if (line.length > 0) {
      try {
        const obj = JSON.parse(line)
        handleStreamEvent(sess, obj)
      } catch {
        // ignore malformed lines — CLIs occasionally emit a banner
      }
    }
    newlineIdx = sess.stdoutBuffer.indexOf('\n')
  }
}

interface StreamSystemInit {
  type: 'system'
  subtype?: string
  session_id?: string
}
interface StreamAssistantContent {
  type: string
  text?: string
  name?: string
  input?: { plan?: string }
}
interface StreamAssistantMessage {
  type: 'assistant'
  message?: { content?: StreamAssistantContent[] }
}
interface StreamResult {
  type: 'result'
  is_error?: boolean
  result?: string
}

type StreamEvent = StreamSystemInit | StreamAssistantMessage | StreamResult | { type: string }

function handleStreamEvent(sess: InternalSession, evt: StreamEvent): void {
  if (evt.type === 'system') {
    const init = evt as StreamSystemInit
    if (init.subtype === 'init' && typeof init.session_id === 'string') {
      sess.sessionId = init.session_id
      emit({
        type: 'session-started',
        goalId: sess.goalId,
        sessionId: sess.sessionId,
        ts: isoNow()
      })
    }
    return
  }

  if (evt.type === 'assistant') {
    const msg = (evt as StreamAssistantMessage).message
    if (!msg?.content) return
    for (const part of msg.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        sess.currentAssistantText += part.text
        emit({
          type: 'assistant-text',
          goalId: sess.goalId,
          text: part.text,
          ts: isoNow()
        })
      } else if (part.type === 'tool_use' && part.name === 'ExitPlanMode') {
        const plan = part.input?.plan ?? ''
        sess.pendingPlan = plan
        emit({ type: 'plan-ready', goalId: sess.goalId, plan, ts: isoNow() })
      }
    }
    return
  }

  if (evt.type === 'result') {
    const r = evt as StreamResult
    sess.awaitingResult = false
    if (sess.currentAssistantText) {
      sess.history.push({
        role: 'assistant',
        text: sess.currentAssistantText,
        ts: isoNow()
      })
      sess.currentAssistantText = ''
    }
    emit({ type: 'assistant-message-complete', goalId: sess.goalId, ts: isoNow() })
    if (r.is_error) {
      emit({
        type: 'error',
        goalId: sess.goalId,
        message: r.result ?? 'plan session returned is_error',
        ts: isoNow()
      })
    }
    emit({ type: 'turn-complete', goalId: sess.goalId, ts: isoNow() })
  }
}

async function abortInternal(
  sess: InternalSession,
  reason: 'approved' | 'aborted'
): Promise<void> {
  // Idempotency guard: if approve and abort race (e.g., the user smashes
  // both buttons), the first call wins and the second becomes a no-op.
  // Without this guard the second caller would clobber sess.exitReason and
  // the on('exit') handler would emit the wrong session-ended reason.
  if (sess.exitReason) return
  sess.exitReason = reason

  // Free the goalId slot eagerly so a follow-up start() (e.g., user picks
  // "プランなしで開始" then changes their mind) doesn't have to wait for the
  // proc to fully drain. The on('exit') handler also calls delete; that's
  // intentional and Map.delete is idempotent.
  sessions.delete(sess.goalId)

  if (sess.proc.exitCode !== null || sess.proc.signalCode !== null) {
    // Already gone — nothing to tear down.
    return
  }

  // Graceful path: close stdin so the process can flush its final response, then
  // wait briefly. If the process doesn't exit on its own, terminate the whole
  // tree (the CLI may have spawned helper subprocesses on macOS).
  try {
    sess.proc.stdin.end()
  } catch {
    // stdin already closed — fall through to the wait
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(softTimer)
      clearTimeout(hardTimer)
      resolve()
    }
    // Register the listener before re-checking exitCode so we don't miss an
    // exit that fires between the check above and the listener registration.
    sess.proc.once('exit', finish)
    if (sess.proc.exitCode !== null || sess.proc.signalCode !== null) {
      finish()
      return
    }

    const pid = sess.proc.pid
    const softTimer = setTimeout(() => {
      if (sess.proc.exitCode !== null) {
        finish()
        return
      }
      if (typeof pid === 'number') {
        void terminateProcessTree(pid, 'SIGTERM')
      }
    }, 2000)

    const hardTimer = setTimeout(() => {
      if (sess.proc.exitCode !== null) {
        finish()
        return
      }
      if (typeof pid === 'number') {
        void terminateProcessTree(pid, 'SIGKILL')
      }
      // Still resolve so callers don't hang if something is wedged in D-state.
      finish()
    }, 5000)
  })
}

// ---------------------------------------------------------------------------
// Test seam — exposed only for planSession.test.ts. Do not consume from the
// rest of the app. Step 6 will pull these in for unit tests.
// ---------------------------------------------------------------------------

export const __test = {
  buildSeedMessage,
  handleStdoutChunk,
  handleStreamEvent,
  sessions
}
