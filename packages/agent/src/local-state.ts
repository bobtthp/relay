import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Machine, Project, SessionEvent, Task } from '../../protocol/src/types.js'
import { savedProjectPaths } from './local-project.js'


const gitInfo = (projectPath: string) => {
  const run = (args: string[]) => { try { return execFileSync('git', args, { cwd: projectPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
  return { branch: run(['branch', '--show-current']) || 'detached', clean: run(['status', '--porcelain']) === '' }
}

export const machines: Machine[] = [{
  id: 'machine-local',
  name: os.hostname(),
  status: 'connected',
  platform: `${os.type()} ${os.release()}`,
  architecture: os.arch(),
}]

const projectIdForPath = (projectPath: string) => `project-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}`
const project = (projectPath: string): Project => ({ id: projectIdForPath(projectPath), machineId: 'machine-local', name: path.basename(projectPath), path: projectPath, ...gitInfo(projectPath) })
export const projects: Project[] = savedProjectPaths().map(project)

export function refreshProjects(selectedPath: string) {
  const paths = savedProjectPaths()
  projects.splice(0, projects.length, ...paths.map(project))
}

export const tasks: Task[] = []
export const events: SessionEvent[] = []
