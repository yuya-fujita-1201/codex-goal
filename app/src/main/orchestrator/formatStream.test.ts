import { describe, expect, it } from 'vitest'

import { FormatStreamTransform, formatStreamLine } from './formatStream'

describe('formatStreamLine — system events', () => {
  it('正常系: system/init は model 付きでセッション開始バナーを返す', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-7' })
    expect(formatStreamLine(line)).toBe('[session start — model=claude-opus-4-7]\n')
  })

  it('境界: system/init で model が無ければ "?" を使う', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init' })
    expect(formatStreamLine(line)).toBe('[session start — model=?]\n')
  })

  it('正常系: system の他 subtype は [system: xxx] を返す', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'compact' })
    expect(formatStreamLine(line)).toBe('[system: compact]\n')
  })
})

describe('formatStreamLine — Codex exec JSON events', () => {
  it('正常系: thread.started は thread id 付きで開始バナーを返す', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })
    expect(formatStreamLine(line)).toBe('[thread start — id=thread-1]\n')
  })

  it('正常系: turn.started は開始行を返す', () => {
    const line = JSON.stringify({ type: 'turn.started' })
    expect(formatStreamLine(line)).toBe('[turn started]\n')
  })

  it('正常系: item.completed agent_message は text をそのまま返す', () => {
    const text = '<digest-update>\n## A\n</digest-update>'
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text }
    })
    expect(formatStreamLine(line)).toBe(`${text}\n`)
  })

  it('正常系: turn.completed は usage を整形する', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }
    })
    expect(formatStreamLine(line)).toBe(
      '\n=== turn completed input_tokens=10 cached=4 output_tokens=2 ===\n'
    )
  })
})

describe('formatStreamLine — assistant events', () => {
  it('正常系: text content をそのまま出力し、末尾に改行を補う', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'こんにちは' }] }
    })
    expect(formatStreamLine(line)).toBe('こんにちは\n')
  })

  it('正常系: text に既に改行があれば二重に足さない', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'foo\n' }] }
    })
    expect(formatStreamLine(line)).toBe('foo\n')
  })

  it('正常系: <digest-update> マーカーはそのまま保存される', () => {
    const text = '<digest-update>\n## A\n</digest-update>'
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] }
    })
    expect(formatStreamLine(line)).toBe(`${text}\n`)
  })

  it('正常系: tool_use は [tool: name] と JSON 化された入力を出力する', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]
      }
    })
    expect(formatStreamLine(line)).toBe('\n▶ [tool: Bash]\n  {"command":"ls"}\n')
  })

  it('境界: tool_use の input が長文だと末尾に truncate マーカーが付く', () => {
    const longVal = 'x'.repeat(600)
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: longVal } }]
      }
    })
    const out = formatStreamLine(line)
    expect(out.startsWith('\n▶ [tool: Bash]\n  ')).toBe(true)
    expect(out).toContain('...(truncated,')
  })

  it('正常系: thinking は短いマーカーのみで本文を漏らさない', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'secret reasoning' }] }
    })
    expect(formatStreamLine(line)).toBe('\n💭 [thinking, 16 chars]\n')
  })

  it('境界: text が空文字なら何も出力しない', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '' }] }
    })
    expect(formatStreamLine(line)).toBe('')
  })

  it('境界: assistant の text + tool_use 混在は順番通り出力される', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'やります' },
          { type: 'tool_use', name: 'Read', input: { path: '/a' } }
        ]
      }
    })
    expect(formatStreamLine(line)).toBe('やります\n\n▶ [tool: Read]\n  {"path":"/a"}\n')
  })
})

describe('formatStreamLine — user / tool_result events', () => {
  it('正常系: tool_result の content が文字列ならそのまま出力する', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'hello' }] }
    })
    expect(formatStreamLine(line)).toBe('◀ [tool_result] hello\n')
  })

  it('正常系: tool_result の content が text オブジェクトの配列なら text を結合する', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' }
            ]
          }
        ]
      }
    })
    expect(formatStreamLine(line)).toBe('◀ [tool_result] ab\n')
  })

  it('異常系: is_error=true なら error プレフィクスを使う', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', is_error: true, content: 'oops' }]
      }
    })
    expect(formatStreamLine(line)).toBe('✗ [tool_result error] oops\n')
  })

  it('境界: tool_result が長文だと 1500 文字で truncate される', () => {
    const longVal = 'y'.repeat(1600)
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: longVal }]
      }
    })
    const out = formatStreamLine(line)
    expect(out).toContain('...(truncated, 100 more chars)')
  })
})

describe('formatStreamLine — result events', () => {
  it('正常系: subtype と duration / cost を整形する', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      duration_ms: 1234,
      total_cost_usd: 0.012345
    })
    expect(formatStreamLine(line)).toBe('\n=== result: success duration=1234ms cost=$0.0123 ===\n')
  })

  it('境界: duration と cost が無い result は subtype のみ出力', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns' })
    expect(formatStreamLine(line)).toBe('\n=== result: error_max_turns ===\n')
  })
})

describe('formatStreamLine — fallback', () => {
  it('異常系: パース不能な JSON は [unparseable] を返す', () => {
    expect(formatStreamLine('not-json')).toBe('[unparseable] not-json\n')
  })

  it('境界: 空行は空文字を返す', () => {
    expect(formatStreamLine('')).toBe('')
    expect(formatStreamLine('   \t')).toBe('')
  })

  it('境界: 知らない type は無視して空文字を返す', () => {
    const line = JSON.stringify({ type: 'unknown', foo: 'bar' })
    expect(formatStreamLine(line)).toBe('')
  })
})

describe('FormatStreamTransform', () => {
  function runThrough(chunks: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = new FormatStreamTransform()
      const out: Buffer[] = []
      t.on('data', (b: Buffer | string) => out.push(typeof b === 'string' ? Buffer.from(b) : b))
      t.on('end', () => resolve(Buffer.concat(out).toString('utf8')))
      t.on('error', reject)
      for (const c of chunks) t.write(c)
      t.end()
    })
  }

  it('正常系: 1 行ずつ流すと整形されたテキストが返る', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'm' }) + '\n',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) +
        '\n',
      JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'
    ]
    const result = await runThrough(lines)
    expect(result).toBe('[session start — model=m]\nhi\n\n=== result: success ===\n')
  })

  it('境界: 改行をまたいで分割されたチャンクでも復元される', async () => {
    const full = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'split-line' }] }
    })
    const a = full.slice(0, 10)
    const b = full.slice(10) + '\n'
    const result = await runThrough([a, b])
    expect(result).toBe('split-line\n')
  })

  it('境界: 末尾改行なしの最後の行も flush で処理される', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'tail' }] }
    })
    const result = await runThrough([line])
    expect(result).toBe('tail\n')
  })
})
