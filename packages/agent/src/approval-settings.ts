import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ApprovalSettings = {
  autoApproveConfirmations: boolean
  autoAcceptDefaultMcpForms: boolean
}

const dataDirectory = process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web')
const settingsPath = path.join(dataDirectory, 'approval-settings.json')
const defaults: ApprovalSettings = {
  autoApproveConfirmations: false,
  autoAcceptDefaultMcpForms: false,
}

export function readApprovalSettings(): ApprovalSettings {
  try {
    const stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Partial<ApprovalSettings>
    return {
      autoApproveConfirmations: stored.autoApproveConfirmations === true,
      autoAcceptDefaultMcpForms: stored.autoAcceptDefaultMcpForms === true,
    }
  } catch {
    return { ...defaults }
  }
}

export function writeApprovalSettings(settings: ApprovalSettings) {
  fs.mkdirSync(dataDirectory, { recursive: true })
  const temporaryPath = `${settingsPath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, settingsPath)
}
