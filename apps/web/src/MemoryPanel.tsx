import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { authenticatedFetch } from './services/auth'

type MemoryEntry = { file: string; name: string; description: string; type?: string; author?: string; source?: string; createdAt?: string; updatedAt?: string; revision: string; body: string }
type ImportFile = { file: string; name: string; description: string; target: string; conflict: boolean }
type ConsolidationOperation =
  | { op: 'update'; file: string; name: string; description: string; body: string; reason: string }
  | { op: 'merge'; sources: string[]; file: string; name: string; description: string; body: string; reason: string }
  | { op: 'delete'; file: string; reason: string }
type ConsolidationProposal = { createdAt: string; agent: 'Claude' | 'Codex'; model?: string; tokens: number; tokensMeasured: boolean; summary: string; operations: ConsolidationOperation[] }
type MemoryState = {
  enabled: boolean
  directory: string
  entries: MemoryEntry[]
  stats: { entries: number; indexBytes: number; indexBudget: number; estimatedConsolidationTokens: number; suggestConsolidation: boolean }
  consolidation: { pending?: ConsolidationProposal; history: Array<{ at: string; agent: string; tokens: number; applied: boolean; operations: number }>; running: boolean }
  claudeImport: { imported: true; at: string; files: Array<{ source: string; target: string }> } | { imported: false; sourceDirectory: string | null; files: ImportFile[] }
}
type AuditRecord = { at: string; file: string; action: 'created' | 'updated' | 'deleted'; actor: string }
type MemoryUsage = { injected: number; tools: number; consolidation: number; total: number; taskTotal: number; share: number | null; items: Array<{ id: string; title: string; agent: string; injected: number; tools: number; taskTotal: number | null }> }
type Draft = { file: string; name: string; description: string; type: string; body: string; revision?: string }

