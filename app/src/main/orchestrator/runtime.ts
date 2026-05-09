// Runtime — keeps a Map<goalId, GoalRunner> and an event broadcaster.

import type { GoalEvent, RunnerSnapshot } from '@shared/types'

import { GoalRunner } from './runner'

type Listener = (event: GoalEvent) => void

const runners = new Map<string, GoalRunner>()
const listeners = new Set<Listener>()
// Phase 4.2 A2: track scheduled auto-resume timers so we can cancel them on
// abort/manual resume and avoid double scheduling.
const resumeTimers = new Map<string, NodeJS.Timeout>()

function clearResumeTimer(goalId: string): void {
  const t = resumeTimers.get(goalId)
  if (t) {
    clearTimeout(t)
    resumeTimers.delete(goalId)
  }
}

function scheduleResume(goalId: string, resumeAt: string): void {
  clearResumeTimer(goalId)
  const ms = Math.max(0, new Date(resumeAt).getTime() - Date.now())
  const timer = setTimeout(() => {
    resumeTimers.delete(goalId)
    broadcast({
      type: 'log',
      goalId,
      level: 'info',
      message: `Auto-resume after rate-limit pause (scheduled ${resumeAt})`,
      ts: new Date().toISOString()
    })
    resumeRunner(goalId)
  }, ms)
  // Don't keep the event loop alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref()
  resumeTimers.set(goalId, timer)
}

function broadcast(event: GoalEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // ignore listener failures
    }
  }
}

export function addEventListener(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function startRunner(goalId: string): GoalRunner {
  let runner = runners.get(goalId)
  if (runner && runner.isRunning()) return runner

  runner = new GoalRunner(goalId)
  runners.set(goalId, runner)

  runner.on('event', (event: GoalEvent) => {
    broadcast(event)
    if (event.type === 'rate-limit') {
      scheduleResume(event.goalId, event.resumeAt)
    }
  })

  // run in background
  void runner
    .run()
    .catch((err) => {
      broadcast({
        type: 'log',
        goalId,
        level: 'error',
        message: `Runner crashed: ${String(err)}`,
        ts: new Date().toISOString()
      })
    })
    .finally(() => {
      // keep the instance for snapshot access until app restart
    })

  return runner
}

export function abortRunner(goalId: string): boolean {
  clearResumeTimer(goalId)
  const runner = runners.get(goalId)
  if (!runner) return false
  runner.abort()
  return true
}

/**
 * Phase 4.3: graceful interrupt for user-message injection. Tells the running
 * runner to terminate the current turn without flipping status to 'abandoned',
 * so the caller (IPC handler) can immediately spawn a fresh runner that
 * continues the goal with the new directive in its prompt.
 */
export function interruptRunner(goalId: string): boolean {
  const runner = runners.get(goalId)
  if (!runner) return false
  runner.interrupt()
  return true
}

/**
 * Phase 4.3: poll-wait until a runner returns from its main loop. Used by
 * interrupt-and-restart flow so we don't race two runners for the same goal.
 */
export async function waitForRunnerStop(
  goalId: string,
  timeoutMs = 15000
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (!isRunning(goalId)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

export function pauseRunner(goalId: string): boolean {
  const runner = runners.get(goalId)
  if (!runner) return false
  runner.pause()
  return true
}

export function resumeRunner(goalId: string): GoalRunner | null {
  // A manual or auto resume cancels any pending rate-limit timer.
  clearResumeTimer(goalId)
  const runner = runners.get(goalId)
  if (!runner) {
    return startRunner(goalId)
  }
  if (runner.isRunning()) {
    runner.resume()
    return runner
  }
  return startRunner(goalId)
}

export async function getSnapshot(goalId: string): Promise<RunnerSnapshot | null> {
  const runner = runners.get(goalId)
  if (!runner) return null
  return {
    goalId,
    running: runner.isRunning(),
    currentTurnId: runner.getCurrentTurnId(),
    recentLog: runner.getRecentLog(),
    recentStdout: runner.getRecentStdout(),
    digest: await runner.getDigest()
  }
}

export function isRunning(goalId: string): boolean {
  return runners.get(goalId)?.isRunning() ?? false
}
