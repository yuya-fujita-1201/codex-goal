import { FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  CRITIC_MODEL_OPTIONS,
  SUPPORTED_MODELS,
  type GlobalSettings,
  type GoalBudget
} from '@shared/types'

const FALLBACK_BUDGET: GoalBudget = {
  max_turns: 300,
  max_wall_time_seconds: 24 * 3600,
  per_turn_timeout_seconds: 1800,
  heartbeat_threshold_seconds: 120,
  rate_limit_sleep_seconds: 5
}

const FALLBACK_MODEL: string = SUPPORTED_MODELS[0].id

export default function Settings(): JSX.Element {
  const navigate = useNavigate()
  const [maxTurns, setMaxTurns] = useState(FALLBACK_BUDGET.max_turns)
  const [perTurnTimeoutSec, setPerTurnTimeoutSec] = useState(
    FALLBACK_BUDGET.per_turn_timeout_seconds
  )
  const [maxWallTimeMin, setMaxWallTimeMin] = useState(
    Math.round(FALLBACK_BUDGET.max_wall_time_seconds / 60)
  )
  const [heartbeatSec, setHeartbeatSec] = useState(FALLBACK_BUDGET.heartbeat_threshold_seconds)
  const [rateLimitSec, setRateLimitSec] = useState(FALLBACK_BUDGET.rate_limit_sleep_seconds)
  const [defaultModel, setDefaultModel] = useState<string>(FALLBACK_MODEL)
  // PR-D: critic_model is *optional* — empty string ('') means "use the
  // default model for critic too". Storing as string keeps the <select>
  // controlled trivially; we convert '' to undefined on save.
  const [criticModel, setCriticModel] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const s = await window.api.settings.get()
        const b = s.default_budget
        setMaxTurns(b.max_turns)
        setPerTurnTimeoutSec(b.per_turn_timeout_seconds)
        setMaxWallTimeMin(Math.round(b.max_wall_time_seconds / 60))
        setHeartbeatSec(b.heartbeat_threshold_seconds)
        setRateLimitSec(b.rate_limit_sleep_seconds)
        setDefaultModel(s.default_model || FALLBACK_MODEL)
        setCriticModel(s.critic_model ?? '')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function onSave(e: FormEvent): Promise<void> {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const next: GlobalSettings = {
        default_budget: {
          max_turns: maxTurns,
          per_turn_timeout_seconds: perTurnTimeoutSec,
          max_wall_time_seconds: maxWallTimeMin * 60,
          heartbeat_threshold_seconds: heartbeatSec,
          rate_limit_sleep_seconds: rateLimitSec
        },
        default_model: defaultModel,
        critic_model: criticModel || undefined
      }
      await window.api.settings.update(next)
      setSavedAt(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-8 pt-10 text-sm text-zinc-500">読み込み中...</div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-8 pb-16 pt-10">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">設定</h1>
      <p className="mb-8 text-sm text-zinc-400">
        新規ゴール作成時にデフォルト値として適用されます。個別ゴールでは「詳細設定」から上書き
        できます。
      </p>

      <form onSubmit={onSave} className="space-y-6">
        <fieldset className="rounded-md border border-zinc-800 bg-bg-secondary p-5">
          <legend className="px-2 text-sm font-medium text-zinc-200">使用モデル</legend>
          <p className="mb-4 mt-1 px-2 text-xs text-zinc-500">
            ターン実行および対話型プランセッションで <code className="mx-1 rounded bg-bg-tertiary px-1.5 py-0.5">codex --model</code>{' '}
            に渡されるモデル ID。長期・複雑なゴールでは GPT-5.5 を推奨します。
          </p>
          <Field
            label="メインモデル"
            hint="新規ゴール作成時のデフォルト。既存ゴールには影響しません。"
          >
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
            >
              {SUPPORTED_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Critic / Judge モデル（任意）"
            hint="達成主張の検証と 10 ターン毎のブロック境界レビューに使うモデル。「メインと同じ」を選ぶとメインモデルがそのままジャッジ役を兼ねます。GPT 系を選ぶと codex CLI、Claude 系を選ぶと claude CLI で読み取り専用 judge を起動します（Claude 系は要 claude バイナリ）。別系統モデルを選ぶほど共通盲点が減らせます。"
          >
            <select
              value={criticModel}
              onChange={(e) => setCriticModel(e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
            >
              <option value="">（メインと同じ）</option>
              <optgroup label="GPT / Codex を明示指定">
                {SUPPORTED_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="別系統モデル">
                {CRITIC_MODEL_OPTIONS.filter(
                  (m) => !SUPPORTED_MODELS.some((s) => s.id === m.id)
                ).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        </fieldset>

        <fieldset className="rounded-md border border-zinc-800 bg-bg-secondary p-5">
          <legend className="px-2 text-sm font-medium text-zinc-200">
            Budget デフォルト
          </legend>
          <p className="mb-4 mt-1 px-2 text-xs text-zinc-500">
            ゴールの暴走と請求事故を防ぐ安全ブレーキ。下記いずれかに到達すると、自走を停止して
            <code className="mx-1 rounded bg-bg-tertiary px-1.5 py-0.5">budget_exhausted</code>
            状態に遷移します。
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="最大ターン数"
              hint="1ゴールでCodexを呼べる最大回数（推奨: 300）"
            >
              <input
                type="number"
                min={1}
                max={5000}
                value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value))}
                className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
              />
            </Field>
            <Field
              label="ターンTO（秒）"
              hint="1ターンが終わらない場合に強制停止する時間（推奨: 1800 = 30分）"
            >
              <input
                type="number"
                min={30}
                value={perTurnTimeoutSec}
                onChange={(e) => setPerTurnTimeoutSec(Number(e.target.value))}
                className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
              />
            </Field>
            <Field
              label="総時間TO（分）"
              hint="ゴール作成からの累計実行時間の上限（推奨: 1440 = 24時間）"
            >
              <input
                type="number"
                min={1}
                value={maxWallTimeMin}
                onChange={(e) => setMaxWallTimeMin(Number(e.target.value))}
                className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
              />
            </Field>
            <Field
              label="ハートビート閾値（秒）"
              hint="ターンの出力がこの秒数沈黙したらハングと判断（推奨: 120）"
            >
              <input
                type="number"
                min={10}
                value={heartbeatSec}
                onChange={(e) => setHeartbeatSec(Number(e.target.value))}
                className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
              />
            </Field>
            <Field
              label="レート制限スリープ（秒）"
              hint="Codexのレート制限検出時に挟む待機（推奨: 5）"
            >
              <input
                type="number"
                min={1}
                value={rateLimitSec}
                onChange={(e) => setRateLimitSec(Number(e.target.value))}
                className="w-full rounded-md border border-zinc-800 bg-bg-tertiary px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent"
              />
            </Field>
          </div>
        </fieldset>

        {error && (
          <div className="rounded-md border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="text-xs text-zinc-500">
            {savedAt
              ? `保存しました: ${savedAt.toLocaleTimeString('ja-JP')}`
              : '変更後、保存ボタンを押してください'}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-bg-tertiary"
            >
              戻る
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  )
}
