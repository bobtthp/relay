import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const dataDirectory = process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web')
const selectionPath = path.join(dataDirectory, 'selected-project.json')
const homeDirectory = os.homedir()

export type DirectoryEntry = { name: string; path: string; isGit: boolean }

export const isGitRepository = (directory: string) => {
  try { return execFileSync('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true' }
  catch { return false }
}

export function selectedProjectPath() {
  try {
    const value = JSON.parse(fs.readFileSync(selectionPath, 'utf8')) as { selectedPath?: string; paths?: string[]; path?: string }
    const selectedPath = value.selectedPath ?? value.path
    if (selectedPath && fs.statSync(selectedPath).isDirectory() && isGitRepository(selectedPath)) return selectedPath
  } catch { /* First launch or an unavailable previous project. */ }
  return undefined
}

export function saveSelectedProject(projectPath: string) {
  let paths: string[] = []
  try { paths = (JSON.parse(fs.readFileSync(selectionPath, 'utf8')) as { paths?: string[] }).paths ?? [] } catch { /* First saved project. */ }
  paths = [projectPath, ...paths.filter(item => item !== projectPath)].filter(item => {
    try { return fs.statSync(item).isDirectory() && isGitRepository(item) } catch { return false }
  }).slice(0, 20)
  fs.mkdirSync(dataDirectory, { recursive: true })
  fs.writeFileSync(selectionPath, JSON.stringify({ selectedPath: projectPath, paths }, null, 2), 'utf8')
}

export function savedProjectPaths() {
  let paths: string[] = []
  try { paths = (JSON.parse(fs.readFileSync(selectionPath, 'utf8')) as { paths?: string[] }).paths ?? [] } catch { /* First launch. */ }
  const selectedPath = selectedProjectPath()
  const candidates = [selectedPath, ...paths].filter((item): item is string => typeof item === 'string')
  return candidates.filter((item, index, values) => values.indexOf(item) === index && isGitRepository(item))
}

export function removeSavedProject(projectPath: string) {
  const remaining = savedProjectPaths().filter(item => item !== projectPath)
  if (remaining.length === 0) throw new Error('Keep at least one workspace')
  fs.mkdirSync(dataDirectory, { recursive: true })
  fs.writeFileSync(selectionPath, JSON.stringify({ selectedPath: remaining[0], paths: remaining }, null, 2), 'utf8')
  return remaining[0]
}

export function listDirectories(requestedPath?: string) {
  const resolved = path.resolve(requestedPath || homeDirectory)
  if (resolved !== homeDirectory && !resolved.startsWith(`${homeDirectory}${path.sep}`)) throw new Error('Only directories inside the current user home are available')
  const entries: DirectoryEntry[] = []
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const child = path.join(resolved, entry.name)
    entries.push({ name: entry.name, path: child, isGit: isGitRepository(child) })
  }
  return { path: resolved, parent: resolved === homeDirectory ? null : path.dirname(resolved), items: entries.sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name)).slice(0, 200) }
}

export function validateProjectPath(candidate: string) {
  const resolved = path.resolve(candidate)
  if (resolved !== homeDirectory && !resolved.startsWith(`${homeDirectory}${path.sep}`)) throw new Error('Project must be inside the current user home directory')
  if (!fs.statSync(resolved).isDirectory()) throw new Error('Project path is not a directory')
  if (!isGitRepository(resolved)) throw new Error('Select a Git repository')
  return resolved
}
