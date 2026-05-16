import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import type { GoalSummary, PlanChatMessage, PlanEvent } from '@shared/types'
import { findExternalAbsolutePaths } from '@shared/planValidation'
import ChatBubble from '../components/ChatBubble'

// Renderer-side chat entry. We store the canonical history of finalized turns
// here, plus a single live "streaming" assistant bubble while a turn is in
// flight. Streaming text is *not* mirrored into history until turn-complete.
interface ChatEntry extends PlanChatMessage {
  // Local-only id used as React key. Server doesn't assign one.
  key: string
}

export default function PlanReview(): JSX.Element {
  const { goalId } = useParams<{ goalId: string }>()
  const navigate = useNavigate()

  const [goal, setGoal] = useState<GoalSummary | null>(null)
  // Mirror of goal so the PlanEvent subscription can read the latest workspace
  // path without re-subscribing on every goal state change.
  const goalRef = useRef<GoalSummary | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [bootLoading, setBootLoading] = useState(true)

  const [history, setHistory] = useState<ChatEntry[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  // Mirror of streamingText so we can read+clear atomically inside event
  // handlers without nesting setState callbacks (which is unsafe under
  // React's concurrent mode / StrictMode double-invoke).
  const streamingTextRef = useRef<string | null>(null)
  const [pendingPlan, setPendingPlan] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [awaitingTurn, setAwaitingTurn] = useState(false)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  // True after the plan-mode process exited with reason='crashed' (or
  // an otherwise unexpected reason). The main process has already reverted
  // status from 'planning' -> 'pending' (see planSession.ts:174), so the
  // session map is empty; further sendMessage/approve calls would throw.
  // Surface a recovery prompt instead of the chat composer.
  const [crashedRecovery, setCrashedRecovery] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)

  // Stable key generator — entries are append-only so index works, but we
  // prefer an explicit id so a future edit feature won't break.
  const nextKeyRef = useRef(0)
  const newKey = (): string => `m-${nextKeyRef.current++}`

  // ---------- boot: load goal, attach to or start a plan session ----------
  useEffect(() => {
    if (!goalId) return
    let mounted = true
    void (async () => {
      try {
        const g = await window.api.goal.get(goalId)
        if (!mounted) return
        if (!g) {
          setBootError(`ゴールが見つかりません: ${goalId}`)
          setBootLoading(false)
          return
        }
        setGoal(g)
        goalRef.current = g
        if (g.state.status !== 'planning') {
          // Caller navigated to /plan/:id but the goal isn't in planning
          // state. Send them back to the detail page, preserving the
          // workspace query so the sidebar's active-ws highlight survives.
          const ws = encodeURIComponent(g.state.workspace_path)
          navigate(`/goals/${goalId}?ws=${ws}`, { replace: true })
          return
        }

        const status = await window.api.plan.status(goalId)
        if (!mounted) return
        if (status.active) {
          // Reattaching to an existing session (e.g. window reload).
          setHistory(
            status.history.map((m) => ({ ...m, key: newKey() }))
          )
          setPendingPlan(status.pendingPlan)
          setBootLoading(false)
          return
        }

        // No live session — start one. The objective is read from the goal's
        // workspace by the main process, so we just kick it off.
        await window.api.plan.start(goalId)
        setHistory([])
        setPendingPlan(null)
        // Plan mode opens with the assistant's first message — set awaiting so the
        // UI shows a thinking indicator until we get assistant-text.
        setAwaitingTurn(true)
        setBootLoading(false)
      } catch (err) {
        if (!mounted) return
        setBootError(err instanceof Error ? err.message : String(err))
        setBootLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [goalId, navigate])

  // ---------- subscribe to PlanEvent stream ----------
  useEffect(() => {
    if (!goalId) return
    const unsub = window.api.plan.onEvent((evt: PlanEvent) => {
      if (evt.goalId !== goalId) return
      switch (evt.type) {
        case 'session-started':
          // Nothing user-visible to do; status() already populated history.
          break
        case 'assistant-text': {
          const next = (streamingTextRef.current ?? '') + evt.text
          streamingTextRef.current = next
          setStreamingText(next)
          setAwaitingTurn(false)
          break
        }
        case 'assistant-message-complete': {
          // Finalize the streaming bubble into history. We snapshot the ref
          // and clear it before any setState so concurrent re-invocations of
          // this handler can't double-append.
          const finalText = streamingTextRef.current
          streamingTextRef.current = null
          setStreamingText(null)
          if (finalText && finalText.length > 0) {
            setHistory((h) => [
              ...h,
              { role: 'assistant', text: finalText, ts: evt.ts, key: newKey() }
            ])
          }
          break
        }
        case 'plan-ready':
          setPendingPlan(evt.plan)
          break
        case 'turn-complete':
          setSending(false)
          setAwaitingTurn(false)
          break
        case 'error':
          setErrorBanner(evt.message)
          setSending(false)
          setAwaitingTurn(false)
          break
        case 'session-ended':
          // approve() already navigates us away, but if the session ended for
          // any other reason (crash/abort from another window) we should
          // surface it and bail back to the goal detail page. Preserve ?ws=
          // so the sidebar's active-workspace highlight stays in sync.
          if (evt.reason === 'approved') {
            const ws = goalRef.current?.state.workspace_path
            navigate(
              ws ? `/goals/${goalId}?ws=${encodeURIComponent(ws)}` : `/goals/${goalId}`
            )
          } else if (evt.reason === 'aborted') {
            navigate('/')
          } else {
            // crashed (or unknown). Backend already reset status to 'pending';
            // show the recovery dialog so the user can choose what to do next.
            setCrashedRecovery(true)
            setSending(false)
            setAwaitingTurn(false)
            setStreamingText(null)
            streamingTextRef.current = null
          }
          break
      }
    })
    return unsub
  }, [goalId, navigate])

  // ---------- auto-scroll on new content ----------
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [history, streamingText, pendingPlan])

  // ---------- abort on window unload ----------
  useEffect(() => {
    if (!goalId) return
    const handler = (): void => {
      // Fire-and-forget; renderer is unloading so we can't await.
      void window.api.plan.abort(goalId)
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [goalId])

  const canSend = useMemo(
    () =>
      Boolean(draft.trim()) &&
      !sending &&
      !awaitingTurn &&
      !approving &&
      !crashedRecovery,
    [draft, sending, awaitingTurn, approving, crashedRecovery]
  )

  async function handleSend(): Promise<void> {
    if (!goalId || !canSend) return
    const text = draft.trim()
    setSending(true)
    setAwaitingTurn(true)
    setErrorBanner(null)
    setDraft('')
    const optimisticKey = newKey()
    setHistory((h) => [
      ...h,
      { role: 'user', text, ts: new Date().toISOString(), key: optimisticKey }
    ])
    try {
      await window.api.plan.sendMessage(goalId, text)
    } catch (err) {
      // Roll back the optimistic user bubble so chat history stays in sync
      // with what the assistant actually saw. Restore the draft so the user can
      // retry without retyping.
      setHistory((h) => h.filter((m) => m.key !== optimisticKey))
      setDraft(text)
      setSending(false)
      setAwaitingTurn(false)
      setErrorBanner(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleApprove(): Promise<void> {
    if (!goalId || !pendingPlan || approving) return
    // Safety net: warn if the plan points new files at a different workspace.
    // The worker will literally follow the plan's absolute paths and produce
    // output outside the goal's workspace, which is confusing and hard to
    // unwind. The prompt-level rule (planSession seed message) is the
    // primary defense; this is the last-line user confirmation.
    const ws = goalRef.current?.state.workspace_path ?? goal?.state.workspace_path ?? ''
    const externals = findExternalAbsolutePaths(pendingPlan, ws)
    if (externals.length > 0) {
      const list = externals.map((p) => `  • ${p}`).join('\n')
      const ok = window.confirm(
        [
          '⚠️ プラン内にワークスペース外の絶対パスが含まれています。',
          '',
          `ワークスペース: ${ws}`,
          '',
          '検出された外部パス（成果物の保存先になる可能性があります）:',
          list,
          '',
          'この plan を承認すると、worker は plan に書かれた絶対パスに沿って',
          'ワークスペース外にファイルを作成する可能性があります。',
          'プランを修正せず、このまま承認しますか？'
        ].join('\n')
      )
      if (!ok) return
    }
    setApproving(true)
    setErrorBanner(null)
    try {
      await window.api.plan.approve(goalId, pendingPlan)
      // session-ended (reason=approved) will navigate us away; as a safety
      // net we also navigate here in case the event arrives before mount.
      // Preserve ?ws= so the sidebar's active-ws highlight stays in sync.
      const ws = goalRef.current?.state.workspace_path
      navigate(
        ws ? `/goals/${goalId}?ws=${encodeURIComponent(ws)}` : `/goals/${goalId}`
      )
    } catch (err) {
      setApproving(false)
      setErrorBanner(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCancel(): Promise<void> {
    if (!goalId) return
    try {
      await window.api.plan.abort(goalId)
    } catch {
      // ignore — we navigate away regardless
    }
    navigate('/')
  }

  async function handleStartWithoutPlan(): Promise<void> {
    if (!goalId) return
    try {
      await window.api.runner.start(goalId)
      // Preserve ?ws= so the sidebar's active-ws highlight stays in sync.
      const ws = goalRef.current?.state.workspace_path
      navigate(
        ws ? `/goals/${goalId}?ws=${encodeURIComponent(ws)}` : `/goals/${goalId}`
      )
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err))
    }
  }

  if (bootLoading) {
    return (
      <div className="p-6 text-sm text-zinc-400">プランセッションを準備中…</div>
    )
  }

  if (bootError) {
    return (
      <div className="p-6">
        <div className="rounded border border-red-700 bg-red-900/30 p-3 text-sm text-red-200">
          {bootError}
        </div>
        <button
          className="mt-4 rounded border border-zinc-700 bg-bg-secondary px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-700"
          onClick={() => navigate('/')}
        >
          戻る
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-sky-400">
              対話型プランモード
            </div>
            <h1 className="text-base font-semibold text-zinc-100">
              {goal?.objective_preview ?? '(no preview)'}
            </h1>
          </div>
          <button
            onClick={handleCancel}
            className="rounded border border-zinc-700 bg-bg-secondary px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            ✗ キャンセル
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Codex と読み取り専用で対話し、プラン候補を承認すると自走を開始します。
        </p>
      </header>

      {errorBanner && (
        <div className="shrink-0 border-b border-red-800 bg-red-900/30 px-6 py-2 text-xs text-red-200">
          {errorBanner}
          <button
            className="ml-2 underline"
            onClick={() => setErrorBanner(null)}
          >
            閉じる
          </button>
        </div>
      )}

      {crashedRecovery && (
        <div className="shrink-0 border-b border-amber-700 bg-amber-900/20 px-6 py-3 text-sm text-amber-100">
          <div className="mb-2 font-semibold">⚠️ プランセッションが予期せず終了しました</div>
          <p className="mb-3 text-xs text-amber-200/80">
            プランセッションが終了しました。ゴールは「pending」状態に戻されたので、プランなしで自走を開始するか、ホームに戻ってやり直すかを選んでください。
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void handleStartWithoutPlan()}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              プランなしで開始
            </button>
            <button
              onClick={() => navigate('/')}
              className="rounded border border-zinc-700 bg-bg-secondary px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              ホームへ戻る
            </button>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto px-6 py-4">
        {history.length === 0 && !streamingText && !awaitingTurn && (
          <div className="text-xs text-zinc-500">
            まだメッセージはありません。最初の応答を待っています…
          </div>
        )}
        {history.map((m) => (
          <ChatBubble key={m.key} role={m.role} text={m.text} ts={m.ts} />
        ))}
        {streamingText !== null && (
          <ChatBubble role="assistant" text={streamingText} streaming />
        )}
        {awaitingTurn && streamingText === null && (
          <div className="text-xs text-zinc-500">処理中…</div>
        )}
      </div>

      {pendingPlan && (
        <div className="shrink-0 border-t border-sky-800/50 bg-sky-950/30 px-6 py-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold text-sky-300">
              📋 プラン候補が提案されました
            </div>
            <button
              onClick={() => void handleApprove()}
              disabled={approving}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {approving ? '承認中…' : '✅ 承認して開始'}
            </button>
          </div>
          {(() => {
            const ws = goal?.state.workspace_path ?? ''
            const externals = findExternalAbsolutePaths(pendingPlan, ws)
            if (externals.length === 0) return null
            return (
              <div className="mb-2 rounded border border-amber-600/60 bg-amber-950/30 p-2 text-xs text-amber-200">
                <div className="mb-1 font-semibold">
                  ⚠️ ワークスペース外の絶対パスが含まれています
                </div>
                <div className="mb-1 text-amber-300/80">
                  ワークスペース: <code className="text-amber-100">{ws}</code>
                </div>
                <div className="mb-1">検出された外部パス:</div>
                <ul className="ml-4 list-disc">
                  {externals.map((p) => (
                    <li key={p}>
                      <code className="text-amber-100">{p}</code>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 text-amber-300/80">
                  このまま承認すると、worker が plan の絶対パスに沿ってワークスペース外にファイルを作成する可能性があります。
                  必要なら Codex にプランを修正させてから承認してください。
                </div>
              </div>
            )
          })()}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-sky-900/50 bg-bg-secondary/60 p-2 text-xs text-zinc-200">
            {pendingPlan}
          </pre>
        </div>
      )}

      <footer className="shrink-0 border-t border-zinc-800 px-6 py-3">
        <div className="flex gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder={
              crashedRecovery
                ? 'プランセッションは終了しました'
                : '質問・指示 (⌘ + Enter で送信)'
            }
            rows={3}
            disabled={sending || awaitingTurn || approving || crashedRecovery}
            className="flex-1 resize-none rounded border border-zinc-700 bg-bg-secondary px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-accent focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="self-end rounded bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {sending ? '送信中…' : '送信'}
          </button>
        </div>
      </footer>
    </div>
  )
}
