import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Image as ImageIcon, Link2, RefreshCw, Trash2, UploadCloud, X } from 'lucide-react'
import { authenticatedFetch } from './services/auth'

type ProjectImage = { name: string; path: string; size: number; mimeType: string; createdAt: string; previewUrl: string }
type UploadShare = { active: boolean; url?: string; createdAt?: string }

const acceptedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const responseError = async (response: Response, fallback: string) => {
  const body = await response.json().catch(() => ({})) as { error?: string }
  return body.error ?? fallback
}

function ImagePreview({ image }: { image: ProjectImage }) {
  const [source, setSource] = useState('')
  useEffect(() => {
    let active = true
    let objectUrl = ''
    void authenticatedFetch(image.previewUrl).then(async response => {
      if (!response.ok) return
      objectUrl = URL.createObjectURL(await response.blob())
      if (active) setSource(objectUrl)
      else URL.revokeObjectURL(objectUrl)
    })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [image.previewUrl])
  return source ? <img src={source} alt={image.name} /> : <div className="image-preview-placeholder"><ImageIcon size={24} /></div>
}

export function ProjectImagesPanel({ projectId, projectName, language, notify }: { projectId: string; projectName: string; language: 'en' | 'zh'; notify: (message: string) => void }) {
  const [images, setImages] = useState<ProjectImage[]>([])
  const [share, setShare] = useState<UploadShare>({ active: false })
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [imagesResponse, shareResponse] = await Promise.all([
        authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/images`),
        authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/image-upload-share`),
      ])
      if (!imagesResponse.ok) throw new Error(await responseError(imagesResponse, 'Unable to load images'))
      if (!shareResponse.ok) throw new Error(await responseError(shareResponse, 'Unable to load upload link'))
      setImages(((await imagesResponse.json()) as { items: ProjectImage[] }).items)
      setShare(await shareResponse.json() as UploadShare)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load images') }
    finally { setLoading(false) }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const uploadFiles = async (files: File[]) => {
    const invalid = files.find(file => !acceptedImageTypes.has(file.type) || file.size > 10 * 1024 * 1024)
    if (invalid) { setError(language === 'zh' ? `${invalid.name} 不是支持的图片，或超过 10 MB` : `${invalid.name} is unsupported or larger than 10 MB`); return }
    if (!files.length) return
    setUploading(true)
    setError('')
    try {
      for (const file of files) {
        const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/images`, {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-Relay-Filename': encodeURIComponent(file.name) },
          body: file,
        })
        if (!response.ok) throw new Error(await responseError(response, language === 'zh' ? '上传失败' : 'Upload failed'))
      }
      notify(language === 'zh' ? `已上传 ${files.length} 张图片` : `Uploaded ${files.length} image${files.length === 1 ? '' : 's'}`)
      if (inputRef.current) inputRef.current.value = ''
      await load()
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : 'Upload failed') }
    finally { setUploading(false) }
  }

  const copy = async (value: string, message: string) => {
    try { await navigator.clipboard.writeText(value); notify(message) }
    catch { setError(language === 'zh' ? '复制失败，请手动选择文本' : 'Copy failed. Select the text manually.') }
  }

  const updateShare = async () => {
    setError('')
    const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/image-upload-share`, { method: 'POST' })
    if (!response.ok) { setError(await responseError(response, 'Unable to create upload link')); return }
    const next = await response.json() as UploadShare
    setShare(next)
    if (next.url) await copy(next.url, language === 'zh' ? '协作上传链接已复制' : 'Upload link copied')
  }

  const disableShare = async () => {
    const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/image-upload-share`, { method: 'DELETE' })
    if (!response.ok) { setError(await responseError(response, 'Unable to disable upload link')); return }
    setShare({ active: false })
    notify(language === 'zh' ? '协作上传链接已关闭' : 'Upload link disabled')
  }

  const removeImage = async (image: ProjectImage) => {
    if (!window.confirm(language === 'zh' ? `删除 ${image.name}？` : `Delete ${image.name}?`)) return
    const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(image.name)}`, { method: 'DELETE' })
    if (!response.ok) { setError(await responseError(response, 'Unable to delete image')); return }
    setImages(current => current.filter(item => item.name !== image.name))
  }

  return <section className="images-page">
    <div className="content-header"><div className="breadcrumbs"><span className="muted">{language === 'zh' ? '项目' : 'Projects'}</span><span>›</span><strong>{language === 'zh' ? '图片' : 'Images'}</strong></div><button className="secondary-btn" onClick={() => void load()}><RefreshCw size={14} /> {language === 'zh' ? '刷新' : 'Refresh'}</button></div>
    <section className="project-hero images-hero"><div><span className="eyebrow">TEMPORARY PROJECT ASSETS</span><h1>{language === 'zh' ? `${projectName} 图片库` : `${projectName} images`}</h1><p className="path">/tmp/relay/uploads/{projectId}/</p></div><span className="images-temporary-note">{language === 'zh' ? '临时文件 · 系统可能自动清理' : 'Temporary · may be cleaned automatically'}</span></section>

    <div className="images-layout">
      <section className="image-upload-card">
        <div><span className="eyebrow">{language === 'zh' ? '上传' : 'UPLOAD'}</span><h2>{language === 'zh' ? '添加图片' : 'Add images'}</h2></div>
        <label className={`image-drop-zone ${dragging ? 'dragging' : ''}`} onDragEnter={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); setDragging(false); void uploadFiles([...event.dataTransfer.files]) }}>
          <UploadCloud size={28} /><strong>{language === 'zh' ? '拖放图片，或点击选择' : 'Drop images or click to choose'}</strong><small>PNG, JPEG, GIF, WebP · 10 MB</small>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple disabled={uploading} onChange={event => void uploadFiles([...(event.target.files ?? [])])} />
        </label>
        {uploading && <p className="images-status">{language === 'zh' ? '正在上传…' : 'Uploading…'}</p>}
      </section>

      <section className="image-share-card">
        <div><span className="eyebrow">{language === 'zh' ? '协作' : 'COLLABORATE'}</span><h2>{language === 'zh' ? '公开上传页' : 'Shared upload page'}</h2></div>
        <p>{language === 'zh' ? '持有链接的人可以上传图片，但看不到图片列表和本地路径。仅在可信局域网或 Tailscale 内分享。' : 'Anyone with the link can upload, but cannot see the library or local paths. Share only on a trusted LAN or Tailscale.'}</p>
        {share.active && share.url ? <div className="image-share-link"><code>{share.url}</code><button className="icon-btn" onClick={() => void copy(share.url!, language === 'zh' ? '链接已复制' : 'Link copied')} aria-label={language === 'zh' ? '复制链接' : 'Copy link'}><Copy size={15} /></button></div> : <p className="images-status">{language === 'zh' ? '协作上传尚未开启' : 'Shared uploading is off'}</p>}
        <div className="image-share-actions"><button className="primary-btn" onClick={() => void updateShare()}><Link2 size={14} /> {share.active ? (language === 'zh' ? '重新生成链接' : 'Regenerate link') : (language === 'zh' ? '创建上传链接' : 'Create upload link')}</button>{share.active && <button className="secondary-btn" onClick={() => void disableShare()}><X size={14} /> {language === 'zh' ? '关闭' : 'Disable'}</button>}</div>
      </section>
    </div>

    {error && <p className="images-error">{error}</p>}
    <div className="images-list-header"><div><span className="eyebrow">{language === 'zh' ? '已上传' : 'UPLOADED'}</span><h2>{language === 'zh' ? '项目图片' : 'Project images'} <small>{images.length}</small></h2></div></div>
    {loading ? <p className="environment-loading">{language === 'zh' ? '正在加载图片…' : 'Loading images…'}</p> : images.length ? <div className="image-grid">{images.map(image => <article className="image-card" key={image.name}>
      <div className="image-preview"><ImagePreview image={image} /></div>
      <div className="image-card-body"><strong title={image.name}>{image.name}</strong><small>{(image.size / 1024).toFixed(image.size < 1024 * 100 ? 1 : 0)} KB · {new Date(image.createdAt).toLocaleString()}</small><code title={image.path}>{image.path}</code><div className="image-card-actions"><button className="secondary-btn" onClick={() => void copy(image.path, language === 'zh' ? '本地路径已复制' : 'Local path copied')}><Copy size={13} /> {language === 'zh' ? '复制路径' : 'Copy path'}</button><button className="icon-btn image-delete" onClick={() => void removeImage(image)} aria-label={language === 'zh' ? '删除图片' : 'Delete image'}><Trash2 size={14} /></button></div></div>
    </article>)}</div> : <div className="images-empty"><ImageIcon size={26} /><strong>{language === 'zh' ? '还没有图片' : 'No images yet'}</strong><span>{language === 'zh' ? '从本页或协作上传页添加图片。' : 'Add images here or from the shared upload page.'}</span></div>}
  </section>
}
