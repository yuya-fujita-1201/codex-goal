import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import type { GoalEvent, GoalStatus, GoalSummary } from '@shared/types'
import StatusBadge from './StatusBadge'

// 'planning' は plan-mode opt-in 中のゴール。アクティブ扱いとしてサイドバーの
// 「未完了」グループに表示する（archived に落ちないように）。
const ACTIVE_STATUSES: GoalStatus[] = ['planning', 'pending', 'active', 'paused']

const COLLAPSED_KEY = 'goalSidebar.collapsed'
const ARCHIVE_OPEN_PREFIX = 'goalSidebar.archive.'
const WS_OPEN_PREFIX = 'goalSidebar.ws.'

function basename(p: string): string {
  if (!p) return '(no workspace)'
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i === -1 ? trimmed : trimmed.slice(i + 1) || trimmed
}

function displayTitle(goal: GoalSummary): string {
  if (goal.state.title && goal.state.title.trim().length > 0) return goal.state.title
  const preview = goal.objective_preview
  if (!preview) return '(無題)'
  const firstNonEmpty = preview
    .split('\n')
    .map((s) => s.replace(/^#+\s*/, '').trim())
    .find((s) => s.length > 0)
  return (firstNonEmpty ?? preview).slice(0, 80)
}

function matchesQuery(goal: GoalSummary, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (displayTitle(goal).toLowerCase().includes(needle)) return true
  if (goal.goal_id.toLowerCase().includes(needle)) return true
  if (goal.state.workspace_path.toLowerCase().includes(needle)) return true
  if (goal.objective_preview.toLowerCase().includes(needle)) return true
  return false
}

interface WorkspaceGroup {
  workspace: string
  active: GoalSummary[]
  archived: GoalSummary[]
  latestUpdate: number
}

function groupByWorkspace(goals: GoalSummary[]): WorkspaceGroup[] {
  const map = new Map<string, WorkspaceGroup>()
  for (const g of goals) {
    const ws = g.state.workspace_path || ''
    let group = map.get(ws)
    if (!group) {
      group = { workspace: ws, active: [], archived: [], latestUpdate: 0 }
      map.set(ws, group)
    }
    if (ACTIVE_STATUSES.includes(g.state.status)) {
      group.active.push(g)
    } else {
      group.archived.push(g)
    }
    const t = new Date(g.state.updated_at).getTime()
    if (Number.isFinite(t) && t > group.latestUpdate) group.latestUpdate = t
  }
  for (const group of map.values()) {
    const byUpdated = (a: GoalSummary, b: GoalSummary): number =>
      new Date(b.state.updated_at).getTime() - new Date(a.state.updated_at).getTime()
    group.active.sort(byUpdated)
    group.archived.sort(byUpdated)
  }
  return Array.from(map.values()).sort((a, b) => b.latestUpdate - a.latestUpdate)
}

function readBoolMap(prefix: string): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) {
        out[k.slice(prefix.length)] = localStorage.getItem(k) === '1'
      }
    }
  } catch {
    // ignore
  }
  return out
}

