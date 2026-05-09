import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import type {
  BlockSummaryEntry,
  GoalBudget,
  GoalEvent,
  GoalSummary,
  TurnHistoryEntry,
  UserMessage,
  WorkKind
} from '@shared/types'
import { canManuallyMarkAchieved } from '@shared/manualCompletion'
import StatusBadge from '../components/StatusBadge'

interface LogLine {
  ts: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export default function GoalDetail(): JSX.Element {
  const { goalId } = useParams<{ goalId: string }>()
  const navigate = useNavigate()

  const [goal, setGoal] = useState<GoalSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null)
  const [stdout, setStdout] = useState('')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [digest, setDigest] = useState('')
  const [history, setHistory] = useState<TurnHistoryEntry[]>([])
  const [blocks, setBlocks] = useState<BlockSummaryEntry[]>([])
  const [selectedBlock, setSelectedBlock] = useState<{
    blockId: string
    content: string
  } | null>(null)
  const [selectedHistory, setSelectedHistory] = useState<{
    workId: string
    kind: WorkKind
    content: string
  } | null>(null)
  const [editing, setEditing] = useState(false)
  const [now, setNow] = useState(Date.now())
  // Phase 4.3: user-message queue UI state
  const [userMessages, setUserMessages] = useState<UserMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const stdoutRef = useRef<HTMLPreElement>(null)
  const logsRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  // ---- subscriptions ----
  useEffect(() => {
    if (!goalId) return
    let mounted = true
    void (async () => {
      try {
        const g = await window.api.goal.get(goalId)
        if (!mounted) return
        // Goals in 'planning' status belong on the PlanReview page; if a user
        // navigates here directly (deep link, sidebar click before status sync,
        // multi-window race), bounce them over before we wire up any of the
        // GoalDetail-specific subscriptions.
        if (g && g.state.status === 'planning') {
          navigate(`/plan/${goalId}`, { replace: true })
          return
        }
        setGoal(g)

        const snap = await window.api.runner.snapshot(goalId)
        if (snap && mounted) {
          setRunning(snap.running)
          setCurrentTurnId(snap.currentTurnId)
          setStdout(snap.recentStdout)
          setLogs(
            snap.recentLog.map((line) => ({
              ts: '',
              level: 'info',
              message: line
            }))
          )
          setDigest(snap.digest)
        }

        const turns = await window.api.goal.turns(goalId)
        if (mounted) setHistory(turns)

        const bls = await window.api.goal.blocksList(goalId)
        if (mounted) setBlocks(bls)

        const msgs = await window.api.goal.userMessageList(goalId)
        if (mounted) setUserMessages(msgs)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [goalId])

  useEffect(() => {
    if (!goalId) return
    const off = window.api.runner.onEvent((event: GoalEvent) => {
      if (event.goalId !== goalId) return
      switch (event.type) {
        case 'state':
          // If another window flipped this goal back to 'planning' (e.g. user
          // re-opened the plan on a different window), bounce to PlanReview so
          // we don't leave a stale GoalDetail subscribing to a goal whose
          // runner is now gated.
          if (event.state.status === 'planning') {
            navigate(`/plan/${goalId}`, { replace: true })
            return
          }
          setGoal((g) => (g ? { ...g, state: event.state } : g))
          // Sync the local 'running' flag with backend status. The runner
          // exits its main loop when status leaves 'active' (paused / achieved
          // / abandoned / blocked / budget_exhausted), but no other event
          // resets running, so without this the Resume/Start buttons stay
          // disabled forever after a Pause click.
          if (event.state.status !== 'active' && event.state.status !== 'pending') {
            setRunning(false)
          }
          break
        case 'turn:started':
          setRunning(true)
          setCurrentTurnId(event.turnId)
          setStdout('')
          break
        case 'turn:stdout':
          setStdout((prev) => {
            const next = prev + event.chunk
            return next.length > 200_000 ? next.slice(-200_000) : next
          })
          break
        case 'turn:finished':
          setCurrentTurnId(null)
          // refresh history list and blocks (block summarizer may have run)
          void window.api.goal.turns(goalId).then(setHistory)
          void window.api.goal.blocksList(goalId).then(setBlocks)
          break
        case 'log':
          setLogs((prev) => {
            const next = [...prev, { ts: event.ts, level: event.level, message: event.message }]
            return next.length > 500 ? next.slice(-500) : next
          })
          break
        case 'digest':
          setDigest(event.digest)
          break
        case 'user-message':
          setUserMessages((prev) => {
            // dedupe in case another window broadcast arrives
            if (prev.some((m) => m.id === event.message.id)) return prev
            return [...prev, event.message]
          })
          break
        case 'user-message-consumed':
          setUserMessages((prev) =>
            prev.map((m) =>
              event.ids.includes(m.id) ? { ...m, consumed_at_turn: event.turnId } : m
            )
          )
          break
        case 'user-message-reply':
          setUserMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId ? { ...m, reply: event.reply } : m
            )
          )
          break
      }
    })
    return off
  }, [goalId])

  // Goals in a terminal status (achieved / abandoned / blocked / budget_exhausted)
  // freeze their elapsed time at updated_at so the counter doesn't keep ticking
  // after the run ended. Active / paused / pending continue to tick live.
  const terminalStatuses: ReadonlyArray<GoalSummary['state']['status']> = [
    'achieved',
    'abandoned',
    'blocked',
    'budget_exhausted'
  ]
  const isTerminal = goal ? terminalStatuses.includes(goal.state.status) : false

  useEffect(() => {
    if (isTerminal) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isTerminal])

  // auto-scroll panes
  useEffect(() => {
    if (stdoutRef.current && autoScrollRef.current) {
      stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight
    }
  }, [stdout])
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logs])

