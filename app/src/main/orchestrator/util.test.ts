import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { atomicWrite, runWithTimeout } from './util'

describe('atomicWrite', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('正常系: ファイルが書き込まれて .tmp が残らない', async () => {
    const target = path.join(tmpDir, 'data.md')
    await atomicWrite(target, 'hello\nworld\n')

    expect(await fs.readFile(target, 'utf8')).toBe('hello\nworld\n')

    const entries = await fs.readdir(tmpDir)
    expect(entries).toEqual(['data.md'])
  })

  it('正常系: 既存ファイルを上書きしても torn write は起きない', async () => {
    const target = path.join(tmpDir, 'data.md')
    await fs.writeFile(target, 'old content', 'utf8')

    await atomicWrite(target, 'new content')

    expect(await fs.readFile(target, 'utf8')).toBe('new content')
  })

  it('異常系: 親ディレクトリが存在しないと throw し、tmp も残らない', async () => {
    const target = path.join(tmpDir, 'nonexistent', 'data.md')

    await expect(atomicWrite(target, 'hello')).rejects.toThrow()

    // tmp ファイルも作られない（writeFile が先に失敗するため）
    const entries = await fs.readdir(tmpDir)
    expect(entries).toEqual([])
  })
})

describe('runWithTimeout', () => {
  it('正常系: 成功するコマンドの stdout を返す', async () => {
    const out = await runWithTimeout(['echo', 'hello'], process.cwd(), 3000)
    expect(out.trim()).toBe('hello')
  })

  it('境界: 存在しないコマンドは空文字列を返す (throw しない)', async () => {
    const out = await runWithTimeout(
      ['this-command-does-not-exist-aaa'],
      process.cwd(),
      3000
    )
    expect(out).toBe('')
  })

  it('境界: 空コマンドは即座に空文字列を返す', async () => {
    const out = await runWithTimeout([], process.cwd(), 3000)
    expect(out).toBe('')
  })

  it('境界: タイムアウトしても部分 stdout を返す (kill 後)', async () => {
    // sleep 5 を 200ms でタイムアウトさせる。出力前に kill されるので空文字。
    const start = Date.now()
    const out = await runWithTimeout(['sleep', '5'], process.cwd(), 200)
    const elapsed = Date.now() - start
    expect(out).toBe('')
    expect(elapsed).toBeLessThan(2000) // タイムアウトが効いているはず
  })
})
