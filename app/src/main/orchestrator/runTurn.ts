import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isClaudeCriticModel } from '@shared/types'

import { CodexFormatStreamTransform } from './codexFormatStream'
import { FormatStreamTransform } from './formatStream'
import { EMPTY_MCP_CONFIG, JUDGE_ALLOWED_TOOLS_CLI } from './prompt'
import { goalDir, terminateProcessTree, turnPaths, type WorkSubdir } from './util'
import { getSettings } from '../settings'

/**
 * TypeScript port of `app/resources/run-turn.sh`.
 *
 * Runs a single Codex worker turn (or a Claude-routed judge worker when the
 * critic model is explicitly set to Claude) as a direct child of the Electron
 * main process and writes the same set of work files the bash version produced:
 *
 *   $GOAL_DIR/$SUBDIR/$TURN_ID.{prompt,stdout,stdout.jsonl,stderr,result,heartbeat,pid}
 *
 * Differences vs run-turn.sh:
 *   - No Terminal banner / press-any-key / auto-close logic. Phase 4.4 already
 *     dropped Terminal mode in the bash script via the HAS_TTY check.
 *   - No bash kill-watcher subprocess. Cancellation is performed by the caller
 *     via {@link RunTurnHandle.kill} (or by writing TIMEOUT/HANG/ABORTED to
 *     the result file directly, mirroring the legacy contract).
 *   - jq dependency replaced with JSON.parse on state.json.
 *   - python3 + format-stream.py replaced with FormatStreamTransform.
 *   - Heartbeat ticker is a setInterval inside the same process.
 *   - Process-group / process-tree kill is delegated to
 *     {@link util.terminateProcessTree}, which handles POSIX (-pid → pid
 *     fallback) and Windows (`taskkill /F /T`).
 *
 * Public contract — the legacy "result file may already contain a sentinel"
 * rule is preserved: if {@link RunTurnHandle.kill} (or any external writer)
 * has populated the result file before the child exits, runTurn reads it back
 * and returns that sentinel instead of overwriting with DONE / FAIL.
 */

export interface RunTurnOptions {
  goalId: string
  turnId: string
  subdir: WorkSubdir
  /** Override claude binary path. Used when critic_model routes judge work to Claude. */
  claudeBin?: string
  /** Override codex binary path. Useful for tests / Windows installs. */
  codexBin?: string
}

// judge / block-judge worker は critic_model 設定が Claude 系のときだけ claude
// CLI へ逃がせる。それ以外（メインターンを含む）は codex CLI で起動する。
const CLAUDE_CAPABLE_SUBDIRS = new Set<WorkSubdir>(['judge', 'block-judge'])

export type RunTurnKillReason = 'TIMEOUT' | 'HANG' | 'ABORTED' | 'INTERRUPTED'

export interface RunTurnResult {
  /** First line of the result file: DONE / FAIL exit=N / TIMEOUT / HANG / ABORTED / INTERRUPTED */
  result: string
  /** Exit code from the spawned CLI. -1 if killed by signal or pre-launch failure. */
  exitCode: number | null
}

export interface RunTurnHandle {
  /** PID of the spawned CLI process, or null if spawn failed. */
  readonly pid: number | null
  /** Resolves once the child has exited and all output streams are flushed. */
  readonly promise: Promise<RunTurnResult>
  /**
   * Write the supplied sentinel to the result file (if not already populated)
   * and signal the child process tree to terminate. Mirrors the legacy
   * `markTurnDeadAndKill` semantics.
   */
  kill(reason: RunTurnKillReason): Promise<void>
}

const HEARTBEAT_INTERVAL_MS = 5000

/**
 * Resolve the path to the `claude` CLI binary. Searches the same locations as
 * run-turn.sh on POSIX and adds Windows-friendly fallbacks (`claude.cmd`,
 * `claude.exe`, and a final `where claude` lookup).
 */
