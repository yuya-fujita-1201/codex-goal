// Global app settings — persisted at ~/.codex-goals/.settings.json.
// Currently stores default budget values pre-filled into the new-goal form.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { SUPPORTED_MODELS } from '@shared/types'
import type { GlobalSettings, GoalBudget } from '@shared/types'
import { GOALS_ROOT, ensureGoalsRoot } from './goalStore'

export const DEFAULT_BUDGET: GoalBudget = {
  max_turns: 300,
  max_wall_time_seconds: 24 * 3600,
  per_turn_timeout_seconds: 1800,
  heartbeat_threshold_seconds: 120,
  rate_limit_sleep_seconds: 5
}

export const DEFAULT_MODEL = 'gpt-5.5'

const SUPPORTED_MODEL_IDS = new Set<string>(SUPPORTED_MODELS.map((m) => m.id))

const DEFAULT_SETTINGS: GlobalSettings = {
  default_budget: { ...DEFAULT_BUDGET },
  default_model: DEFAULT_MODEL
}

function settingsPath(): string {
  return path.join(GOALS_ROOT, '.settings.json')
}

function validateBudget(b: unknown): GoalBudget {
  const fallback = { ...DEFAULT_BUDGET }
  if (!b || typeof b !== 'object') return fallback
  const obj = b as Record<string, unknown>
  const out: GoalBudget = { ...fallback }
  for (const k of Object.keys(fallback) as Array<keyof GoalBudget>) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[k] = Math.floor(v)
    }
  }
  return out
}

function validateModel(m: unknown): string {
  if (typeof m === 'string' && SUPPORTED_MODEL_IDS.has(m)) return m
  return DEFAULT_MODEL
}

/**
 * PR-D: critic_model is *optional* — the runner falls back to default_model
 * when this is undefined. We accept a literal `''` (empty string) from the
 * UI as "explicit unset" and convert it to undefined so JSON serialization
 * stays clean. Unknown model ids are silently dropped (returning undefined)
 * so a typo doesn't break the worker — they just get default_model.
 */
function validateCriticModel(m: unknown): string | undefined {
  if (typeof m !== 'string' || m === '') return undefined
  if (SUPPORTED_MODEL_IDS.has(m)) return m
  return undefined
}

export async function getSettings(): Promise<GlobalSettings> {
  await ensureGoalsRoot()
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>
    return {
      default_budget: validateBudget(parsed?.default_budget),
      default_model: validateModel(parsed?.default_model),
      critic_model: validateCriticModel(parsed?.critic_model)
    }
  } catch {
    return { ...DEFAULT_SETTINGS, default_budget: { ...DEFAULT_BUDGET } }
  }
}

export async function updateSettings(next: GlobalSettings): Promise<GlobalSettings> {
  await ensureGoalsRoot()
  const validated: GlobalSettings = {
    default_budget: validateBudget(next?.default_budget),
    default_model: validateModel(next?.default_model),
    critic_model: validateCriticModel(next?.critic_model)
  }
  const file = settingsPath()
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
  return validated
}
