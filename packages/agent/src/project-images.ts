import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const MAX_PROJECT_IMAGE_BYTES = 10 * 1024 * 1024

type SupportedImage = { extension: 'png' | 'jpg' | 'gif' | 'webp'; mimeType: string }
export type ProjectImage = { name: string; path: string; size: number; mimeType: string; createdAt: string }

const relayTempRoot = path.join('/tmp', 'relay')
const imageRoot = path.join(relayTempRoot, 'uploads')
const imageTypes: Record<SupportedImage['extension'], string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

const safeProjectId = (projectId: string) => {
  if (!/^project-[a-f0-9]{16}$/.test(projectId)) throw new Error('Invalid project id')
  return projectId
}

export const projectImageDirectory = (projectId: string) => path.join(imageRoot, safeProjectId(projectId))

const ensurePrivateDirectory = (directory: string) => {
  try { fs.mkdirSync(directory, { mode: 0o700 }) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  const stats = fs.lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe temporary image directory: ${directory}`)
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new Error(`Temporary image directory is owned by another user: ${directory}`)
  fs.chmodSync(directory, 0o700)
}

const secureProjectImageDirectory = (projectId: string) => {
  ensurePrivateDirectory(relayTempRoot)
  ensurePrivateDirectory(imageRoot)
  const directory = projectImageDirectory(projectId)
  ensurePrivateDirectory(directory)
  return directory
}

const detectImage = (data: Buffer): SupportedImage | undefined => {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { extension: 'png', mimeType: imageTypes.png }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { extension: 'jpg', mimeType: imageTypes.jpg }
  if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) return { extension: 'gif', mimeType: imageTypes.gif }
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return { extension: 'webp', mimeType: imageTypes.webp }
  return undefined
}

const safeStem = (originalName: string) => {
  const stem = path.basename(originalName, path.extname(originalName)).normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  return stem || 'image'
}

const imageMetadata = (directory: string, name: string): ProjectImage | undefined => {
  const extension = path.extname(name).slice(1).toLowerCase() as SupportedImage['extension']
  const mimeType = imageTypes[extension]
  if (!mimeType || path.basename(name) !== name) return undefined
  try {
    const target = path.join(directory, name)
    const stats = fs.lstatSync(target)
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined
    return { name, path: target, size: stats.size, mimeType, createdAt: stats.birthtime.toISOString() }
  } catch { return undefined }
}

export const listProjectImages = (projectId: string): ProjectImage[] => {
  const directory = secureProjectImageDirectory(projectId)
  try {
    return fs.readdirSync(directory).flatMap(name => imageMetadata(directory, name) ?? []).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  } catch { return [] }
}

export const saveProjectImage = (projectId: string, originalName: string, declaredMimeType: string, data: Buffer): ProjectImage => {
  if (!data.length) throw new Error('Choose a non-empty image')
  if (data.length > MAX_PROJECT_IMAGE_BYTES) throw new Error('Image must be 10 MB or smaller')
  const detected = detectImage(data)
  if (!detected) throw new Error('Only PNG, JPEG, GIF and WebP images are supported')
  if (declaredMimeType && declaredMimeType !== 'application/octet-stream' && declaredMimeType !== detected.mimeType) throw new Error('Image content does not match its media type')
  const directory = secureProjectImageDirectory(projectId)
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeStem(originalName)}.${detected.extension}`
  fs.writeFileSync(path.join(directory, name), data, { flag: 'wx', mode: 0o600 })
  return imageMetadata(directory, name)!
}

export const projectImagePath = (projectId: string, name: string) => {
  const metadata = imageMetadata(secureProjectImageDirectory(projectId), name)
  if (!metadata) throw new Error('Image not found')
  return metadata
}

export const deleteProjectImage = (projectId: string, name: string) => {
  const image = projectImagePath(projectId, name)
  fs.unlinkSync(image.path)
}
