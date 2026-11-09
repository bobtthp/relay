import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

type UploadShare = { token: string; createdAt: string }
type UploadShares = Record<string, UploadShare>

const dataDirectory = process.env.RELAY_DATA_DIR ?? path.join(os.homedir(), '.relay-web')
const sharesPath = path.join(dataDirectory, 'image-upload-shares.json')

const readShares = (): UploadShares => {
  try {
    const value = JSON.parse(fs.readFileSync(sharesPath, 'utf8')) as UploadShares
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

const writeShares = (shares: UploadShares) => {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(sharesPath, JSON.stringify(shares, null, 2), { mode: 0o600 })
  fs.chmodSync(sharesPath, 0o600)
}

export const projectImageShare = (projectId: string) => readShares()[projectId]

export const createProjectImageShare = (projectId: string) => {
  const shares = readShares()
  const share = { token: randomBytes(32).toString('base64url'), createdAt: new Date().toISOString() }
  shares[projectId] = share
  writeShares(shares)
  return share
}

export const deleteProjectImageShare = (projectId: string) => {
  const shares = readShares()
  delete shares[projectId]
  writeShares(shares)
}

export const projectIdForImageShare = (token: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
  return Object.entries(readShares()).find(([, share]) => share.token === token)?.[0]
}
