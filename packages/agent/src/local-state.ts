import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Machine, Project, SessionEvent, Task } from '../../protocol/src/types.js'
import { savedProjectPaths } from './local-project.js'

const execFileAsync = promisify(execFile)

const gitInfo = () => ({ branch: 'detached', clean: false })

const refreshProjectGitInfo = async (project: Project) => {
  const run = async (args: string[]) => {
    const { stdout } = await execFileAsync('git', ['-C', project.path, ...args], {
      encoding: 'utf8',
      timeout: 2_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    return stdout.trim()
  }
  try {
    const [branch, status] = await Promise.all([run(['branch', '--show-current']), run(['status', '--porcelain'])])
    project.branch = branch || 'detached'
    project.clean = status === ''
  } catch { /* Keep the fast local fallback when Git or the filesystem is unavailable. */ }
}

const refreshProjectGitInfoInBackground = (items: Project[]) => {
  const timer = setTimeout(() => {
    void (async () => {
      for (const item of items) await refreshProjectGitInfo(item)
    })()
  }, 0)
  timer.unref()
}

export const machines: Machine[] = [{
  id: 'machine-local',
  name: os.hostname(),
  status: 'connected',
  platform: `${os.type()} ${os.release()}`,
  architecture: os.arch(),
}]

const projectIdForPath = (projectPath: string) => `project-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}`
const project = (projectPath: string): Project => ({ id: projectIdForPath(projectPath), machineId: 'machine-local', name: path.basename(projectPath), path: projectPath, ...gitInfo() })
export const projects: Project[] = savedProjectPaths().map(project)
refreshProjectGitInfoInBackground(projects)

export function refreshProjects(selectedPath: string) {
  const paths = savedProjectPaths()
  projects.splice(0, projects.length, ...paths.map(project))
  refreshProjectGitInfoInBackground(projects)
}

export const tasks: Task[] = []
export const events: SessionEvent[] = []