export async function detectClaudeBin(): Promise<string | null> {
  const home = os.homedir()
  const candidates: string[] = []

  if (process.platform === 'win32') {
    // Prefer .exe over .cmd: .exe can be spawned directly, while .cmd requires
    // a cmd.exe /c shim (handled at spawn time below).
    candidates.push(
      path.join(home, '.claude', 'local', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.cmd'),
      path.join(home, '.claude', 'local', 'claude'),
      path.join(home, 'AppData', 'Local', 'claude', 'claude.exe'),
      path.join(home, 'AppData', 'Local', 'claude', 'claude.cmd')
    )
  } else {
    candidates.push(
      path.join(home, '.claude', 'local', 'claude'),
      // 公式ネイティブインストーラ (v2.x 以降) のデフォルト配置。
      // symlink → ~/.local/share/claude/versions/<ver> を指す。
      // Electron が Finder/Dock 起動だと launchd の PATH に ~/.local/bin が
      // 入らず PATH フォールバックも空振りするため、ここで明示的に拾う。
      path.join(home, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude'
    )
  }

  for (const cand of candidates) {
    try {
      const stat = await fs.stat(cand)
      if (stat.isFile()) return cand
    } catch {
      // candidate not present — keep searching
    }
  }

  // PATH fallback — `where claude` on Windows, `command -v claude` on POSIX.
  return await pathLookupClaude()
}

function pathLookupClaude(): Promise<string | null> {
  return pathLookup('claude')
}

/**
 * Resolve the path to the `codex` CLI binary. Mirrors detectClaudeBin's search
 * strategy but for codex. Used for main turns and for judge / block-judge
 * workers unless critic_model explicitly routes them to Claude.
 */
export async function detectCodexBin(): Promise<string | null> {
  const home = os.homedir()
  const candidates: string[] = []

  if (process.platform === 'win32') {
    candidates.push(
      path.join(home, '.codex', 'local', 'codex.exe'),
      path.join(home, '.codex', 'local', 'codex.cmd'),
      path.join(home, '.codex', 'local', 'codex'),
      path.join(home, 'AppData', 'Local', 'codex', 'codex.exe'),
      path.join(home, 'AppData', 'Local', 'codex', 'codex.cmd')
    )
  } else {
    candidates.push(
      path.join(home, '.codex', 'local', 'codex'),
      // 将来公式インストーラが ~/.local/bin に置く場合の保険。
      // 現状の Homebrew Cask は /opt/homebrew/bin/codex に置く。
      path.join(home, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex'
    )
  }

  for (const cand of candidates) {
    try {
      const stat = await fs.stat(cand)
      if (stat.isFile()) return cand
    } catch {
      // candidate not present — keep searching
    }
  }

  return await pathLookup('codex')
}

function pathLookup(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const lookupBin = isWin ? 'where' : 'sh'
    const args = isWin ? [bin] : ['-c', `command -v ${bin}`]
    const child = spawn(lookupBin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      resolve(first ?? null)
    })
    child.on('error', () => resolve(null))
  })
}

/**
 * Read $GOAL_DIR/state.json and return workspace_path, falling back to $HOME
 * when the file is missing or malformed (matches run-turn.sh's `jq -r` default).
 */
async function readWorkspacePath(goalId: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(goalDir(goalId), 'state.json'), 'utf8')
    const obj = JSON.parse(raw) as { workspace_path?: unknown }
    if (typeof obj.workspace_path === 'string' && obj.workspace_path.length > 0) {
      return obj.workspace_path
    }
  } catch {
    // missing / malformed — use HOME
  }
  return os.homedir()
}

/**
 * Write `text` to the result file only if the file does not yet contain a
 * non-empty sentinel. Returns the line that ended up in the file.
 */
async function writeResultIfEmpty(resultPath: string, text: string): Promise<string> {
  try {
    const existing = await fs.readFile(resultPath, 'utf8')
    const firstLine = existing.split('\n')[0]?.trim() ?? ''
    if (firstLine.length > 0) return firstLine
  } catch {
    // file does not exist yet — write it
  }
  const line = text.endsWith('\n') ? text : text + '\n'
  try {
    await fs.writeFile(resultPath, line, 'utf8')
  } catch {
    // ignore — caller still gets the intended sentinel back
  }
  return text.replace(/\n$/, '')
}

/**
 * Start a single worker turn. Returns a handle whose `.promise` resolves to
 * the result sentinel + exit code.
 */
