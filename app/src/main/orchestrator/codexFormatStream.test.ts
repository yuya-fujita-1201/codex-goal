import { describe, expect, it } from 'vitest'

import { CodexFormatStreamTransform, formatCodexStreamLine } from './codexFormatStream'

describe('formatCodexStreamLine — item.completed agent_message', () => {
  it('agent_message は text を verbatim で改行付きで返す', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '判定結果を述べます。' }
    })
    expect(formatCodexStreamLine(line)).toBe('判定結果を述べます。\n')
  })

  it('agent_message の text が既に改行で終わるときは追加しない', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'hello\n' }
    })
    expect(formatCodexStreamLine(line)).toBe('hello\n')
  })

  it('agent_message のタグ付きテキストはそのまま verbatim で保持される（後段で正規表現抽出する想定）', () => {
    const text = '<block-judge-verdict>should_stop</block-judge-verdict>'
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text }
    })
    expect(formatCodexStreamLine(line)).toContain(text)
  })

  it('空文字 text は空文字を返す', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '' }
    })
    expect(formatCodexStreamLine(line)).toBe('')
  })
})

describe('formatCodexStreamLine — item.completed command_execution', () => {
  it('command と output の両方が含まれる', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'ls -la', output: 'total 0' }
    })
    const out = formatCodexStreamLine(line)
    expect(out).toContain('[command]')
    expect(out).toContain('ls -la')
    expect(out).toContain('total 0')
  })

  it('command が cmd フィールドにある形式にも対応する', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', cmd: 'pwd', output: '/tmp' }
    })
    const out = formatCodexStreamLine(line)
    expect(out).toContain('pwd')
    expect(out).toContain('/tmp')
  })

  it('output が無くても command だけ出力する', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'ls' }
    })
    const out = formatCodexStreamLine(line)
    expect(out).toContain('[command]')
    expect(out).toContain('ls')
  })
})

describe('formatCodexStreamLine — thread / turn events', () => {
  it('thread.started は thread id 付きでバナーを返す', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'abc-123' })
    expect(formatCodexStreamLine(line)).toBe('[codex thread start — id=abc-123]\n')
  })

  it('thread.started で id が無ければ ? を使う', () => {
    const line = JSON.stringify({ type: 'thread.started' })
    expect(formatCodexStreamLine(line)).toBe('[codex thread start — id=?]\n')
  })

  it('turn.started は固定文字列を返す', () => {
    const line = JSON.stringify({ type: 'turn.started' })
    expect(formatCodexStreamLine(line)).toBe('[codex turn started]\n')
  })

  it('turn.completed は usage 情報を整形して返す', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 123, cached_input_tokens: 45, output_tokens: 67 }
    })
    const out = formatCodexStreamLine(line)
    expect(out).toContain('codex turn completed')
    expect(out).toContain('input_tokens=123')
    expect(out).toContain('cached=45')
    expect(out).toContain('output_tokens=67')
  })

  it('turn.completed は usage が無くても落ちない', () => {
    const line = JSON.stringify({ type: 'turn.completed' })
    expect(formatCodexStreamLine(line)).toBe('\n=== codex turn completed ===\n')
  })
})

describe('formatCodexStreamLine — エラー・未知イベント', () => {
  it('JSON パース不能行は [unparseable] プレフィックス付きで返す', () => {
    expect(formatCodexStreamLine('not json')).toContain('[unparseable]')
  })

  it('空行は空文字を返す', () => {
    expect(formatCodexStreamLine('')).toBe('')
    expect(formatCodexStreamLine('   \t  ')).toBe('')
  })

  it('未知の type は空文字を返す（落ちない）', () => {
    const line = JSON.stringify({ type: 'mystery.event', payload: 'whatever' })
    expect(formatCodexStreamLine(line)).toBe('')
  })

  it('item.completed で未知の item.type は空文字を返す', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', content: 'private' }
    })
    expect(formatCodexStreamLine(line)).toBe('')
  })

  it('object でない JSON 値は空文字を返す', () => {
    expect(formatCodexStreamLine('"just a string"')).toBe('')
    expect(formatCodexStreamLine('123')).toBe('')
    expect(formatCodexStreamLine('null')).toBe('')
  })
})

describe('CodexFormatStreamTransform', () => {
  function collect(input: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = new CodexFormatStreamTransform()
      let out = ''
      t.on('data', (chunk: Buffer | string) => {
        out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      })
      t.on('end', () => resolve(out))
      t.on('error', reject)
      t.end(input)
    })
  }

  it('複数行を順に整形して連結する', async () => {
    const input =
      JSON.stringify({ type: 'turn.started' }) +
      '\n' +
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '答えはこれです。' }
      }) +
      '\n'
    const out = await collect(input)
    expect(out).toContain('[codex turn started]')
    expect(out).toContain('答えはこれです。')
  })

  it('改行を含まない最終行 (flush) でも処理される', async () => {
    const input = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '末尾行' }
    })
    // 末尾改行なし
    const out = await collect(input)
    expect(out).toContain('末尾行')
  })

  it('部分入力を跨いでバッファリングする（split chunk）', async () => {
    return new Promise<void>((resolve, reject) => {
      const t = new CodexFormatStreamTransform()
      let out = ''
      t.on('data', (chunk: Buffer | string) => {
        out += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      })
      t.on('end', () => {
        try {
          expect(out).toContain('分割でも復元')
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      t.on('error', reject)
      const full = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '分割でも復元' }
      })
      // 真ん中で意図的にちぎる
      const mid = Math.floor(full.length / 2)
      t.write(full.slice(0, mid))
      t.write(full.slice(mid) + '\n')
      t.end()
    })
  })
})
