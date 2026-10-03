import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SessionEvent, Task } from '../../protocol/src/types.js'

export type DeletedTask = { task: Task; events: SessionEvent[]; deletedAt: string }
type CacheState = { tasks: Task[]; events: SessionEvent[]; hiddenCodexSessionIds?: string[]; deletedTasks?: DeletedTask[] }

const relayDataDirectory = process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web')
const cachePath = (projectPath: string) => path.join(relayDataDirectory, 'projects', createHash('sha256').update(projectPath).digest('hex'), 'state.json')

const readState = (target: string): CacheState | null => {
  try {
    const raw = fs.readFileSync(target, 'utf8')
    const parsed = JSON.parse(raw) as CacheState
    if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.events)) return null
    return parsed
  } catch { return null }
}

export function loadProjectCache(projectPath: string): CacheState | null {
  return readState(cachePath(projectPath))
}

export function saveProjectCache(projectPath: string, state: CacheState) {
  const target = cachePath(projectPath)
  const directory = path.dirname(target)
  fs.mkdirSync(directory, { recursive: true })
  const temporary = `${target}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(temporary, target)
}
