// Tail a file: emit new bytes appended to the file as utf-8 chunks.
// Uses chokidar to watch for changes, then reads the delta from a tracked offset.

import { promises as fs } from 'node:fs'
import * as chokidar from 'chokidar'

export class TailWatcher {
  private watcher: chokidar.FSWatcher | null = null
  private offset = 0
  private polling = false
  private stopped = false

  constructor(private file: string, private onChunk: (chunk: string) => void) {}

  async start(): Promise<void> {
    // Reset to 0 on start; if file already has content, emit it.
    this.offset = 0
    this.watcher = chokidar.watch(this.file, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      usePolling: false
    })
    this.watcher.on('add', () => void this.poll())
    this.watcher.on('change', () => void this.poll())
    // initial poll in case file already exists
    await this.poll()
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(this.file)
      } catch {
        return
      }
      if (stat.size <= this.offset) return
      const fd = await fs.open(this.file, 'r')
      try {
        const len = stat.size - this.offset
        const buf = Buffer.alloc(len)
        await fd.read(buf, 0, len, this.offset)
        this.offset = stat.size
        this.onChunk(buf.toString('utf8'))
      } finally {
        await fd.close()
      }
    } finally {
      this.polling = false
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
  }
}
