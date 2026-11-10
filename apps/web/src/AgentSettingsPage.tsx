import { useEffect, useState } from 'react'
import { Bot, KeyRound, Server, Workflow, BookOpen } from 'lucide-react'
import { AgentAccountsPanel } from './AgentAccountsPanel'
import type { AgentAccount } from './services/apiAgentService'
import { listSkills, type Skill } from './services/apiAgentService'

type DeepSeekStatus = { configured: boolean; source: 'relay' | 'environment' | null; keyHint: string | null }
type LocalModelStatus = { agent?: 'Codex' | 'Claude'; configured: boolean; name: string | null; baseUrl: string | null; model: string | null; keyHint: string | null; contextWindow: number | null; autoCompactTokenLimit: number | null }

export function AgentSettingsPage({
  accounts, language, onAccountsChanged, onUseAccount, deepseekStatus, deepseekKeyDraft,
  onDeepseekKeyDraftChange, onSaveDeepseekKey, localModelStatus, onSaveLocalModel, localRegressionEnabled, onLocalRegressionChange, pushUseLocalModel, onPushUseLocalModelChange, providerSaving, checkpointsEnabled,
  onCheckpointsChange,
}: {
  accounts: AgentAccount[]
  language: 'en' | 'zh'
  onAccountsChanged: (accounts: AgentAccount[]) => void
  onUseAccount: (account: AgentAccount) => void
  deepseekStatus: DeepSeekStatus
  deepseekKeyDraft: string
  onDeepseekKeyDraftChange: (value: string) => void
  onSaveDeepseekKey: (key: string | null) => void
  localModelStatus: LocalModelStatus
  onSaveLocalModel: (provider: { agent: 'Codex' | 'Claude'; name: string; baseUrl: string; model: string; contextWindow?: number | null; autoCompactTokenLimit?: number | null; apiKey?: string | null } | null) => void
  localRegressionEnabled: boolean
  onLocalRegressionChange: (enabled: boolean) => void
  pushUseLocalModel: boolean
  onPushUseLocalModelChange: (enabled: boolean) => void
  providerSaving: boolean
  checkpointsEnabled: boolean
  onCheckpointsChange: (enabled: boolean) => void
}) {
  const zh = language === 'zh'
  const [localAgent, setLocalAgent] = useState<'Codex' | 'Claude'>('Claude')
  const [localName, setLocalName] = useState('Custom model')
  const [localBaseUrl, setLocalBaseUrl] = useState('http://127.0.0.1:11434')
  const [localModel, setLocalModel] = useState('')
  const [contextWindow, setContextWindow] = useState('')
  const [autoCompact, setAutoCompact] = useState('')
  const [localApiKey, setLocalApiKey] = useState('')
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  useEffect(() => {
    setLocalAgent(localModelStatus.agent ?? (localModelStatus.configured ? 'Codex' : 'Claude'))
    setLocalName(localModelStatus.name ?? 'Custom model')
    setLocalBaseUrl(localModelStatus.baseUrl ?? 'http://127.0.0.1:11434')
    setLocalModel(localModelStatus.model ?? '')
    setContextWindow(localModelStatus.contextWindow?.toString() ?? '')
    setAutoCompact(localModelStatus.autoCompactTokenLimit?.toString() ?? '')
    setLocalApiKey('')
  }, [localModelStatus])
  useEffect(() => {
    listSkills().then(setSkills).catch(() => {})
  }, [])
  return <section className="agent-settings-page">
    <div className="content-header"><div className="breadcrumbs"><span className="muted">{zh ? '工作区' : 'Workspace'}</span><span>›</span><strong>{zh ? 'Agent 设置' : 'Agent settings'}</strong></div></div>
    <section className="project-hero"><div><span className="eyebrow">LOCAL CONFIGURATION</span><h1>{zh ? 'Agent 设置' : 'Agent settings'}</h1><p className="path">{zh ? '管理本机账号、模型提供方和 Agent 之间的进度交接。' : 'Manage local accounts, model providers, and handoffs between agents.'}</p></div></section>
    <div className="agent-settings-grid">
      <div className="agent-settings-card agent-settings-accounts"><div className="agent-settings-card-heading"><Bot size={17} /><div><h2>{zh ? '账号' : 'Accounts'}</h2><p>{zh ? '在项目间共用的 Codex 和 Claude 账号' : 'Codex and Claude accounts shared across projects'}</p></div></div>
        <AgentAccountsPanel embedded accounts={accounts} language={language} onClose={() => {}} onChanged={onAccountsChanged} onUse={onUseAccount} />
      </div>
      <div className="agent-settings-card"><div className="agent-settings-card-heading"><KeyRound size={17} /><div><h2>DeepSeek</h2><p>{zh ? '添加本机 API Key，以在模型列表中使用 DeepSeek。' : 'Add a local API key to use DeepSeek models.'}</p></div></div>
        <p className="provider-status">{deepseekStatus.configured ? (deepseekStatus.source === 'environment' ? (zh ? `使用环境变量 ${deepseekStatus.keyHint}` : `Using environment key ${deepseekStatus.keyHint}`) : (zh ? `已设置 ${deepseekStatus.keyHint}` : `Key set ${deepseekStatus.keyHint}`)) : (zh ? '未设置 API Key' : 'No API key set')}</p>
        <form className="provider-key-form" onSubmit={event => { event.preventDefault(); if (deepseekKeyDraft.trim()) onSaveDeepseekKey(deepseekKeyDraft.trim()) }}><input type="password" autoComplete="off" spellCheck={false} placeholder="sk-…" aria-label="DeepSeek API key" value={deepseekKeyDraft} onChange={event => onDeepseekKeyDraftChange(event.target.value)} /><button className="secondary-btn" type="submit" disabled={providerSaving || !deepseekKeyDraft.trim()}>{zh ? '保存' : 'Save'}</button></form>
        {deepseekStatus.source === 'relay' && <button className="secondary-btn provider-key-clear" disabled={providerSaving} onClick={() => onSaveDeepseekKey(null)}>{zh ? '清除 Key' : 'Remove key'}</button>}
        <p className="auto-approval-help provider-help">{zh ? '仅保存在本机 ~/.relay-web。' : 'Stored only on this Mac in ~/.relay-web.'}</p>
      </div>
      <div className="agent-settings-card agent-settings-local-model"><div className="agent-settings-card-heading"><Server size={17} /><div><h2>{zh ? '自定义模型 Provider' : 'Custom model provider'}</h2><p>{zh ? '选择 Claude 或 Codex，连接本机、局域网或远程模型服务。' : 'Choose Claude or Codex to connect to a local, LAN, or remote model service.'}</p></div></div>
        <p className="provider-status">{localModelStatus.configured ? (zh ? `已配置 ${localModelStatus.name} · ${localModelStatus.model}` : `Configured ${localModelStatus.name} · ${localModelStatus.model}`) : (zh ? '尚未配置' : 'Not configured')}</p>
        <form className="local-provider-form" onSubmit={event => { event.preventDefault(); if (localName.trim() && localBaseUrl.trim() && localModel.trim()) onSaveLocalModel({ agent: localAgent, name: localName.trim(), baseUrl: localBaseUrl.trim(), model: localModel.trim(), contextWindow: contextWindow ? Number(contextWindow) : null, autoCompactTokenLimit: autoCompact ? Number(autoCompact) : null, ...(localApiKey.trim() ? { apiKey: localApiKey.trim() } : {}) }) }}>
          <label>{zh ? '启动 Agent' : 'Launch agent'}<select value={localAgent} onChange={event => setLocalAgent(event.target.value as 'Codex' | 'Claude')}><option value="Claude">Claude</option><option value="Codex">Codex</option></select></label>
          <label>{zh ? '名称' : 'Name'}<input value={localName} maxLength={80} onChange={event => setLocalName(event.target.value)} placeholder="Ollama" /></label>
          <label>Base URL<input value={localBaseUrl} spellCheck={false} onChange={event => setLocalBaseUrl(event.target.value)} placeholder={localAgent === 'Claude' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:11434/v1'} /></label>
          <label>{zh ? '模型 ID' : 'Model ID'}<input value={localModel} maxLength={160} spellCheck={false} onChange={event => setLocalModel(event.target.value)} placeholder="qwen2.5-coder:7b" /></label>
          <label>{zh ? 'API Key（可选）' : 'API key (optional)'}<input type="password" autoComplete="off" spellCheck={false} value={localApiKey} onChange={event => setLocalApiKey(event.target.value)} placeholder={localModelStatus.keyHint ?? (zh ? '无需认证时留空' : 'Leave blank when not required')} /></label>
          <label>{zh ? '上下文窗口（token，可选）' : 'Context window (tokens, optional)'}<input disabled={localAgent === 'Claude'} type="number" min="1" max="10000000" step="1" value={contextWindow} onChange={event => setContextWindow(event.target.value)} /></label>
          <label>{zh ? '自动压缩阈值（token，可选）' : 'Auto-compaction threshold (tokens, optional)'}<input disabled={localAgent === 'Claude'} type="number" min="1" max={contextWindow ? Number(contextWindow) - 1 : 10000000} step="1" value={autoCompact} onChange={event => setAutoCompact(event.target.value)} /></label>
          <p className="auto-approval-help">{zh ? '上下文窗口和压缩阈值仅适用于 Codex；Claude 使用自身的上下文管理。' : 'Context window and compaction overrides apply to Codex; Claude manages its own context.'}</p>
          <button className="secondary-btn" type="submit" disabled={providerSaving || !localName.trim() || !localBaseUrl.trim() || !localModel.trim()}>{zh ? '保存 Provider' : 'Save provider'}</button>
        </form>
        <div className="local-provider-actions">{localModelStatus.keyHint && <button className="secondary-btn" disabled={providerSaving} onClick={() => onSaveLocalModel({ agent: localAgent, name: localName.trim(), baseUrl: localBaseUrl.trim(), model: localModel.trim(), contextWindow: contextWindow ? Number(contextWindow) : null, autoCompactTokenLimit: autoCompact ? Number(autoCompact) : null, apiKey: null })}>{zh ? '清除 Key' : 'Remove key'}</button>}{localModelStatus.configured && <button className="secondary-btn provider-key-clear" disabled={providerSaving} onClick={() => onSaveLocalModel(null)}>{zh ? '移除 Provider' : 'Remove provider'}</button>}</div>
        <p className="auto-approval-help">{zh ? '支持任意 HTTP 或 HTTPS 地址，但远程服务建议使用 HTTPS，避免 API Key 明文传输。Claude 需要 Anthropic Messages API（填写网关根地址）；Codex 需要 Responses API。' : 'Any HTTP or HTTPS URL is supported, but remote services should use HTTPS so API keys are not sent in cleartext. Claude requires an Anthropic Messages API (enter the gateway root URL); Codex requires a Responses API.'}</p>
        <div className="local-regression-setting"><label className="sound-toggle auto-approval-toggle"><input type="checkbox" checked={localRegressionEnabled} disabled={providerSaving || !localModelStatus.configured} onChange={event => onLocalRegressionChange(event.target.checked)} /><span>{zh ? '提交前委派回归给此 Provider' : 'Delegate pre-commit regression to this provider'}</span></label><p className="auto-approval-help">{zh ? 'Agent 请求 git commit 时，Relay 会以当前本机用户权限运行仓库的 ci-local 入口；没有共用入口时依次运行 check、test、build 和已配置的 UI 安装测试，再由此模型审核结果。只应在你信任的仓库中开启。失败、模型不可用或代码快照变化都会阻止提交。' : 'When an agent requests git commit, Relay runs the repository ci-local entry with your local user permissions; without one it runs check, test, build, and the configured UI install test, then asks this model to review the result. Enable this only for repositories you trust. Failures, an unavailable model, or a changed snapshot block the commit.'}</p></div>
        <label className="sound-toggle auto-approval-toggle"><input type="checkbox" checked={pushUseLocalModel} disabled={providerSaving || !localModelStatus.configured} onChange={event => onPushUseLocalModelChange(event.target.checked)} /><span>{zh ? 'Push 时使用本地模型' : 'Push with local model'}</span></label>
        <p className="auto-approval-help">{zh ? '开启后，所有发送的消息都会走已配置的本地模型；关闭则使用默认模型。' : 'When on, all sent messages use the configured local model; otherwise the default model is used.'}</p>
      </div>
      <div className="agent-settings-card agent-settings-skills"><div className="agent-settings-card-heading"><BookOpen size={17} /><div><h2>{zh ? 'Skills' : 'Skills'}</h2><p>{zh ? '读取本机 ~/.agents/skills 下的 skill 实现，提交时指定使用的 skill。' : 'Read skill implementations from ~/.agents/skills, specify which skills to use on push.'}</p></div></div>
        {skills.length === 0 ? <p className="provider-status">{zh ? '未找到 skill' : 'No skills found'}</p> : (
          <div className="skills-list">
            {skills.map(skill => (
              <div key={skill.name} className={`skill-item ${selectedSkill?.name === skill.name ? 'selected' : ''}`} onClick={() => setSelectedSkill(selectedSkill?.name === skill.name ? null : skill)}>
                <div className="skill-item-header">
                  <span className="skill-item-name">{skill.name}</span>
                  <span className="skill-item-count">{zh ? '查看' : 'View'}</span>
                </div>
                {selectedSkill?.name === skill.name && (
                  <pre className="skill-item-content"><code>{skill.content}</code></pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="agent-settings-card"><div className="agent-settings-card-heading"><Workflow size={17} /><div><h2>{zh ? '交接检查点' : 'Handoff checkpoints'}</h2><p>{zh ? '切换 Agent 时让后续 Agent 获取更完整的进度。' : 'Give the next agent a fuller progress note when switching.'}</p></div></div>
        <label className="sound-toggle auto-approval-toggle"><input type="checkbox" checked={checkpointsEnabled} disabled={providerSaving} onChange={event => onCheckpointsChange(event.target.checked)} /><span>{zh ? '让 Agent 记录进度检查点' : 'Agents keep a progress checkpoint'}</span></label>
        <p className="auto-approval-help">{zh ? '切换 Agent 时总会附带 Relay 记录的事实，不消耗模型 token。开启后 Agent 还会在工作中维护进度笔记，让交接更完整，但会额外消耗 token。' : 'Switches always include facts Relay recorded at no model-token cost. With this enabled, agents also maintain a progress note for a fuller handoff, using extra tokens.'}</p>
      </div>
    </div>
  </section>
}
