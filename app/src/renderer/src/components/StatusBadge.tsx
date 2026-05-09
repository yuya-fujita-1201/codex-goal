import type { GoalStatus } from '@shared/types'

const styles: Record<GoalStatus, { bg: string; fg: string; label: string }> = {
  pending: { bg: 'bg-zinc-700', fg: 'text-zinc-200', label: '未開始' },
  planning: { bg: 'bg-purple-700', fg: 'text-purple-50', label: '計画中' },
  active: { bg: 'bg-emerald-700', fg: 'text-emerald-50', label: '実行中' },
  paused: { bg: 'bg-amber-700', fg: 'text-amber-50', label: '一時停止' },
  achieved: { bg: 'bg-blue-700', fg: 'text-blue-50', label: '達成' },
  blocked: { bg: 'bg-red-800', fg: 'text-red-50', label: 'ブロック' },
  budget_exhausted: { bg: 'bg-red-800', fg: 'text-red-50', label: '上限到達' },
  abandoned: { bg: 'bg-zinc-700', fg: 'text-zinc-300', label: '中止' }
}

export default function StatusBadge({ status }: { status: GoalStatus }): JSX.Element {
  const s = styles[status]
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${s.bg} ${s.fg}`}
    >
      {s.label}
    </span>
  )
}
