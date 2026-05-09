// Types shared between main, preload, and renderer.

export type GoalStatus =
  | 'pending'
  | 'planning'
  | 'active'
  | 'paused'
  | 'achieved'
  | 'blocked'
  | 'budget_exhausted'
  | 'abandoned'

export interface GoalState {
  goal_id: string
  // Human-readable title auto-derived from the objective's first non-empty line
  // at creation time. Persisted so objective edits don't change how the goal is
  // listed/searched. Optional for backwards compat with older state.json files.
  title?: string
  status: GoalStatus
  created_at: string
  updated_at: string
  turns: number
  last_turn_id: string | null
  last_result: string | null
  workspace_path: string
  parent_goal_id: string | null
  // Phase 4.2 A2: when set, the runner was paused after detecting a Codex
  // rate-limit response. The runtime schedules an automatic resume at this ISO
  // timestamp. Cleared when the runner resumes (manually or automatically).
  next_resume_at?: string | null
  // PR-D: when true, the runner refuses to mark the goal as 'achieved' unless
  // the hard checker (checker.sh) actually passes. A no_checker outcome is
  // treated as a forced fail. Optional for backwards compatibility — legacy
  // state.json files without this field default to false (preserves the
  // previous "judge worker can claim achieved without a checker" behavior).
  // New goals default to true via the NewGoal form.
  checker_required?: boolean
  // Smart Verification defaults to 'smart': checker pass can finish the goal,
  // checker miss/fail falls back to judge verification, and repeated rejected
  // achievement claims stop as blocked instead of looping forever. 'strict'
  // preserves the old hard-gate behavior; 'off' accepts worker achievement
  // tokens without external verification.
  verification_mode?: 'smart' | 'strict' | 'off'
}

export interface GoalBudget {
  max_turns: number
  max_wall_time_seconds: number
  per_turn_timeout_seconds: number
  heartbeat_threshold_seconds: number
  rate_limit_sleep_seconds: number
}

export interface GoalSummary {
  goal_id: string
  objective_preview: string
  state: GoalState
  budget: GoalBudget
  has_checker: boolean
}

export interface CreateGoalParams {
  goal_id_slug: string // human-readable slug; full id will be slug + short uuid
  workspace_path: string
  objective: string
  budget: GoalBudget
  checker_script: string | null // contents of checker.sh, or null
  // PR-D: when true, the runner cannot accept 'achieved' without checker.sh
  // passing. NewGoal form defaults to true; user can opt out for ad-hoc /
  // exploratory goals. Omitted = legacy behavior (judge-only path allowed).
  checker_required?: boolean
  verification_mode?: 'smart' | 'strict' | 'off'
  // Plan mode integration: when 'planning', the goal is created without
  // auto-starting the runner; the renderer redirects to /plan/:goalId. Omit or
  // set to 'pending' to preserve the legacy "create then auto-run" flow.
  initial_status?: GoalStatus
}

export interface RecentWorkspace {
  path: string
  last_opened_at: string
}

// Global settings — applied as defaults to new goals. Stored at
// ~/.codex-goals/.settings.json. Renderer reads via IPC and pre-fills the new
// goal form; users can override per-goal in the "詳細" disclosure.
export interface GlobalSettings {
  default_budget: GoalBudget
  // Model id passed to `codex --model`.
  default_model: string
  // PR-D: optional model override for non-main workers (judge / critic). When
  // omitted (default), workers reuse default_model. Setting a *different*
  // model here gives the critic a slightly different training distribution
  // → less correlated blind spots when validating the main worker's claims.
  // Cheap option: main=GPT-5.5, critic=GPT-5.4.
  critic_model?: string
}

export const SUPPORTED_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5（最高品質・推奨）' },
  { id: 'gpt-5.4', label: 'GPT-5.4（品質・速度バランス）' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex（コード作業向け）' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini（軽量タスク向け）' }
] as const

export type SupportedModelId = (typeof SUPPORTED_MODELS)[number]['id']

/**
 * PR-D: structured result emitted by checker.sh as a `<checker-result>JSON
 * </checker-result>` block at the end of stdout. The exit code is still the
 * authoritative pass/fail (legacy contract); this JSON is *additional*
 * information that lets the runner inject "M3 fail: <evidence>" into the
 * next turn's prompt instead of just logging "checker failed".
 *
 * `schema_version: 1` is required so we can evolve the format later without
 * breaking older checker scripts. `milestones` is allowed to be empty for
 * checkers that only report a single overall pass/fail.
 */
export interface CheckerResult {
  schema_version: 1
  milestones: Array<{
    id: string // e.g. "M1"
    label: string // e.g. "binaries uploaded"
    status: 'pass' | 'fail' | 'skip'
  }>
  evidence: string // human-readable summary, ≤ 500 chars by convention
  passed_count: number
  total_count: number
}

export interface TurnRecord {
  turn_id: string
  result: string
  started_at: string
  ended_at: string
}

export type WorkKind = 'turn' | 'block' | 'judge'

export interface TurnHistoryEntry {
  kind: WorkKind
  workId: string
  result: string | null
  mtime: string
  hasStdout: boolean
  hasPrompt: boolean
}