const memoryTypes = ['project', 'feedback', 'user', 'reference']
const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, init?.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init)
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`)
  return body
}

export function MemoryPanel({ projectId, projectName, language, reloadKey, notify: notifyProp }: { projectId: string; projectName: string; language: 'en' | 'zh'; reloadKey: number; notify: (message: string) => void }) {
  const zh = language === 'zh'
  // The parent recreates notify on every render; a ref keeps load() stable.
  const notifyRef = useRef(notifyProp)
  notifyRef.current = notifyProp
  const notify = useCallback((message: string) => notifyRef.current(message), [])
  const base = `/api/projects/${encodeURIComponent(projectId)}/memory`
  const [state, setState] = useState<MemoryState | null>(null)
  const [audit, setAudit] = useState<AuditRecord[]>([])
  const [usage, setUsage] = useState<MemoryUsage | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [importSelection, setImportSelection] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [consolidationAgent, setConsolidationAgent] = useState<'Claude' | 'Codex'>('Claude')

  const load = useCallback(() => {
    void request<MemoryState>(base).then(next => {
      setState(next)
      if (!next.claudeImport.imported) setImportSelection(new Set(next.claudeImport.files.map(file => file.file)))
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to load memory'))
    void request<{ items: AuditRecord[] }>(`${base}/audit?limit=50`).then(body => setAudit(body.items)).catch(() => undefined)
    void request<MemoryUsage>(`${base}/usage`).then(setUsage).catch(() => undefined)
  }, [base, notify])
  useEffect(() => { load() }, [load, reloadKey])

  const run = (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    void action().then(() => { notify(done); load() }).catch(error => notify(error instanceof Error ? error.message : 'Request failed')).finally(() => setBusy(false))
  }
  const toggle = (enabled: boolean) => run(() => request(`${base}/settings`, { method: 'PUT', body: JSON.stringify({ enabled }) }), enabled ? (zh ? '已开启本项目的共享记忆' : 'Shared memory enabled for this project') : (zh ? '已关闭共享记忆' : 'Shared memory disabled'))
  const save = () => {
    if (!draft) return
    const file = draft.file || `${slugify(draft.name) || 'memory'}.md`
    run(async () => {
      await request(`${base}/entries/${encodeURIComponent(file)}`, { method: 'PUT', body: JSON.stringify({ name: draft.name, description: draft.description, type: draft.type, body: draft.body, revision: draft.revision }) })
      setDraft(null)
    }, zh ? '记忆已保存' : 'Memory saved')
  }
  const remove = () => {
    if (!draft?.revision) return
    run(async () => {
      await request(`${base}/entries/${encodeURIComponent(draft.file)}?revision=${encodeURIComponent(draft.revision!)}`, { method: 'DELETE' })
      setDraft(null)
      setConfirmDelete(false)
    }, zh ? '记忆已删除' : 'Memory deleted')
  }
  const consolidate = () => run(() => request(`${base}/consolidate`, { method: 'POST', body: JSON.stringify({ agent: consolidationAgent }) }), zh ? '整理建议已生成，请确认后应用' : 'Proposal ready; review it before applying')
  const applyProposal = () => run(() => request(`${base}/consolidate/apply`, { method: 'POST' }), zh ? '已应用整理；被合并或删除的记忆已归档' : 'Applied; merged and removed entries were archived')
  const discardProposal = () => run(() => request(`${base}/consolidate`, { method: 'DELETE' }), zh ? '已放弃这次整理建议' : 'Proposal discarded')
  const importClaude = () => run(() => request(`${base}/import-claude`, { method: 'POST', body: JSON.stringify({ files: [...importSelection] }) }), zh ? '已导入所选的 Claude 记忆' : 'Imported the selected Claude memories')
  const rollback = () => run(() => request(`${base}/import-claude/rollback`, { method: 'POST' }), zh ? '已回滚导入；导入后被编辑过的记忆会保留' : 'Import rolled back; entries edited since are kept')
  const formatTime = (value?: string) => value ? new Date(value).toLocaleString(zh ? 'zh-CN' : 'en-US') : '—'
  const actorLabel = (actor?: string) => actor ? ({ claude: 'Claude', codex: 'Codex', user: zh ? '用户' : 'User', relay: 'Relay', unknown: zh ? '未知' : 'Unknown' } as Record<string, string>)[actor] ?? actor : (zh ? '未知' : 'Unknown')

  if (!state) return <section className="memory-page"><p className="environment-loading">{zh ? '正在读取记忆…' : 'Loading memory…'}</p></section>
  const claudeImport = state.claudeImport

  return <section className="memory-page">
    <div className="content-header"><div className="breadcrumbs"><span className="muted">{projectName}</span><ChevronRight size={14} /><strong>{zh ? '共享记忆' : 'Shared memory'}</strong></div><button className="secondary-btn" onClick={load}><RefreshCw size={14} /> {zh ? '刷新' : 'Refresh'}</button></div>
    <section className="memory-hero">
      <label className="sound-toggle memory-toggle"><input type="checkbox" checked={state.enabled} disabled={busy} onChange={event => toggle(event.target.checked)} /><span>{zh ? '本项目开启共享记忆' : 'Shared memory for this project'}</span></label>
      <p className="memory-help">{zh ? 'Codex 和 Claude 共用一份长期记忆。Claude 的自动记忆会写到这里；Codex 只在会话开始和恢复时读取索引，需要时再读单条记忆。关闭后两边恢复各自原来的行为。' : 'Codex and Claude share one long-term memory. Claude’s auto-memory writes here; Codex receives the index when a session starts or resumes and reads entries on demand. When off, both keep their own behavior.'}</p>
      <code className="memory-path">{state.directory}</code>
    </section>

    {state.enabled && !claudeImport.imported && claudeImport.sourceDirectory && claudeImport.files.length > 0 && <section className="memory-card">
      <span className="eyebrow">{zh ? '导入 CLAUDE 记忆' : 'IMPORT CLAUDE MEMORY'}</span>
      <p className="memory-help">{zh ? `在 ${claudeImport.sourceDirectory} 找到以下记忆。会复制到共享记忆并标记来源为 claude，原文件保持不动；同名的会另存为副本。` : `Found these memories in ${claudeImport.sourceDirectory}. They are copied and tagged source: claude; the originals stay untouched and name clashes get a copy.`}</p>
      {claudeImport.files.map(file => <label className="memory-import-row" key={file.file}><input type="checkbox" checked={importSelection.has(file.file)} onChange={event => setImportSelection(current => { const next = new Set(current); if (event.target.checked) next.add(file.file); else next.delete(file.file); return next })} /><span><strong>{file.name}</strong><small>{file.description}</small>{file.conflict && <small className="memory-conflict">{zh ? `同名，将保存为 ${file.target}` : `Name in use; saved as ${file.target}`}</small>}</span></label>)}
      <button className="primary-btn" disabled={busy || importSelection.size === 0} onClick={importClaude}>{zh ? `导入 ${importSelection.size} 条` : `Import ${importSelection.size}`}</button>
    </section>}
    {state.enabled && state.entries.length >= 2 && <section className={`memory-card ${state.stats.suggestConsolidation ? 'memory-suggest' : ''}`}>
      <span className="eyebrow">{zh ? '整理记忆' : 'CONSOLIDATE'}</span>
      <p className="memory-help">{zh ? `${state.stats.entries} 条 · 索引 ${(state.stats.indexBytes / 1024).toFixed(1)}KB / ${(state.stats.indexBudget / 1024).toFixed(0)}KB` : `${state.stats.entries} entries · index ${(state.stats.indexBytes / 1024).toFixed(1)}KB of ${(state.stats.indexBudget / 1024).toFixed(0)}KB`}{state.stats.suggestConsolidation ? (zh ? ' · 建议整理' : ' · consolidation recommended') : ''}</p>
      <p className="memory-help">{zh ? `把全部记忆交给 Agent 一次性整理（不使用工具），合并重复、删除过时内容。预计约 ${state.stats.estimatedConsolidationTokens.toLocaleString()} tokens。生成的是建议，确认后才会修改。` : `One tool-less pass over all entries to merge duplicates and drop outdated ones, about ${state.stats.estimatedConsolidationTokens.toLocaleString()} tokens. It produces a proposal; nothing changes until you apply it.`}</p>
      {!state.consolidation.pending && <div className="memory-consolidate-row"><select value={consolidationAgent} disabled={busy || state.consolidation.running} onChange={event => setConsolidationAgent(event.target.value as 'Claude' | 'Codex')}><option value="Claude">Claude (sonnet)</option><option value="Codex">Codex</option></select><button className="primary-btn" disabled={busy || state.consolidation.running} onClick={consolidate}>{state.consolidation.running || busy ? (zh ? '正在整理…' : 'Consolidating…') : (zh ? '生成整理建议' : 'Propose consolidation')}</button></div>}
      {state.consolidation.pending && <div className="memory-proposal">
        <p><strong>{state.consolidation.pending.summary || (zh ? '整理建议' : 'Proposal')}</strong></p>
        <p className="memory-help">{state.consolidation.pending.agent}{state.consolidation.pending.model ? ` ${state.consolidation.pending.model}` : ''} · {state.consolidation.pending.tokensMeasured ? '' : '~'}{state.consolidation.pending.tokens.toLocaleString()} tokens · {formatTime(state.consolidation.pending.createdAt)}</p>
        {state.consolidation.pending.operations.length === 0 && <p className="memory-help">{zh ? '无需修改。' : 'Nothing needs to change.'}</p>}
        {state.consolidation.pending.operations.map((operation, index) => <div className={`memory-op ${operation.op}`} key={index}>
          <span className="memory-op-title">{operation.op === 'merge' ? `${zh ? '合并' : 'Merge'} ${operation.sources.join(' + ')} → ${operation.file}` : operation.op === 'update' ? `${zh ? '改写' : 'Rewrite'} ${operation.file}` : `${zh ? '删除（归档）' : 'Remove (archive)'} ${operation.file}`}</span>
          {operation.reason && <small>{operation.reason}</small>}
          {operation.op !== 'delete' && <pre>{`${operation.name} — ${operation.description}\n\n${operation.body}`}</pre>}
        </div>)}
        <div className="modal-actions"><button className="secondary-btn" disabled={busy} onClick={discardProposal}>{zh ? '放弃' : 'Discard'}</button><button className="primary-btn" disabled={busy || state.consolidation.pending.operations.length === 0} onClick={applyProposal}>{zh ? '应用' : 'Apply'}</button></div>
      </div>}
    </section>}

    {claudeImport.imported && <section className="memory-card memory-imported"><span>{zh ? `已于 ${formatTime(claudeImport.at)} 导入 ${claudeImport.files.length} 条 Claude 记忆` : `Imported ${claudeImport.files.length} Claude memories on ${formatTime(claudeImport.at)}`}</span><button className="secondary-btn" disabled={busy} onClick={rollback}>{zh ? '回滚导入' : 'Roll back import'}</button></section>}

    <section className="memory-card">
      <div className="memory-list-header"><span className="eyebrow">{zh ? `记忆 ${state.entries.length}` : `ENTRIES ${state.entries.length}`}</span><button className="secondary-btn" disabled={!state.enabled} onClick={() => { setConfirmDelete(false); setDraft({ file: '', name: '', description: '', type: 'project', body: '' }) }}><Plus size={14} /> {zh ? '新建' : 'New'}</button></div>
      {state.entries.length === 0 && <p className="memory-help">{zh ? '还没有记忆。' : 'No entries yet.'}</p>}
      {state.entries.map(entry => <button className={`memory-entry ${draft?.file === entry.file ? 'active' : ''}`} key={entry.file} onClick={() => { setConfirmDelete(false); setDraft({ file: entry.file, name: entry.name, description: entry.description, type: entry.type ?? 'project', body: entry.body, revision: entry.revision }) }}>
        <span className="memory-entry-title"><strong>{entry.name}</strong><span className={`memory-author ${entry.author ?? 'unknown'}`}>{actorLabel(entry.author)}</span>{entry.source && <span className="memory-source">{zh ? '来源' : 'from'} {entry.source}</span>}</span>
        <small>{entry.description}</small>
        <small className="muted">{zh ? '更新于' : 'Updated'} {formatTime(entry.updatedAt)}{entry.createdAt ? ` · ${zh ? '创建于' : 'created'} ${formatTime(entry.createdAt)}` : ''}</small>
      </button>)}
    </section>

    {draft && <section className="memory-card memory-editor">
      <span className="eyebrow">{draft.revision ? draft.file : (zh ? '新记忆' : 'NEW ENTRY')}</span>
      <label>{zh ? '名称' : 'Name'}<input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="release-process" /></label>
      <label>{zh ? '一句话描述' : 'One-line description'}<input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
      <label>{zh ? '类型' : 'Type'}<select value={draft.type} onChange={event => setDraft({ ...draft, type: event.target.value })}>{memoryTypes.map(type => <option key={type}>{type}</option>)}</select></label>
      <label>{zh ? '内容（请用英文）' : 'Content (in English)'}<textarea rows={8} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
      <div className="modal-actions">
        {draft.revision && (confirmDelete
          ? <><button className="secondary-btn" onClick={() => setConfirmDelete(false)}>{zh ? '取消' : 'Cancel'}</button><button className="secondary-btn memory-danger" disabled={busy} onClick={remove}><Trash2 size={14} /> {zh ? '确认删除' : 'Confirm delete'}</button></>
          : <button className="secondary-btn" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> {zh ? '删除' : 'Delete'}</button>)}
        <button className="secondary-btn" onClick={() => setDraft(null)}>{zh ? '关闭' : 'Close'}</button>
        <button className="primary-btn" disabled={busy || !draft.name.trim() || !draft.body.trim()} onClick={save}>{zh ? '保存' : 'Save'}</button>
      </div>
    </section>}

    {usage && <section className="memory-card">
      <span className="eyebrow">{zh ? '额外 TOKEN（估算）' : 'EXTRA TOKENS (ESTIMATED)'}</span>
      <div className="memory-usage-totals">
        <span><strong>{usage.total.toLocaleString()}</strong>{zh ? '合计' : 'total'}</span>
        <span><strong>{usage.injected.toLocaleString()}</strong>{zh ? '注入（说明 + 索引）' : 'injected (rules + index)'}</span>
        <span><strong>{usage.tools.toLocaleString()}</strong>{zh ? '读写记忆' : 'memory reads/writes'}</span>
        <span><strong>{usage.consolidation.toLocaleString()}</strong>{zh ? '整理' : 'consolidation'}</span>
        <span><strong>{usage.share == null ? '—' : `${(usage.share * 100).toFixed(1)}%`}</strong>{zh ? '占任务总 token' : 'of task tokens'}</span>
      </div>
      {usage.items.map(item => <div className="memory-audit-row" key={item.id}><span className={`memory-author ${item.agent.toLowerCase()}`}>{item.agent}</span><span className="memory-usage-title">{item.title}</span><span className="muted">{zh ? '注入' : 'injected'} {item.injected.toLocaleString()} · {zh ? '读写' : 'tools'} {item.tools.toLocaleString()}{item.taskTotal ? ` / ${item.taskTotal.toLocaleString()}` : ''}</span></div>)}
      <p className="memory-help">{zh ? '按记忆相关内容估算（英文约 4 字符 = 1 token），不是账单数字；注入内容大多命中缓存，实际费用更低。' : 'Estimated from memory-related text (~4 characters per token), not billing data; injected context is mostly cached, so the cost is lower.'}</p>
    </section>}

    <section className="memory-card">
      <span className="eyebrow">{zh ? '变更记录' : 'CHANGE LOG'}</span>
      {audit.length === 0 && <p className="memory-help">{zh ? '暂无记录。' : 'No changes recorded yet.'}</p>}
      {audit.map((record, index) => <div className="memory-audit-row" key={`${record.at}-${record.file}-${index}`}><span className="muted">{formatTime(record.at)}</span><span className={`memory-author ${record.actor}`}>{actorLabel(record.actor)}</span><span>{({ created: zh ? '新建' : 'created', updated: zh ? '更新' : 'updated', deleted: zh ? '删除' : 'deleted' })[record.action]}</span><code>{record.file}</code></div>)}
      <p className="memory-help">{zh ? 'Agent 直接写文件时，Relay 按当时项目里正在运行的 Agent 记录作者；两个同时运行时记为“未知”。' : 'When an agent writes a file directly, Relay attributes it to the agent running in the project at the time, or Unknown if both were running.'}</p>
    </section>
  </section>
}
