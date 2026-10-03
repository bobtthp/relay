import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive, ChevronDown, ChevronRight,
  Code2, FolderGit2, Laptop, Menu, MessageSquare, MoreHorizontal,
  Maximize2, Minimize2, Plus, Search, Settings, Sparkles, Square, TerminalSquare, Trash2, X, Zap,
} from 'lucide-react'
import { apiAgentService, getTaskTokenUsage, listCodexModels, listTaskEvents, listTaskHistory, type CodexModel } from './services/apiAgentService'
import { isExecutionLog, isFinalAssistantMessage, isStreamingDelta, mergeEventSnapshots, mergeSessionTimeline, type TranscriptMessage } from './services/chatTranscript'
import { type AgentName, type Task } from './services/agentService'
import { authenticatedFetch, getRelayAccessToken } from './services/auth'
import type { PendingApproval } from '../../../packages/protocol/src/types.js'

const copy = {
  en: { workspace: 'WORKSPACE', connected: 'Connected', overview: 'Overview', projects: 'Projects', activity: 'Activity', workspaces: 'WORKSPACES', recentTasks: 'Recent tasks', projectActivity: 'PROJECT ACTIVITY', newTask: 'New task', searchTasks: 'Search tasks', running: 'Running', completed: 'Completed', readingSize: 'READING SIZE', language: 'LANGUAGE', completionSound: 'COMPLETION SOUND', autoApproval: 'Auto-approve eligible requests', autoApprovalHelp: 'Allows commands, reviewed file changes, and current-turn permissions. Links, forms, and Codex questions still need you.', soundEnabled: 'Play when a task finishes', soundStyle: 'Sound', chimeSound: 'Chime', bellSound: 'Bell', digitalSound: 'Digital', volume: 'Volume', previewSound: 'Preview sound', task: 'Task', agent: 'Agent', startTask: 'Start task', cancel: 'Cancel', ask: 'Ask', sendHint: 'Enter for new line · Shift + Enter to send', liveOutput: 'LIVE OUTPUT', selectedTask: 'SELECTED TASK' },
  zh: { workspace: '工作区', connected: '已连接', overview: '概览', projects: '项目', activity: '活动', workspaces: 'WORKSPACES', recentTasks: '最近任务', projectActivity: '项目动态', newTask: '新建任务', searchTasks: '搜索任务', running: '执行中', completed: '已完成', readingSize: '阅读字号', language: '语言', completionSound: '完成提示音', autoApproval: '自动批准可自动处理的请求', autoApprovalHelp: '自动允许命令、可审阅的文件修改和仅本轮权限。外部链接、表单和 Codex 提问仍需你处理。', soundEnabled: '任务完成时播放', soundStyle: '音效', chimeSound: '清脆', bellSound: '铃声', digitalSound: '电子音', volume: '音量', previewSound: '试听提示音', task: '任务', agent: 'Agent', startTask: '新建任务', cancel: '取消', ask: '向', sendHint: 'Enter 换行 · Shift + Enter 发送', liveOutput: '实时输出', selectedTask: '当前任务' },
} as const

type RateLimitWindow = { usedPercent: number; windowDurationMins?: number; resetsAt: number }
type RateLimits = { primary: RateLimitWindow; secondary?: RateLimitWindow | null }
type EnvironmentItem = { id?: 'codex' | 'claude'; label: string; installed: boolean; version?: string; status?: 'installing' | 'failed'; detail?: string }
type CompletionSound = 'chime' | 'bell' | 'digital'
const CODEX_MODEL_REFRESH_MS = 24 * 60 * 60 * 1_000

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp))
}

const logLabel = (kind: NonNullable<TranscriptMessage['logType']>, language: 'en' | 'zh') => {
  const labels = {
    command: ['Command', '命令'], test: ['Test', '测试'], warning: ['Warning', '警告'],
    error: ['Error', '错误'], status: ['Status', '状态'], change: ['Changes', '文件变更'], tool: ['Tool', '工具'],
  } as const
  return labels[kind][language === 'zh' ? 1 : 0]
}

const ExecutionLogEntry = memo(function ExecutionLogEntry({ log, kind, language }: { log: TranscriptMessage; kind: NonNullable<TranscriptMessage['logType']>; language: 'en' | 'zh' }) {
  const summary = log.text.split('\n').find(line => line.trim()) ?? ''
  return <details className={`execution-log-entry ${kind}`}>
    <summary><span className={`execution-log-kind ${kind}`}>{logLabel(kind, language)}</span>{log.createdAt && <time>{formatTime(log.createdAt)}</time>}{log.progressState && <span className="execution-log-state">{log.progressState === 'running' ? (language === 'zh' ? '执行中' : 'Running') : (language === 'zh' ? '已结束' : 'Finished')}</span>}<span className="execution-log-summary">{summary}</span></summary>
    <div className="markdown-output message-markdown execution-log-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{log.text}</ReactMarkdown></div>
  </details>
})

const ExecutionLogPanel = memo(function ExecutionLogPanel({ logs, taskState, language, onCollapse }: { logs: TranscriptMessage[]; taskState: Task['state']; language: 'en' | 'zh'; onCollapse: () => void }) {
  const logViewport = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const latest = logs.at(-1)

  useEffect(() => {
    if (followLatest.current && logViewport.current) logViewport.current.scrollTop = logViewport.current.scrollHeight
  }, [logs.length, latest?.text, latest?.progressState])

  const latestLine = latest?.text.split('\n')[0] ?? ''
  const latestStatus = taskState === 'running' ? (language === 'zh' ? '执行中' : 'Running')
    : taskState === 'waiting_for_approval' ? (language === 'zh' ? '等待批准' : 'Waiting for approval')
      : taskState === 'failed' ? (language === 'zh' ? '失败' : 'Failed')
        : taskState === 'interrupted' ? (language === 'zh' ? '已中断' : 'Interrupted')
          : taskState === 'completed' ? (language === 'zh' ? '已完成' : 'Completed')
            : latest?.progressState === 'running' ? (language === 'zh' ? '执行中' : 'Running')
              : latest?.progressState === 'completed' ? (language === 'zh' ? '已完成' : 'Completed')
                : (language === 'zh' ? '执行记录' : 'Activity')

  return <section className="execution-log-panel">
    <header className="execution-log-header"><div className="execution-log-title"><span className="execution-log-icon">⌁</span><strong>{language === 'zh' ? '执行日志' : 'Execution log'}</strong><span className="execution-log-count">{logs.length}</span></div><button className="execution-log-collapse" onClick={onCollapse} aria-label={language === 'zh' ? '收起执行日志' : 'Collapse execution logs'} title={language === 'zh' ? '收起日志栏' : 'Collapse log panel'}><ChevronRight size={15} /></button><span className={`execution-log-status ${latest?.logType ?? 'status'}`}>{latestStatus}</span></header>
    <div className="execution-log-current">{latestLine}</div>
    <div className="execution-log-list" ref={logViewport} onScroll={event => {
      const element = event.currentTarget
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28
    }}>
      {logs.length ? logs.map((log, index) => {
        const kind = log.logType ?? (log.eventType === 'error' ? 'error' : 'status')
        return <ExecutionLogEntry key={log.id ?? `${log.taskId}-${log.createdAt}-${index}`} log={log} kind={kind} language={language} />
      }) : <div className="execution-log-empty">{language === 'zh' ? '此任务暂无执行日志' : 'No execution logs for this task yet.'}</div>}
    </div>
  </section>
})

const ChatMessage = memo(function ChatMessage({ message, agent, language }: { message: TranscriptMessage; agent: AgentName; language: 'en' | 'zh' }) {
  return <div className={`preview-event session-message ${message.role}`}><div className="event-marker"><MessageSquare size={14} /></div><div><strong>{message.role === 'user' ? 'You' : agent}{message.createdAt && <span className="event-time">{formatTime(message.createdAt)}</span>}</strong><div className="markdown-output message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></div></div></div>
}, (previous, next) => previous.agent === next.agent && previous.language === next.language && previous.message.id === next.message.id && previous.message.role === next.message.role && previous.message.text === next.message.text && previous.message.createdAt === next.message.createdAt)

const ChatTranscript = memo(function ChatTranscript({ messages, agent, language }: { messages: TranscriptMessage[]; agent: AgentName; language: 'en' | 'zh' }) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  const followLatest = useRef(true)
  const latestMessage = messages.at(-1)

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript && followLatest.current) transcript.scrollTop = transcript.scrollHeight
  }, [messages.length, latestMessage?.role, latestMessage?.text, latestMessage?.createdAt])

  if (!messages.length) return null
  const chatMessages = messages.filter(message => !isExecutionLog(message))
  if (!chatMessages.length) return null
  return <div className="chat-transcript" ref={transcriptRef} onScroll={event => {
    const element = event.currentTarget
    followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28
  }}>{chatMessages.map((message, index) => <ChatMessage key={message.id ?? `${message.role}-${index}`} message={message} agent={agent} language={language} />)}</div>
})

const RateLimitStatus = memo(function RateLimitStatus({ rateLimit }: { rateLimit: RateLimits }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const ticker = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(ticker)
  }, [])
  const resetInSeconds = Math.max(0, rateLimit.primary.resetsAt * 1000 - now) / 1_000
  const formatCountdown = (seconds: number) => `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`
  return <div className="topbar-token" title={`Codex 5-hour quota resets in ${formatCountdown(resetInSeconds)}`}><span>5h</span><strong>{rateLimit.primary.usedPercent}%</strong><i><b style={{ width: `${rateLimit.primary.usedPercent}%` }} /></i><em>↻ {formatCountdown(resetInSeconds)}</em>{rateLimit.secondary && <><span className="quota-week">7d</span><strong>{rateLimit.secondary.usedPercent}%</strong></>}</div>
})