  // ---- actions ----
  async function onStart(): Promise<void> {
    if (!goalId) return
    await window.api.runner.start(goalId)
    setRunning(true)
  }

  async function onAbort(): Promise<void> {
    if (!goalId) return
    if (!confirm('実行中のループを中止します。よろしいですか？')) return
    await window.api.runner.abort(goalId)
  }

  async function onPause(): Promise<void> {
    if (!goalId) return
    await window.api.runner.pause(goalId)
  }

  async function onResume(): Promise<void> {
    if (!goalId) return
    await window.api.runner.resume(goalId)
    setRunning(true)
  }

  async function onMarkAchieved(): Promise<void> {
    if (!goalId) return
    if (!confirm('この一時停止中のゴールを達成済みにします。よろしいですか？')) return
    const updated = await window.api.goal.markAchieved(goalId)
    if (!updated) {
      setError('このゴールは現在、手動完了できる状態ではありません')
      return
    }
    setGoal(updated)
    setRunning(false)
    setCurrentTurnId(null)
  }

  async function onDelete(): Promise<void> {
    if (!goalId) return
    if (!confirm(`ゴール ${goalId} を削除します。よろしいですか？`)) return
    await window.api.goal.delete(goalId)
    navigate('/')
  }

  async function openHistoryItem(entry: TurnHistoryEntry): Promise<void> {
    if (!goalId) return
    const content = await window.api.goal.turnStdout(goalId, entry.workId, entry.kind)
    setSelectedHistory({ workId: entry.workId, kind: entry.kind, content })
  }

  async function openBlockItem(entry: BlockSummaryEntry): Promise<void> {
    if (!goalId) return
    const content = await window.api.goal.blocksRead(goalId, entry.blockId)
    setSelectedBlock({ blockId: entry.blockId, content })
  }

