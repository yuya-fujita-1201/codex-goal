// GoalRunner — TS port of prototype/goal-loop.sh, kept resident in the main
// process. Each instance manages a single goal: reading state, evaluating the
// hard checker, building the per-turn prompt, launching a new Terminal.app
// window via osascript, waiting for the sentinel, extracting the digest update,
// and updating state. Phase 3 adds block summarizer + judge worker. Emits
// GoalEvent objects that the IPC layer forwards to the renderer.

import { EventEmitter } from 'node:events'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import type { CheckerResult, GoalBudget, GoalEvent, GoalState, GoalStatus } from '@shared/types'
import { isDefaultSampleCheckerTemplate } from '@shared/checkerTemplate'

import * as goalStore from '../goalStore'
import {
  buildBlockPrompt,
  buildDigestCompressorPrompt,
  buildJudgePrompt,
  buildPrompt,
  detectRateLimit,
  extractBlockSummary,
  extractCheckerResult,
  extractCompressedDigest,
  extractCriticFlags,
  extractDigestUpdate,
  extractJudgeReason,
  extractJudgeVerdict,
  extractPlan,
  extractUserReplies,
  hasGoalAchievedToken,
  lintDigestSections
} from './prompt'
import { startRunTurn, type RunTurnHandle } from './runTurn'
import { TailWatcher } from './tail'
import {
  atomicWrite,
  formatTurnId,
  goalDir,
  isoNow,
  runWithTimeout,
  sleep,
  terminateProcessTree,
  turnPaths,
  type WorkSubdir
} from './util'

const HEARTBEAT_GRACE_MS = 30_000
const BLOCK_SIZE = 10 // run a block summary every N main turns
const MAX_CONSECUTIVE_ANOMALIES = 3 // transition to 'blocked' after this many
const DIGEST_COMPRESS_THRESHOLD_BYTES = 16 * 1024 // 16 KB — kick compressor if digest exceeds this
// Phase 4.2 A2: when a rate-limit response is detected, pause the runner and
// schedule resume. Codex limit messages may include a retry duration; when
// they do not, use a conservative one-hour fallback plus slack.
const RATE_LIMIT_SLACK_MS = 5 * 60 * 1000
const RATE_LIMIT_FALLBACK_PAUSE_MS = 60 * 60 * 1000 + RATE_LIMIT_SLACK_MS

type StopReason = 'completed' | 'aborted'
type HardCheckerOutcome = 'pass' | 'fail' | 'no_checker' | 'placeholder_checker'
type HardCheckerRunResult = { outcome: HardCheckerOutcome; result: CheckerResult | null }

const ANOMALY_RESULTS = new Set([
  'TIMEOUT',
  'HANG',
  'ABORTED',
  'LAUNCH_FAIL'
])

function isAnomaly(result: string): boolean {
  if (ANOMALY_RESULTS.has(result)) return true
  if (result.startsWith('FAIL')) return true
  return false
}

