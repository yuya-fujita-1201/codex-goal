import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { app } from 'electron'

export const GOALS_ROOT = path.join(os.homedir(), '.codex-goals')

export function goalDir(goalId: string): string {
  return path.join(GOALS_ROOT, goalId)
}

export type WorkSubdir = 'turns' | 'blocks' | 'judge' | 'compressor'

export function turnPaths(
  goalId: string,
  turnId: string,
  subdir: WorkSubdir = 'turns'
): {
  prompt: string
  stdout: string
  stderr: string
  result: string
  heartbeat: string
} {
  const base = path.join(goalDir(goalId), subdir)
  return {
    prompt: path.join(base, `${turnId}.prompt`),
    stdout: path.join(base, `${turnId}.stdout`),
    stderr: path.join(base, `${turnId}.stderr`),
    result: path.join(base, `${turnId}.result`),
    heartbeat: path.join(base, `${turnId}.heartbeat`)
  }
}

/**
 * Resolve a path under app/resources/ that works in both dev and packaged builds.
 * In dev:  <appPath>/resources/<file>
 * In prod: <process.resourcesPath>/resources/<file>
 *          (electron-builder.yml extraResources copies from=resources to=resources)
 */
export function resourcePath(file: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', file)
  }
  return path.join(app.getAppPath(), 'resources', file)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run a shell command with a hard wall-clock timeout, returning whatever
 * stdout it managed to produce. Designed for *best-effort* observation tasks
 * (git status, diff stat, checker probes) where:
 *   - we never want a hung process to block the next turn,
 *   - non-zero exit codes / stderr are OK — partial stdout is still useful,
 *   - errors (binary missing, permission denied, etc.) silently degrade to
 *     an empty string.
 *
 * Not for tasks where you need to detect failure — those should call
 * `child_process` directly. The contract here is "give me what you have, in
 * bounded time, and never throw."
 */
export function runWithTimeout(
  cmd: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<string> {
  if (cmd.length === 0) return Promise.resolve('')
  return new Promise<string>((resolve) => {
    let settled = false
    const finish = (output: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(output)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish('')
      return
    }
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      output += d
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone — fall through to exit handler
      }
      finish(output)
    }, timeoutMs)
    child.on('exit', () => finish(output))
    child.on('error', () => finish(''))
  })
}

/**
 * Atomically write `content` (UTF-8) to `filePath`. The data is first written
 * to a `.tmp` sibling, then `rename()`d into place — POSIX rename is atomic,
 * so concurrent readers either see the old file or the new file in full,
 * never a partial / torn write. The tmp file is best-effort cleaned up on
 * any failure so we don't leak garbage next to the target.
 *
 * Used for digest.md / state.json / similar single-file persistence where a
 * crash mid-write would corrupt the long-term memory of a goal. The cost
 * over a plain writeFile is one extra rename syscall; negligible vs. the
 * guarantee of never seeing a half-written file on the next read.
 */
export async function atomicWrite(
  filePath: string,
  content: string
): Promise<void> {
  const tmp = filePath + '.tmp'
  try {
    await fs.writeFile(tmp, content, 'utf8')
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
  try {
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

export function formatTurnId(num: number): string {
  return `turn-${String(num).padStart(3, '0')}`
}

/** Escape a string so it's safe inside an AppleScript double-quoted literal. */
export function escapeForOsa(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Cross-platform "kill this PID and all of its descendants".
 *
 * - macOS / Linux: send the signal to the negative PID (process group). Falls
 *   back to the lone PID if the target wasn't started detached or the group
 *   has already been reaped.
 * - Windows: spawn `taskkill /F /T /PID <pid>` which kills the process and the
 *   entire child tree. Signal numbers don't translate, so SIGKILL semantics
 *   are the only meaningful behavior.
 *
 * Errors are swallowed because callers always invoke this best-effort (the
 * process may already be gone, the PID may have been recycled, etc.).
 */
export async function terminateProcessTree(
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'
): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 1) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true
      })
      child.on('exit', () => resolve())
      child.on('error', () => resolve())
    })
    return
  }
  try {
    process.kill(-pid, signal) // process-group kill
    return
  } catch {
    // not a group leader, or already gone — fall through to single-PID kill
  }
  try {
    process.kill(pid, signal)
  } catch {
    // already gone — best-effort
  }
}
