import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FormatStreamTransform } from './formatStream'
import { goalDir, terminateProcessTree, turnPaths, type WorkSubdir } from './util'
import { getSettings } from '../settings'

/**
 * TypeScript port of `app/resources/run-turn.sh`.
 *
 * Runs a single `codex exec --json` invocation as a
 * direct child of the Electron main process and writes the same set of work
 * files the bash version produced:
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
  /** Override codex binary path. Useful for tests / Windows installs. */
  codexBin?: string
}

export type RunTurnKillReason = 'TIMEOUT' | 'HANG' | 'ABORTED' | 'INTERRUPTED'

export interface RunTurnResult {
  /** First line of the result file: DONE / FAIL exit=N / TIMEOUT / HANG / ABORTED / INTERRUPTED */
  result: string
  /** Exit code from codex. -1 if killed by signal or pre-launch failure. */
  exitCode: number | null
}

export interface RunTurnHandle {
  /** PID of the spawned codex process, or null if spawn failed. */
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
 * Resolve the path to the `codex` CLI binary. Searches common local install
 * locations and then falls back to PATH.
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
      // 公式ネイティブインストーラ (codex を ~/.local/bin に置くパッケージ) の
      // デフォルト配置。Electron が Finder/Dock 起動だと launchd の PATH に
      // ~/.local/bin が入らず PATH フォールバックも空振りするため、ここで
      // 明示的に拾う。
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

  // PATH fallback — `where codex` on Windows, `command -v codex` on POSIX.
  return await pathLookupCodex()
}

function pathLookupCodex(): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const lookupBin = isWin ? 'where' : 'sh'
    const args = isWin ? ['codex'] : ['-c', 'command -v codex']
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
 * Start a single codex turn. Returns a handle whose `.promise` resolves to
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

    const codexBin = opts.codexBin ?? (await detectCodexBin())
    if (!codexBin) {
      const result = await writeResultIfEmpty(tp.result, 'FAIL: codex not found')
      return { result, exitCode: -1 }
    }

    const workspace = await readWorkspacePath(goalId)
    const promptText = await fs.readFile(tp.prompt, 'utf8')

    // Resolve the model from global settings so each turn pins an explicit
    // --model flag. Judge / critic workers can use a different model; when
    // critic_model isn't set we fall back to default_model.
    const settings = await getSettings()
    const modelId =
      subdir === 'judge'
        ? settings.critic_model ?? settings.default_model
        : settings.default_model

    // Initial heartbeat so the orchestrator's HANG-detector gets an mtime to
    // compare against immediately on the first poll.
    await fs.writeFile(tp.heartbeat, '', 'utf8').catch(() => {
      /* ignore */
    })

    // Windows .cmd / .bat files cannot be spawned directly via CreateProcess;
    // they must be invoked through cmd.exe /c. .exe (and any other PE binary)
    // is fine as-is. We avoid `shell: true` because that would require manual
    // escaping of the prompt text (shell metacharacters -> injection risk).
    const isWinBatch =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin)
    const codexArgs = [
      '-a',
      'never',
      '--model',
      modelId,
      '--sandbox',
      'danger-full-access',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      workspace,
      '-'
    ]
    const spawnExec = isWinBatch ? 'cmd.exe' : codexBin
    const spawnArgs = isWinBatch ? ['/c', codexBin, ...codexArgs] : codexArgs

    const child = spawn(spawnExec, spawnArgs, {
      cwd: workspace,
      // POSIX: detach so the existing process-group kill path keeps working.
      // Windows: leave attached — process-tree kill goes through taskkill /T (M4).
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })

    child.stdin.end(promptText)

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
    const formatter = new FormatStreamTransform()

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
    const fallback = exitCode === 0 ? 'DONE' : `FAIL exit=${exitCode ?? '?'}`
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

/** Convenience: await a turn end-to-end without exposing the kill handle. */
export async function runTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  return startRunTurn(opts).promise
}
