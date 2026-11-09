import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { deleteProjectImage, listProjectImages, projectImageDirectory, projectImagePath, saveProjectImage } from './project-images.js'

const projectId = 'project-0123456789abcdef'
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

test('stores, lists and deletes a validated project image in the temporary directory', () => {
  fs.rmSync(projectImageDirectory(projectId), { recursive: true, force: true })
  const saved = saveProjectImage(projectId, '../Product hero.png', 'image/png', png)
  assert.match(saved.name, /^\d+-[a-f0-9]{8}-Product-hero\.png$/)
  assert.equal(saved.path.startsWith(projectImageDirectory(projectId)), true)
  assert.deepEqual(listProjectImages(projectId).map(image => image.name), [saved.name])
  assert.equal(projectImagePath(projectId, saved.name).mimeType, 'image/png')
  deleteProjectImage(projectId, saved.name)
  assert.deepEqual(listProjectImages(projectId), [])
})

test('rejects spoofed and unsupported image content', () => {
  assert.throws(() => saveProjectImage(projectId, 'fake.png', 'image/png', Buffer.from('<svg></svg>')), /Only PNG/)
  assert.throws(() => saveProjectImage(projectId, 'photo.jpg', 'image/jpeg', png), /does not match/)
  assert.throws(() => projectImagePath(projectId, '../secret.png'), /Image not found/)
})

test('does not list or serve symbolic links from the temporary image directory', () => {
  const directory = projectImageDirectory(projectId)
  fs.mkdirSync(directory, { recursive: true })
  const link = `${directory}/outside.png`
  try { fs.symlinkSync('/etc/hosts', link) } catch { /* A previous interrupted run may have left the link. */ }
  assert.equal(listProjectImages(projectId).some(image => image.name === 'outside.png'), false)
  assert.throws(() => projectImagePath(projectId, 'outside.png'), /Image not found/)
  fs.rmSync(link, { force: true })
})
