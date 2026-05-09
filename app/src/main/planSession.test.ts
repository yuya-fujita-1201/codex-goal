import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/codex-goal-test'
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { __test, onPlanEvent } from './planSession'
import type { PlanEvent } from '@shared/types'

const {
  buildSeedMessage,
  buildFollowupMessage,
  extractPlan,
  handleStdoutChunk,
  handleCodexEvent
} = __test

interface MockSession {
  goalId: string
  workspacePath: string
  threadId: string | null
  history: { role: 'user' | 'assistant'; text: string; ts: string }[]
  pendingPlan: string | null
  stdoutBuffer: string
  currentAssistantText: string
  awaitingResult: boolean
  currentProc: unknown
  exitReason: 'approved' | 'aborted' | null
}

function makeSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    goalId: 'g1',
    workspacePath: '/tmp/ws',
    threadId: null,
    history: [],
    pendingPlan: null,
    stdoutBuffer: '',
    currentAssistantText: '',
    awaitingResult: true,
    currentProc: null,
    exitReason: null,
    ...overrides
  }
}

function captureEvents(): { events: PlanEvent[]; dispose: () => void } {
  const events: PlanEvent[] = []
  const dispose = onPlanEvent((e) => {
    events.push(e)
  })
  return { events, dispose }
}

describe('buildSeedMessage', () => {
  it('正常系: ゴール本文を <goal> タグで包む', () => {
    const msg = buildSeedMessage('Build a calculator app')
    expect(msg).toContain('<goal>\nBuild a calculator app\n</goal>')
  })

  it('正常系: 読み取り専用の計画フェーズであることを明記する', () => {
    const msg = buildSeedMessage('x')
    expect(msg).toContain('planning only')
    expect(msg).toContain('Do not edit')
    expect(msg).toContain('<plan>')
  })
})

describe('buildFollowupMessage', () => {
  it('正常系: ユーザー文と plan タグ指示を含む', () => {
    const msg = buildFollowupMessage('もっと小さくして')
    expect(msg).toContain('もっと小さくして')
    expect(msg).toContain('<plan>...</plan>')
  })
})

describe('extractPlan', () => {
  it('正常系: 最後の <plan> ブロックを抽出する', () => {
    const text = '<plan>old</plan>\ntext\n<plan>\n## New\n- step\n</plan>'
    expect(extractPlan(text)).toBe('## New\n- step')
  })

  it('境界系: plan タグがなければ null', () => {
    expect(extractPlan('no plan')).toBeNull()
  })
})

describe('handleStdoutChunk', () => {
  let sess: MockSession
  let cap: ReturnType<typeof captureEvents>

  beforeEach(() => {
    sess = makeSession()
    cap = captureEvents()
  })

  it('正常系: 分割された JSONL を復元して処理する', () => {
    const full = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'split-text' }
    })
    handleStdoutChunk(sess as never, full.slice(0, 20))
    expect(sess.currentAssistantText).toBe('')
    handleStdoutChunk(sess as never, full.slice(20) + '\n')
    expect(sess.currentAssistantText).toBe('split-text')
    expect(cap.events.some((e) => e.type === 'assistant-text')).toBe(true)
    cap.dispose()
  })

  it('異常系: 不正JSON行は捨てて後続行を処理する', () => {
    const good = JSON.stringify({ type: 'thread.started', thread_id: 'tid-1' })
    handleStdoutChunk(sess as never, 'not-json\n' + good + '\n')
    expect(sess.threadId).toBe('tid-1')
    cap.dispose()
  })
})

describe('handleCodexEvent', () => {
  it('正常系: thread.started で session-started を emit する', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleCodexEvent(sess as never, { type: 'thread.started', thread_id: 'tid-A' })
    expect(sess.threadId).toBe('tid-A')
    const started = cap.events.find(
      (e): e is Extract<PlanEvent, { type: 'session-started' }> =>
        e.type === 'session-started'
    )
    expect(started?.sessionId).toBe('tid-A')
    cap.dispose()
  })

  it('正常系: agent_message を streaming text として emit し plan-ready も出す', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleCodexEvent(sess as never, {
      type: 'item.completed',
      item: { type: 'agent_message', text: '説明\n<plan>\n## Plan\n</plan>' }
    })
    expect(sess.currentAssistantText).toContain('説明')
    expect(sess.pendingPlan).toBe('## Plan')
    expect(cap.events.map((e) => e.type)).toContain('assistant-text')
    expect(cap.events.map((e) => e.type)).toContain('plan-ready')
    cap.dispose()
  })

  it('正常系: turn.completed で assistant text を history に確定する', () => {
    const sess = makeSession({ currentAssistantText: 'final answer', awaitingResult: true })
    const cap = captureEvents()
    handleCodexEvent(sess as never, { type: 'turn.completed' })
    expect(sess.awaitingResult).toBe(false)
    expect(sess.history).toHaveLength(1)
    expect(sess.history[0]).toMatchObject({ role: 'assistant', text: 'final answer' })
    expect(cap.events.map((e) => e.type)).toEqual([
      'assistant-message-complete',
      'turn-complete'
    ])
    cap.dispose()
  })
})
