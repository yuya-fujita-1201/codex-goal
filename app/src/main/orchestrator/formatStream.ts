import { Transform, type TransformCallback } from 'node:stream'

/**
 * TypeScript port of `app/resources/format-stream.py`.
 *
 * Converts `claude --output-format stream-json --verbose` JSONL events
 * into a human-readable transcript. The transcript intentionally preserves:
 *   - assistant text content verbatim (so <digest-update>...</digest-update>
 *     and <goal-status>...</goal-status> markers survive for the orchestrator's
 *     regex extraction in turn-NNN.stdout)
 *   - tool call markers ([tool: Bash] + truncated input)
 *   - tool result markers (truncated)
 *   - system/init banner and final result subtype
 */

const INPUT_TRUNCATE_LIMIT = 500
const TOOL_RESULT_TRUNCATE_LIMIT = 1500
const UNPARSEABLE_TRUNCATE_LIMIT = 200

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `\n...(truncated, ${s.length - n} more chars)`
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatInput(inp: unknown): string {
  return truncate(safeJsonStringify(inp), INPUT_TRUNCATE_LIMIT)
}

function formatToolResult(content: unknown): string {
  let s: string
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const c of content) {
      if (c && typeof c === 'object') {
        const obj = c as Record<string, unknown>
        const text = obj.text
        parts.push(typeof text === 'string' ? text : '')
      } else {
        parts.push(String(c))
      }
    }
    s = parts.join('')
  } else if (typeof content === 'string') {
    s = content
  } else {
    s = safeJsonStringify(content)
  }
  return truncate(s, TOOL_RESULT_TRUNCATE_LIMIT)
}

/**
 * Format a single JSONL event line into the human-readable transcript fragment.
 * Returns the (possibly multi-line) string to emit, or `''` for events we
 * don't render. The output already contains its own trailing newlines where
 * appropriate, mirroring the Python implementation byte-for-byte.
 */
export function formatStreamLine(rawLine: string): string {
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

  if (t === 'system') {
    const sub = typeof event.subtype === 'string' ? event.subtype : ''
    if (sub === 'init') {
      const model = typeof event.model === 'string' ? event.model : '?'
      return `[session start — model=${model}]\n`
    }
    return `[system: ${sub}]\n`
  }

  if (t === 'assistant') {
    let out = ''
    const msg = (event.message && typeof event.message === 'object'
      ? (event.message as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const item = c as Record<string, unknown>
      const ct = item.type
      if (ct === 'text') {
        const txt = typeof item.text === 'string' ? item.text : ''
        if (txt) {
          out += txt
          if (!txt.endsWith('\n')) out += '\n'
        }
      } else if (ct === 'tool_use') {
        const name = typeof item.name === 'string' ? item.name : '?'
        const inp = item.input ?? {}
        out += `\n▶ [tool: ${name}]\n  ${formatInput(inp)}\n`
      } else if (ct === 'thinking') {
        const thought = typeof item.thinking === 'string' ? item.thinking : ''
        if (thought) {
          out += `\n💭 [thinking, ${thought.length} chars]\n`
        }
      }
    }
    return out
  }

  if (t === 'user') {
    let out = ''
    const msg = (event.message && typeof event.message === 'object'
      ? (event.message as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const item = c as Record<string, unknown>
      if (item.type === 'tool_result') {
        const isErr = item.is_error === true
        const prefix = isErr ? '✗ [tool_result error]' : '◀ [tool_result]'
        out += `${prefix} ${formatToolResult(item.content ?? '')}\n`
      }
    }
    return out
  }

  if (t === 'result') {
    const sub = typeof event.subtype === 'string' ? event.subtype : ''
    const duration = event.duration_ms
    const cost = event.total_cost_usd
    const extras: string[] = []
    if (typeof duration === 'number') extras.push(`duration=${duration}ms`)
    if (typeof cost === 'number') extras.push(`cost=$${cost.toFixed(4)}`)
    const extra = extras.length ? ' ' + extras.join(' ') : ''
    return `\n=== result: ${sub}${extra} ===\n`
  }

  return ''
}

/**
 * Transform stream that consumes JSONL bytes and emits the formatted transcript.
 * Buffers partial lines so it can be piped directly from a child process stdout.
 */
export class FormatStreamTransform extends Transform {
  private buffer = ''

  constructor() {
    super({ readableObjectMode: false, writableObjectMode: false })
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.buffer += text
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      const out = formatStreamLine(line)
      if (out) this.push(out)
    }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0) {
      const out = formatStreamLine(this.buffer)
      this.buffer = ''
      if (out) this.push(out)
    }
    callback()
  }
}

export const __test = { truncate, formatInput, formatToolResult }