  // Phase 4.3: queue an additional directive to be picked up by the next turn.
  async function onSendMessage(immediate: boolean): Promise<void> {
    if (!goalId) return
    const text = draft.trim()
    if (!text) {
      setSendError('メッセージを入力してください')
      return
    }
    setSendError(null)
    setSending(true)
    try {
      if (immediate) {
        await window.api.goal.userMessageInterrupt(goalId, text)
      } else {
        await window.api.goal.userMessageAdd(goalId, text)
      }
      setDraft('')
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const status = goal?.state.status

  const canStart = useMemo(() => {
    if (!status) return false
    if (running) return false
    return (
      status === 'pending' ||
      status === 'paused' ||
      status === 'active' ||
      status === 'blocked' ||
      status === 'budget_exhausted'
    )
  }, [status, running])

  const canPause = running && status === 'active'
  const canResume = !running && status === 'paused'
  const canMarkAchieved = canManuallyMarkAchieved(status, running)

  // elapsed time — freeze at updated_at if the goal is in a terminal status
  const referenceTime =
    isTerminal && goal ? new Date(goal.state.updated_at).getTime() : now
  const elapsedSec = goal
    ? Math.max(0, Math.floor((referenceTime - new Date(goal.state.created_at).getTime()) / 1000))
    : 0
  const wallTimeBudget = goal?.budget.max_wall_time_seconds ?? 0
  const wallTimeRatio = wallTimeBudget ? Math.min(1, elapsedSec / wallTimeBudget) : 0
  const turnRatio = goal ? Math.min(1, goal.state.turns / goal.budget.max_turns) : 0

  if (loading) return <div className="px-8 pt-8 text-sm text-zinc-500">読み込み中...</div>
  if (error)
    return <div className="px-8 pt-8 text-sm text-red-300">エラー: {error}</div>
  if (!goal)
    return (
      <div className="px-8 pt-8 text-sm text-zinc-500">
        ゴールが見つかりませんでした。
      </div>
    )

  return (
    <div className="mx-auto max-w-6xl px-8 pb-12 pt-6">
      <button
        onClick={() => navigate('/')}
        className="mb-2 text-xs text-zinc-500 hover:text-zinc-300"
      >
        ← ホーム
      </button>

      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate font-mono text-lg text-zinc-100">{goal.goal_id}</h1>
          <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">
            workspace: {goal.state.workspace_path}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={goal.state.status} />
          {currentTurnId && (
            <span
              className={`rounded px-2 py-0.5 text-xs ${
                currentTurnId.startsWith('block-')
                  ? 'bg-purple-700/30 text-purple-200'
                  : currentTurnId.startsWith('judge-')
                    ? 'bg-sky-700/30 text-sky-200'
                    : 'bg-amber-700/30 text-amber-200'
              }`}
            >
              {currentTurnId}
            </span>
          )}
        </div>
      </div>

      {/* Progress bars */}
      <div className="mb-5 grid grid-cols-2 gap-3 rounded-md border border-zinc-800 bg-bg-secondary px-4 py-3">
        <ProgressBar
          label={`ターン ${goal.state.turns} / ${goal.budget.max_turns}`}
          ratio={turnRatio}
          color="emerald"
        />
        <ProgressBar
          label={`経過 ${formatSeconds(elapsedSec)} / ${formatSeconds(wallTimeBudget)}`}
          ratio={wallTimeRatio}
          color={wallTimeRatio > 0.9 ? 'red' : wallTimeRatio > 0.6 ? 'amber' : 'sky'}
        />
      </div>

      {/* Action bar */}
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-bg-secondary px-4 py-3">
        <button
          onClick={onStart}
          disabled={!canStart}
          className="rounded-md bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {running ? '実行中…' : '開始'}
        </button>
        <button
          onClick={onPause}
          disabled={!canPause}
          className="rounded-md bg-amber-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          一時停止
        </button>
        <button
          onClick={onResume}
          disabled={!canResume}
          className="rounded-md bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          再開
        </button>
        <button
          onClick={onMarkAchieved}
          disabled={!canMarkAchieved}
          className="rounded-md bg-blue-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          完了にする
        </button>
        <button
          onClick={onAbort}
          disabled={!running}
          className="rounded-md bg-red-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          中止
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setEditing(true)}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-bg-tertiary"
          >
            編集
          </button>
          <button
            onClick={onDelete}
            className="rounded border border-red-900 px-3 py-1 text-xs text-red-300 hover:bg-red-900/30"
          >
            削除
          </button>
        </div>
      </div>

      {/* Phase 4.3: user-message queue — type a directive that will be
          injected into the next turn (or interrupt the current one). */}
      <Panel title="📨 追加指示（ユーザー → Codex）">
        <div className="space-y-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="走っているターンに追加で伝えたいこと（例: ファイルパスを /tmp に変更して / その方針はやめて、別アプローチで）"
            rows={3}
            className="w-full rounded border border-zinc-800 bg-bg-tertiary p-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-amber-700 focus:outline-none"
            disabled={sending}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void onSendMessage(false)
              }
            }}
          />
          {sendError && <div className="text-xs text-red-300">{sendError}</div>}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void onSendMessage(false)}
              disabled={sending || !draft.trim()}
              className="rounded bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              title="現ターン完了後、次ターンの prompt 先頭に注入される（⌘+Enter）"
            >
              次ターンに送る
            </button>
            <button
              onClick={() => void onSendMessage(true)}
              disabled={sending || !draft.trim() || !running}
              className="rounded bg-red-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              title="現ターンを中止 → このメッセージ込みで次ターンを即起動"
            >
              ⚡ 即時反映
            </button>
            <span className="ml-auto text-xs text-zinc-500">
              {userMessages.filter((m) => !m.consumed_at_turn).length} 件未読 ・
              {userMessages.length} 件総数
            </span>
          </div>

          {userMessages.length > 0 && (
            <ul className="max-h-72 space-y-2 overflow-auto rounded border border-zinc-800 bg-black/30 p-2 text-xs">
              {userMessages
                .slice()
                .reverse()
                .map((m) => (
                  <li key={m.id} className="rounded bg-bg-tertiary/50 px-2 py-1.5">
                    <div className="flex items-start gap-2">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          m.consumed_at_turn
                            ? 'bg-zinc-800 text-zinc-400'
                            : 'bg-amber-900/60 text-amber-100'
                        }`}
                      >
                        {m.consumed_at_turn ? `✓ ${m.consumed_at_turn}` : '未読'}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-500">
                        {new Date(m.ts).toLocaleTimeString('ja-JP')}
                      </span>
                      <span className="flex-1 whitespace-pre-wrap break-words text-zinc-200">
                        💬 {m.text}
                      </span>
                    </div>
                    {m.reply ? (
                      <div className="mt-1 ml-12 rounded border-l-2 border-emerald-700 bg-emerald-950/30 px-2 py-1 text-zinc-200">
                        <div className="mb-0.5 flex items-center gap-2 text-[10px] text-emerald-400">
                          <span>↩ Codex の返答</span>
                          <span className="font-mono text-zinc-500">
                            {m.reply.turn_id} ・ {new Date(m.reply.ts).toLocaleTimeString('ja-JP')}
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap break-words">{m.reply.text}</div>
                      </div>
                    ) : m.consumed_at_turn ? (
                      <div className="mt-1 ml-12 text-[10px] italic text-zinc-500">
                        （返答なし — Codex が
                        <code className="mx-0.5 font-mono">{`<user-reply>`}</code>
                        を出力しなかった可能性）
                      </div>
                    ) : null}
                  </li>
                ))}
            </ul>
          )}
        </div>
      </Panel>

      {/* Live panes */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`ターン出力 ${currentTurnId ? `(${currentTurnId})` : ''}`}>
          <pre
            ref={stdoutRef}
            onScroll={(e) => {
              const el = e.currentTarget
              autoScrollRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
            }}
            className="h-72 overflow-auto whitespace-pre-wrap rounded bg-black/50 p-3 font-mono text-xs leading-relaxed text-zinc-200"
          >
            {stdout || '(まだ出力はありません)'}
          </pre>
        </Panel>

        <Panel title="orchestrator log">
          <div
            ref={logsRef}
            className="h-72 overflow-auto rounded bg-black/50 p-3 font-mono text-xs leading-relaxed"
          >
            {logs.length === 0 ? (
              <div className="text-zinc-500">(まだログはありません)</div>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === 'error'
                      ? 'text-red-300'
                      : l.level === 'warn'
                        ? 'text-amber-300'
                        : 'text-zinc-200'
                  }
                >
                  {l.message}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel title="objective">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-bg-tertiary p-3 font-sans text-sm text-zinc-200">
            {goal.objective_preview}
          </pre>
        </Panel>

        <Panel title="digest（次ターンへの引き継ぎ）">
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-bg-tertiary p-3 font-mono text-xs text-zinc-200">
            {digest || '(まだ digest はありません)'}
          </pre>
        </Panel>
      </div>

      {/* Block summaries (long-term memory) */}
      <Panel title={`ブロック要約 (${blocks.length})`}>
        {blocks.length === 0 ? (
          <div className="text-sm text-zinc-500">
            (まだブロック要約はありません — 10 ターンごとに作成されます)
          </div>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-auto">
            {blocks.map((entry) => (
              <li key={entry.blockId}>
                <button
                  onClick={() => openBlockItem(entry)}
                  className="flex w-full items-center gap-3 rounded px-3 py-1.5 text-left text-xs hover:bg-bg-tertiary"
                >
                  <span className="w-16 shrink-0 rounded bg-purple-900/50 px-1.5 py-0.5 text-center text-[10px] font-medium text-purple-200">
                    block
                  </span>
                  <span className="font-mono text-zinc-200">{entry.blockId}</span>
                  <span className="ml-auto font-mono text-[10px] text-zinc-500">
                    {entry.bytes}B
                  </span>
                  <span className="font-mono text-[10px] text-zinc-500">
                    {new Date(entry.mtime).toLocaleTimeString('ja-JP')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Turn history */}
      <Panel title={`ターン履歴 (${history.length})`}>
        {history.length === 0 ? (
          <div className="text-sm text-zinc-500">(まだターン履歴はありません)</div>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-auto">
            {history.map((entry) => (
              <li key={`${entry.kind}:${entry.workId}`}>
                <button
                  onClick={() => openHistoryItem(entry)}
                  className="flex w-full items-center gap-3 rounded px-3 py-1.5 text-left text-xs hover:bg-bg-tertiary"
                >
                  <span
                    className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-medium ${
                      entry.kind === 'block'
                        ? 'bg-purple-900/50 text-purple-200'
                        : entry.kind === 'judge'
                          ? 'bg-sky-900/50 text-sky-200'
                          : 'bg-zinc-800 text-zinc-300'
                    }`}
                  >
                    {entry.kind}
                  </span>
                  <span className="font-mono text-zinc-200">{entry.workId}</span>
                  <span
                    className={`ml-auto font-mono text-[10px] ${
                      entry.result === 'DONE'
                        ? 'text-emerald-400'
                        : entry.result?.startsWith('FAIL') ||
                            entry.result === 'HANG' ||
                            entry.result === 'TIMEOUT'
                          ? 'text-red-400'
                          : 'text-zinc-500'
                    }`}
                  >
                    {entry.result ?? '...'}
                  </span>
                  <span className="font-mono text-[10px] text-zinc-500">
                    {new Date(entry.mtime).toLocaleTimeString('ja-JP')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* Selected block modal */}
      {selectedBlock && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setSelectedBlock(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-md border border-zinc-800 bg-bg-secondary"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div>
                <span className="font-mono text-sm text-zinc-200">
                  {selectedBlock.blockId}
                </span>
                <span className="ml-2 text-xs uppercase text-zinc-500">block summary</span>
              </div>
              <button
                onClick={() => setSelectedBlock(null)}
                className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-bg-tertiary"
              >
                閉じる
              </button>
            </div>
            <pre className="h-[60vh] overflow-auto whitespace-pre-wrap bg-black/40 p-4 font-mono text-xs text-zinc-200">
              {selectedBlock.content || '(本文はありません)'}
            </pre>
          </div>
        </div>
      )}

      {/* Edit modal (E1) */}
      {editing && goal && (
        <EditGoalModal
          goal={goal}
          onClose={() => setEditing(false)}
          onSaved={(g) => {
            setGoal(g)
            setEditing(false)
          }}
        />
      )}

      {/* Selected history modal */}
      {selectedHistory && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setSelectedHistory(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-md border border-zinc-800 bg-bg-secondary"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <div>
                <span className="font-mono text-sm text-zinc-200">
                  {selectedHistory.workId}
                </span>
                <span className="ml-2 text-xs uppercase text-zinc-500">
                  {selectedHistory.kind}
                </span>
              </div>
              <button
                onClick={() => setSelectedHistory(null)}
                className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-bg-tertiary"
              >
                閉じる
              </button>
            </div>
            <pre className="h-[60vh] overflow-auto whitespace-pre-wrap bg-black/40 p-4 font-mono text-xs text-zinc-200">
              {selectedHistory.content || '(出力はありません)'}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

interface EditGoalModalProps {
  goal: GoalSummary
  onClose: () => void
  onSaved: (g: GoalSummary) => void
}

function EditGoalModal({ goal, onClose, onSaved }: EditGoalModalProps): JSX.Element {
  const [objective, setObjective] = useState(goal.objective_preview)
  const [budget, setBudget] = useState<GoalBudget>(goal.budget)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isActive = goal.state.status === 'active'

  function setBudgetField(key: keyof GoalBudget, raw: string): void {
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    setBudget({ ...budget, [key]: n })
  }

  async function onSave(): Promise<void> {
    setError(null)
    for (const k of Object.keys(budget) as Array<keyof GoalBudget>) {
      const v = budget[k]
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        setError(`${k} は正の数値を指定してください`)
        return
      }
    }
    setSaving(true)
    try {
      const objChanged = objective !== goal.objective_preview
      const budgetChanged = (Object.keys(budget) as Array<keyof GoalBudget>).some(
        (k) => budget[k] !== goal.budget[k]
      )
      let next: GoalSummary | null = goal
      if (objChanged) {
        next = await window.api.goal.updateObjective(goal.goal_id, objective)
      }
      if (budgetChanged) {
        next = await window.api.goal.updateBudget(goal.goal_id, budget)
      }
      if (next) onSaved(next)
      else onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-md border border-zinc-800 bg-bg-secondary"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="font-mono text-sm text-zinc-200">ゴール編集 — {goal.goal_id}</div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-bg-tertiary"
            disabled={saving}
          >
            閉じる
          </button>
        </div>

        <div className="max-h-[65vh] space-y-5 overflow-auto p-5">
          {isActive && (
            <div className="rounded border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
              実行中のゴールを編集しています。次のターンから新しい設定が適用されます。
            </div>
          )}

          <section>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-zinc-500">
              objective.md
            </label>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              spellCheck={false}
              className="h-56 w-full resize-y rounded border border-zinc-800 bg-bg-tertiary px-3 py-2 font-mono text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
            />
          </section>

          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              budget.json
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <BudgetField
                label="max_turns"
                value={budget.max_turns}
                onChange={(v) => setBudgetField('max_turns', v)}
              />
              <BudgetField
                label="max_wall_time_seconds"
                value={budget.max_wall_time_seconds}
                onChange={(v) => setBudgetField('max_wall_time_seconds', v)}
              />
              <BudgetField
                label="per_turn_timeout_seconds"
                value={budget.per_turn_timeout_seconds}
                onChange={(v) => setBudgetField('per_turn_timeout_seconds', v)}
              />
              <BudgetField
                label="heartbeat_threshold_seconds"
                value={budget.heartbeat_threshold_seconds}
                onChange={(v) => setBudgetField('heartbeat_threshold_seconds', v)}
              />
              <BudgetField
                label="rate_limit_sleep_seconds"
                value={budget.rate_limit_sleep_seconds}
                onChange={(v) => setBudgetField('rate_limit_sleep_seconds', v)}
              />
            </div>
          </section>

          {error && (
            <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-bg-tertiary disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded bg-emerald-700 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

function BudgetField({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (raw: string) => void
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[11px] text-zinc-400">{label}</span>
      <input
        type="number"
        min={1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-zinc-800 bg-bg-tertiary px-2 py-1 font-mono text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
      />
    </label>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="mt-4 rounded-md border border-zinc-800 bg-bg-secondary p-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  )
}

function ProgressBar({
  label,
  ratio,
  color
}: {
  label: string
  ratio: number
  color: 'emerald' | 'sky' | 'amber' | 'red'
}): JSX.Element {
  const colorClass = {
    emerald: 'bg-emerald-600',
    sky: 'bg-sky-600',
    amber: 'bg-amber-500',
    red: 'bg-red-600'
  }[color]
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className="font-mono text-zinc-500">{Math.round(ratio * 100)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
        <div
          className={`h-full transition-all ${colorClass}`}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
    </div>
  )
}

function formatSeconds(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}
