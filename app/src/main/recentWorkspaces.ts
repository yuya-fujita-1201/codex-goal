// Persists recent workspaces in <userData>/recent-workspaces.json.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

import type { RecentWorkspace } from '@shared/types'

const MAX_RECENT = 10

function storePath(): string {
  return path.join(app.getPath('userData'), 'recent-workspaces.json')
}

async function read(): Promise<RecentWorkspace[]> {
  try {
    const data = await fs.readFile(storePath(), 'utf8')
    const parsed = JSON.parse(data)
    if (Array.isArray(parsed)) return parsed as RecentWorkspace[]
    return []
  } catch {
    return []
  }
}

async function write(items: RecentWorkspace[]): Promise<void> {
  await fs.mkdir(path.dirname(storePath()), { recursive: true })
  await fs.writeFile(storePath(), JSON.stringify(items, null, 2), 'utf8')
}

export async function listRecent(): Promise<RecentWorkspace[]> {
  const items = await read()
  // Filter out entries pointing to non-existent directories.
  const surviving: RecentWorkspace[] = []
  for (const item of items) {
    try {
      const stat = await fs.stat(item.path)
      if (stat.isDirectory()) surviving.push(item)
    } catch {
      // skip
    }
  }
  if (surviving.length !== items.length) await write(surviving)
  return surviving
}

export async function addRecent(workspacePath: string): Promise<RecentWorkspace[]> {
  const items = await read()
  const filtered = items.filter((it) => it.path !== workspacePath)
  filtered.unshift({
    path: workspacePath,
    last_opened_at: new Date().toISOString()
  })
  const trimmed = filtered.slice(0, MAX_RECENT)
  await write(trimmed)
  return trimmed
}

export async function removeRecent(workspacePath: string): Promise<RecentWorkspace[]> {
  const items = await read()
  const filtered = items.filter((it) => it.path !== workspacePath)
  await write(filtered)
  return filtered
}