export default function Sidebar(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { goalId: routeGoalId } = useParams()
  const activeWorkspace = searchParams.get('ws') ?? ''

  const [goals, setGoals] = useState<GoalSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [archiveOpen, setArchiveOpen] = useState<Record<string, boolean>>(() =>
    readBoolMap(ARCHIVE_OPEN_PREFIX)
  )
  // Workspace groups default to OPEN (unset key -> true). Only stored when the
  // user collapses one explicitly.
  const [wsClosed, setWsClosed] = useState<Record<string, boolean>>(() =>
    readBoolMap(WS_OPEN_PREFIX)
  )

  const refresh = useCallback(async () => {
    const list = await window.api.goal.list(null)
    setGoals(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
  }, [location.pathname, refresh])

  useEffect(() => {
    const off = window.api.runner.onEvent((event: GoalEvent) => {
      if (event.type !== 'state') return
      setGoals((prev) => {
        const idx = prev.findIndex((g) => g.goal_id === event.goalId)
        if (idx === -1) {
          void refresh()
          return prev
        }
        const next = [...prev]
        next[idx] = { ...next[idx], state: event.state }
        return next
      })
    })
    return off
  }, [refresh])

  const filteredGoals = useMemo(() => {
    const q = query.trim()
    if (!q) return goals
    return goals.filter((g) => matchesQuery(g, q))
  }, [goals, query])
  const groups = useMemo(() => groupByWorkspace(filteredGoals), [filteredGoals])
  const totalActive = useMemo(
    () => goals.filter((g) => ACTIVE_STATUSES.includes(g.state.status)).length,
    [goals]
  )
  const isSearching = query.trim().length > 0

  function toggleCollapsed(): void {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }

  function toggleArchive(workspace: string): void {
    setArchiveOpen((prev) => {
      const cur = !!prev[workspace]
      const next = { ...prev, [workspace]: !cur }
      try {
        localStorage.setItem(ARCHIVE_OPEN_PREFIX + workspace, !cur ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }

  function toggleWorkspace(workspace: string): void {
    setWsClosed((prev) => {
      const cur = !!prev[workspace]
      const next = { ...prev, [workspace]: !cur }
      try {
        localStorage.setItem(WS_OPEN_PREFIX + workspace, !cur ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }

  function openGoal(goal: GoalSummary): void {
    const ws = goal.state.workspace_path
    // planning 中のゴールは PlanReview ページへ遷移する。GoalDetail にもリダイレクト
    // ガードがあるが、サイドバーから直接正しい URL を選ぶことで余分なナビゲーションを
    // 避ける。
    if (goal.state.status === 'planning') {
      navigate(`/plan/${goal.goal_id}?ws=${encodeURIComponent(ws)}`)
      return
    }
    navigate(`/goals/${goal.goal_id}?ws=${encodeURIComponent(ws)}`)
  }

  function startNewGoalForWorkspace(ws: string): void {
    navigate(`/goals/new?ws=${encodeURIComponent(ws)}`)
  }

  // 「+ 新規ゴール」ボタン: 常にフォルダピッカーを開いて新しいワークスペースで
  // 新規ゴールを開始する。既存ワークスペースで新しいゴールを作るには、サイドバー
  // 内のワークスペース行をクリックする運用。
  async function pickAndStartNewGoal(): Promise<void> {
    const chosen = await window.api.workspace.select()
    if (chosen) navigate(`/goals/new?ws=${encodeURIComponent(chosen)}`)
  }

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-zinc-800 bg-bg-secondary py-3">
        <button
          onClick={toggleCollapsed}
          className="titlebar-no-drag mb-3 rounded p-1 text-zinc-400 hover:bg-bg-tertiary hover:text-zinc-200"
          title="サイドバーを開く"
          aria-label="サイドバーを開く"
        >
          ▶
        </button>
        <button
          onClick={pickAndStartNewGoal}
          className="titlebar-no-drag mb-3 rounded bg-accent px-1.5 py-1 text-sm font-bold text-white hover:bg-accent-hover"
          title="新規ゴール"
          aria-label="新規ゴール"
        >
          +
        </button>
        <div
          className="rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-50"
          title={`未完了 ${totalActive} 件`}
        >
          {totalActive}
        </div>
        <div className="flex-1" />
        <button
          onClick={() => navigate('/settings')}
          className="titlebar-no-drag rounded p-1 text-zinc-400 hover:bg-bg-tertiary hover:text-zinc-200"
          title="設定"
          aria-label="設定"
        >
          ⚙
        </button>
      </aside>
    )
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-bg-secondary">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <button
          onClick={() => navigate('/')}
          className="titlebar-no-drag flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-100 hover:text-white"
          title="ホーム"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-accent" />
          Codex Goal
        </button>
        <button
          onClick={toggleCollapsed}
          className="titlebar-no-drag rounded p-1 text-zinc-400 hover:bg-bg-tertiary hover:text-zinc-200"
          title="サイドバーを閉じる"
          aria-label="サイドバーを閉じる"
        >
          ◀
        </button>
      </div>

      <div className="border-b border-zinc-800 px-3 py-2">
        <button
          onClick={pickAndStartNewGoal}
          className="titlebar-no-drag flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition hover:bg-accent-hover"
        >
          <span className="text-base leading-none">＋</span>
          <span>新規ゴール</span>
        </button>
        <div className="relative mt-2">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500">
            🔍
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="タスクを検索"
            className="titlebar-no-drag w-full rounded-md border border-zinc-800 bg-bg-tertiary py-1.5 pl-7 pr-7 text-xs text-zinc-100 outline-none focus:border-accent"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="titlebar-no-drag absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:bg-bg-secondary hover:text-zinc-200"
              title="クリア"
              aria-label="検索をクリア"
            >
              ×
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
          <span>タスク</span>
          <span>
            未完了
            <span className="ml-1 rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-50">
              {totalActive}
            </span>
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-4 text-xs text-zinc-500">読み込み中...</div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-4 text-xs text-zinc-500">
            {isSearching
              ? `「${query}」に一致するタスクはありません`
              : 'まだタスクがありません。「新規ゴール」から作成すると、ここに一覧表示されます。'}
          </div>
        ) : (
          groups.map((group) => {
            const isActiveWs = group.workspace === activeWorkspace
            // While searching, force-open both the workspace group and the
            // archive section so all matches are visible without extra clicks.
            const isArchiveOpen = isSearching || !!archiveOpen[group.workspace]
            const isWsOpen = isSearching || !wsClosed[group.workspace]
            return (
              <div key={group.workspace} className="border-b border-zinc-800/60">
                <div
                  className={`group flex items-center ${
                    isActiveWs ? 'bg-bg-tertiary' : ''
                  }`}
                >
                  <button
                    onClick={() => toggleWorkspace(group.workspace)}
                    className="titlebar-no-drag px-2 py-2 text-zinc-500 hover:text-zinc-200"
                    title={isWsOpen ? '折りたたむ' : '展開する'}
                    aria-expanded={isWsOpen}
                  >
                    {isWsOpen ? '▾' : '▸'}
                  </button>
                  <button
                    onClick={() => startNewGoalForWorkspace(group.workspace)}
                    className="titlebar-no-drag min-w-0 flex-1 py-2 pr-2 text-left transition hover:bg-bg-tertiary"
                    title={`${group.workspace}\n（クリック: このワークスペースで新規ゴール）`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate text-xs font-medium text-zinc-200">
                        {basename(group.workspace)}
                      </div>
                      <div className="shrink-0 text-[10px] text-zinc-500">
                        {group.active.length}/{group.active.length + group.archived.length}
                      </div>
                    </div>
                    <div className="truncate font-mono text-[10px] text-zinc-500">
                      {group.workspace || '(no workspace)'}
                    </div>
                  </button>
                </div>

                {isWsOpen && (
                  <>
                    {group.active.length === 0 ? (
                      <div className="px-3 pb-2 pl-7 text-[10px] text-zinc-600">
                        未完了タスクなし
                      </div>
                    ) : (
                      <ul className="pb-1">
                        {group.active.map((goal) => (
                          <GoalRow
                            key={goal.goal_id}
                            goal={goal}
                            selected={routeGoalId === goal.goal_id}
                            onClick={() => openGoal(goal)}
                          />
                        ))}
                      </ul>
                    )}

                    {group.archived.length > 0 && (
                      <div className="pb-1">
                        <button
                          onClick={() => toggleArchive(group.workspace)}
                          className="titlebar-no-drag flex w-full items-center justify-between pl-7 pr-3 py-1 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                          aria-expanded={isArchiveOpen}
                        >
                          <span>
                            {isArchiveOpen ? '▼' : '▶'} 履歴 ({group.archived.length})
                          </span>
                        </button>
                        {isArchiveOpen && (
                          <ul>
                            {group.archived.map((goal) => (
                              <GoalRow
                                key={goal.goal_id}
                                goal={goal}
                                selected={routeGoalId === goal.goal_id}
                                onClick={() => openGoal(goal)}
                                dim
                              />
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="border-t border-zinc-800 px-3 py-2">
        <button
          onClick={() => navigate('/settings')}
          className={`titlebar-no-drag flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-bg-tertiary hover:text-zinc-200 ${
            location.pathname === '/settings' ? 'bg-bg-tertiary text-zinc-100' : ''
          }`}
        >
          <span>⚙</span>
          <span>設定</span>
        </button>
      </div>
    </aside>
  )
}

function GoalRow({
  goal,
  selected,
  onClick,
  dim
}: {
  goal: GoalSummary
  selected: boolean
  onClick: () => void
  dim?: boolean
}): JSX.Element {
  return (
    <li>
      <button
        onClick={onClick}
        className={`titlebar-no-drag block w-full pl-7 pr-3 py-1.5 text-left transition hover:bg-bg-tertiary ${
          selected ? 'bg-bg-tertiary ring-1 ring-inset ring-amber-600/40' : ''
        } ${dim ? 'opacity-70' : ''}`}
        title={displayTitle(goal)}
      >
        <div className="flex items-center gap-1.5">
          <StatusBadge status={goal.state.status} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300">
            {displayTitle(goal)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[10px] text-zinc-500">
          <span className="truncate">turn {goal.state.turns}</span>
          <span className="ml-2 shrink-0">
            {new Date(goal.state.updated_at).toLocaleString('ja-JP', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit'
            })}
          </span>
        </div>
      </button>
    </li>
  )
}
