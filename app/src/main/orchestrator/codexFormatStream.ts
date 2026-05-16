import { Transform, type TransformCallback } from 'node:stream'

/**
 * `codex exec --json` の JSONL イベントをテキスト transcript に変換する。
 * Claude 用の format-stream とは別物（イベント形式が違うため）。
 *
 * judge / block-judge worker でしか使わないので、必要最低限のイベント種別だけ
 * 扱う：
 *   - item.completed (agent_message) → assistant text を verbatim で残す
 *   - item.completed (command_execution) → tool 実行ログ
 *   - turn.completed / thread.started → 区切り
 *
 * orchestrator は最終的に `<judge-verdict>` / `<critic-flags>` /
 * `<block-judge-verdict>` のようなタグ付きテキストを stdout から正規表現で
 * 抜き出すだけなので、assistant text さえ verbatim で出力されていれば良い。
 */

const INPUT_TRUNCATE_LIMIT = 500
const TOOL_RESULT_TRUNCATE_LIMIT = 1500
const UNPARSEABLE_TRUNCATE_LIMIT = 200

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `\n...(truncated, ${s.length - n} more chars)`
}

export function formatCodexStreamLine(rawLine: string): string {
  const line = rawLine.trim()
  if (!line) return ''

  let ev: unknown
  try {
    ev = JSON.parse(line)
  } catch {
    return `[unparseable] ${truncate(line, UNPARSEABLE_TRUNCATE_LIMIT)}\n`
  }

  if (!ev || typeof ev !== 'object') return ''
  const event = ev as Record<string, unknown>
  const t = event.type

  if (t === 'thread.started') {
    const id = typeof event.thread_id === 'string' ? event.thread_id : '?'
    return `[codex thread start — id=${id}]\n`
  }

  if (t === 'turn.started') return '[codex turn started]\n'

  if (t === 'item.completed') {
    const item = (event.item && typeof event.item === 'object'
      ? (event.item as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const itemType = typeof item.type === 'string' ? item.type : ''

    if (itemType === 'agent_message') {
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text) return ''
      return text.endsWith('\n') ? text : text + '\n'
    }

    if (itemType === 'command_execution') {
      const command =
        typeof item.command === 'string'
          ? item.command
          : typeof item.cmd === 'string'
            ? item.cmd
            : ''
      const output = typeof item.output === 'string' ? item.output : ''
      let out = '\n▶ [command]'
      if (command) out += ` ${truncate(command, INPUT_TRUNCATE_LIMIT)}`
      out += '\n'
      if (output) out += `${truncate(output, TOOL_RESULT_TRUNCATE_LIMIT)}\n`
      return out
    }

    return ''
  }

  if (t === 'turn.completed') {
    const usage =
      event.usage && typeof event.usage === 'object'
        ? (event.usage as Record<string, unknown>)
        : null
    const extras: string[] = []
    const input = usage?.input_tokens
    const cached = usage?.cached_input_tokens
    const output = usage?.output_tokens
    if (typeof input === 'number') extras.push(`input_tokens=${input}`)
    if (typeof cached === 'number') extras.push(`cached=${cached}`)
    if (typeof output === 'number') extras.push(`output_tokens=${output}`)
    const extra = extras.length ? ' ' + extras.join(' ') : ''
    return `\n=== codex turn completed${extra} ===\n`
  }

  return ''
}

export class CodexFormatStreamTransform extends Transform {
  private buffer = ''

  constructor() {
    super({ readableObjectMode: false, writableObjectMode: false })
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.buffer += text
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      const out = formatCodexStreamLine(line)
      if (out) this.push(out)
    }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0) {
      const out = formatCodexStreamLine(this.buffer)
      this.buffer = ''
      if (out) this.push(out)
    }
    callback()
  }
}
