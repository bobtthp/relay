import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const OUTPUT_TAIL_LIMIT = 16_000

export type RegressionStep = { label: string; command: string }
export type RegressionStepResult = RegressionStep & { passed: boolean; exitCode: number | null; durationMs: number; outputTail: string; timedOut: boolean }

const shellValue = String.raw`(?:"[^"]+"|'[^']+'|\S+)`
const gitCommitPattern = new RegExp(String.raw`(?:^|[;&|]\s*)(?:env\s+\S+\s+)*(?:\/usr\/bin\/)?git(?:\s+(?:-C|-c)\s+${shellValue})*\s+commit(?:\s|$)`)
export const isGitCommitCommand = (command?: string) => Boolean(command && gitCommitPattern.test(command))

export function discoverRegressionSteps(projectPath: string): RegressionStep[] {
  if (fs.existsSync(path.join(projectPath, 'scripts/ci-local.mjs'))) return [{ label: 'ci-local', command: 'node scripts/ci-local.mjs' }]
  if (fs.existsSync(path.join(projectPath, 'scripts/ci-local.sh'))) return [{ label: 'ci-local', command: 'bash scripts/ci-local.sh' }]
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    const scripts = packageJson.scripts ?? {}
    return ['check', 'test', 'build', 'test:ui-install']
      .filter(name => typeof scripts[name] === 'string')
      .map(name => ({ label: name, command: name === 'test' ? 'npm test' : `npm run ${name}` }))
  } catch { /* Try language-specific fallbacks below. */ }
  if (fs.existsSync(path.join(projectPath, 'go.mod'))) return [{ label: 'go test', command: 'go test ./...' }]
  if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) return [{ label: 'cargo test', command: 'cargo test' }]
  return []
}

export async function projectSnapshot(projectPath: string) {
  const hash = createHash('sha256')
  const { stdout: diff } = await execFileAsync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: projectPath, encoding: 'buffer', maxBuffer: 24 * 1024 * 1024 })
  hash.update(diff)
  const { stdout: untrackedOutput } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: projectPath, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 })
  const untracked = untrackedOutput.toString('utf8').split('\0').filter(Boolean).sort()
  for (const relativePath of untracked) {
    hash.update(`\0${relativePath}\0`)
    const absolutePath = path.join(projectPath, relativePath)
    const stat = fs.lstatSync(absolutePath)
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolutePath))
    else if (stat.isFile() && stat.size <= 2 * 1024 * 1024) hash.update(fs.readFileSync(absolutePath))
    else hash.update(`${stat.size}:${stat.mtimeMs}`)
  }
  return hash.digest('hex')
}

export async function runRegressionStep(step: RegressionStep, projectPath: string, timeoutMs = 20 * 60_000): Promise<RegressionStepResult> {
  const startedAt = Date.now()
  return new Promise(resolve => {
    const child = spawn('/bin/zsh', ['-lc', step.command], { cwd: projectPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    let timedOut = false
    let settled = false
    const append = (chunk: unknown) => { tail = `${tail}${String(chunk)}`.slice(-OUTPUT_TAIL_LIMIT) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...step, passed: exitCode === 0 && !timedOut, exitCode, durationMs: Date.now() - startedAt, outputTail: redactRegressionOutput(tail.trim()), timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 5_000).unref()
    }, timeoutMs)
    child.once('error', error => { append(error.message); finish(null) })
    child.once('exit', code => finish(code))
  })
}

export const redactRegressionOutput = (output: string) => output
  .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1***')
  .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '***')
  .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s]+/gi, '$1***')

const noteworthySuccessOutput = (output: string) => output.split('\n')
  .filter(line => /\b(?:warn(?:ing)?|skip(?:ped)?|flaky|retr(?:y|ied)|coverage)\b/i.test(line))
  .slice(-40)
  .join('\n')

export const regressionReviewPrompt = (steps: RegressionStepResult[]) => {
  const details = steps.map(step => {
    const relevantOutput = step.passed ? noteworthySuccessOutput(step.outputTail) : step.outputTail
    return `${step.label}: ${step.passed ? 'PASS' : 'FAIL'} exit=${step.exitCode ?? 'unknown'} duration=${Math.round(step.durationMs / 100) / 10}s${relevantOutput ? `\n${relevantOutput}` : ''}`
  }).join('\n\n')
  return `Review this deterministic pre-commit regression result. Do not claim a failed command passed. Return one JSON object only: {"verdict":"PASS"|"BLOCKED","summary":"concise reason"}. A PASS is allowed only when every command passed and the output has no warning that should block a commit.\n\n${details}`
}

export function parseRegressionVerdict(text: string) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[0]) as { verdict?: unknown; summary?: unknown }
    if ((value.verdict !== 'PASS' && value.verdict !== 'BLOCKED') || typeof value.summary !== 'string' || !value.summary.trim()) return undefined
    return { verdict: value.verdict, summary: value.summary.trim().slice(0, 1_000) }
  } catch { return undefined }
}