// Phase 4.2 E3: minimal listing entry for history/blocks/*.md so the renderer
// can render a clickable list without paying for the full file body up front.
export interface BlockSummaryEntry {
  blockId: string // e.g. "block-001"
  mtime: string // ISO timestamp
  bytes: number
}

// Phase 4.3 (chat-injection): mid-flight directive from the user. Persisted to
// <goal>/user-messages.jsonl so a runner restart picks up unprocessed messages.
// `consumed_at_turn` is null until the worker actually ran with the message in
// its prompt (and the turn finished cleanly); after that it stays as a record.
// Phase 4.4 adds an optional `reply` populated when the worker emitted a
// <user-reply id="..."> block addressing this message.
export interface UserMessage {
  id: string
  ts: string
  text: string
  consumed_at_turn: string | null
  reply?: { text: string; ts: string; turn_id: string } | null
}

export type GoalEvent =
  | { type: 'log'; goalId: string; level: 'info' | 'warn' | 'error'; message: string; ts: string }
  | { type: 'state'; goalId: string; state: GoalState }
  | { type: 'turn:started'; goalId: string; turnId: string; ts: string }
  | { type: 'turn:stdout'; goalId: string; turnId: string; chunk: string }
  | { type: 'turn:finished'; goalId: string; turnId: string; result: string; ts: string }
  | { type: 'digest'; goalId: string; digest: string }
  // Phase 4.2 A2: emitted when the runner detected a Codex rate-limit response
  // and paused itself. The runtime schedules an automatic resume at resumeAt.
  | { type: 'rate-limit'; goalId: string; resumeAt: string; reason: string }
  // Phase 4.3: emitted when the user adds a mid-flight directive via the app.
  | { type: 'user-message'; goalId: string; message: UserMessage }
  // Phase 4.3: emitted when a turn marked queued user messages as consumed.
  | { type: 'user-message-consumed'; goalId: string; ids: string[]; turnId: string }
  // Phase 4.4: emitted when the worker addressed a user message with a reply.
  | {
      type: 'user-message-reply'
      goalId: string
      messageId: string
      reply: { text: string; ts: string; turn_id: string }
    }

export interface RunnerSnapshot {
  goalId: string
  running: boolean
  currentTurnId: string | null
  recentLog: string[]
  recentStdout: string
  digest: string
}

// IPC channel names — keep them strongly typed to prevent typos.
export const IPC = {
  Workspace: {
    Select: 'workspace:select',
    RecentList: 'workspace:recent:list',
    RecentAdd: 'workspace:recent:add',
    RecentRemove: 'workspace:recent:remove'
  },
  Goal: {
    List: 'goal:list',
    Get: 'goal:get',
    Create: 'goal:create',
    Delete: 'goal:delete',
    Turns: 'goal:turns',
    TurnStdout: 'goal:turns:stdout',
    // Phase 4.2 E3: list / read block summaries (history/blocks/*.md) so the
    // renderer can show the long-term memory the runner injects into prompts.
    BlocksList: 'goal:blocks:list',
    BlocksRead: 'goal:blocks:read',
    // Phase 4.2 E1: edit objective.md / budget.json from the renderer.
    UpdateObjective: 'goal:update:objective',
    UpdateBudget: 'goal:update:budget',
    // Phase 4.3: queue / list mid-flight user directives, or interrupt-and-restart.
    UserMessageAdd: 'goal:user-message:add',
    UserMessageList: 'goal:user-message:list',
    UserMessageInterrupt: 'goal:user-message:interrupt'
  },
  Settings: {
    Get: 'settings:get',
    Update: 'settings:update'
  },
  Runner: {
    Start: 'runner:start',
    Abort: 'runner:abort',
    Pause: 'runner:pause',
    Resume: 'runner:resume',
    Snapshot: 'runner:snapshot'
  },
  // Plan mode (Phase 2+): interactive planning session lifecycle. Only used
  // when a goal was created with detailed planning enabled. The session ends
  // when the user approves (→ writes plan.md, transitions status to 'pending')
  // or aborts (→ deletes the goal or reverts to 'pending' without plan.md).
  Plan: {
    Status: 'plan:status',
    Start: 'plan:start',
    SendMessage: 'plan:send-message',
    Approve: 'plan:approve',
    Abort: 'plan:abort'
  },
  Events: {
    GoalEvent: 'goal:event',
    PlanEvent: 'plan:event'
  }
} as const

// Plan mode session events broadcast from main → renderer over IPC.Events.PlanEvent.
// The renderer's PlanReview page subscribes and updates its chat history state.
export type PlanEvent =
  | { type: 'session-started'; goalId: string; sessionId: string | null; ts: string }
  | { type: 'assistant-text'; goalId: string; text: string; ts: string }
  | { type: 'assistant-message-complete'; goalId: string; ts: string }
  | { type: 'plan-ready'; goalId: string; plan: string; ts: string }
  | { type: 'turn-complete'; goalId: string; ts: string }
  | { type: 'error'; goalId: string; message: string; ts: string }
  | { type: 'session-ended'; goalId: string; reason: 'approved' | 'aborted' | 'crashed'; ts: string }

export interface PlanSessionStatus {
  goalId: string
  active: boolean
  sessionId: string | null
  history: PlanChatMessage[]
  pendingPlan: string | null
}

export interface PlanChatMessage {
  role: 'user' | 'assistant'
  text: string
  ts: string
}
