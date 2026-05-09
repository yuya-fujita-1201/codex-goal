import { FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import type { CreateGoalParams, GoalBudget, RecentWorkspace } from '@shared/types'
import {
  SAMPLE_CHECKER_TEMPLATE,
  isDefaultSampleCheckerTemplate
} from '@shared/checkerTemplate'

const FALLBACK_BUDGET: GoalBudget = {
  max_turns: 300,
  max_wall_time_seconds: 24 * 3600,
  per_turn_timeout_seconds: 1800,
  heartbeat_threshold_seconds: 120,
  rate_limit_sleep_seconds: 5
}

function basename(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i === -1 ? trimmed : trimmed.slice(i + 1) || trimmed
}

export default function NewGoal(): JSX.Element {
  const navigate = useNavigate()
  const [params, setSearchParams] = useSearchParams()
  const wsParam = params.get('ws')

  const [recents, setRecents] = useState<RecentWorkspace[] | null>(null)
  const [wsMenuOpen, setWsMenuOpen] = useState(false)
  const wsMenuRef = useRef<HTMLDivElement | null>(null)

  const [objective, setObjective] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [maxTurns, setMaxTurns] = useState(FALLBACK_BUDGET.max_turns)
  const [perTurnTimeoutSec, setPerTurnTimeoutSec] = useState(
    FALLBACK_BUDGET.per_turn_timeout_seconds
  )
  const [maxWallTimeMin, setMaxWallTimeMin] = useState(
    Math.round(FALLBACK_BUDGET.max_wall_time_seconds / 60)
  )
  const [budgetDefaults, setBudgetDefaults] = useState<GoalBudget>(FALLBACK_BUDGET)
  const [checkerEnabled, setCheckerEnabled] = useState(false)
  const [checkerScript, setCheckerScript] = useState(SAMPLE_CHECKER_TEMPLATE)
  // When true, the runner refuses 'achieved' unless checker.sh passes.
  // This is intentionally opt-in because many goals are docs/research tasks
  // whose completion cannot be measured by the bundled code-build sample.
  const [checkerRequired, setCheckerRequired] = useState(false)
  const [detailedPlanning, setDetailedPlanning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load recents once. If no ?ws= in URL, redirect (replace) to the most-recent
  // workspace so the home screen always lands on a usable new-goal form.
  useEffect(() => {
    void (async () => {
      const list = await window.api.workspace.recentList()
      setRecents(list)
      if (!wsParam && list.length > 0) {
        setSearchParams({ ws: list[0].path }, { replace: true })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pull global budget defaults; user can still override per-goal in 詳細.
  useEffect(() => {
    void (async () => {
      try {
        const settings = await window.api.settings.get()
        const b = settings.default_budget
        setBudgetDefaults(b)
        setMaxTurns(b.max_turns)
        setPerTurnTimeoutSec(b.per_turn_timeout_seconds)
        setMaxWallTimeMin(Math.round(b.max_wall_time_seconds / 60))
      } catch {
        // fall back to hard-coded defaults
      }
    })()
  }, [])

  // Close the workspace dropdown when clicking outside it.
  useEffect(() => {
    if (!wsMenuOpen) return
    function onDoc(e: MouseEvent): void {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [wsMenuOpen])

  async function pickFolder(): Promise<void> {
    setWsMenuOpen(false)
    const chosen = await window.api.workspace.select()
    if (chosen) {
      setSearchParams({ ws: chosen }, { replace: true })
      const updated = await window.api.workspace.recentList()
      setRecents(updated)
    }
  }

  async function chooseRecent(path: string): Promise<void> {
    setWsMenuOpen(false)
    await window.api.workspace.recentAdd(path)
    setSearchParams({ ws: path }, { replace: true })
    const updated = await window.api.workspace.recentList()
    setRecents(updated)
  }

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!wsParam) {
      setError('ワークスペースが選択されていません')
      return
    }
    if (objective.trim().length === 0) {
      setError('ゴールを入力してください')
      return
    }
    if (checkerEnabled && checkerScript.trim().length === 0) {
      setError(
        'checker.sh が有効ですが、スクリプトが空です。スクリプトを書くか、checker を OFF にしてください'
      )
      return
    }
    if (checkerEnabled && isDefaultSampleCheckerTemplate(checkerScript)) {
      setError(
        'checker.sh がサンプルのままです。このゴール専用の達成条件に書き換えるか、checker を OFF にしてください'
      )
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const payload: CreateGoalParams = {
        goal_id_slug: objective.slice(0, 40),
        workspace_path: wsParam,
        objective: objective.trim() + '\n',
        budget: {
          ...budgetDefaults,
          max_turns: maxTurns,
          per_turn_timeout_seconds: perTurnTimeoutSec,
          max_wall_time_seconds: maxWallTimeMin * 60
        },
        checker_script: checkerEnabled ? checkerScript : null,
        // PR-D: only require the checker if the user actually provided one.
        // checkerEnabled=false implies checker_required=false (any other
        // combination would be unsatisfiable).
        checker_required: checkerEnabled && checkerRequired,
        initial_status: detailedPlanning ? 'planning' : undefined
      }
      const created = await window.api.goal.create(payload)
      const wsQuery = `?ws=${encodeURIComponent(wsParam)}`
      if (detailedPlanning) {
        navigate(`/plan/${created.goal_id}${wsQuery}`)
      } else {
        navigate(`/goals/${created.goal_id}${wsQuery}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  // First render before recents load — just show nothing to avoid flicker.
  if (recents === null) {
    return <div className="px-8 pt-10 text-sm text-zinc-500">読み込み中...</div>
  }

  // Empty state: no URL param, no recent workspaces. Single CTA to pick a
  // folder and start.
  if (!wsParam && recents.length === 0) {
    return (
      <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center px-8 text-center">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight text-zinc-100">
          ようこそ
        </h1>
        <p className="mb-8 text-sm text-zinc-400">
          ワークスペース（作業フォルダ）を選んで、最初のゴールを作りましょう。
        </p>
        <button
          onClick={pickFolder}
          className="rounded-md bg-accent px-6 py-3 text-sm font-medium text-white transition hover:bg-accent-hover"
        >
          📁 ワークスペースを選んで開始
        </button>
      </div>
    )
  }

  // Transient: have recents but URL not yet rewritten — render nothing to avoid flicker.
  if (!wsParam) return <div />

  return (
    <div className="mx-auto max-w-3xl px-8 pb-16 pt-10">
      <div className="mb-1 text-xs uppercase tracking-wider text-zinc-500">workspace</div>
      <div className="mb-6 flex items-center gap-2">
        <div ref={wsMenuRef} className="relative min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setWsMenuOpen((v) => !v)}
            className="group flex w-full items-center justify-between gap-2 rounded-md border border-zinc-800 bg-bg-secondary px-3 py-2 text-left transition hover:border-zinc-700"
            title={wsParam}
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-zinc-200">
                {basename(wsParam)}
              </div>
              <div className="truncate font-mono text-[11px] text-zinc-500">
                {wsParam}
              </div>
            </div>
            <span className="shrink-0 text-zinc-500 group-hover:text-zinc-300">▾</span>
          </button>

          {wsMenuOpen && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-zinc-800 bg-bg-secondary shadow-xl">
              <button
                type="button"
                onClick={pickFolder}
                className="flex w-full items-center gap-2 border-b border-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-bg-tertiary"
              >
                📁 別のフォルダを選ぶ...
              </button>
              {recents.length > 0 && (
                <div className="max-h-72 overflow-y-auto">
                  <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-zinc-500">
                    最近使ったワークスペース
                  </div>
                  {recents.map((r) => (
                    <button
                      key={r.path}
                      type="button"
                      onClick={() => chooseRecent(r.path)}
                      className={`block w-full px-3 py-2 text-left hover:bg-bg-tertiary ${
                        r.path === wsParam ? 'bg-bg-tertiary' : ''
                      }`}
                      title={r.path}
                    >
                      <div className="truncate text-sm text-zinc-200">{basename(r.path)}</div>
                      <div className="truncate font-mono text-[10px] text-zinc-500">
                        {r.path}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <h1 className="mb-2 text-2xl font-semibold tracking-tight">新規ゴール</h1>
      <p className="mb-6 text-sm text-zinc-400">
        達成したいゴールを自然言語で書いてください。エージェントが自走してこのゴールを目指します。
      </p>

      <form onSubmit={onSubmit} className="space-y-5">
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={10}
          autoFocus
          placeholder={
            '例: 認証フローをリファクタしてテスト全部緑にする。\n' +
            '具体的には ...'
          }
          className="w-full rounded-md border border-zinc-800 bg-bg-secondary px-4 py-3 font-mono text-sm text-zinc-100 outline-none transition focus:border-accent"
        />

        <label className="flex items-start gap-3 rounded-md border border-zinc-800 bg-bg-secondary px-4 py-3 text-sm text-zinc-200 transition hover:border-zinc-700 cursor-pointer">
          <input
            type="checkbox"
            checked={detailedPlanning}
            onChange={(e) => setDetailedPlanning(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-700 bg-bg-tertiary"
          />
          <span className="flex-1">
            <span className="block font-medium">詳細プランニング</span>
            <span className="block text-xs text-zinc-500">
              自走を開始する前に Codex と対話してプランを練り上げ、承認してから着手します。
              プラン作成中は読み取り専用で実行されます。
            </span>
          </span>
        </label>

        <div className="rounded-md border border-zinc-800 bg-bg-secondary">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-zinc-300 hover:bg-bg-tertiary"
            aria-expanded={advancedOpen}
          >
            <span className="font-medium">
              詳細設定（このゴールだけのBudget上書き / Hard checker）
            </span>
            <span className="text-zinc-500">{advancedOpen ? '▼' : '▶'}</span>
          </button>

          {advancedOpen && (
            <div className="space-y-5 border-t border-zinc-800 px-4 py-4">
              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Budget（このゴールのみ）
                </div>
                <p className="mb-3 text-xs text-zinc-500">
                  デフォルトはアプリ設定の値。ここで変更すると、このゴールだけ上書きされます。
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="最大ターン数">
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={maxTurns}
                      onChange={(e) => setMaxTurns(Number(e.target.value))}
                      className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
                    />
                  </Field>
                  <Field label="ターンTO（秒）">
                    <input
                      type="number"
                      min={30}
                      value={perTurnTimeoutSec}
                      onChange={(e) => setPerTurnTimeoutSec(Number(e.target.value))}
                      className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
                    />
                  </Field>
                  <Field label="総時間TO（分）">
                    <input
                      type="number"
                      min={1}
                      value={maxWallTimeMin}
                      onChange={(e) => setMaxWallTimeMin(Number(e.target.value))}
                      className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
                    />
                  </Field>
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Hard checker（任意）
                </div>
                <p className="mb-3 text-xs text-zinc-500">
                  毎ターン後にこのスクリプトをワークスペースで実行し、exit 0 を返したら
                  「達成」状態へ自動遷移します。ビルド、テスト、生成物の存在確認など、
                  このゴール専用の機械判定が書ける場合だけ設定してください。
                </p>
                <label className="mb-2 flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={checkerEnabled}
                    onChange={(e) => setCheckerEnabled(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-700 bg-bg-tertiary"
                  />
                  checker.sh を設定する
                </label>
                {checkerEnabled && (
                  <>
                    <textarea
                      value={checkerScript}
                      onChange={(e) => setCheckerScript(e.target.value)}
                      rows={12}
                      className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-accent"
                      spellCheck={false}
                    />
                    <label className="mt-3 flex items-center gap-2 text-sm text-zinc-300">
                      <input
                        type="checkbox"
                        checked={checkerRequired}
                        onChange={(e) => setCheckerRequired(e.target.checked)}
                        className="h-4 w-4 rounded border-zinc-700 bg-bg-tertiary"
                      />
                      checker.sh の合格を必須にする
                    </label>
                    <p className="mt-1 text-xs text-zinc-500">
                      ON の場合、worker が <code>&lt;goal-status&gt;achieved&lt;/goal-status&gt;</code>{' '}
                      を出しても、このスクリプトが exit 0 を返さない限り達成扱いになりません。
                      OFF の場合は judge worker による独立判定（旧来の動作）でも達成可能。
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {submitting ? '作成中...' : 'ゴールを作成'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-400">{label}</span>
      {children}
    </label>
  )
}