function rateLimitPauseMs(reason: string): number {
  const m = reason.match(/\b(?:try again|retry|reset)?\s*(?:in|after)?\s*(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i)
  if (!m) return RATE_LIMIT_FALLBACK_PAUSE_MS
  const amount = Number(m[1])
  if (!Number.isFinite(amount) || amount <= 0) return RATE_LIMIT_FALLBACK_PAUSE_MS
  const unit = m[2].toLowerCase()
  const base = unit.startsWith('h') ? amount * 60 * 60 * 1000 : amount * 60 * 1000
  return Math.min(Math.max(base + RATE_LIMIT_SLACK_MS, RATE_LIMIT_SLACK_MS), 6 * 60 * 60 * 1000)
}

export class GoalRunner extends EventEmitter {
  private aborted = false
  private paused = false
  private running = false
  // Phase 4.3: when set together with `aborted`, the loop exit treats the
  // termination as a graceful interrupt (preserve status, no anomaly counter
  // bump, result file marked INTERRUPTED so the run-turn kill watcher trips
  // and we don't burn tokens for the killed turn).
  private interrupted = false
  private currentTurnId: string | null = null
  private currentTail: TailWatcher | null = null
  private recentLog: string[] = []
  private recentStdout = ''
  private consecutiveAnomalies = 0
  // C4: judge cooldown — skip judge for 3 turns after a not_yet verdict.
  private lastJudgeAtTurn = -Infinity
  private lastJudgeVerdict: 'achieved' | 'not_yet' | null = null
  // PR-D: most recent structured checker output (parsed from <checker-result>
  // JSON). Forwarded into the next turn's prompt via {{CHECKER_RESULT}} so
  // the worker can see which milestones failed without re-running checker.
  private lastCheckerResult: CheckerResult | null = null
  // PR-E: most recent critic-flags list from the judge worker. When non-empty
  // it indicates which "achieved" claims the critic pushed back on; injected
  // into the next turn's prompt via {{CRITIC_FLAGS}} so the worker addresses
  // the specific gap instead of guessing at new approaches.
  private lastCriticFlags: string[] = []

  constructor(public readonly goalId: string) {
    super()
  }

  isRunning(): boolean {
    return this.running
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId
  }

  getRecentLog(): string[] {
    return [...this.recentLog]
  }

  getRecentStdout(): string {
    return this.recentStdout
  }

  async getDigest(): Promise<string> {
    return fs.readFile(path.join(goalDir(this.goalId), 'digest.md'), 'utf8').catch(() => '')
  }

  abort(): void {
    this.aborted = true
    void this.log('warn', 'Abort requested')
  }

  /**
   * Phase 4.3: Abort the current turn for the purpose of immediately picking up
   * a new user-message in the next turn. Unlike abort(), this preserves the
   * goal's status (no transition to 'abandoned') so the runtime can spawn a
   * fresh runner that continues the goal cleanly.
   */
  interrupt(): void {
    this.interrupted = true
    this.aborted = true
    void this.log('info', 'Interrupt requested (user-message injection)')
  }

  pause(): void {
    this.paused = true
    void this.log('warn', 'Pause requested (will pause after current turn)')
  }

  resume(): void {
    if (this.paused) {
      this.paused = false
      void this.log('info', 'Resume requested')
    }
  }

  // -------- main loop --------

  async run(): Promise<StopReason> {
    if (this.running) return 'completed'
    this.running = true
    try {
      await this.transitionPendingToActive()

      while (!this.aborted) {
        if (this.paused) {
          await this.updateState({ status: 'paused' })
          return 'completed'
        }

        const state = await this.readState()
        const budget = await this.readBudget()
        if (!state || !budget) {
          await this.log('error', 'state.json or budget.json missing — stopping')
          return 'completed'
        }

        if (
          state.status === 'achieved' ||
          state.status === 'abandoned' ||
          state.status === 'budget_exhausted' ||
          state.status === 'blocked' ||
          state.status === 'paused' ||
          state.status === 'planning'
        ) {
          await this.log('info', `Status is '${state.status}' — stopping loop`)
          return 'completed'
        }

        // hard checker (before launching)
        const checkerResult = await this.runHardChecker(state.workspace_path)
        if (checkerResult.outcome === 'pass') {
          await this.log('info', 'Hard checker PASSED — goal achieved')
          await this.updateState({ status: 'achieved' })
          return 'completed'
        }

        if (state.turns >= budget.max_turns) {
          await this.log('warn', `Budget exhausted: ${state.turns}/${budget.max_turns} turns`)
          await this.writeHandoff('turn_budget', state, budget)
          await this.updateState({ status: 'budget_exhausted' })
          return 'completed'
        }

        if (typeof budget.max_wall_time_seconds === 'number' && budget.max_wall_time_seconds > 0) {
          const createdMs = new Date(state.created_at).getTime()
          if (Number.isFinite(createdMs)) {
            const elapsedSec = Math.floor((Date.now() - createdMs) / 1000)
            if (elapsedSec >= budget.max_wall_time_seconds) {
              await this.log(
                'warn',
                `Wall-time budget exhausted: ${elapsedSec}s elapsed >= ${budget.max_wall_time_seconds}s`
              )
              await this.writeHandoff('wall_time', state, budget, elapsedSec)
              await this.updateState({ status: 'budget_exhausted' })
              return 'completed'
            }
          }
        }

        const turnNum = state.turns + 1
        const turnId = formatTurnId(turnNum)
        await this.log('info', `Starting ${turnId} (${turnNum}/${budget.max_turns})`)

        // pre-turn snapshot
        await this.preTurnSnapshot(state.workspace_path, turnId)

        // Phase 4.3: pick up any user-typed directives queued via the app and
        // inject them at the top of the prompt. Capture ids so we can mark
        // consumed only after the turn completes cleanly.
        const userMessages = await goalStore.listUnconsumedUserMessages(this.goalId)
        const userMessageIds = userMessages.map((m) => m.id)

        const prevTurnId = turnNum > 1 ? formatTurnId(turnNum - 1) : null
        const evidence = await this.collectEvidence(state.workspace_path, prevTurnId)

        const promptText = await buildPrompt({
          state,
          budget,
          turnId,
          turnNum,
          consecutiveAnomalies: this.consecutiveAnomalies,
          userMessages,
          evidence,
          lastCheckerResult: this.lastCheckerResult,
          lastCriticFlags: this.lastCriticFlags
        })

        const { result, stdout } = await this.runWorker('turns', turnId, promptText, budget, {
          tail: true
        })

        // Phase 4.3: a turn that finished cleanly with messages in its prompt
        // should mark them consumed so they don't re-inject next turn.
        // Phase 4.4: also extract <user-reply id="..."> blocks and persist the
        // matching reply per message so the renderer can show a chat-style
        // thread under each user directive. Replies are extracted regardless
        // of whether the turn was successful — even a partial reply is useful
        // for the user when an anomaly happens mid-turn.
        // Phase 4.5: if Codex emitted an explicit <user-reply> for a message,
        // that is hard evidence the message was processed even when the turn
        // ended non-cleanly (INTERRUPTED / TIMEOUT / HANG / ABORTED / FAIL).
        // In that case mark the replied messages consumed too — otherwise the
        // UI shows "返答が来たのに未読のまま" and the same message gets
        // re-injected on the next turn.
        if (userMessageIds.length > 0) {
          const replies = extractUserReplies(stdout)
          if (replies.size > 0) {
            const replyTs = isoNow()
            for (const id of userMessageIds) {
              const text = replies.get(id)
              if (!text) continue
              await goalStore.setUserMessageReply(this.goalId, id, {
                text,
                ts: replyTs,
                turn_id: turnId
              })
              this.emit('event', {
                type: 'user-message-reply',
                goalId: this.goalId,
                messageId: id,
                reply: { text, ts: replyTs, turn_id: turnId }
              } satisfies GoalEvent)
            }
            await this.log(
              'info',
              `Extracted ${replies.size} user-reply block(s) in ${turnId}`
            )
          }

          let consumedIds: string[]
          if (result === 'DONE') {
            // turn finished cleanly — every queued message that was injected
            // into the prompt is considered processed by Codex
            consumedIds = userMessageIds
          } else {
            // turn ended early — only messages with an explicit reply are
            // proven to have been processed; leave the rest queued
            consumedIds = userMessageIds.filter((id) => replies.has(id))
          }

          if (consumedIds.length > 0) {
            await goalStore.markUserMessagesConsumed(this.goalId, consumedIds, turnId)
            const remaining = userMessageIds.length - consumedIds.length
            await this.log(
              'info',
              `Marked ${consumedIds.length} user message(s) consumed by ${turnId}` +
                (remaining > 0
                  ? ` (${remaining} still queued for retry: result=${result})`
                  : '')
            )
            this.emit('event', {
              type: 'user-message-consumed',
              goalId: this.goalId,
              ids: consumedIds,
              turnId
            } satisfies GoalEvent)
          }
        }

        // Phase 4.2 A2: rate-limit detection — if Codex reported the 5-hour
        // usage window is exhausted, pause the runner and schedule auto-resume.
        // Read stderr too, since the CLI may emit limit messages there.
        if (result !== 'ABORTED') {
          const stderrPath = turnPaths(this.goalId, turnId, 'turns').stderr
          const stderrText = await fs.readFile(stderrPath, 'utf8').catch(() => '')
          const rlMatch = detectRateLimit(stdout) ?? detectRateLimit(stderrText)
          if (rlMatch) {
            const resumeAt = new Date(Date.now() + rateLimitPauseMs(rlMatch))
              .toISOString()
              .replace(/\.\d+Z$/, 'Z')
            await this.log(
              'warn',
              `Rate limit detected (${rlMatch.replace(/\s+/g, ' ').trim()}). Pausing until ${resumeAt}.`
            )
            // Persist turn record before bailing so we don't lose progress.
            await fs.writeFile(
              path.join(goalDir(this.goalId), 'history', 'raw', `${turnId}.json`),
              JSON.stringify(
                { turn_id: turnId, result, started_at: isoNow(), ended_at: isoNow() },
                null,
                2
              ) + '\n',
              'utf8'
            )
            await this.updateState({
              turns: turnNum,
              last_turn_id: turnId,
              last_result: result,
              status: 'paused',
              next_resume_at: resumeAt
            })
            this.emit('event', {
              type: 'rate-limit',
              goalId: this.goalId,
              resumeAt,
              reason: rlMatch
            } satisfies GoalEvent)
            return 'completed'
          }
        }

        // Phase 4.3: an INTERRUPTED turn is a deliberate user-action stop, not
        // a worker failure. Skip anomaly accounting AND digest extraction (the
        // killed turn's stdout is usually partial / lacks the digest tag).
        const wasInterrupted = result === 'INTERRUPTED'

        // anomaly detection — TIMEOUT / HANG / ABORTED / LAUNCH_FAIL / FAIL
        if (!wasInterrupted && isAnomaly(result)) {
          this.consecutiveAnomalies++
          await this.appendAnomalyToDigest(turnId, result)
          await this.log(
            'warn',
            `Anomaly: ${turnId} returned ${result} (${this.consecutiveAnomalies}/${MAX_CONSECUTIVE_ANOMALIES} consecutive)`
          )
        } else if (wasInterrupted) {
          await this.log('info', `${turnId} INTERRUPTED — skipping anomaly counter and digest update`)
        } else {
          if (this.consecutiveAnomalies > 0) {
            await this.log(
              'info',
              `Anomaly streak broken (was ${this.consecutiveAnomalies}); resetting counter`
            )
          }
          this.consecutiveAnomalies = 0

          // process digest update only on successful turns
          const digestUpdate = extractDigestUpdate(stdout)
          if (digestUpdate) {
            const digestPath = path.join(goalDir(this.goalId), 'digest.md')
            // Read prev for diff linting *before* overwriting. Missing/empty
            // (first turn) -> linter returns no warnings.
            const prevDigest = await fs.readFile(digestPath, 'utf8').catch(() => '')
            for (const w of lintDigestSections(prevDigest, digestUpdate)) {
              await this.log('warn', w)
            }
            await atomicWrite(digestPath, digestUpdate)
            await this.saveDigestSnapshot(turnId, digestUpdate)
            this.emit('event', {
              type: 'digest',
              goalId: this.goalId,
              digest: digestUpdate
            } satisfies GoalEvent)
          } else {
            await this.log('warn', 'No <digest-update> block found in stdout')
          }

          // turn-001 only: extract <plan> and persist to plan.md so subsequent
          // turns can read it via the {{PLAN}} placeholder. If plan is missing
          // we just warn — turn-002's prompt template handles the empty case.
          // Skip if plan.md already exists (e.g. approved via interactive plan mode)
          // to avoid overwriting a human-approved plan with turn-001's <plan> tag.
          if (turnNum === 1) {
            const planPath = path.join(goalDir(this.goalId), 'plan.md')
            let planExists = false
            try {
              await fs.access(planPath)
              planExists = true
            } catch {
              planExists = false
            }
            if (planExists) {
              await this.log(
                'info',
                `${turnId}: plan.md already exists (likely from interactive plan mode) — skipping <plan> extraction`
              )
            } else {
              const plan = extractPlan(stdout)
              if (plan) {
                await fs.writeFile(planPath, plan, 'utf8')
                await this.log('info', `${turnId}: plan.md saved (${plan.length} chars)`)
              } else {
                await this.log(
                  'warn',
                  `${turnId}: no <plan> tag found — implementation turns will run without a stored plan`
                )
              }
            }
          }
        }

        // save raw turn record
        await fs.writeFile(
          path.join(goalDir(this.goalId), 'history', 'raw', `${turnId}.json`),
          JSON.stringify(
            { turn_id: turnId, result, started_at: isoNow(), ended_at: isoNow() },
            null,
            2
          ) + '\n',
          'utf8'
        )

        // update state turns counter
        await this.updateState({
          turns: turnNum,
          last_turn_id: turnId,
          last_result: result
        })

        // bail out if we've hit too many anomalies in a row
        if (this.consecutiveAnomalies >= MAX_CONSECUTIVE_ANOMALIES) {
          await this.log(
            'error',
            `${this.consecutiveAnomalies} consecutive anomalies — marking blocked`
          )
          await this.updateState({ status: 'blocked' })
          return 'completed'
        }

        // soft achievement check
        if (hasGoalAchievedToken(stdout)) {
          await this.log('info', 'Worker emitted <goal-status>achieved</goal-status>')
          const confirm = await this.runHardChecker(state.workspace_path)
          if (confirm.outcome === 'pass') {
            await this.log('info', 'Hard checker confirms achievement')
            await this.updateState({ status: 'achieved' })
            return 'completed'
          }
          if (confirm.outcome === 'no_checker' || confirm.outcome === 'placeholder_checker') {
            // PR-D: when the goal opted into checker_required at creation,
            // a missing checker.sh blocks 'achieved' even if the worker
            // claims it. Refuses the judge-only path and continues looping
            // so the operator can either install a checker or abandon.
            if (state.checker_required === true && confirm.outcome === 'no_checker') {
              await this.log(
                'warn',
                'Worker claims achieved but goal requires a checker.sh which is missing — refusing to mark achieved'
              )
            } else {
              if (confirm.outcome === 'placeholder_checker') {
                await this.log(
                  'warn',
                  'Worker claims achieved but checker.sh is still the bundled sample — ignoring the placeholder and using judge verification'
                )
              }
              // C4: cooldown — if judge said not_yet within the last 3 turns, skip re-judging.
              const turnsSinceJudge = turnNum - this.lastJudgeAtTurn
              if (this.lastJudgeVerdict === 'not_yet' && turnsSinceJudge < 3) {
                await this.log(
                  'info',
                  `Judge cooldown active (last not_yet at turn ${this.lastJudgeAtTurn}, ${turnsSinceJudge} turns ago) — skipping judge`
                )
              } else {
                // Phase 3: run judge worker for independent verification
                const verdict = await this.runJudgeWorker(turnId, budget)
                this.lastJudgeAtTurn = turnNum
                this.lastJudgeVerdict =
                  verdict === 'achieved' || verdict === 'not_yet' ? verdict : null
                if (verdict === 'achieved') {
                  await this.log('info', 'Judge confirms achievement — marking achieved')
                  await this.updateState({ status: 'achieved' })
                  return 'completed'
                }
                if (verdict === 'not_yet') {
                  await this.log('warn', 'Judge says not_yet — continuing')
                } else {
                  await this.log('warn', 'Judge produced no verdict — continuing')
                }
              }
            }
          } else {
            await this.log(
              'warn',
              'Worker claims achieved but hard checker failed — continuing'
            )
          }
        }

        // block summarizer every BLOCK_SIZE turns
        if (turnNum > 0 && turnNum % BLOCK_SIZE === 0) {
          const blockNum = Math.floor(turnNum / BLOCK_SIZE)
          const fromTurn = turnNum - BLOCK_SIZE + 1
          await this.runBlockSummarizer(blockNum, fromTurn, turnNum, budget)
        }

        // digest compressor — if digest.md has grown beyond the threshold,
        // run a dedicated worker to compress it. This keeps the per-turn prompt
        // size bounded over long-running goals.
        await this.maybeRunDigestCompressor(turnId, budget)

        // brief pause
        await sleep((budget.rate_limit_sleep_seconds ?? 5) * 1000)
      }

      // Phase 4.3: distinguish a normal abort (user clicked 中止 → mark
      // 'abandoned' so it stops staying in 'active') from an interrupt
      // (user-message injection → preserve status so the runtime can spawn a
      // fresh runner that continues the goal).
      if (this.interrupted) {
        await this.log('info', 'Loop interrupted — preserving status for restart')
      } else {
        await this.log('warn', 'Loop aborted')
        await this.updateState({ status: 'abandoned' })
      }
      return 'aborted'
    } finally {
      this.running = false
      this.currentTurnId = null
      if (this.currentTail) {
        await this.currentTail.stop()
        this.currentTail = null
      }
    }
  }

  // -------- block summarizer --------

  private async runBlockSummarizer(
    blockNum: number,
    fromTurn: number,
    toTurn: number,
    budget: GoalBudget
  ): Promise<void> {
    const blockId = `block-${String(blockNum).padStart(3, '0')}`
    await this.log(
      'info',
      `Starting ${blockId} (compresses turn-${String(fromTurn).padStart(3, '0')} ~ turn-${String(toTurn).padStart(3, '0')})`
    )
    const prompt = await buildBlockPrompt({
      goalId: this.goalId,
      blockId,
      fromTurn,
      toTurn
    })
    const { result, stdout } = await this.runWorker('blocks', blockId, prompt, budget, {
      tail: true
    })
    if (result !== 'DONE') {
      await this.log('warn', `Block summarizer ${blockId} returned ${result} — skipping`)
      return
    }
    const summary = extractBlockSummary(stdout)
    if (!summary) {
      await this.log('warn', `${blockId}: no <block-summary> tag found — skipping save`)
      return
    }
    const blocksDir = path.join(goalDir(this.goalId), 'history', 'blocks')
    await fs.mkdir(blocksDir, { recursive: true })
    await fs.writeFile(path.join(blocksDir, `${blockId}.md`), summary, 'utf8')
    await this.log('info', `${blockId} saved`)
  }

  // -------- digest compressor --------

  private async maybeRunDigestCompressor(
    triggerTurnId: string,
    budget: GoalBudget
  ): Promise<void> {
    const digestPath = path.join(goalDir(this.goalId), 'digest.md')
    let size: number
    try {
      const stat = await fs.stat(digestPath)
      size = stat.size
    } catch {
      return
    }
    if (size < DIGEST_COMPRESS_THRESHOLD_BYTES) return

    const compressorId = `compressor-${triggerTurnId.replace(/^turn-/, '')}`
    await this.log(
      'info',
      `digest.md is ${size}B (>= ${DIGEST_COMPRESS_THRESHOLD_BYTES}B) — starting ${compressorId}`
    )
    const prompt = await buildDigestCompressorPrompt({ goalId: this.goalId })
    const { result, stdout } = await this.runWorker('compressor', compressorId, prompt, budget, {
      tail: true
    })
    if (result !== 'DONE') {
      await this.log('warn', `${compressorId} returned ${result} — keeping uncompressed digest`)
      return
    }
    const compressed = extractCompressedDigest(stdout)
    if (!compressed) {
      await this.log('warn', `${compressorId}: no <compressed-digest> tag found — skipping`)
      return
    }
    if (compressed.length >= size) {
      await this.log(
        'warn',
        `${compressorId}: compressed (${compressed.length}B) not smaller than original (${size}B) — keeping original`
      )
      return
    }
    // Snapshot the pre-compression digest so we can recover from a bad
    // compression (the worker is itself an LLM and can drop information).
    const preCompress = await fs.readFile(digestPath, 'utf8').catch(() => '')
    if (preCompress) {
      await this.saveDigestSnapshot(`${compressorId}-pre`, preCompress)
    }
    await atomicWrite(digestPath, compressed)
    await this.saveDigestSnapshot(compressorId, compressed)
    await this.log(
      'info',
      `${compressorId}: digest compressed ${size}B → ${compressed.length}B`
    )
    this.emit('event', {
      type: 'digest',
      goalId: this.goalId,
      digest: compressed
    } satisfies GoalEvent)
  }

  // -------- judge / critic worker --------

  /**
   * PR-E: judge worker is now a Skeptic critic — it returns verdict AND a
   * list of `<critic-flags>` (specific weak claims it pushed back on).
   * Achievement is gated on **both** verdict='achieved' AND flags=[].
   * Any non-empty flags downgrade the result to 'not_yet' even if the
   * critic happened to write 'achieved' (defense in depth: contradicting
   * a worker's own concerns is a sign of confused reasoning).
   *
   * Side effects: stores flags on this.lastCriticFlags so the next main
   * turn's prompt can show the worker what evidence the critic found
   * lacking — that way the worker addresses the specific gap instead of
   * trying random new approaches.
   */
  private async runJudgeWorker(
    triggerTurnId: string,
    budget: GoalBudget
  ): Promise<'achieved' | 'not_yet' | 'error'> {
    const judgeId = `judge-${triggerTurnId.replace(/^turn-/, '')}`
    await this.log('info', `Starting ${judgeId} for ${triggerTurnId}`)
    const prompt = await buildJudgePrompt({ goalId: this.goalId, triggerTurnId })
    const { result, stdout } = await this.runWorker('judge', judgeId, prompt, budget, {
      tail: true
    })
    if (result !== 'DONE') {
      await this.log('warn', `${judgeId} returned ${result}`)
      return 'error'
    }
    const verdict = extractJudgeVerdict(stdout)
    const reason = extractJudgeReason(stdout)
    const flags = extractCriticFlags(stdout)
    this.lastCriticFlags = flags
    if (!verdict) {
      await this.log('warn', `${judgeId}: no verdict tag found`)
      return 'error'
    }
    if (flags.length > 0) {
      await this.log(
        'warn',
        `${judgeId}: critic raised ${flags.length} flag(s) — refusing achieved` +
          (reason ? ` (reason: ${reason})` : '')
      )
      // Downgrade: any flag, regardless of self-reported verdict, blocks
      // achievement. This is the core of the Skeptic gate.
      return 'not_yet'
    }
    await this.log(
      'info',
      `${judgeId} verdict: ${verdict} (no flags)${reason ? ` — ${reason}` : ''}`
    )
    return verdict
  }

  // -------- generic worker turn (used by main / block / judge) --------

  private async runWorker(
    subdir: WorkSubdir,
    workId: string,
    prompt: string,
    budget: GoalBudget,
    options: { tail: boolean }
  ): Promise<{ result: string; stdout: string }> {
    const tp = turnPaths(this.goalId, workId, subdir)
    await fs.mkdir(path.dirname(tp.prompt), { recursive: true })
    await fs.writeFile(tp.prompt, prompt, 'utf8')

    this.currentTurnId = workId
    this.recentStdout = ''
    this.emit('event', {
      type: 'turn:started',
      goalId: this.goalId,
      turnId: workId,
      ts: isoNow()
    } satisfies GoalEvent)

    let tail: TailWatcher | null = null
    if (options.tail) {
      tail = new TailWatcher(tp.stdout, (chunk) => {
        this.recentStdout += chunk
        if (this.recentStdout.length > 200_000) {
          this.recentStdout = this.recentStdout.slice(-200_000)
        }
        this.emit('event', {
          type: 'turn:stdout',
          goalId: this.goalId,
          turnId: workId,
          chunk
        } satisfies GoalEvent)
      })
      await tail.start()
      this.currentTail = tail
    }

    let handle: RunTurnHandle
    try {
      handle = startRunTurn({ goalId: this.goalId, turnId: workId, subdir })
    } catch (err) {
      await this.log('error', `Failed to launch worker: ${String(err)}`)
      if (tail) {
        await tail.stop()
        this.currentTail = null
      }
      this.currentTurnId = null
      this.emit('event', {
        type: 'turn:finished',
        goalId: this.goalId,
        turnId: workId,
        result: 'LAUNCH_FAIL',
        ts: isoNow()
      } satisfies GoalEvent)
      return { result: 'LAUNCH_FAIL', stdout: '' }
    }

    const result = await this.waitForTurn(handle, workId, subdir, budget)
    // Ensure the child has fully exited and stdout streams are flushed before
    // we read the file. waitForTurn returns as soon as the result sentinel is
    // visible, which can race the tail end of formatStream.
    await handle.promise.catch(() => undefined)

    if (tail) {
      await tail.stop()
      this.currentTail = null
      await this.flushTailOnce(tp.stdout, workId)
    }

    const stdout = await fs.readFile(tp.stdout, 'utf8').catch(() => '')
    this.emit('event', {
      type: 'turn:finished',
      goalId: this.goalId,
      turnId: workId,
      result,
      ts: isoNow()
    } satisfies GoalEvent)
    this.currentTurnId = null
    return { result, stdout }
  }

  // -------- helpers --------

  private async transitionPendingToActive(): Promise<void> {
    const state = await this.readState()
    if (state?.status === 'planning') {
      // 2層防衛 層2: planning ステータスのゴールは PlanReview 画面でユーザーが
      // プランを承認するまで自走を開始しない。万一 runner.start が誤って呼ばれても
      // ここで早期リターンして active へ遷移しないよう防ぐ。
      await this.log('info', "Status is 'planning' — runner will not auto-activate")
      return
    }
    if (state?.status === 'pending') {
      await this.updateState({ status: 'active' })
      await this.log('info', "Status: pending → active")
    } else if (state?.status === 'paused') {
      // Resume from pause. Covers both manual pause (no next_resume_at) and
      // rate-limit auto-resume (next_resume_at populated). Without this branch
      // the new runner reads state, sees status === 'paused', and bails out
      // immediately at the top of the main loop with "Status is 'paused' —
      // stopping loop", making the Resume button effectively a no-op.
      await this.updateState({ status: 'active', next_resume_at: null })
      await this.log('info', 'Status: paused → active')
    }
  }

  private async readState(): Promise<GoalState | null> {
    try {
      const data = await fs.readFile(path.join(goalDir(this.goalId), 'state.json'), 'utf8')
      return JSON.parse(data) as GoalState
    } catch {
      return null
    }
  }

  private async readBudget(): Promise<GoalBudget | null> {
    try {
      const data = await fs.readFile(path.join(goalDir(this.goalId), 'budget.json'), 'utf8')
      return JSON.parse(data) as GoalBudget
    } catch {
      return null
    }
  }

  private async updateState(
    patch: Partial<GoalState> & { status?: GoalStatus }
  ): Promise<void> {
    const cur = await this.readState()
    if (!cur) return
    const next: GoalState = { ...cur, ...patch, updated_at: isoNow() }
    await fs.writeFile(
      path.join(goalDir(this.goalId), 'state.json'),
      JSON.stringify(next, null, 2) + '\n',
      'utf8'
    )
    this.emit('event', { type: 'state', goalId: this.goalId, state: next } satisfies GoalEvent)
  }

  /**
   * Run the optional checker.sh and return both the pass/fail/no_checker
   * outcome and (PR-D) the structured CheckerResult parsed from any
   * `<checker-result>JSON</checker-result>` block in stdout. The exit code
   * remains the authoritative pass/fail signal — JSON parse failure does
   * NOT degrade pass→fail. Side effect: this.lastCheckerResult is updated
   * so the next turn's {{CHECKER_RESULT}} placeholder gets a fresh value.
   */
  private async runHardChecker(
    workspacePath: string
  ): Promise<HardCheckerRunResult> {
    const checker = path.join(goalDir(this.goalId), 'checker.sh')
    if (!existsSync(checker)) {
      return { outcome: 'no_checker', result: null }
    }
    const checkerSource = await fs.readFile(checker, 'utf8').catch(() => '')
    if (checkerSource && isDefaultSampleCheckerTemplate(checkerSource)) {
      this.lastCheckerResult = null
      await this.log(
        'warn',
        'checker.sh is the bundled sample template, so it is ignored. Customize it for this goal before making it authoritative.'
      )
      return { outcome: 'placeholder_checker', result: null }
    }
    const checkerLog = path.join(goalDir(this.goalId), 'logs', 'checker.log')
    const startedAt = isoNow()
    return new Promise((resolve) => {
      const child = spawn('bash', [checker], {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => {
        stdout += String(d)
      })
      child.stderr?.on('data', (d) => {
        stderr += String(d)
      })
      const finalize = async (
        outcome: Extract<HardCheckerOutcome, 'pass' | 'fail'>,
        code: number | null,
        errMsg?: string
      ): Promise<void> => {
        const finishedAt = isoNow()
        const parsed = extractCheckerResult(stdout)
        if (parsed) this.lastCheckerResult = parsed
        const sep = '----------------------------------------\n'
        const block =
          sep +
          `[${startedAt} -> ${finishedAt}] checker rc=${code ?? 'null'} outcome=${outcome}${errMsg ? ` error=${errMsg}` : ''}${parsed ? ` json=parsed(${parsed.passed_count}/${parsed.total_count})` : ''}\n` +
          (stdout ? `--- stdout ---\n${stdout}${stdout.endsWith('\n') ? '' : '\n'}` : '') +
          (stderr ? `--- stderr ---\n${stderr}${stderr.endsWith('\n') ? '' : '\n'}` : '')
        try {
          await fs.appendFile(checkerLog, block, 'utf8')
        } catch {
          // ignore log write failures
        }
        if (outcome === 'fail') {
          const summarize = (s: string): string => {
            const trimmed = s.trim()
            if (!trimmed) return ''
            const tailLines = trimmed.split('\n').slice(-3).join(' | ')
            return tailLines.length > 240 ? tailLines.slice(-240) : tailLines
          }
          const tail = summarize(stderr) || summarize(stdout)
          await this.log(
            'warn',
            `Hard checker failed (rc=${code ?? 'null'})${tail ? `: ${tail}` : ''}`
          )
        }
        resolve({ outcome, result: parsed })
      }
      child.on('exit', (code) => {
        void finalize(code === 0 ? 'pass' : 'fail', code)
      })
      child.on('error', (err) => {
        void finalize('fail', null, String(err))
      })
    })
  }

  // Generate HANDOFF.md so a follow-up goal can pick up where this one stopped.
  // Triggered when the runner hits max_turns or max_wall_time. Contains the
  // original objective, the latest digest, block summaries, recent turn
  // results, and a copy-paste-ready objective template for the next goal.
  private async writeHandoff(
    reason: 'turn_budget' | 'wall_time',
    state: GoalState,
    budget: GoalBudget,
    elapsedSec?: number
  ): Promise<void> {
    const dir = goalDir(this.goalId)
    const read = async (rel: string): Promise<string> => {
      try {
        return await fs.readFile(path.join(dir, rel), 'utf8')
      } catch {
        return ''
      }
    }

    const objective = (await read('objective.md')).trim()
    const digest = (await read('digest.md')).trim()

    // block summaries (history/blocks/block-NNN.md)
    const blocksDir = path.join(dir, 'history', 'blocks')
    let blocksSection = ''
    try {
      const files = (await fs.readdir(blocksDir))
        .filter((f) => f.endsWith('.md'))
        .sort()
      const parts: string[] = []
      for (const f of files) {
        const body = (await fs.readFile(path.join(blocksDir, f), 'utf8')).trim()
        parts.push(`### ${f.replace(/\.md$/, '')}\n\n${body}`)
      }
      if (parts.length > 0) blocksSection = parts.join('\n\n')
    } catch {
      // no blocks dir
    }

    // recent turn history (last 10 raw records)
    const rawDir = path.join(dir, 'history', 'raw')
    let turnsSection = ''
    try {
      const files = (await fs.readdir(rawDir))
        .filter((f) => f.startsWith('turn-') && f.endsWith('.json'))
        .sort()
      const recent = files.slice(-10)
      const lines: string[] = []
      for (const f of recent) {
        const data = await fs.readFile(path.join(rawDir, f), 'utf8').catch(() => '')
        try {
          const j = JSON.parse(data) as {
            turn_id?: string
            result?: string
            started_at?: string
            ended_at?: string
          }
          lines.push(
            `- ${j.turn_id ?? f}: ${j.result ?? '?'} (${j.started_at ?? '?'} → ${j.ended_at ?? '?'})`
          )
        } catch {
          lines.push(`- ${f}: (parse error)`)
        }
      }
      if (lines.length > 0) turnsSection = lines.join('\n')
    } catch {
      // no raw dir
    }

    const reasonLabel =
      reason === 'turn_budget'
        ? `ターン上限到達 (${state.turns}/${budget.max_turns})`
        : `経過時間上限到達 (${elapsedSec ?? '?'}s / ${budget.max_wall_time_seconds}s)`

    const finishedAt = isoNow()
    const wsPath = state.workspace_path

    // Copy-paste objective for the next goal — embeds the original goal +
    // current digest so the follow-up runner starts with full context.
    const handoffObjective = [
      '【前ゴールからの引き継ぎ】',
      '',
      `前ゴール ID: ${this.goalId}`,
      `前ゴール終了理由: ${reasonLabel}`,
      `前ゴール終了日時: ${finishedAt}`,
      '',
      '## 元のゴール',
      '',
      objective || '(objective.md が空)',
      '',
      '## 現在地（前ゴールの digest）',
      '',
      digest || '(digest.md が空)',
      '',
      '## このゴールでやること',
      '',
      '上記 digest の「未解決ブロッカー」「次の最小ステップ候補」から再開し、',
      '元のゴールが達成されるまで作業を継続すること。'
    ].join('\n')

    const md = [
      `# HANDOFF — ${this.goalId}`,
      '',
      `- 終了理由: **${reasonLabel}**`,
      `- 終了日時: ${finishedAt}`,
      `- workspace: \`${wsPath}\``,
      `- ターン数: ${state.turns} / ${budget.max_turns}`,
      `- last_turn_id: ${state.last_turn_id ?? '(なし)'} (${state.last_result ?? '?'})`,
      '',
      '## 元のゴール (objective.md)',
      '',
      objective || '(objective.md が空)',
      '',
      '## 最終 digest',
      '',
      digest || '(digest.md が空)',
      '',
      ...(blocksSection
        ? ['## ブロックサマリ (10ターンごと)', '', blocksSection, '']
        : []),
      ...(turnsSection ? ['## 直近ターン履歴', '', turnsSection, ''] : []),
      '## 後続ゴールへの引き継ぎ手順',
      '',
      `1. 同じワークスペース (\`${wsPath}\`) で「新規ゴール」を作成する。`,
      '2. ゴール本文として下記「引き継ぎ用 objective テンプレ」をコピペする。',
      '3. 必要に応じて max_turns / 総時間を増やしてから作成する。',
      '',
      '## 引き継ぎ用 objective テンプレ（コピペしてください）',
      '',
      '```',
      handoffObjective,
      '```',
      ''
    ].join('\n')

    const outPath = path.join(dir, 'HANDOFF.md')
    await fs.writeFile(outPath, md, 'utf8')
    await this.log('info', `HANDOFF.md generated (${reason})`)
  }

  /**
   * Collect external-observation evidence for the next turn's prompt
   * ({{EVIDENCE}}). Independent of digest content (which is the worker's
   * self-report) so the worker can cross-check its own claims against what
   * the shell actually sees.
   *
   * Sources (each with a 3s timeout / best-effort, missing data → omitted):
   *   1. git status --short     (workspace dirty state)
   *   2. git diff --stat HEAD   (size of pending changes)
   *   3. logs/checker.log tail  (last 50 lines of hard checker output)
   *   4. prior turn's stdout    (last 30 lines, so the worker recalls
   *                              its own immediately-prior output without
   *                              relying on the lossy digest summary)
   */
  private async collectEvidence(
    workspacePath: string,
    prevTurnId: string | null
  ): Promise<string> {
    const sections: string[] = []

    if (existsSync(path.join(workspacePath, '.git'))) {
      const status = await runWithTimeout(['git', 'status', '--short'], workspacePath, 3000)
      sections.push(
        status.trim()
          ? `### git status --short\n\`\`\`\n${status.trim()}\n\`\`\``
          : '### git status --short\n（変更なし）'
      )

      const diffStat = await runWithTimeout(
        ['git', 'diff', '--stat', 'HEAD'],
        workspacePath,
        3000
      )
      if (diffStat.trim()) {
        sections.push(`### git diff --stat HEAD\n\`\`\`\n${diffStat.trim()}\n\`\`\``)
      }
    }

    const checkerLog = path.join(goalDir(this.goalId), 'logs', 'checker.log')
    const checkerTail = await fs.readFile(checkerLog, 'utf8').catch(() => '')
    if (checkerTail.trim()) {
      const tail = checkerTail.trim().split('\n').slice(-50).join('\n')
      sections.push(`### 直前 checker.log (末尾 50 行)\n\`\`\`\n${tail}\n\`\`\``)
    }

    if (prevTurnId) {
      const stdoutPath = path.join(goalDir(this.goalId), 'turns', `${prevTurnId}.stdout`)
      const stdout = await fs.readFile(stdoutPath, 'utf8').catch(() => '')
      if (stdout.trim()) {
        const tail = stdout.trim().split('\n').slice(-30).join('\n')
        sections.push(`### ${prevTurnId} stdout 末尾 30 行\n\`\`\`\n${tail}\n\`\`\``)
      }
    }

    return sections.join('\n\n')
  }

  private async preTurnSnapshot(workspacePath: string, turnId: string): Promise<void> {
    if (!existsSync(path.join(workspacePath, '.git'))) return
    const tag = `codex-goal/${this.goalId}/${turnId}`
    await new Promise<void>((resolve) => {
      const child = spawn('git', ['tag', '-f', tag], {
        cwd: workspacePath,
        stdio: 'ignore'
      })
      child.on('exit', () => resolve())
      child.on('error', () => resolve())
    })
    await this.log('info', `Pre-turn git tag: ${tag}`)
  }

  private async waitForTurn(
    handle: RunTurnHandle,
    workId: string,
    subdir: WorkSubdir,
    budget: GoalBudget
  ): Promise<string> {
    const tp = turnPaths(this.goalId, workId, subdir)
    const startedAt = Date.now()
    const timeoutMs = budget.per_turn_timeout_seconds * 1000
    const heartbeatMs = budget.heartbeat_threshold_seconds * 1000
    const graceUntil = startedAt + HEARTBEAT_GRACE_MS

    while (true) {
      if (this.aborted) {
        const reason = this.interrupted ? 'INTERRUPTED' : 'ABORTED'
        await this.markTurnDeadAndKill(handle, workId, subdir, reason)
        return reason
      }
      if (existsSync(tp.result)) {
        return (await fs.readFile(tp.result, 'utf8')).trim()
      }
      const now = Date.now()
      if (now - startedAt > timeoutMs) {
        await this.log(
          'warn',
          `${workId} TIMEOUT after ${Math.floor((now - startedAt) / 1000)}s`
        )
        await this.markTurnDeadAndKill(handle, workId, subdir, 'TIMEOUT')
        return 'TIMEOUT'
      }
      if (existsSync(tp.heartbeat)) {
        const stat = await fs.stat(tp.heartbeat)
        if (now - stat.mtimeMs > heartbeatMs) {
          await this.log(
            'warn',
            `${workId} HANG (heartbeat lost ${Math.floor((now - stat.mtimeMs) / 1000)}s)`
          )
          await this.markTurnDeadAndKill(handle, workId, subdir, 'HANG')
          return 'HANG'
        }
      } else if (now > graceUntil) {
        await this.log('warn', `${workId} HANG (no heartbeat appeared)`)
        await this.markTurnDeadAndKill(handle, workId, subdir, 'HANG')
        return 'HANG'
      }
      await sleep(1000)
    }
  }

  /**
   * Write the sentinel result and ask the in-process runTurn handle to
   * terminate the codex child. As a backup we also fall back to reading the
   * pid file and killing the process tree directly — this covers the rare
   * case where the handle has already been garbage-collected (e.g. orphaned
   * pid from a previous app instance picked up by reapOrphanedPids).
   */
  // Phase 4.3: extend the union with INTERRUPTED so user-message injection
  // can mark a turn as a graceful stop rather than an anomaly.
  private async markTurnDeadAndKill(
    handle: RunTurnHandle | null,
    workId: string,
    subdir: WorkSubdir,
    reason: 'TIMEOUT' | 'HANG' | 'ABORTED' | 'INTERRUPTED'
  ): Promise<void> {
    const tp = turnPaths(this.goalId, workId, subdir)
    if (handle) {
      await handle.kill(reason).catch(() => undefined)
    } else {
      try {
        await fs.writeFile(tp.result, `${reason}\n`, 'utf8')
      } catch {
        // ignore
      }
    }
    // Backup: read pid file and terminate the process tree. Cross-platform:
    // mac/linux send SIGTERM to the process group, win32 spawns taskkill /T.
    const pidFile = path.join(goalDir(this.goalId), subdir, `${workId}.pid`)
    try {
      const raw = await fs.readFile(pidFile, 'utf8')
      const pid = parseInt(raw.trim(), 10)
      if (Number.isFinite(pid) && pid > 1) {
        await terminateProcessTree(pid, 'SIGTERM')
        await this.log('info', `Sent SIGTERM to pid=${pid} for ${workId}`)
        // Escalate to SIGKILL if the child is still around after a grace.
        setTimeout(() => {
          void terminateProcessTree(pid, 'SIGKILL')
        }, 5000).unref()
      }
    } catch {
      // pid file unreadable / missing — handle.kill (or the result-file
      // sentinel runTurn polls) is the primary kill signal anyway.
    }
  }

  /**
   * Persist a snapshot of digest.md at a specific moment for audit trail. The
   * `label` identifies what produced this snapshot (e.g. 'turn-005' for a
   * normal turn write, 'turn-005-pre-compress' for the pre-compression state,
   * 'turn-005-anomaly' for an anomaly-appended digest) and becomes the
   * filename under <goalDir>/history/digests/. Snapshots let us reconstruct
   * how digest content evolved across turns and detect silent deletions
   * (PR-B's diff linter consumes these). Best-effort: a single snapshot
   * failure must not block the turn.
   */
  private async saveDigestSnapshot(label: string, content: string): Promise<void> {
    const dir = path.join(goalDir(this.goalId), 'history', 'digests')
    try {
      await fs.mkdir(dir, { recursive: true })
      await atomicWrite(path.join(dir, `${label}.md`), content)
    } catch (err) {
      await this.log('warn', `digest snapshot ${label} failed: ${String(err)}`)
    }
  }

  private async appendAnomalyToDigest(turnId: string, result: string): Promise<void> {
    const digestPath = path.join(goalDir(this.goalId), 'digest.md')
    const cur = await fs.readFile(digestPath, 'utf8').catch(() => '')
    const ANOMALY_HEADING = '## 🚨 直前ターンの異常終了'
    const note = [
      '',
      ANOMALY_HEADING,
      `- ${turnId}: ${result} (連続 ${this.consecutiveAnomalies} 回目)`,
      '  → このアプローチは時間内に完了しなかった。**同じ手順を繰り返さない**こと。',
      '  → 原因仮説: ツール呼び出しが多すぎる / dev-browser 待機が長い / ブラウザが応答しない 等。',
      '  → 次ターンでは作業を **より小さなステップに分割**し、ファイル状態のみ確認して digest を更新するなど **軽い作業**から始めること。',
      ''
    ].join('\n')
    let next: string
    if (cur.includes(ANOMALY_HEADING)) {
      // Replace existing anomaly section with the latest
      next = cur.replace(/\n*## 🚨 直前ターンの異常終了[\s\S]*?(?=\n## |$)/, note)
    } else {
      next = cur.trimEnd() + '\n' + note
    }
    await atomicWrite(digestPath, next)
    await this.saveDigestSnapshot(`${turnId}-anomaly`, next)
    this.emit('event', {
      type: 'digest',
      goalId: this.goalId,
      digest: next
    } satisfies GoalEvent)
  }

  private async flushTailOnce(stdoutPath: string, workId: string): Promise<void> {
    try {
      const content = await fs.readFile(stdoutPath, 'utf8')
      if (content.length > this.recentStdout.length) {
        const newPart = content.slice(this.recentStdout.length)
        this.recentStdout = content.slice(-200_000)
        this.emit('event', {
          type: 'turn:stdout',
          goalId: this.goalId,
          turnId: workId,
          chunk: newPart
        } satisfies GoalEvent)
      }
    } catch {
      // ignore
    }
  }

  private async log(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    const line = `[${isoNow()}] ${level.toUpperCase()} ${message}`
    this.recentLog.push(line)
    if (this.recentLog.length > 500) this.recentLog = this.recentLog.slice(-500)
    try {
      await fs.appendFile(
        path.join(goalDir(this.goalId), 'logs', 'orchestrator.log'),
        line + '\n',
        'utf8'
      )
    } catch {
      // ignore
    }
    this.emit('event', {
      type: 'log',
      goalId: this.goalId,
      level,
      message,
      ts: isoNow()
    } satisfies GoalEvent)
  }
}