const TaskDuration = memo(function TaskDuration({ task, language }: { task: Task; language: 'en' | 'zh' }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (task.state !== 'running') return
    const ticker = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(ticker)
  }, [task.state])

  if (task.executionDurationMs == null) return <span className="task-duration">{language === 'zh' ? '用时 未记录' : 'Duration Not recorded'}</span>
  const startedAt = task.executionStartedAt ? Date.parse(task.executionStartedAt) : NaN
  const elapsed = task.executionDurationMs + (Number.isFinite(startedAt) && task.state === 'running' ? Math.max(0, now - startedAt) : 0)
  const seconds = Math.floor(elapsed / 1_000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const duration = language === 'zh'
    ? days ? `${days}天${hours % 24}小时` : hours ? `${hours}小时${minutes % 60}分` : minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`
    : days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
  return <span className="task-duration">{language === 'zh' ? '用时' : 'Duration'} {duration}</span>
})

function appendLiveEvent(current: TranscriptMessage[], incoming: TranscriptMessage): TranscriptMessage[] {
  const existingIndex = incoming.id ? current.findIndex(item => item.id === incoming.id) : -1
  if (existingIndex >= 0) {
    const updated = [...current]
    updated[existingIndex] = incoming
    return updated
  }
  const deltaIndex = isStreamingDelta(incoming.method) && incoming.itemId
    ? current.findIndex(item => item.taskId === incoming.taskId && item.method === incoming.method && item.itemId === incoming.itemId)
    : -1
  if (deltaIndex >= 0) {
    const updated = [...current]
    const previous = updated[deltaIndex]
    updated[deltaIndex] = { ...previous, text: previous.text + incoming.text, createdAt: incoming.createdAt, eventType: incoming.eventType, logType: incoming.logType, progressState: incoming.progressState }
    return updated
  }
  const previous = current.at(-1)
  if (previous && isStreamingDelta(incoming.method) && previous.taskId === incoming.taskId && previous.method === incoming.method && previous.itemId === incoming.itemId) {
    return [...current.slice(0, -1), { ...previous, text: previous.text + incoming.text }]
  }
  return [...current, incoming]
}

type ComposerActions = {
  sendMessage: (message: string) => void
  changeTaskModel: (model: string) => void
}

const TaskComposer = memo(function TaskComposer({
  actions,
  agent,
  disabled,
  language,
  models,
  model,
  modelDisabled,
  sendHint,
}: {
  actions: { current: ComposerActions }
  agent: AgentName
  disabled: boolean
  language: 'en' | 'zh'
  models: CodexModel[]
  model: string
  modelDisabled: boolean
  sendHint: string
}) {
  const [draft, setDraft] = useState('')
  const submit = () => {
    if (!draft.trim() || disabled) return
    actions.current.sendMessage(draft)
    setDraft('')
  }

  return <div className="composer"><div className="composer-model-row"><label htmlFor="turn-model">Model</label><select id="turn-model" className="model-select" value={model} disabled={modelDisabled} onChange={event => actions.current.changeTaskModel(event.target.value)} title={modelDisabled ? 'Model changes apply to the next turn' : 'Choose a model for the next turn'}>{models.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}</select><span>Applies to the next turn</span></div><textarea disabled={disabled} placeholder={disabled ? (language === 'zh' ? '请先处理上方审批请求' : 'Respond to the approval request above first') : `Ask ${agent} anything...`} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} /><button className="send-btn" onClick={submit} disabled={disabled} aria-label="Send message">↑</button><span className="composer-hint">{sendHint}</span></div>
})

let completionAudioContext: AudioContext | undefined

function ApprovalCard({ approval, language, onRespond }: { approval: PendingApproval; language: 'en' | 'zh'; onRespond: (response: Record<string, unknown>) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const required = Array.isArray(approval.requestedSchema?.required) ? approval.requestedSchema.required.filter((key): key is string => typeof key === 'string') : []
  const properties = approval.requestedSchema?.properties && typeof approval.requestedSchema.properties === 'object' ? approval.requestedSchema.properties as Record<string, Record<string, unknown>> : {}
  const title = approval.kind === 'command' ? (language === 'zh' ? 'Codex 请求运行命令' : 'Codex requests command execution') : approval.kind === 'file_change' ? (language === 'zh' ? 'Codex 请求应用文件修改' : 'Codex requests file changes') : approval.kind === 'permissions' ? (language === 'zh' ? 'Codex 请求额外权限' : 'Codex requests additional permissions') : approval.kind === 'user_input' ? (language === 'zh' ? 'Codex 需要你的回答' : 'Codex needs your input') : approval.kind === 'mcp_url' ? (language === 'zh' ? 'MCP 服务请求打开外部页面' : 'MCP server requests an external page') : (language === 'zh' ? 'MCP 服务请求填写表单' : 'MCP server requests form input')
  const inputText = language === 'zh' ? '提交回答' : 'Submit answers'
  const submitUserInput = () => onRespond({ answers: Object.fromEntries((approval.questions ?? []).map(question => { const selected = Array.isArray(values[question.id]) ? values[question.id] as string[] : values[question.id] === undefined || values[question.id] === '' ? [] : [String(values[question.id])]; const other = values[`${question.id}__other`]; return [question.id, { answers: typeof other === 'string' && other.trim() ? [...selected, other] : selected }] })) })
  const submitForm = () => onRespond({ action: 'accept', content: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => { const property = properties[key]; const converted = property?.type === 'number' || property?.type === 'integer' ? Number(value) : value; return [key, converted] })), _meta: null })
  const controlsReady = approval.kind === 'user_input' ? (approval.questions ?? []).length > 0 : approval.canApprove
  return <section className="approval-card"><div className="approval-heading"><strong>{title}</strong><span>{language === 'zh' ? '等待你的确认' : 'Your confirmation is required'}</span></div>{approval.serverName && <p className="approval-reason">{approval.serverName}</p>}{(approval.reason || approval.message) && <p className="approval-reason">{approval.reason || approval.message}</p>}{approval.command && <><span className="approval-label">{language === 'zh' ? '命令' : 'Command'}</span><pre>{approval.command}</pre></>}{approval.cwd && <p className="approval-cwd">{language === 'zh' ? '工作目录：' : 'Working directory: '}{approval.cwd}</p>}{approval.networkContext && <details><summary>{language === 'zh' ? '网络访问详情' : 'Network access details'}</summary><pre>{JSON.stringify(approval.networkContext, null, 2)}</pre></details>}{approval.changes?.map(change => <details className="approval-change" key={change.path} open><summary>{change.kind} · {change.path}</summary><pre>{change.diff}</pre></details>)}{approval.permissions && <details open><summary>{language === 'zh' ? '请求的权限（仅本轮）' : 'Requested permissions (this turn only)'}</summary><pre>{JSON.stringify(approval.permissions, null, 2)}</pre></details>}
    {approval.kind === 'mcp_form' && Object.entries(properties).map(([key, property]) => <label className="approval-field" key={key}>{String(property.title || key)}{property.description ? <small>{String(property.description)}</small> : null}{Array.isArray(property.enum) ? <select value={String(values[key] ?? '')} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))}><option value="">{language === 'zh' ? '请选择' : 'Choose…'}</option>{property.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : property.type === 'boolean' ? <input type="checkbox" checked={Boolean(values[key])} onChange={event => setValues(current => ({ ...current, [key]: event.target.checked }))} /> : property.type === 'string' ? <textarea rows={property.format === 'textarea' || property.multiline === true ? 5 : 3} value={String(values[key] ?? '')} required={required.includes(key)} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} /> : <input type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'} value={String(values[key] ?? '')} required={required.includes(key)} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} />}</label>)}
    {approval.kind === 'user_input' && approval.questions?.map(question => <fieldset className="approval-field" key={question.id}><legend>{question.header}</legend><p>{question.question}</p>{question.options?.map(option => <label key={option.label}><input type="checkbox" checked={(Array.isArray(values[question.id]) ? values[question.id] as string[] : []).includes(option.label)} onChange={event => setValues(current => { const selected = Array.isArray(current[question.id]) ? current[question.id] as string[] : []; return { ...current, [question.id]: event.target.checked ? [...selected, option.label] : selected.filter(item => item !== option.label) } })} /> {option.label}{option.description && <small>{option.description}</small>}</label>)}{(!question.options?.length || question.isOther) && <input type={question.isSecret ? 'password' : 'text'} autoComplete={question.isSecret ? 'off' : undefined} placeholder={language === 'zh' ? '输入回答' : 'Type an answer'} value={typeof values[`${question.id}__other`] === 'string' ? values[`${question.id}__other`] as string : ''} onChange={event => setValues(current => ({ ...current, [`${question.id}__other`]: event.target.value }))} />}</fieldset>)}
    {approval.kind === 'mcp_url' && <><p className="approval-warning">{language === 'zh' ? 'Relay 不会自动打开该链接。请检查域名，仅在你主动完成外部操作后确认。' : 'Relay will not open this link automatically. Check the domain and confirm only after you have completed the external action yourself.'}</p><code className="approval-url">{approval.url}</code></>}
    {approval.kind === 'file_change' && !approval.canApprove && <p className="approval-warning">{language === 'zh' ? '未收到可检查的差异预览。为避免盲目应用修改，Relay 暂不允许批准；请拒绝后在 Codex 中检查。' : 'No reviewable diff was received. Relay will not allow blind approval; deny this request and inspect it in Codex.'}</p>}{approval.kind === 'mcp_form' && !approval.canApprove && <p className="approval-warning">{language === 'zh' ? '此表单包含 Relay 暂不支持的字段类型，因此只能拒绝。' : 'This form contains field types Relay cannot safely render; it can only be declined.'}</p>}
    <div className="approval-actions">{controlsReady && (approval.kind === 'user_input' ? <button className="primary-btn" onClick={submitUserInput}>{inputText}</button> : approval.kind === 'mcp_form' ? <button className="primary-btn" disabled={required.some(key => values[key] === undefined || values[key] === '')} onClick={submitForm}>{inputText}</button> : <button className="primary-btn" onClick={() => approval.kind === 'mcp_url' ? onRespond({ action: 'accept' }) : onRespond({ decision: 'accept' })}>{approval.kind === 'permissions' ? (language === 'zh' ? '仅本轮授予' : 'Grant for this turn') : approval.kind === 'mcp_url' ? (language === 'zh' ? '我已完成，继续' : 'I completed it, continue') : (language === 'zh' ? '批准一次' : 'Allow once')}</button>)}<button className="secondary-btn" onClick={() => onRespond(approval.kind === 'mcp_form' || approval.kind === 'mcp_url' ? { action: 'decline' } : approval.kind === 'user_input' ? { answers: Object.fromEntries((approval.questions ?? []).map(question => [question.id, { answers: [] }])) } : { decision: 'decline' })}>{language === 'zh' ? '拒绝' : 'Deny'}</button></div></section>
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTask, setActiveTask] = useState(0)
  const [taskMaximized, setTaskMaximized] = useState(false)
  const [executionLogsCollapsed, setExecutionLogsCollapsed] = useState(() => window.innerWidth <= 1024)
  const collapseExecutionLogs = useCallback(() => setExecutionLogsCollapsed(true), [])
  const [executionLogWidth, setExecutionLogWidth] = useState(() => {
    const savedWidth = Number(localStorage.getItem('relay-execution-log-width'))
    return Number.isFinite(savedWidth) && savedWidth >= 220 ? Math.min(savedWidth, Math.max(220, window.innerWidth / 2)) : 310
  })
  const executionWorkspaceRef = useRef<HTMLDivElement>(null)
  const executionLogSidebarRef = useRef<HTMLElement>(null)
  const resizingExecutionLogs = useRef(false)
  const executionLogResizeFrame = useRef<number | null>(null)
  const pendingExecutionLogWidth = useRef(executionLogWidth)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 650)
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsMenuRef = useRef<HTMLDivElement>(null)
  const [readingSize, setReadingSize] = useState<'small' | 'medium' | 'large'>(() => (localStorage.getItem('relay-reading-size') as 'small' | 'medium' | 'large') || 'medium')
  const [language, setLanguage] = useState<'en' | 'zh'>(() => (localStorage.getItem('relay-language') as 'en' | 'zh') || 'en')
  const [completionSoundEnabled, setCompletionSoundEnabled] = useState(() => localStorage.getItem('relay-completion-sound') !== 'false')
  const [completionSoundVolume, setCompletionSoundVolume] = useState(() => Math.max(0, Math.min(100, Number(localStorage.getItem('relay-completion-volume') ?? '70'))))
  const [completionSound, setCompletionSound] = useState<CompletionSound>(() => {
    const stored = localStorage.getItem('relay-completion-sound-style')
    return stored === 'bell' || stored === 'digital' ? stored : 'chime'
  })
  const [autoApproveConfirmations, setAutoApproveConfirmations] = useState(false)
  const completionSoundSettings = useRef({ enabled: completionSoundEnabled, volume: completionSoundVolume, sound: completionSound })
  completionSoundSettings.current = { enabled: completionSoundEnabled, volume: completionSoundVolume, sound: completionSound }
  const [localProject, setLocalProject] = useState<{ id: string; name: string; path: string; branch: string; clean: boolean } | null>(null)
  const [machineName, setMachineName] = useState('Relay Agent')
  const [workspaceProjects, setWorkspaceProjects] = useState<Array<{ id: string; name: string; path: string; branch: string; clean: boolean }>>([])
  const [taskSearchOpen, setTaskSearchOpen] = useState(false)
  const [taskQuery, setTaskQuery] = useState('')
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [directory, setDirectory] = useState<{ path: string; parent: string | null; items: Array<{ name: string; path: string; isGit: boolean }> } | null>(null)
  const [projectPickerError, setProjectPickerError] = useState('')
  const [rateLimit, setRateLimit] = useState<RateLimits | null>(null)
  const composerActionsRef = useRef<ComposerActions>({ sendMessage: () => {}, changeTaskModel: () => {} })
  const [sent, setSent] = useState(false)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskAgent, setNewTaskAgent] = useState<AgentName>('Codex')
  const [models, setModels] = useState<CodexModel[]>([])
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem('relay-codex-model') || '')
  const [selectedEffort, setSelectedEffort] = useState(() => localStorage.getItem('relay-codex-effort') || '')
  const selectedModelRef = useRef(selectedModel)
  const selectedEffortRef = useRef(selectedEffort)
  const modelsLoaded = useRef(false)
  const modelsRefreshAt = useRef<number | null>(null)
  const [notice, setNotice] = useState('')
  const [noticeAction, setNoticeAction] = useState<{ label: string; run: () => void } | null>(null)
  const noticeTimeout = useRef<number | undefined>(undefined)
  const [recoverTasksOpen, setRecoverTasksOpen] = useState(false)
  const [recoverableTasks, setRecoverableTasks] = useState<Array<{ id: string; title: string; lastActivityAt: string; deletedAt: string }>>([])
  const [recoverTasksLoading, setRecoverTasksLoading] = useState(false)
  const [liveEvents, setLiveEvents] = useState<TranscriptMessage[]>([])
  const pendingLiveEvents = useRef<TranscriptMessage[]>([])
  const liveEventFrame = useRef<number | null>(null)
  const queueLiveEvent = (event: TranscriptMessage) => {
    pendingLiveEvents.current.push(event)
    if (liveEventFrame.current !== null) return
    liveEventFrame.current = window.requestAnimationFrame(() => {
      liveEventFrame.current = null
      const batch = pendingLiveEvents.current.splice(0)
      if (batch.length) setLiveEvents(current => batch.reduce(appendLiveEvent, current))
    })
  }
  const [sessionHistory, setSessionHistory] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  const [activeView, setActiveView] = useState<'projects' | 'overview' | 'activity'>('projects')
  const [activityEvents, setActivityEvents] = useState<Array<{ taskId: string; taskTitle: string; role: 'user' | 'assistant' | 'progress'; text: string; createdAt: string }>>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityRefresh, setActivityRefresh] = useState(0)
  const [environment, setEnvironment] = useState<{ tools: EnvironmentItem[]; requirements: EnvironmentItem[] } | null>(null)
  const [environmentLoading, setEnvironmentLoading] = useState(false)
  const [environmentError, setEnvironmentError] = useState('')
  const tasksRef = useRef(tasks)
  const activeTaskRef = useRef(activeTask)
  const transcriptLoadRequest = useRef(0)
  tasksRef.current = tasks
  activeTaskRef.current = activeTask
  selectedModelRef.current = selectedModel
  selectedEffortRef.current = selectedEffort

  useEffect(() => {
    if (!settingsOpen) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !settingsMenuRef.current?.contains(event.target)) setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [settingsOpen])

  useEffect(() => {
    if (!taskMaximized) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTaskMaximized(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [taskMaximized])

  const getExecutionLogWidthAt = (clientX: number) => {
    const workspace = executionWorkspaceRef.current
    if (!workspace) return pendingExecutionLogWidth.current
    const rect = workspace.getBoundingClientRect()
    const maxWidth = rect.width * 0.5
    return Math.max(220, Math.min(maxWidth, clientX - rect.left))
  }

  const resizeExecutionLogsTo = (clientX: number) => {
    pendingExecutionLogWidth.current = getExecutionLogWidthAt(clientX)
    if (executionLogResizeFrame.current !== null) return
    executionLogResizeFrame.current = window.requestAnimationFrame(() => {
      executionLogResizeFrame.current = null
      if (executionLogSidebarRef.current) executionLogSidebarRef.current.style.width = `${pendingExecutionLogWidth.current}px`
    })
  }

  const finishExecutionLogResize = (clientX?: number) => {
    if (clientX !== undefined) pendingExecutionLogWidth.current = getExecutionLogWidthAt(clientX)
    resizingExecutionLogs.current = false
    if (executionLogResizeFrame.current !== null) {
      window.cancelAnimationFrame(executionLogResizeFrame.current)
      executionLogResizeFrame.current = null
    }
    const width = pendingExecutionLogWidth.current
    if (executionLogSidebarRef.current) executionLogSidebarRef.current.style.width = `${width}px`
    setExecutionLogWidth(width)
  }

  useEffect(() => () => {
    if (executionLogResizeFrame.current !== null) window.cancelAnimationFrame(executionLogResizeFrame.current)
  }, [])

  const text = copy[language]
  const sizeLabel = (size: 'small' | 'medium' | 'large') => language === 'zh' ? ({ small: '小', medium: '中', large: '大' }[size]) : ({ small: 'Small', medium: 'Medium', large: 'Large' }[size])
  const visibleTasks = tasks.map((task, index) => ({ task, index })).filter(({ task }) => task.title.toLowerCase().includes(taskQuery.trim().toLowerCase()))
  const taskSelectOptions = tasks[activeTask]
    ? [{ task: tasks[activeTask], index: activeTask, selected: true }, ...visibleTasks.filter(({ index }) => index !== activeTask).map(option => ({ ...option, selected: false }))]
    : visibleTasks.map(option => ({ ...option, selected: false }))
  const statusLabel = (state: Task['state']) => ({ running: text.running, completed: text.completed, failed: language === 'zh' ? '失败' : 'Failed', interrupted: language === 'zh' ? '已中断' : 'Interrupted', waiting_for_approval: language === 'zh' ? '等待批准' : 'Waiting for approval' })[state]
  const selectedModelInfo = models.find(model => model.model === selectedModel)
  const reasoningOptions = selectedModelInfo?.supportedReasoningEfforts ?? []
  const playCompletionTone = () => {
    if (!completionSoundSettings.current.enabled) return
    try {
      const context = completionAudioContext ?? new window.AudioContext()
      completionAudioContext = context
      const play = () => {
        if (context.state !== 'running') return
        const peak = Math.max(0.0001, completionSoundSettings.current.volume / 100 * 0.09)
        const now = context.currentTime
        if (completionSoundSettings.current.sound === 'bell') {
          for (const [frequency, level] of [[880, 1], [1760, 0.28], [2630, 0.1]]) {
            const oscillator = context.createOscillator()
            const gain = context.createGain()
            oscillator.type = 'sine'
            oscillator.frequency.setValueAtTime(frequency, now)
            gain.gain.setValueAtTime(0.0001, now)
            gain.gain.exponentialRampToValueAtTime(peak * level, now + 0.012)
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62)
            oscillator.connect(gain).connect(context.destination)
            oscillator.start(now)
            oscillator.stop(now + 0.64)
          }
        } else if (completionSoundSettings.current.sound === 'digital') {
          ;[740, 988, 1318].forEach((frequency, index) => {
            const start = now + index * 0.105
            const oscillator = context.createOscillator()
            const gain = context.createGain()
            oscillator.type = 'triangle'
            oscillator.frequency.setValueAtTime(frequency, start)
            gain.gain.setValueAtTime(0.0001, start)
            gain.gain.exponentialRampToValueAtTime(peak, start + 0.008)
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.095)
            oscillator.connect(gain).connect(context.destination)
            oscillator.start(start)
            oscillator.stop(start + 0.1)
          })
        } else {
          const oscillator = context.createOscillator()
          const gain = context.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.setValueAtTime(660, now)
          oscillator.frequency.setValueAtTime(880, now + 0.13)
          gain.gain.setValueAtTime(0.0001, now)
          gain.gain.exponentialRampToValueAtTime(peak, now + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32)
          oscillator.connect(gain).connect(context.destination)
          oscillator.start(now)
          oscillator.stop(now + 0.34)
        }
      }
      if (context.state === 'running') play()
      else void context.resume().then(play).catch(() => undefined)
    } catch { /* Browsers may block audio until a user gesture. */ }
  }

  const loadTaskEvents = (taskId?: string) => {
    if (!taskId) return
    const requestId = ++transcriptLoadRequest.current
    void Promise.allSettled([listTaskEvents(taskId), listTaskHistory(taskId)]).then(([eventsResult, historyResult]) => {
      if (requestId !== transcriptLoadRequest.current || tasksRef.current[activeTaskRef.current]?.id !== taskId) return
      if (eventsResult.status === 'fulfilled') setLiveEvents(current => mergeEventSnapshots(eventsResult.value, current.filter(event => event.taskId === taskId)))
      if (historyResult.status === 'fulfilled') setSessionHistory(Array.isArray(historyResult.value) ? historyResult.value : [])
    })
    void getTaskTokenUsage(taskId).then(tokenUsage => {
      if (tokenUsage) setTasks(current => current.map(task => task.id === taskId ? { ...task, tokenUsage } : task))
    }).catch(() => undefined)
  }

  useEffect(() => {
    void authenticatedFetch('/api/machines').then(async response => {
      if (!response.ok) return
      const body = await response.json() as { items?: Array<{ name?: string }> }
      const name = body.items?.[0]?.name?.trim()
      if (name) setMachineName(name)
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    void authenticatedFetch('/api/projects').then(async response => {
      const body = await response.json() as { items?: Array<{ id: string; name: string; path: string; branch: string; clean: boolean }>; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to load local projects')
      const loadedProjects = body.items ?? []
      setWorkspaceProjects(loadedProjects)
      const rememberedProjectId = sessionStorage.getItem('relay-active-project-id')
      const project = loadedProjects.find(item => item.id === rememberedProjectId) ?? loadedProjects[0]
      setLocalProject(project ?? null)
      if (!project) { setTasks([]); return }
      sessionStorage.setItem('relay-active-project-id', project.id)
      const loadedTasks = await apiAgentService.listTasks()
      setTasks(loadedTasks)
      const firstTask = loadedTasks[0]
      if (firstTask?.model) setSelectedModel(firstTask.model)
      if (firstTask?.reasoningEffort) setSelectedEffort(firstTask.reasoningEffort)
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to load local projects')).finally(() => setLoading(false))
  }, [])

  useEffect(() => { localStorage.setItem('relay-reading-size', readingSize) }, [readingSize])
  useEffect(() => { localStorage.setItem('relay-execution-log-width', String(executionLogWidth)) }, [executionLogWidth])
  useEffect(() => {
    const collapseForNarrowView = () => { if (window.innerWidth <= 1024) setExecutionLogsCollapsed(true) }
    window.addEventListener('resize', collapseForNarrowView)
    return () => window.removeEventListener('resize', collapseForNarrowView)
  }, [])
  useEffect(() => { localStorage.setItem('relay-language', language) }, [language])
  useEffect(() => { localStorage.setItem('relay-completion-sound', String(completionSoundEnabled)) }, [completionSoundEnabled])
  useEffect(() => { localStorage.setItem('relay-completion-volume', String(completionSoundVolume)) }, [completionSoundVolume])
  useEffect(() => { localStorage.setItem('relay-completion-sound-style', completionSound) }, [completionSound])
  useEffect(() => {
    void authenticatedFetch('/api/settings/approvals').then(async response => {
      if (!response.ok) return
      const settings = await response.json() as { autoApproveConfirmations?: boolean }
      setAutoApproveConfirmations(settings.autoApproveConfirmations === true)
    }).catch(() => undefined)
  }, [])
  useEffect(() => { if (selectedModel) localStorage.setItem('relay-codex-model', selectedModel) }, [selectedModel])
  useEffect(() => { if (selectedEffort) localStorage.setItem('relay-codex-effort', selectedEffort) }, [selectedEffort])
  useEffect(() => {
    if (!selectedModelInfo || reasoningOptions.some(option => option.reasoningEffort === selectedEffort)) return
    setSelectedEffort(selectedModelInfo.defaultReasoningEffort ?? reasoningOptions[0]?.reasoningEffort ?? '')
  }, [selectedModelInfo, selectedEffort, reasoningOptions])
  useEffect(() => {
    let cancelled = false
    const refreshModels = async () => {
      try {
        const available = await listCodexModels()
        if (cancelled) return
        const initialLoad = !modelsLoaded.current
        const activeTask = tasksRef.current[activeTaskRef.current]
        const taskModel = activeTask?.model && available.some(model => model.model === activeTask.model) ? activeTask.model : ''
        const storedModel = localStorage.getItem('relay-codex-model')
        const preferred = initialLoad
          ? taskModel || (storedModel && available.some(model => model.model === storedModel) ? storedModel : '')
          : selectedModelRef.current && available.some(model => model.model === selectedModelRef.current) ? selectedModelRef.current : taskModel
        const model = preferred || available.find(item => item.isDefault)?.model || available[0]?.model || ''
        const selected = available.find(item => item.model === model)
        const supported = selected?.supportedReasoningEfforts ?? []
        const storedEffort = localStorage.getItem('relay-codex-effort')
        const taskEffort = activeTask?.reasoningEffort && supported.some(option => option.reasoningEffort === activeTask.reasoningEffort) ? activeTask.reasoningEffort : ''
        const currentEffort = selectedEffortRef.current
        const effort = !initialLoad && currentEffort && supported.some(option => option.reasoningEffort === currentEffort)
          ? currentEffort
          : taskEffort || (storedEffort && supported.some(option => option.reasoningEffort === storedEffort) ? storedEffort : selected?.defaultReasoningEffort ?? supported[0]?.reasoningEffort ?? '')

        modelsLoaded.current = true
        modelsRefreshAt.current = Date.now()
        setModels(available)
        setSelectedModel(model)
        setSelectedEffort(effort)
      } catch {
        // Keep the last known list and retry on the next scheduled refresh.
      }
    }
    const refreshIfStale = () => {
      if (modelsRefreshAt.current === null || Date.now() - modelsRefreshAt.current >= CODEX_MODEL_REFRESH_MS) void refreshModels()
    }

    void refreshModels()
    const timer = window.setInterval(refreshIfStale, CODEX_MODEL_REFRESH_MS)
    window.addEventListener('focus', refreshIfStale)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshIfStale)
    }
  }, [])
  useEffect(() => {
    const runningTasks = tasks.filter(task => task.state === 'running').length
    document.title = runningTasks ? `Relay (${runningTasks}) — Remote Coding Agents` : 'Relay — Remote Coding Agents'
  }, [tasks])

  useEffect(() => {
    const unlockCompletionTone = () => {
      try {
        const context = completionAudioContext ?? new window.AudioContext()
        completionAudioContext = context
        void context.resume()
      } catch { /* Audio is unavailable in this browser. */ }
    }
    window.addEventListener('pointerdown', unlockCompletionTone, { once: true })
    window.addEventListener('keydown', unlockCompletionTone, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlockCompletionTone)
      window.removeEventListener('keydown', unlockCompletionTone)
    }
  }, [])

  useEffect(() => {
    const loadRateLimit = () => {
      void authenticatedFetch('/api/account/rate-limits').then(async response => {
        const body = await response.json() as { rateLimits?: RateLimits; rateLimitsByLimitId?: Record<string, RateLimits> }
        if (!response.ok) return
        setRateLimit(body.rateLimitsByLimitId?.codex ?? body.rateLimits ?? null)
      }).catch(() => undefined)
    }
    loadRateLimit()
    const refresh = window.setInterval(loadRateLimit, 30_000)
    return () => window.clearInterval(refresh)
  }, [])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
    const accessToken = getRelayAccessToken()
    if (accessToken) socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: accessToken })), { once: true })
    socket.onmessage = event => {
      try {
      const message = JSON.parse(event.data) as {
        type?: string
        taskId?: string
        status?: Task['state'] | 'done'
        executionStartedAt?: string | null
        executionDurationMs?: number
        tokenUsage?: Task['tokenUsage']
        approval?: NonNullable<Task['pendingApprovals']>[number]
        approvalId?: string
        settings?: { autoApproveConfirmations?: boolean }
        event?: {
          id: string
          taskId: string
          type?: string
          createdAt: string
          payload?: {
            text?: string
            method?: string
            itemId?: string
            logType?: TranscriptMessage['logType']
            progressState?: 'running' | 'completed'
            error?: boolean
            stderr?: boolean
          }
        }
      }
        if (message.type === 'approval_settings' && message.settings) setAutoApproveConfirmations(message.settings.autoApproveConfirmations === true)
        if (message.type === 'task_deleted' && message.taskId) {
          setActiveTask(0)
          setTasks(current => current.filter(task => task.id !== message.taskId))
          setLiveEvents(current => current.filter(item => item.taskId !== message.taskId))
          setSessionHistory([])
          return
        }
        if (message.type === 'task_usage' && message.taskId && message.tokenUsage) setTasks(current => current.map(task => task.id === message.taskId ? { ...task, tokenUsage: message.tokenUsage } : task))
        if (message.type === 'task_status' && message.taskId && message.status) { const state = message.status === 'done' ? 'completed' : message.status; setTasks(current => current.map(task => task.id === message.taskId ? { ...task, state, executionDurationMs: message.executionDurationMs ?? task.executionDurationMs, executionStartedAt: message.executionStartedAt === null ? undefined : message.executionStartedAt ?? task.executionStartedAt } : task)); if (state === 'completed') playCompletionTone() }
        if (message.type === 'approval_request' && message.taskId && message.approval) setTasks(current => current.map(task => task.id === message.taskId ? { ...task, state: 'waiting_for_approval', pendingApprovals: [...(task.pendingApprovals ?? []).filter(item => item.id !== message.approval!.id), message.approval!] } : task))
        if (message.type === 'approval_updated' && message.taskId && message.approval) setTasks(current => current.map(task => task.id === message.taskId ? { ...task, pendingApprovals: (task.pendingApprovals ?? []).map(item => item.id === message.approval!.id ? message.approval! : item) } : task))
        if (message.type === 'approval_resolved' && message.taskId && message.approvalId) setTasks(current => current.map(task => {
          if (task.id !== message.taskId) return task
          const pendingApprovals = (task.pendingApprovals ?? []).filter(item => item.id !== message.approvalId)
          return { ...task, pendingApprovals, state: pendingApprovals.length ? 'waiting_for_approval' : task.state === 'waiting_for_approval' ? 'running' : task.state }
        }))
        if (message.type !== 'session_event' || !message.event) return
          const text = message.event.payload?.text
          const method = message.event.payload?.method
          const itemId = message.event.payload?.itemId
          const role = message.event.type === 'user_message' ? 'user' as const : isFinalAssistantMessage(method) ? 'assistant' as const : 'progress' as const
          const logType = message.event.payload?.error || message.event.type === 'error' ? 'error' : message.event.type === 'test_result' ? 'test' : message.event.payload?.logType ?? (message.event.payload?.stderr ? 'warning' : undefined)
          if (text) queueLiveEvent({ id: message.event.id, taskId: message.event.taskId, text, method, itemId, createdAt: message.event.createdAt, role, eventType: message.event.type, logType, progressState: message.event.payload?.progressState })
      } catch { /* Ignore non-JSON socket messages. */ }
    }
    return () => {
      socket.close()
      if (liveEventFrame.current !== null) window.cancelAnimationFrame(liveEventFrame.current)
      liveEventFrame.current = null
      pendingLiveEvents.current = []
    }
  }, [])

  useEffect(() => {
    loadTaskEvents(tasks[activeTask]?.id)
  }, [activeTask, tasks.length])

  useEffect(() => {
    if (activeView !== 'activity') return
    let cancelled = false
    setActivityLoading(true)
    void Promise.all(tasks.filter(task => task.id).map(async task => ({ task, events: await listTaskEvents(task.id!) })))
      .then(results => {
        if (cancelled) return
        const items = results.flatMap(({ task, events }) => events.map(event => ({ taskId: task.id!, taskTitle: task.title, role: event.role, text: event.text, createdAt: event.createdAt })))
        items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        setActivityEvents(items)
      })
      .catch(error => { if (!cancelled) notify(error instanceof Error ? error.message : 'Unable to load activity') })
      .finally(() => { if (!cancelled) setActivityLoading(false) })
    return () => { cancelled = true }
  }, [activeView, activityRefresh, tasks])

  const sendMessage = (draft: string) => {
    if (!draft.trim() || tasks[activeTask].state === 'waiting_for_approval') return
    const message = draft.trim()
    const task = tasks[activeTask]
    void apiAgentService.sendMessage(task, message, selectedModel || undefined, selectedEffort || undefined).then(() => {
      setTasks(current => current.map(item => item.id === task.id ? { ...item, state: 'running' } : item))
      setSent(true)
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to send message'))
  }

  const interruptTask = (task: Task) => {
    void apiAgentService.interruptTask(task).then(() => {
      setTasks(current => current.map(item => item.id === task.id ? { ...item, state: 'interrupted' } : item))
      notify(language === 'zh' ? '任务已中断，可以继续发送消息恢复会话' : 'Task interrupted. Send a message to resume the session.')
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to interrupt task'))
  }

  const deleteTask = (task: Task, index: number) => {
    if (!task.id) return
    const confirmed = window.confirm(language === 'zh'
      ? `从 Relay 删除“${task.title}”？Codex 原始 session 和项目文件不会删除。`
      : `Remove “${task.title}” from Relay? The original Codex session and project files will remain.`)
    if (!confirmed) return
    void apiAgentService.deleteTask(task).then(() => {
      setTasks(current => current.filter(item => item.id !== task.id))
      setActiveTask(current => current > index ? current - 1 : current === index ? Math.max(0, Math.min(index, tasks.length - 2)) : current)
      setLiveEvents(current => current.filter(event => event.taskId !== task.id))
      setSessionHistory([])
      setSent(false)
      notify(language === 'zh' ? '任务已从 Relay 删除' : 'Task removed from Relay', {
        label: language === 'zh' ? '撤销' : 'Undo',
        run: () => { void restoreDeletedTask(task.remoteSessionId ?? task.id!) },
      })
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to delete task'))
  }

  const respondToApproval = (task: Task, approvalId: string, response: Record<string, unknown>) => {
    void apiAgentService.respondToApproval(task, approvalId, response).then(() => {
      const accepted = response.decision === 'accept' || response.action === 'accept' || response.answers !== undefined
      const message = accepted
        ? language === 'zh' ? '已批准这一次请求' : 'Approved this request once'
        : language === 'zh' ? '已拒绝请求，Codex 可以尝试其他方案' : 'Request denied. Codex can try another approach.'
      notify(message)
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to respond to approval'))
  }

  const createTask = () => {
    if (!newTaskTitle.trim()) return
    void apiAgentService.createTask(newTaskAgent, newTaskTitle.trim(), selectedModel || undefined, selectedEffort || undefined).then(task => {
      setTasks(current => [task, ...current])
      setActiveTask(0)
      setNewTaskTitle('')
      setNewTaskOpen(false)
    })
  }

  const saveTaskModel = (task: Task, model: string, effort: string) => {
    if (!task.id || !model || !effort) return
    setTasks(current => current.map(item => item.id === task.id ? { ...item, model, reasoningEffort: effort } : item))
    void apiAgentService.updateTaskModel(task, model, effort).catch(error => {
      setTasks(current => current.map(item => item.id === task.id ? { ...item, model: task.model, reasoningEffort: task.reasoningEffort } : item))
      notify(error instanceof Error ? error.message : 'Unable to save task model')
    })
  }

  const changeTaskModel = (model: string) => {
    const task = tasks[activeTask]
    const availableEfforts = models.find(item => item.model === model)?.supportedReasoningEfforts ?? []
    const effort = availableEfforts.some(option => option.reasoningEffort === selectedEffort)
      ? selectedEffort
      : models.find(item => item.model === model)?.defaultReasoningEffort ?? availableEfforts[0]?.reasoningEffort ?? ''
    setSelectedModel(model)
    setSelectedEffort(effort)
    if (task) saveTaskModel(task, model, effort)
  }

  composerActionsRef.current = { sendMessage, changeTaskModel }

  const changeTaskEffort = (effort: string) => {
    setSelectedEffort(effort)
    const task = tasks[activeTask]
    if (task) saveTaskModel(task, selectedModel, effort)
  }

  const activateTask = (index: number) => {
    const task = tasks[index]
    setActiveTask(index)
    setSent(false)
    if (task?.model) setSelectedModel(task.model)
    else {
      const preferred = localStorage.getItem('relay-codex-model')
      if (preferred) setSelectedModel(preferred)
    }
    if (task?.reasoningEffort) setSelectedEffort(task.reasoningEffort)
    else {
      const preferred = localStorage.getItem('relay-codex-effort')
      if (preferred) setSelectedEffort(preferred)
    }
  }

  const notify = (message: string, action?: { label: string; run: () => void }) => {
    setNotice(message)
    setNoticeAction(action ?? null)
    if (noticeTimeout.current) window.clearTimeout(noticeTimeout.current)
    noticeTimeout.current = window.setTimeout(() => { setNotice(''); setNoticeAction(null) }, action ? 8000 : 2200)
  }

  const openDeletedTasks = async () => {
    if (!localProject) return
    setRecoverTasksOpen(true)
    setRecoverTasksLoading(true)
    try { setRecoverableTasks(await apiAgentService.listDeletedTasks(localProject.id)) }
    catch (error) { notify(error instanceof Error ? error.message : 'Unable to load Codex history') }
    finally { setRecoverTasksLoading(false) }
  }

  const restoreDeletedTask = async (sessionId: string) => {
    if (!localProject) return
    try {
      const restored = await apiAgentService.restoreDeletedTask(localProject.id, sessionId)
      setTasks(current => [restored, ...current.filter(task => task.id !== restored.id)])
      setActiveTask(0)
      setRecoverableTasks(current => current.filter(item => item.id !== sessionId))
      setRecoverTasksOpen(false)
      setLiveEvents([])
      setSessionHistory([])
      notify(language === 'zh' ? '任务已恢复，可以继续对话' : 'Task restored. You can continue the conversation.')
    } catch (error) { notify(error instanceof Error ? error.message : 'Unable to restore task') }
  }

  const recoverTasksModal = recoverTasksOpen && <div className="modal-backdrop" onClick={() => setRecoverTasksOpen(false)}><div className="modal project-picker" onClick={event => event.stopPropagation()}><div className="modal-header"><div><span className="eyebrow">{language === 'zh' ? '本机会话' : 'LOCAL SESSIONS'}</span><h2>{language === 'zh' ? '历史记录' : 'History'}</h2></div><button className="icon-btn" onClick={() => setRecoverTasksOpen(false)}><X size={18} /></button></div><p className="picker-hint">{language === 'zh' ? '显示当前项目在 Codex 本机记录中找到的会话。选择一条即可用 Codex resume 恢复并继续。' : 'Sessions found in Codex local history for this project. Select one to resume it in Codex and continue.'}</p>{recoverTasksLoading ? <p>{language === 'zh' ? '正在查找…' : 'Searching…'}</p> : recoverableTasks.length ? <div className="directory-list">{recoverableTasks.map(item => <div className="directory-row" key={item.id}><div className="directory-open"><Archive size={16} /><span>{item.title}<small>{new Date(item.lastActivityAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</small></span></div><button className="secondary-btn" onClick={() => void restoreDeletedTask(item.id)}>{language === 'zh' ? '继续' : 'Resume'}</button></div>)}</div> : <p>{language === 'zh' ? '当前项目下没有找到 Codex 历史会话。' : 'No local sessions were found for this project.'}</p>}</div></div>

  const setAutoApproval = (enabled: boolean) => {
    void authenticatedFetch('/api/settings/approvals', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoApproveConfirmations: enabled }),
    }).then(async response => {
      const result = await response.json() as { autoApproveConfirmations?: boolean; error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Unable to save approval settings')
      setAutoApproveConfirmations(result.autoApproveConfirmations === true)
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to save approval settings'))
  }

  const openProjectPicker = () => {
    setProjectPickerOpen(true)
    browseDirectory()
  }

  const loadEnvironment = (source?: unknown) => {
    const installingTool = source === 'codex' || source === 'claude' ? source : undefined
    setEnvironmentLoading(true)
    setEnvironmentError('')
    void authenticatedFetch('/api/environment').then(async response => {
      const body = await response.json() as { tools?: EnvironmentItem[]; requirements?: EnvironmentItem[]; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to inspect this Mac')
      setEnvironment({ tools: body.tools ?? [], requirements: body.requirements ?? [] })
      if (installingTool && body.tools?.some(tool => tool.id === installingTool && tool.status === 'installing')) {
        window.setTimeout(() => loadEnvironment(installingTool), 1_000)
      }
    }).catch(error => setEnvironmentError(error instanceof Error ? error.message : 'Unable to inspect this Mac')).finally(() => setEnvironmentLoading(false))
  }

  const showOverview = () => { setActiveView('overview'); setSidebarOpen(false); loadEnvironment() }
  const installTool = (tool: 'codex' | 'claude') => {
    void authenticatedFetch(`/api/environment/${tool}/install`, { method: 'POST' }).then(async response => {
      const body = await response.json() as { error?: string; message?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to start installation')
      notify(body.message ?? 'Installation started')
      window.setTimeout(() => loadEnvironment(tool), 1_000)
    }).catch(error => setEnvironmentError(error instanceof Error ? error.message : 'Unable to start installation'))
  }

  const browseDirectory = (directoryPath?: string) => {
    setProjectPickerError('')
    const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : ''
    void authenticatedFetch(`/api/directories${query}`).then(async response => {
      const body = await response.json() as typeof directory & { error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to browse directories')
      setDirectory(body)
    }).catch(error => setProjectPickerError(error instanceof Error ? error.message : 'Unable to browse directories'))
  }

  const switchToProject = (project: { id: string; name: string; path: string; branch: string; clean: boolean }) => {
    sessionStorage.setItem('relay-active-project-id', project.id)
    setLocalProject(project)
    setTasks([])
    setActiveTask(0)
    setLiveEvents([])
    setSessionHistory([])
    setLoading(true)
    void apiAgentService.listTasks().then(loadedTasks => {
      setTasks(loadedTasks)
      if (loadedTasks[0]?.model) setSelectedModel(loadedTasks[0].model)
      if (loadedTasks[0]?.reasoningEffort) setSelectedEffort(loadedTasks[0].reasoningEffort)
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to load local tasks')).finally(() => setLoading(false))
  }

  const selectProject = (projectPath: string) => {
    void authenticatedFetch('/api/projects/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: projectPath }) }).then(async response => {
      const body = await response.json() as { id?: string; name?: string; path?: string; branch?: string; clean?: boolean; error?: string }
      if (!response.ok) throw new Error(body.error ?? 'Unable to select project')
      const refreshed = await authenticatedFetch('/api/projects').then(result => result.json()) as { items?: Array<{ id: string; name: string; path: string; branch: string; clean: boolean }> }
      const loadedProjects = refreshed.items ?? []
      setWorkspaceProjects(loadedProjects)
      const project = loadedProjects.find(item => item.id === body.id)
      if (!project) throw new Error('Selected project is unavailable')
      switchToProject(project)
      setProjectPickerOpen(false)
    }).catch(error => setProjectPickerError(error instanceof Error ? error.message : 'Unable to select project'))
  }

  const removeProject = (project: { id: string; name: string }) => {
    if (!window.confirm(`Remove ${project.name} from Relay? Your repository and Codex history will not be deleted.`)) return
    void authenticatedFetch(`/api/projects/${project.id}`, { method: 'DELETE' }).then(async response => {
      if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? 'Unable to remove workspace') }
      const refreshed = await authenticatedFetch('/api/projects').then(result => result.json()) as { items?: Array<{ id: string; name: string; path: string; branch: string; clean: boolean }> }
      const loadedProjects = refreshed.items ?? []
      setWorkspaceProjects(loadedProjects)
      if (localProject?.id === project.id) {
        const fallback = loadedProjects[0]
        sessionStorage.removeItem('relay-active-project-id')
        if (fallback) switchToProject(fallback)
        else { setLocalProject(null); setTasks([]) }
      }
    }).catch(error => notify(error instanceof Error ? error.message : 'Unable to remove workspace'))
  }

  const activeTaskId = tasks[activeTask]?.id
  const activeLiveEvents = useMemo(() => activeTaskId ? liveEvents.filter(event => event.taskId === activeTaskId) : [], [activeTaskId, liveEvents])
  const activeExecutionLogs = useMemo(() => activeLiveEvents.filter(isExecutionLog).slice(-100), [activeLiveEvents])
  // Keep older Codex-only turns, then use timestamped Relay events from the
  // first shared user message onward. This avoids both losing history and
  // appending duplicated older assistant replies at the end.
  const chatMessages = useMemo(() => mergeSessionTimeline(sessionHistory, activeLiveEvents).slice(-120), [sessionHistory, activeLiveEvents])

  if (loading) return <div className="loading-screen">Loading local tasks…</div>
  if (!localProject) return <div className="loading-screen"><div className="empty-home"><FolderGit2 size={24} /><h1>Choose a local project</h1><p>Select a Git repository to load its local Codex session history.</p><button className="primary-btn" onClick={openProjectPicker}><Plus size={16} /> Choose project</button></div>{projectPickerOpen && <div className="modal-backdrop" onClick={() => setProjectPickerOpen(false)}><div className="modal project-picker" onClick={event => event.stopPropagation()}><div className="modal-header"><div><span className="eyebrow">LOCAL PROJECT</span><h2>Choose a Git repository</h2></div><button className="icon-btn" onClick={() => setProjectPickerOpen(false)}><X size={18} /></button></div><p className="picker-path">{directory?.path ?? 'Loading…'}</p>{directory?.parent && <button className="parent-directory" onClick={() => browseDirectory(directory.parent ?? undefined)}>← Parent folder</button>}{projectPickerError && <p className="picker-error">{projectPickerError}</p>}<div className="directory-list">{directory?.items.map(item => <div className="directory-row" key={item.path}><button className="directory-open" onClick={() => browseDirectory(item.path)}><FolderGit2 size={16} /><span>{item.name}</span>{item.isGit && <small>Git repository</small>}</button>{item.isGit && <button className="secondary-btn" onClick={() => selectProject(item.path)}>Select</button>}</div>)}</div><p className="picker-hint">Choose a Git repository to load its local Codex session history.</p></div></div>}</div>
  if (tasks.length === 0) return <div className="loading-screen"><div className="empty-home"><Sparkles size={24} /><h1>No local Codex sessions yet</h1><p>Create a task to start a session in {localProject.name}.</p><button className="primary-btn" onClick={() => setNewTaskOpen(true)}><Plus size={16} /> Start a task</button><button className="secondary-btn" onClick={() => void openDeletedTasks()}><Archive size={15} /> {language === 'zh' ? '浏览历史记录' : 'Browse history'}</button>{recoverTasksModal}{newTaskOpen && <div className="modal-backdrop" onClick={() => setNewTaskOpen(false)}><div className="modal" onClick={event => event.stopPropagation()}><div className="modal-header"><div><span className="eyebrow">NEW SESSION</span><h2>Start a task</h2></div><button className="icon-btn" onClick={() => setNewTaskOpen(false)}><X size={18} /></button></div><label>Agent<select value={newTaskAgent} onChange={event => setNewTaskAgent(event.target.value as AgentName)}><option>Codex</option><option disabled>Claude (coming soon)</option></select></label>{newTaskAgent === 'Codex' && <><label>Model<select value={selectedModel} disabled={!models.length} onChange={event => setSelectedModel(event.target.value)}>{models.map(model => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}</select></label><label>Reasoning level<select value={selectedEffort} disabled={!reasoningOptions.length} onChange={event => setSelectedEffort(event.target.value)}>{reasoningOptions.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}</select></label></>}<button className="secondary-btn" onClick={() => { setNewTaskOpen(false); void openDeletedTasks() }}><Archive size={15} /> {language === 'zh' ? '从历史会话继续' : 'Continue from history'}</button><label>Task<textarea autoFocus value={newTaskTitle} onChange={event => setNewTaskTitle(event.target.value)} placeholder="Describe what you want Codex to do…" /></label><div className="modal-actions"><button className="secondary-btn" onClick={() => setNewTaskOpen(false)}>Cancel</button><button className="primary-btn" onClick={createTask}><Zap size={15} /> Start task</button></div></div></div>}</div></div>

  return <div className={`app-shell reading-${readingSize}${taskMaximized ? ' task-maximized' : ''}${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Sparkles size={16} /></div><span>relay</span></div>
      <div className="topbar-center"><span className="connection-dot" /> {machineName} <ChevronDown size={14} /></div>
      {rateLimit && <RateLimitStatus rateLimit={rateLimit} />}
      <div className="topbar-actions"><button className="icon-btn sidebar-toggle" onClick={() => setSidebarOpen(current => !current)} aria-label={sidebarOpen ? 'Collapse workspace sidebar' : 'Expand workspace sidebar'} title={sidebarOpen ? 'Collapse workspace' : 'Expand workspace'}><Menu size={18} /></button><div className="settings-menu" ref={settingsMenuRef}><button className="icon-btn" onClick={() => setSettingsOpen(current => !current)} aria-label="Display settings" aria-expanded={settingsOpen}><Settings size={18} /></button>{settingsOpen && <div className="settings-popover"><span className="eyebrow">{text.readingSize}</span><div className="size-options">{(['small', 'medium', 'large'] as const).map(size => <button key={size} className={readingSize === size ? 'active' : ''} onClick={() => setReadingSize(size)}>{sizeLabel(size)}</button>)}</div><span className="eyebrow settings-approval-label">{language === 'zh' ? '审批' : 'APPROVALS'}</span><label className="sound-toggle auto-approval-toggle"><input type="checkbox" checked={autoApproveConfirmations} onChange={event => setAutoApproval(event.target.checked)} /><span>{text.autoApproval}</span></label><p className="auto-approval-help">{text.autoApprovalHelp}</p><span className="eyebrow settings-sound-label">{text.completionSound}</span><label className="sound-toggle"><input type="checkbox" checked={completionSoundEnabled} onChange={event => setCompletionSoundEnabled(event.target.checked)} /><span>{text.soundEnabled}</span></label><label className="sound-style"><span>{text.soundStyle}</span><select value={completionSound} onChange={event => setCompletionSound(event.target.value as CompletionSound)} disabled={!completionSoundEnabled}><option value="chime">{text.chimeSound}</option><option value="bell">{text.bellSound}</option><option value="digital">{text.digitalSound}</option></select></label><label className="sound-volume"><span>{text.volume}<output>{completionSoundVolume}%</output></span><input type="range" min="0" max="100" step="5" value={completionSoundVolume} onChange={event => setCompletionSoundVolume(Number(event.target.value))} disabled={!completionSoundEnabled} /></label><button className="secondary-btn sound-preview" onClick={playCompletionTone} disabled={!completionSoundEnabled}>{text.previewSound}</button><span className="eyebrow settings-language-label">{text.language}</span><div className="language-options"><button className={language === 'zh' ? 'active' : ''} onClick={() => setLanguage('zh')}>中文</button><button className={language === 'en' ? 'active' : ''} onClick={() => setLanguage('en')}>English</button></div></div>}</div><div className="avatar">KC</div></div>
    </header>

    <div className="workspace">
      <aside className={`sidebar ${sidebarOpen ? 'is-open' : ''}`}>
        <div className="sidebar-heading"><div><span className="eyebrow">{text.workspace}</span><h2>{machineName}</h2></div><button className="icon-btn" onClick={() => notify('Machine actions will be connected to SSH')}><MoreHorizontal size={18} /></button></div>
        <div className="machine-status"><span className="connection-dot" /> {text.connected} <span className="muted">·</span> <span className="muted">Apple Silicon</span></div>
        <nav className="side-nav"><button className={`nav-item ${activeView === 'overview' ? 'active' : ''}`} onClick={showOverview}><Laptop size={16} /> {text.overview}</button><button className={`nav-item ${activeView === 'projects' ? 'active' : ''}`} onClick={() => { setActiveView('projects'); setSidebarOpen(false) }}><FolderGit2 size={16} /> {text.projects} <span className="nav-count">{workspaceProjects.length}</span></button><button className={`nav-item ${activeView === 'activity' ? 'active' : ''}`} onClick={() => { setActiveView('activity'); setSidebarOpen(false) }}><Archive size={16} /> {text.activity}</button></nav>
        <div className="project-label"><button className="workspace-toggle" onClick={() => setProjectsExpanded(current => !current)} aria-expanded={projectsExpanded}><ChevronDown size={14} className={projectsExpanded ? '' : 'is-collapsed'} /><span className="eyebrow">{text.workspaces}</span><span className="workspace-count">{workspaceProjects.length}</span></button><button className="tiny-add" onClick={openProjectPicker} aria-label="Add project" title="Add project"><Plus size={14} /></button></div>
        {projectsExpanded && <div className="project-list">{workspaceProjects.map(project => <div className={`project-row ${project.id === localProject?.id ? 'active' : ''}`} key={project.path}><button className="project" onClick={() => project.id === localProject?.id ? undefined : switchToProject(project)}><span className="repo-icon"><Code2 size={15} /></span><span><strong>{project.name}</strong><small>{project.branch} · {project.clean ? 'clean' : 'changed'}</small></span>{project.id === localProject?.id && <ChevronRight size={14} />}</button>{workspaceProjects.length > 1 && <button className="remove-project" onClick={() => removeProject(project)} aria-label={`Remove ${project.name}`} title="Remove workspace"><X size={13} /></button>}</div>)}</div>}
        <div className="sidebar-bottom"><div className="agent-ready"><span className="agent-icon codex">C</span><span>Codex <small>Ready</small></span><span className="ready-dot" /></div><div className="agent-ready"><span className="agent-icon claude">✦</span><span>Claude <small>Ready</small></span><span className="ready-dot" /></div></div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close workspace menu" />}

      <main className={`main-content ${activeView === 'projects' ? `project-main-content${taskMaximized ? ' task-maximized' : ''}` : ''}`}>
        {activeView === 'overview' ? <section className="environment-page"><div className="content-header"><div className="breadcrumbs"><span className="muted">{text.overview}</span><ChevronRight size={14} /><strong>Local environment</strong></div><button className="secondary-btn" onClick={loadEnvironment}>Refresh</button></div><section className="project-hero"><div><span className="eyebrow">LOCAL AGENT SETUP</span><h1>Codex & Claude environment</h1><p className="path">Inspect the tools Relay uses on this Mac. Installation runs only when you choose it.</p></div></section>{environmentLoading && !environment ? <p className="environment-loading">Checking local tools…</p> : <><div className="environment-grid">{environment?.tools.map(tool => <article className="environment-card" key={tool.id}><div><span className="eyebrow">AI CODING AGENT</span><h2>{tool.label}</h2><p>{tool.installed ? tool.version ?? 'Installed' : 'Not installed'}</p></div><span className={`environment-status ${tool.status ?? (tool.installed ? 'installed' : 'missing')}`}>{tool.status === 'installing' ? 'Installing' : tool.status === 'failed' ? 'Failed' : tool.installed ? 'Ready' : 'Missing'}</span>{tool.status === 'failed' && <small className="environment-error">{tool.detail}</small>}<button className={tool.installed ? 'secondary-btn' : 'primary-btn'} disabled={tool.status === 'installing'} onClick={() => !tool.installed && tool.id && installTool(tool.id)}>{tool.status === 'installing' ? 'Installing…' : tool.installed ? 'Installed' : `Install ${tool.label}`}</button></article>)}</div><section className="environment-requirements"><span className="eyebrow">REQUIREMENTS</span>{environment?.requirements.map(item => <div key={item.label}><span>{item.label}</span><strong className={item.installed ? 'ok' : 'missing'}>{item.installed ? item.version ?? 'Ready' : 'Missing'}</strong></div>)}</section><p className="environment-note">After installation, sign in in a local terminal with <code>codex login</code> or <code>claude login</code>. Relay does not store your credentials.</p>{environmentError && <p className="environment-error">{environmentError}</p>}</>}</section> : activeView === 'activity' ? <section className="activity-page"><div className="content-header"><div className="breadcrumbs"><span className="muted">{text.workspace}</span><ChevronRight size={14} /><strong>{text.activity}</strong></div><button className="secondary-btn" onClick={() => setActivityRefresh(value => value + 1)}>Refresh</button></div><section className="project-hero"><div><span className="eyebrow">LOCAL SESSION FEED</span><h1>{text.activity}</h1><p className="path">Recent messages across tasks in {localProject?.name ?? 'this project'}.</p></div></section>{activityLoading ? <p className="environment-loading">Loading activity…</p> : activityEvents.length ? <div className="activity-feed">{activityEvents.map((event, index) => <article className={`activity-item ${event.role}`} key={`${event.taskId}-${event.createdAt}-${index}`}><div className="activity-marker"><MessageSquare size={15} /></div><div className="activity-body"><div className="activity-meta"><strong>{event.role === 'user' ? 'You' : event.role === 'progress' ? 'Codex activity' : 'Codex'}</strong><time>{formatTime(event.createdAt)}</time></div><button className="activity-task-link" onClick={() => { const index = tasks.findIndex(task => task.id === event.taskId); if (index >= 0) { setActiveTask(index); setActiveView('projects') } }}>{event.taskTitle}</button><div className="markdown-output"><ReactMarkdown remarkPlugins={[remarkGfm]}>{event.text}</ReactMarkdown></div></div></article>)}</div> : <div className="empty-tasks">No task messages yet.</div>}</section> : <>
        <div className="content-header project-content-header"><div className="breadcrumbs"><span className="muted">{text.projects}</span><ChevronRight size={14} /><strong>{localProject?.name ?? 'Local project'}</strong></div><div className="header-actions"><button className="secondary-btn" onClick={() => notify('Raw terminal needs the SSH terminal endpoint, which is not enabled yet')}><TerminalSquare size={15} /> Open terminal</button><button className="secondary-btn" onClick={() => void openDeletedTasks()}><Archive size={15} /> {language === 'zh' ? '历史记录' : 'History'}</button><button className="primary-btn" onClick={() => setNewTaskOpen(true)}><Plus size={16} /> {text.newTask}</button></div></div>
        <section className="project-hero project-page-hero"><div><div className="hero-title"><h1>{localProject?.name ?? 'Local project'}</h1><span className="repo-pill"><FolderGit2 size={13} /> Git repository</span></div><p className="path">{localProject?.path ?? ''}</p></div><div className="branch"><span className="branch-icon">⌘</span> {localProject?.branch ?? '—'} <span className="clean-dot" /> {localProject?.clean ? 'Clean' : 'Changed'}</div></section>
        <div className="section-heading recent-task-heading"><div><span className="eyebrow">{text.projectActivity}</span><h2>{text.recentTasks}<span className="active-task-count"><span className="pulse" />{tasks.filter(task => task.state === 'running').length} {language === 'zh' ? '运行中' : 'running'}</span></h2></div><div className="recent-task-controls"><label className="recent-task-select-label"><span className="sr-only">{text.recentTasks}</span><select className="recent-task-select" value={tasks[activeTask] ? String(activeTask) : ''} onChange={event => { const index = Number(event.target.value); if (Number.isInteger(index)) activateTask(index) }} aria-label={text.recentTasks}><option value="" disabled>{language === 'zh' ? '选择任务' : 'Select a task'}</option>{taskSelectOptions.map(({ task, index, selected }) => <option key={`${task.id}-${index}`} value={index}>{selected ? (language === 'zh' ? '已选择 · ' : 'Selected · ') : `${statusLabel(task.state)} · `}{task.title}</option>)}</select><ChevronDown size={14} /></label><button className={`filter ${taskSearchOpen ? 'active' : ''}`} onClick={() => setTaskSearchOpen(current => !current)} aria-label={text.searchTasks} title={text.searchTasks}><Search size={15} /><span>{text.searchTasks}</span></button></div></div>
        {taskSearchOpen && <div className="task-search"><Search size={15} /><input autoFocus value={taskQuery} onChange={event => setTaskQuery(event.target.value)} placeholder={text.searchTasks} /><button onClick={() => { setTaskQuery(''); setTaskSearchOpen(false) }} aria-label="Close search"><X size={15} /></button></div>}
        <div className="task-preview-workspace" ref={executionWorkspaceRef}>
            {!executionLogsCollapsed && <><button className="execution-log-backdrop" onClick={collapseExecutionLogs} aria-label={language === 'zh' ? '关闭执行日志' : 'Close execution logs'} /><aside ref={executionLogSidebarRef} className="execution-log-sidebar" style={{ width: executionLogWidth }}><ExecutionLogPanel key={activeTaskId} logs={activeExecutionLogs} taskState={tasks[activeTask].state} language={language} onCollapse={collapseExecutionLogs} /></aside><div className="execution-log-resize" role="separator" tabIndex={0} aria-valuemin={220} aria-valuemax={Math.floor((executionWorkspaceRef.current?.clientWidth ?? window.innerWidth) / 2)} aria-valuenow={executionLogWidth} aria-orientation="vertical" aria-label={language === 'zh' ? '调整日志栏宽度' : 'Resize execution log panel'} onPointerDown={event => { resizingExecutionLogs.current = true; pendingExecutionLogWidth.current = executionLogWidth; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (resizingExecutionLogs.current) resizeExecutionLogsTo(event.clientX) }} onPointerUp={event => finishExecutionLogResize(event.clientX)} onPointerCancel={() => finishExecutionLogResize()} onKeyDown={event => { if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return; event.preventDefault(); const maxWidth = Math.floor((executionWorkspaceRef.current?.clientWidth ?? window.innerWidth) / 2); setExecutionLogWidth(width => Math.max(220, Math.min(maxWidth, width + (event.key === 'ArrowRight' ? 16 : -16)))) }} /> </>}
            <div className="task-preview">
            <div className="preview-top"><div><span className="eyebrow">{text.selectedTask}</span><h3>{tasks[activeTask].title}</h3></div><div className="preview-actions"><button className="execution-log-toggle" onClick={() => setExecutionLogsCollapsed(current => !current)} aria-expanded={!executionLogsCollapsed} title={language === 'zh' ? '显示或收起执行日志' : 'Show or hide execution logs'}><span>⌁</span>{language === 'zh' ? `日志 ${activeExecutionLogs.length}` : `Logs ${activeExecutionLogs.length}`}</button><button className="task-maximize-toggle" onClick={() => setTaskMaximized(current => !current)} aria-pressed={taskMaximized} aria-label={taskMaximized ? (language === "zh" ? "退出任务专注模式" : "Exit task focus mode") : (language === "zh" ? "最大化当前任务" : "Maximize current task")} title={taskMaximized ? (language === "zh" ? "退出专注模式（Esc）" : "Exit focus mode (Esc)") : (language === "zh" ? "最大化当前任务" : "Maximize current task")}>{taskMaximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>{(tasks[activeTask].state === 'running' || tasks[activeTask].state === 'waiting_for_approval') && <button className="secondary-btn task-interrupt" onClick={() => interruptTask(tasks[activeTask])}><Square size={13} /> {language === 'zh' ? '中断' : 'Interrupt'}</button>}<button className="icon-btn selected-task-delete" onClick={() => deleteTask(tasks[activeTask], activeTask)} disabled={tasks[activeTask].state === 'running' || tasks[activeTask].state === 'waiting_for_approval'} title={language === 'zh' ? '从 Relay 删除任务' : 'Remove task from Relay'} aria-label={language === 'zh' ? `删除 ${tasks[activeTask].title}` : `Delete ${tasks[activeTask].title}`}><Trash2 size={14} /></button></div></div>
            <div className="preview-agent"><span className={`task-agent ${tasks[activeTask].color}`}>{tasks[activeTask].agent === 'Codex' ? 'C' : '✦'}</span><span>{tasks[activeTask].agent}</span><span className={`status-badge ${tasks[activeTask].state}`}>{tasks[activeTask].state === 'running' ? <><span className="worker-animation" role="img" aria-label="Agent is working">🧑‍🔧<span>🔨</span></span> {statusLabel(tasks[activeTask].state)}</> : statusLabel(tasks[activeTask].state)}</span><TaskDuration task={tasks[activeTask]} language={language} /></div>
            {(tasks[activeTask].pendingApprovals ?? []).map(approval => <ApprovalCard key={approval.id} approval={approval} language={language} onRespond={response => respondToApproval(tasks[activeTask], approval.id, response)} />)}
            <ChatTranscript key={tasks[activeTask].id} messages={chatMessages} agent={tasks[activeTask].agent} language={language} />
            {tasks[activeTask].agent === 'Codex' && reasoningOptions.length > 0 && <div className="reasoning-control"><label htmlFor="turn-effort">Reasoning level</label><select id="turn-effort" value={selectedEffort} disabled={tasks[activeTask].state === 'running' || tasks[activeTask].state === 'waiting_for_approval'} onChange={event => changeTaskEffort(event.target.value)} title={tasks[activeTask].state === 'running' || tasks[activeTask].state === 'waiting_for_approval' ? 'The current turn is already using its selected level' : 'Choose a reasoning level for the next turn'}>{reasoningOptions.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}</select><span>Applies to the next turn</span></div>}
            {sent && <div className="sent-note"><span className="pulse" /> Message sent to {tasks[activeTask].agent}</div>}
            <TaskComposer actions={composerActionsRef} agent={tasks[activeTask].agent} disabled={tasks[activeTask].state === 'waiting_for_approval'} language={language} models={models} model={selectedModel} modelDisabled={tasks[activeTask].state === 'running' || tasks[activeTask].state === 'waiting_for_approval' || models.length === 0} sendHint={text.sendHint} />
            </div>
        </div></>}
      </main>
    </div>
    {recoverTasksModal}
    {projectPickerOpen && <div className="modal-backdrop" onClick={() => setProjectPickerOpen(false)}><div className="modal project-picker" onClick={event => event.stopPropagation()}><div className="modal-header"><div><span className="eyebrow">LOCAL PROJECT</span><h2>Choose a Git repository</h2></div><button className="icon-btn" onClick={() => setProjectPickerOpen(false)}><X size={18} /></button></div><p className="picker-path">{directory?.path ?? 'Loading…'}</p>{directory?.parent && <button className="parent-directory" onClick={() => browseDirectory(directory.parent ?? undefined)}>← Parent folder</button>}{projectPickerError && <p className="picker-error">{projectPickerError}</p>}<div className="directory-list">{directory?.items.map(item => <div className="directory-row" key={item.path}><button className="directory-open" onClick={() => browseDirectory(item.path)}><FolderGit2 size={16} /><span>{item.name}</span>{item.isGit && <small>Git repository</small>}</button>{item.isGit && <button className="secondary-btn" onClick={() => selectProject(item.path)}>Select</button>}</div>)}</div><p className="picker-hint">Choose a Git repository to load its local Codex session history.</p></div></div>}
    {newTaskOpen && <div className="modal-backdrop" onClick={() => setNewTaskOpen(false)}><div className="modal" onClick={event => event.stopPropagation()}><div className="modal-header"><div><span className="eyebrow">NEW SESSION</span><h2>Start a task</h2></div><button className="icon-btn" onClick={() => setNewTaskOpen(false)}><X size={18} /></button></div><label>Agent<select value={newTaskAgent} onChange={event => setNewTaskAgent(event.target.value as AgentName)}><option>Codex</option><option disabled>Claude (coming soon)</option></select></label>{newTaskAgent === 'Codex' && <><label>Model<select value={selectedModel} disabled={!models.length} onChange={event => setSelectedModel(event.target.value)}>{models.map(model => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}</select></label><label>Reasoning level<select value={selectedEffort} disabled={!reasoningOptions.length} onChange={event => setSelectedEffort(event.target.value)}>{reasoningOptions.map(option => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}</select></label></>}<button className="secondary-btn" onClick={() => { setNewTaskOpen(false); void openDeletedTasks() }}><Archive size={15} /> {language === 'zh' ? '从历史会话继续' : 'Continue from history'}</button><label>Task<textarea autoFocus value={newTaskTitle} onChange={event => setNewTaskTitle(event.target.value)} placeholder="Describe what you want Codex to do…" /></label><div className="modal-actions"><button className="secondary-btn" onClick={() => setNewTaskOpen(false)}>Cancel</button><button className="primary-btn" onClick={createTask}><Zap size={15} /> Start task</button></div></div></div>}
    {notice && <div className="demo-toast"><span className="pulse" /> {notice}{noticeAction && <button className="toast-action" onClick={noticeAction.run}>{noticeAction.label}</button>}</div>}
  </div>
}

export default App
