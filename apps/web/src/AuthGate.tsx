import { useEffect, useState, type FormEvent } from 'react'
import App from './App'
import { getRelayAccessToken, saveRelayAccessToken } from './services/auth'

type GateState = 'checking' | 'ready' | 'locked' | 'unavailable'
const isChinese = navigator.language.toLowerCase().startsWith('zh')

async function verifyToken(token: string) {
  const response = await window.fetch('/api/auth/verify', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.ok
}

export default function AuthGate() {
  const [state, setState] = useState<GateState>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await window.fetch('/api/auth/status')
        if (!response.ok) throw new Error('Relay backend is unavailable')
        const status = await response.json() as { required?: boolean }
        if (!status.required) { if (active) setState('ready'); return }
        const savedToken = getRelayAccessToken()
        if (savedToken && await verifyToken(savedToken)) {
          if (active) setState('ready')
        } else {
          if (savedToken) window.localStorage.removeItem('relay-access-token')
          if (active) setState('locked')
        }
      } catch {
        if (active) setState('unavailable')
      }
    })()
    return () => { active = false }
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      if (!await verifyToken(token.trim())) {
        setError(isChinese ? '令牌不正确，请重新输入。' : 'That access token is not valid. Try again.')
        return
      }
      saveRelayAccessToken(token.trim())
      setState('ready')
    } catch {
      setError(isChinese ? '无法连接 Relay。请确认服务已启动。' : 'Could not connect to Relay. Check that the service is running.')
    } finally {
      setSubmitting(false)
    }
  }

  if (state === 'ready') return <App />
  if (state === 'checking') return <main className="auth-gate"><p>{isChinese ? '正在连接 Relay…' : 'Connecting to Relay…'}</p></main>

  return <main className="auth-gate">
    <form className="auth-card" onSubmit={submit}>
      <span className="eyebrow">RELAY · PRIVATE ACCESS</span>
      <h1>{isChinese ? '连接到你的 Relay' : 'Connect to your Relay'}</h1>
      {state === 'unavailable' ? <p>{isChinese ? '无法连接 Relay 服务。请确认服务已启动后刷新页面。' : 'Relay is unavailable. Start the service, then refresh this page.'}</p> : <>
        <p>{isChinese ? '输入这台 Mac 上保存的访问令牌。' : 'Enter the access token stored on your Mac.'}</p>
        <label htmlFor="relay-access-token">{isChinese ? '访问令牌' : 'Access token'}</label>
        <input id="relay-access-token" type="password" autoComplete="current-password" autoFocus value={token} onChange={event => setToken(event.target.value)} required />
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="primary-btn" type="submit" disabled={submitting}>{submitting ? (isChinese ? '正在验证…' : 'Verifying…') : (isChinese ? '连接' : 'Connect')}</button>
        <p className="auth-hint">{isChinese ? '在 Mac 终端运行 `cat ~/.relay-web/auth-token` 查看令牌。请勿分享令牌。' : 'On your Mac, run `cat ~/.relay-web/auth-token` to view the token. Keep it private.'}</p>
      </>}
      <p className="auth-warning">{isChinese ? '仅在可信的局域网中使用。不要将 3000 端口转发到公网。' : 'Use only on a trusted local network. Do not expose port 3000 to the public internet.'}</p>
    </form>
  </main>
}
