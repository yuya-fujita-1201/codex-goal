import { describe, expect, it, beforeEach, vi } from 'vitest'

// util.ts imports `app` from 'electron' (used by resourcePath, not by anything
// reachable from planSession's test seam). Mock it so vitest can load the module
// without the actual electron runtime.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/claude-goal-test'
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { __test, onPlanEvent } from './planSession'
import type { PlanEvent } from '@shared/types'

const { buildSeedMessage, handleStdoutChunk, handleStreamEvent } = __test

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockSession {
  goalId: string
  sessionId: string | null
  history: { role: 'user' | 'assistant'; text: string; ts: string }[]
  pendingPlan: string | null
  stdoutBuffer: string
  currentAssistantText: string
  awaitingResult: boolean
  exitReason: 'approved' | 'aborted' | null
  // Required by InternalSession's type but never touched on the test paths.
  proc: unknown
}

function makeSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    goalId: 'g1',
    sessionId: null,
    history: [],
    pendingPlan: null,
    stdoutBuffer: '',
    currentAssistantText: '',
    awaitingResult: true,
    exitReason: null,
    proc: { stdin: { write: () => true } },
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

// ---------------------------------------------------------------------------
// buildSeedMessage
// ---------------------------------------------------------------------------

describe('buildSeedMessage', () => {
  it('正常系: ゴール本文を <goal> タグで包んで返す', () => {
    const msg = buildSeedMessage('Build a calculator app')
    expect(msg).toContain('<goal>\nBuild a calculator app\n</goal>')
  })

  it('正常系: AskUserQuestion ツールを使わないよう指示文に明記する', () => {
    const msg = buildSeedMessage('x')
    expect(msg).toMatch(/do NOT use the AskUserQuestion tool/i)
  })

  it('正常系: ExitPlanMode 起動を明記する', () => {
    const msg = buildSeedMessage('x')
    expect(msg).toMatch(/ExitPlanMode/)
  })

  it('正常系: 改行・特殊文字を含む objective も保存される', () => {
    const objective = 'line one\nline two\n<weird>tag</weird>'
    const msg = buildSeedMessage(objective)
    expect(msg).toContain(objective)
  })
})

// ---------------------------------------------------------------------------
// handleStdoutChunk — line-buffered JSON splitter
// ---------------------------------------------------------------------------

describe('handleStdoutChunk', () => {
  let sess: MockSession
  let cap: ReturnType<typeof captureEvents>

  beforeEach(() => {
    sess = makeSession()
    cap = captureEvents()
  })

  it('正常系: 1行 1 JSON で完結するチャンクをそのままパースする', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-A' }) + '\n'
    handleStdoutChunk(sess as never, line)
    expect(sess.sessionId).toBe('sid-A')
    expect(cap.events.find((e) => e.type === 'session-started' && e.sessionId === 'sid-A')).toBeTruthy()
    cap.dispose()
  })

  it('正常系: 複数行を 1 チャンクで受けても各行が個別にパースされる', () => {
    const a = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-B' })
    const b = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello ' }] }
    })
    handleStdoutChunk(sess as never, a + '\n' + b + '\n')
    expect(sess.sessionId).toBe('sid-B')
    expect(sess.currentAssistantText).toBe('hello ')
    cap.dispose()
  })

  it('正常系: 行が分割チャンクで届いても末尾を buffer して連結される', () => {
    const full = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'split-text' }] }
    })
    const half = full.slice(0, 20)
    const rest = full.slice(20) + '\n'
    handleStdoutChunk(sess as never, half)
    // 改行が来るまでパースされない
    expect(sess.currentAssistantText).toBe('')
    expect(sess.stdoutBuffer).toBe(half)
    handleStdoutChunk(sess as never, rest)
    expect(sess.currentAssistantText).toBe('split-text')
    expect(sess.stdoutBuffer).toBe('')
    cap.dispose()
  })

  it('異常系: 不正な JSON 行は黙って捨てて後続行に影響しない', () => {
    const bad = 'this is not json'
    const good = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-C' })
    handleStdoutChunk(sess as never, bad + '\n' + good + '\n')
    expect(sess.sessionId).toBe('sid-C')
    cap.dispose()
  })

  it('正常系: 空行 (newline のみ) は無視される', () => {
    handleStdoutChunk(sess as never, '\n\n')
    expect(cap.events).toHaveLength(0)
    cap.dispose()
  })
})

// ---------------------------------------------------------------------------
// handleStreamEvent — protocol dispatcher
// ---------------------------------------------------------------------------

describe('handleStreamEvent: system.init', () => {
  it('正常系: session_id を反映して session-started を再発火する', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'system',
      subtype: 'init',
      session_id: 'init-sid'
    } as never)
    expect(sess.sessionId).toBe('init-sid')
    const started = cap.events.find(
      (e): e is Extract<PlanEvent, { type: 'session-started' }> =>
        e.type === 'session-started'
    )
    expect(started).toBeTruthy()
    expect(started?.sessionId).toBe('init-sid')
    expect(started?.goalId).toBe('g1')
    cap.dispose()
  })

  it('異常系: subtype が init 以外なら session_id を上書きしない', () => {
    const sess = makeSession({ sessionId: 'pre-existing' })
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'system',
      subtype: 'tooluse',
      session_id: 'should-not-apply'
    } as never)
    expect(sess.sessionId).toBe('pre-existing')
    expect(cap.events.filter((e) => e.type === 'session-started')).toHaveLength(0)
    cap.dispose()
  })
})