export function startRunTurn(opts: RunTurnOptions): RunTurnHandle {
  const { goalId, turnId, subdir } = opts
  const tp = turnPaths(goalId, turnId, subdir)
  const workDir = path.join(goalDir(goalId), subdir)
  const pidFile = path.join(workDir, `${turnId}.pid`)
  const stdoutJsonlPath = path.join(workDir, `${turnId}.stdout.jsonl`)

  let resolvedPid: number | null = null
  let killed = false

  const promise = (async (): Promise<RunTurnResult> => {
    await fs.mkdir(workDir, { recursive: true })

    if (!existsSync(tp.prompt)) {
      const result = await writeResultIfEmpty(tp.result, 'FAIL: prompt missing')
      return { result, exitCode: -1 }
    }

    const workspace = await readWorkspacePath(goalId)
    const promptText = await fs.readFile(tp.prompt, 'utf8')

    // Resolve the model from global settings so each turn pins an explicit
    // --model flag. Without this, Codex defaults to whatever its config/CLI
    // resolves, which is not what the app advertises in Settings → 使用モデル.
    // Failure to read settings falls back to the on-disk default inside
    // getSettings.
    //
    // PR-D: judge / critic workers can use a *different* model from main
    // turns, giving the validator slightly less correlated blind spots. When
    // critic_model isn't set we fall back to default_model so existing
    // single-model setups keep working unchanged.
    const settings = await getSettings()
    const isJudgeLike = CLAUDE_CAPABLE_SUBDIRS.has(subdir)
    const useClaude = isJudgeLike && isClaudeCriticModel(settings.critic_model)
    const modelId = isJudgeLike
      ? settings.critic_model ?? settings.default_model
      : settings.default_model

    // Initial heartbeat so the orchestrator's HANG-detector gets an mtime to
    // compare against immediately on the first poll.
    await fs.writeFile(tp.heartbeat, '', 'utf8').catch(() => {
      /* ignore */
    })

    let spawnExec: string
    let spawnArgs: string[]
    let stdioMode: 'ignore-stdin' | 'pipe-stdin'

    if (useClaude) {
      // critic_model が Claude 系のとき、judge / block-judge を claude CLI で
      // 走らせる。Codex Goal のメインターンは codex 経路（下の else）。
      const claudeBin = opts.claudeBin ?? (await detectClaudeBin())
      if (!claudeBin) {
        const result = await writeResultIfEmpty(tp.result, 'FAIL: claude not found')
        return { result, exitCode: -1 }
      }
      // Windows .cmd / .bat files cannot be spawned directly via CreateProcess;
      // they must be invoked through cmd.exe /c. .exe (and any other PE binary)
      // is fine as-is. We avoid `shell: true` because that would require manual
      // escaping of the prompt text (shell metacharacters → injection risk).
      const isWinBatch =
        process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin)
      const claudeArgs = [
        '-p',
        promptText,
        '--model',
        modelId,
        '--output-format',
        'stream-json',
        '--verbose'
      ]
      // judge / block-judge は判定のための **読み取り** だけで動く想定。
      // メインターンの未信頼 stdout が prompt に混ざる構造上、prompt injection
      // で advisory worker にファイル編集や破壊的 shell コマンドを実行させる
      // 経路がある。
      //
      // 経緯（試行錯誤の記録）:
      //   (1) --disallowedTools で書き込み系を deny → Bash の "rm:*" コロン
      //       構文が silently 無視され、deny 自体が空振り
      //   (2) --allowedTools "Bash(rm *)" などスペース構文に修正 → Bash を
      //       許可する限り python / node / tee / sed -i / リダイレクト経由で
      //       書き込み経路が無数に残る
      //   (3) --allowedTools "Read Glob Grep" だけに絞った → qa-code-review
      //       v5 の実機検証で **--dangerously-skip-permissions が permission
      //       検査全体をバイパス**するため --allowedTools / --tools 自体が
      //       無効化されることが確定（v2.1.126）
      //
      // 結論: judge 系では --dangerously-skip-permissions を渡さない。
      // 代わりに --tools で内蔵ツールセットを Read,Glob,Grep に限定し、
      // --permission-mode dontAsk で -p 非対話モードでも permission dialog
      // が詰まらないようにする。これで「指定ツール以外はそもそも存在しない」
      // 状態を作り、prompt injection で Bash/Edit/Write を呼ぼうとしても
      // 呼び出し先が無くなる。
      //
      // useClaude=true に到達するのは CLAUDE_CAPABLE_SUBDIRS（judge /
      // block-judge）に限られるため isJudgeLike は常に true。else 側
      // (bypass) はメインターン用の保険として残すが、現状の Codex Goal
      // ではここを通過しない。
      if (isJudgeLike) {
        claudeArgs.push(
          '--tools',
          JUDGE_ALLOWED_TOOLS_CLI,
          '--strict-mcp-config',
          '--mcp-config',
          EMPTY_MCP_CONFIG,
          '--disable-slash-commands',
          '--setting-sources',
          '',
          '--permission-mode',
          'dontAsk'
        )
      } else {
        claudeArgs.push('--dangerously-skip-permissions')
      }
      spawnExec = isWinBatch ? 'cmd.exe' : claudeBin
      spawnArgs = isWinBatch ? ['/c', claudeBin, ...claudeArgs] : claudeArgs
      stdioMode = 'ignore-stdin'
    } else {
      // メインターンおよび GPT 系 critic_model のときの judge / block-judge を
      // codex CLI で走らせる。prompt は stdin から渡す（claude のように引数渡し
      // は不可）。codex 用の formatter を後段で使う必要があるため stdin を
      // pipe 化する。
      const codexBin = opts.codexBin ?? (await detectCodexBin())
      if (!codexBin) {
        const result = await writeResultIfEmpty(tp.result, 'FAIL: codex not found')
        return { result, exitCode: -1 }
      }
      const isWinBatch =
        process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin)
      // メインターンは workspace への書き込みが必要なため `danger-full-access`、
      // judge / block-judge を Codex CLI で走らせる場合は読み取りだけなので
      // `read-only` で十分。`--sandbox read-only` でメイン worker の未信頼
      // stdout が prompt 経由で破壊的コマンドを実行させようとしても拒否される。
      //
      const codexArgs = buildCodexExecArgs({
        modelId,
        sandbox: isJudgeLike ? 'read-only' : 'danger-full-access',
        workspace
      })
      spawnExec = isWinBatch ? 'cmd.exe' : codexBin
      spawnArgs = isWinBatch ? ['/c', codexBin, ...codexArgs] : codexArgs
      stdioMode = 'pipe-stdin'
    }

    const child = spawn(spawnExec, spawnArgs, {
      cwd: workspace,
      // POSIX: detach so the existing process-group kill path keeps working.
      // Windows: leave attached — process-tree kill goes through taskkill /T (M4).
      detached: process.platform !== 'win32',
      stdio: [stdioMode === 'pipe-stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    // Codex は prompt を stdin から受け取る。EPIPE 等で書き込みに失敗した
    // 場合、Node はデフォルトで unhandled 'error' イベント → uncaughtException
    // に昇格させてプロセスごと落とすので、必ず error listener を張ってから
    // end する。stdin 失敗時は最終 sentinel 確定パスに伝えるため stdinErrorSentinel
    // に sentinel 文字列を保持し、出口側の writeResultIfEmpty 呼び出しで使う。
    // 非同期 fire-and-forget では「stderr が先に書く / child が先に exit」と
    // 競合し得るので、明示的に同期パスで sentinel を確定させる。
    let stdinErrorSentinel: string | null = null
    if (!useClaude && child.stdin) {
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (stdinErrorSentinel === null) {
          stdinErrorSentinel = `FAIL: codex stdin error (${err.code ?? err.message ?? 'unknown'})`
        }
      })
      try {
        child.stdin.end(promptText)
      } catch (err) {
        // end() が同期投げした場合（pipe 既に閉、ENOENT 等）。
        if (stdinErrorSentinel === null) {
          stdinErrorSentinel = `FAIL: codex stdin error (${(err as Error).message})`
        }
      }
    }

    resolvedPid = typeof child.pid === 'number' ? child.pid : null
    if (resolvedPid !== null) {
      await fs.writeFile(pidFile, String(resolvedPid), 'utf8').catch(() => {
        /* ignore */
      })
    }

    // ---- output pipeline ----
    // Tee stdout: raw bytes → <id>.stdout.jsonl, formatted text → <id>.stdout.
    const stderrFile = createWriteStream(tp.stderr)
    const stdoutJsonl = createWriteStream(stdoutJsonlPath)
    const stdoutText = createWriteStream(tp.stdout)
    // useClaude=true は Claude CLI 経路 (stream-json) → FormatStreamTransform
    // useClaude=false は Codex CLI 経路 (codex JSONL) → CodexFormatStreamTransform
    const formatter = useClaude
      ? new FormatStreamTransform()
      : new CodexFormatStreamTransform()

    child.stderr?.pipe(stderrFile)

    const stdoutDrained = new Promise<void>((resolve) => {
      let finished = 0
      const done = (): void => {
        finished += 1
        if (finished >= 2) resolve()
      }
      stdoutJsonl.on('finish', done)
      stdoutJsonl.on('error', done)
      stdoutText.on('finish', done)
      stdoutText.on('error', done)
    })

    formatter.pipe(stdoutText)

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutJsonl.write(chunk)
        formatter.write(chunk)
      })
      child.stdout.on('end', () => {
        stdoutJsonl.end()
        formatter.end()
      })
      child.stdout.on('error', () => {
        stdoutJsonl.end()
        formatter.end()
      })
    } else {
      stdoutJsonl.end()
      formatter.end()
    }

    // ---- heartbeat ticker ----
    const heartbeatTimer = setInterval(() => {
      const now = new Date()
      fs.utimes(tp.heartbeat, now, now).catch(() => {
        /* ignore — file may have been removed by external cleanup */
      })
    }, HEARTBEAT_INTERVAL_MS)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

    // ---- await child exit ----
    // Use 'close' (not 'exit'): Node guarantees stdio streams are fully closed
    // by the time 'close' fires, eliminating a race where stderr could still be
    // draining when we tear down stderrFile below.
    const exitCode = await new Promise<number | null>((resolve) => {
      let settled = false
      child.on('close', (code) => {
        if (settled) return
        settled = true
        resolve(code)
      })
      child.on('error', () => {
        if (settled) return
        settled = true
        resolve(-1)
      })
    })

    clearInterval(heartbeatTimer)

    // Wait for output streams to fully drain so the caller can read complete
    // stdout / stdout.jsonl files.
    await new Promise<void>((resolve) => {
      stderrFile.end(() => resolve())
    })
    await stdoutDrained

    // ---- decide result sentinel ----
    // Preserve any pre-existing sentinel (TIMEOUT / HANG / ABORTED / INTERRUPTED
    // written by RunTurnHandle.kill or a legacy markTurnDeadAndKill caller).
    // Codex stdin error sentinel が立っていれば、それを通常の DONE/FAIL より
    // 優先する: stdin が落ちた時点で worker 実行は無効化されており、たまたま
    // exit code 0 で返っても DONE 扱いしてはいけない。
    const fallback =
      stdinErrorSentinel !== null
        ? stdinErrorSentinel
        : exitCode === 0
          ? 'DONE'
          : `FAIL exit=${exitCode ?? '?'}`
    const result = await writeResultIfEmpty(tp.result, fallback)
    return { result, exitCode }
  })()

  const handle: RunTurnHandle = {
    get pid(): number | null {
      return resolvedPid
    },
    promise,
    kill: async (reason: RunTurnKillReason): Promise<void> => {
      if (killed) return
      killed = true
      // Write sentinel first — preserves legacy "result file is the kill
      // signal" contract for any code path that polls it.
      try {
        const existing = await fs.readFile(tp.result, 'utf8').catch(() => '')
        if (existing.trim().length === 0) {
          await fs.writeFile(tp.result, `${reason}\n`, 'utf8').catch(() => {
            /* ignore */
          })
        }
      } catch {
        /* ignore */
      }
      // Best-effort tree termination. terminateProcessTree handles POSIX
      // process-group kill (with pid fallback) and Windows taskkill /F /T.
      const pid = resolvedPid
      if (pid !== null && Number.isFinite(pid) && pid > 1) {
        await terminateProcessTree(pid, 'SIGTERM')
      }
    }
  }
  return handle
}

function buildCodexExecArgs(args: {
  modelId: string
  sandbox: 'read-only' | 'danger-full-access'
  workspace: string
}): string[] {
  return [
    '-a',
    'never',
    '--model',
    args.modelId,
    '--sandbox',
    args.sandbox,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    args.workspace,
    '-'
  ]
}

export const __test = { buildCodexExecArgs }

/** Convenience: await a turn end-to-end without exposing the kill handle. */
export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  return startRunTurn(opts).promise
}
