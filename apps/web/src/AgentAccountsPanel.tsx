import { useState } from 'react'
import { Copy, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { authenticatedFetch } from './services/auth'
import type { AgentAccount } from './services/apiAgentService'
import type { AgentName } from './services/agentService'

const copyText = async (value: string) => {
  try { await navigator.clipboard.writeText(value); return true } catch { /* Use the HTTP/Safari fallback below. */ }
  const input = document.createElement('textarea')
  input.value = value
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  let copied = false
  try { input.select(); copied = document.execCommand('copy') } finally { input.remove() }
  return copied
}

type RateLimitWindow = { usedPercent: number; windowDurationMins?: number; resetsAt?: number }
type RateLimits = { primary: RateLimitWindow; secondary?: RateLimitWindow | null }
type QuotaState = { loading?: boolean; limits?: RateLimits | null; error?: string }

const quotaWindowLabel = (window: RateLimitWindow, zh: boolean) => {
  const remaining = Math.round(Math.max(0, 100 - window.usedPercent))
  if (!window.resetsAt) return zh ? `${remaining}% 剩余 · 已重置，使用后开始计时` : `${remaining}% left · reset; starts on next use`
  const reset = new Date(window.resetsAt * 1_000)
  if (reset.getTime() <= Date.now()) return zh ? `${remaining}% 剩余 · 已到重置时间` : `${remaining}% left · reset time reached`
  return zh ? `${remaining}% 剩余 · ${reset.toLocaleString()} 重置` : `${remaining}% left · resets ${reset.toLocaleString()}`
}

export function AgentAccountsPanel({ accounts, language, onClose, onChanged, onUse, embedded = false }: { accounts: AgentAccount[]; language: 'en' | 'zh'; onClose: () => void; onChanged: (accounts: AgentAccount[]) => void; onUse: (account: AgentAccount) => void; embedded?: boolean }) {
  const zh = language === 'zh'
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<AgentName>('Codex')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [quotas, setQuotas] = useState<Record<string, QuotaState>>({})

  const reload = async () => {
    const response = await authenticatedFetch('/api/agent-accounts')
    if (!response.ok) throw new Error(zh ? '无法加载账号' : 'Unable to load accounts')
    onChanged(((await response.json()) as { items: AgentAccount[] }).items)
  }
  const add = async () => {
    if (!name.trim()) return
    setBusy(true); setMessage('')
    try {
      const response = await authenticatedFetch('/api/agent-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, agent }) })
      const body = await response.json() as AgentAccount & { error?: string }
      if (!response.ok) throw new Error(body.error || (zh ? '添加失败' : 'Unable to add account'))
      setName('')
      await reload()
      setMessage(zh ? `已添加 ${body.name}。复制登录命令，在终端完成登录。` : `${body.name} added. Copy the login command and sign in from Terminal.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to add account') }
    finally { setBusy(false) }
  }
  const remove = async (account: AgentAccount) => {
    if (!window.confirm(zh ? `移除账号配置“${account.name}”？登录目录会保留。` : `Remove ${account.name}? Its login directory will be kept.`)) return
    const response = await authenticatedFetch(`/api/agent-accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' })
    if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; setMessage(body.error || 'Unable to remove account'); return }
    await reload()
  }
  const loadQuota = async (account: AgentAccount) => {
    setQuotas(current => ({ ...current, [account.id]: { ...current[account.id], loading: true, error: undefined } }))
    try {
      const query = new URLSearchParams({ accountId: account.id })
      if (account.agent === 'Claude') query.set('agent', 'Claude')
      const response = await authenticatedFetch(`/api/account/rate-limits?${query}`)
      const body = await response.json() as { rateLimits?: RateLimits | null; rateLimitsByLimitId?: Record<string, RateLimits>; error?: string }
      if (!response.ok) throw new Error(body.error || (zh ? '无法读取额度' : 'Unable to read quota'))
      const limits = account.agent === 'Codex' ? body.rateLimitsByLimitId?.codex ?? body.rateLimits ?? null : body.rateLimits ?? null
      setQuotas(current => ({ ...current, [account.id]: { limits } }))
    } catch (error) {
      setQuotas(current => ({ ...current, [account.id]: { error: error instanceof Error ? error.message : (zh ? '无法读取额度' : 'Unable to read quota') } }))
    }
  }

  const panel = <section className={`modal agent-accounts-modal${embedded ? ' agent-accounts-embedded' : ''}`} role="dialog" aria-label={zh ? 'Agent 账号' : 'Agent accounts'}>
    <div className="modal-header"><div><span className="eyebrow">LOCAL AGENT PROFILES</span><h2>{zh ? 'Agent 账号' : 'Agent accounts'}</h2></div>{!embedded && <button className="icon-btn" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}><X size={18} /></button>}</div>
    <p className="picker-hint">{zh ? '账号在所有项目中共用。Relay 只保存名称和配置目录；凭证由 Codex 或 Claude CLI 管理。' : 'Accounts are shared by every project. Relay stores names and config directories; the CLIs manage credentials.'}</p>
    <div className="agent-account-create"><label>Agent<select value={agent} onChange={event => setAgent(event.target.value as AgentName)}><option>Codex</option><option>Claude</option></select></label><label>{zh ? '账号名称' : 'Account name'}<input value={name} maxLength={80} placeholder={zh ? '例如：个人 1' : 'e.g. Personal 1'} onChange={event => setName(event.target.value)} /></label><button className="primary-btn" disabled={busy || !name.trim()} onClick={() => void add()}><Plus size={14} /> {zh ? '添加账号' : 'Add account'}</button></div>
    {message && <p className="agent-account-message">{message}</p>}
    <div className="agent-account-list">{(['Codex', 'Claude'] as const).map(kind => <section key={kind}><h3>{kind}</h3>{accounts.filter(account => account.agent === kind).map(account => { const quota = quotas[account.id]; return <article className="agent-account-row" key={account.id}><div><strong>{account.name}</strong><code>{account.configDirectory}</code></div>{quota && <div className={`agent-account-quota${quota.error ? ' error' : ''}`}>{quota.loading ? (zh ? '正在读取额度…' : 'Reading quota…') : quota.error ? quota.error : quota.limits ? <><span><b>5h</b>{quotaWindowLabel(quota.limits.primary, zh)}</span>{quota.limits.secondary && <span><b>7d</b>{quotaWindowLabel(quota.limits.secondary, zh)}</span>}</> : (zh ? '此账号没有可显示的订阅额度' : 'No subscription quota available for this account')}</div>}<div className="agent-account-actions"><button className="secondary-btn" onClick={() => onUse(account)}>{zh ? '用于新任务' : 'Use for new tasks'}</button><button className="secondary-btn account-quota-btn" disabled={quota?.loading} onClick={() => void loadQuota(account)}><RefreshCw size={13} className={quota?.loading ? 'is-spinning' : ''} /> {quota ? (zh ? '刷新额度' : 'Refresh quota') : (zh ? '查看额度' : 'View quota')}</button><button className="icon-btn" title={zh ? '复制登录命令' : 'Copy login command'} aria-label={zh ? `复制 ${account.name} 登录命令` : `Copy ${account.name} login command`} onClick={() => void copyText(account.loginCommand).then(ok => setMessage(ok ? (zh ? '登录命令已复制' : 'Login command copied') : (zh ? '复制失败' : 'Copy failed')))}><Copy size={14} /></button>{!account.isDefault && <button className="icon-btn image-delete" aria-label={zh ? `删除 ${account.name}` : `Delete ${account.name}`} onClick={() => void remove(account)}><Trash2 size={14} /></button>}</div></article> })}</section>)}</div>
  </section>
  return embedded ? panel : <div className="modal-backdrop agent-accounts-backdrop" onClick={onClose}><div onClick={event => event.stopPropagation()}>{panel}</div></div>
}