describe('handleStreamEvent: assistant text', () => {
  it('正常系: text パートを currentAssistantText に累積し assistant-text を emit する', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'foo ' }] }
    } as never)
    handleStreamEvent(sess as never, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'bar' }] }
    } as never)
    expect(sess.currentAssistantText).toBe('foo bar')
    const texts = cap.events
      .filter((e): e is Extract<PlanEvent, { type: 'assistant-text' }> => e.type === 'assistant-text')
      .map((e) => e.text)
    expect(texts).toEqual(['foo ', 'bar'])
    cap.dispose()
  })

  it('正常系: 1 メッセージ内の複数 text パートも 1 つずつ emit される', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' }
        ]
      }
    } as never)
    expect(sess.currentAssistantText).toBe('AB')
    expect(
      cap.events.filter((e) => e.type === 'assistant-text').length
    ).toBe(2)
    cap.dispose()
  })

  it('異常系: message.content 不在ならノーオペで落ちない', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleStreamEvent(sess as never, { type: 'assistant' } as never)
    handleStreamEvent(sess as never, { type: 'assistant', message: {} } as never)
    expect(sess.currentAssistantText).toBe('')
    expect(cap.events).toHaveLength(0)
    cap.dispose()
  })
})

describe('handleStreamEvent: ExitPlanMode tool_use', () => {
  it('正常系: input.plan を pendingPlan に格納し plan-ready を emit する', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'ExitPlanMode',
            input: { plan: '## Plan\n- step 1\n- step 2' }
          }
        ]
      }
    } as never)
    expect(sess.pendingPlan).toBe('## Plan\n- step 1\n- step 2')
    const ready = cap.events.find(
      (e): e is Extract<PlanEvent, { type: 'plan-ready' }> => e.type === 'plan-ready'
    )
    expect(ready?.plan).toBe('## Plan\n- step 1\n- step 2')
    cap.dispose()
  })

  it('異常系: 別の tool_use 名は plan-ready を emit しない', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { plan: 'fake' } }]
      }
    } as never)
    expect(sess.pendingPlan).toBeNull()
    expect(cap.events.filter((e) => e.type === 'plan-ready')).toHaveLength(0)
    cap.dispose()
  })

  it('境界系: input.plan 不在なら空文字列で plan-ready を emit する', () => {
    const sess = makeSession()
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'ExitPlanMode' }]
      }
    } as never)
    expect(sess.pendingPlan).toBe('')
    expect(cap.events.find((e) => e.type === 'plan-ready')).toBeTruthy()
    cap.dispose()
  })
})

describe('handleStreamEvent: result', () => {
  it('正常系: awaitingResult を false にし、累積した assistant text を history に確定する', () => {
    const sess = makeSession({
      awaitingResult: true,
      currentAssistantText: 'final answer'
    })
    const cap = captureEvents()
    handleStreamEvent(sess as never, { type: 'result', is_error: false } as never)
    expect(sess.awaitingResult).toBe(false)
    expect(sess.currentAssistantText).toBe('')
    expect(sess.history).toHaveLength(1)
    expect(sess.history[0]).toMatchObject({ role: 'assistant', text: 'final answer' })
    expect(sess.history[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(cap.events.some((e) => e.type === 'assistant-message-complete')).toBe(true)
    expect(cap.events.some((e) => e.type === 'turn-complete')).toBe(true)
    cap.dispose()
  })

  it('正常系: assistant text が無いターンでは history に追加しない', () => {
    const sess = makeSession({ awaitingResult: true, currentAssistantText: '' })
    const cap = captureEvents()
    handleStreamEvent(sess as never, { type: 'result' } as never)
    expect(sess.awaitingResult).toBe(false)
    expect(sess.history).toHaveLength(0)
    expect(cap.events.some((e) => e.type === 'turn-complete')).toBe(true)
    cap.dispose()
  })

  it('異常系: is_error=true なら error event を turn-complete の前に emit する', () => {
    const sess = makeSession({ awaitingResult: true })
    const cap = captureEvents()
    handleStreamEvent(sess as never, {
      type: 'result',
      is_error: true,
      result: 'rate limited'
    } as never)
    const errIdx = cap.events.findIndex((e) => e.type === 'error')
    const completeIdx = cap.events.findIndex((e) => e.type === 'turn-complete')
    expect(errIdx).toBeGreaterThanOrEqual(0)
    expect(completeIdx).toBeGreaterThan(errIdx)
    const err = cap.events[errIdx] as Extract<PlanEvent, { type: 'error' }>
    expect(err.message).toBe('rate limited')
    cap.dispose()
  })
})

describe('handleStreamEvent: 統合シナリオ', () => {
  it('正常系: init → assistant text → ExitPlanMode → result の一連で全 PlanEvent が順序通り発火する', () => {
    const sess = makeSession()
    const cap = captureEvents()
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-X' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'thinking…' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'final plan' } }
          ]
        }
      }),
      JSON.stringify({ type: 'result', is_error: false })
    ]
    handleStdoutChunk(sess as never, lines.join('\n') + '\n')
    const types = cap.events.map((e) => e.type)
    expect(types).toEqual([
      'session-started',
      'assistant-text',
      'plan-ready',
      'assistant-message-complete',
      'turn-complete'
    ])
    expect(sess.sessionId).toBe('sid-X')
    expect(sess.pendingPlan).toBe('final plan')
    expect(sess.history).toHaveLength(1)
    expect(sess.history[0].text).toBe('thinking…')
    expect(sess.awaitingResult).toBe(false)
    cap.dispose()
  })
})
