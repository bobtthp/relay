import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import AuthGate from './AuthGate'
import './styles.css'

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Keep the UI recoverable without exposing stack details. */ }
  render() {
    if (this.state.error) return <main className="app-error"><h1>Unable to load Relay</h1><p>Please refresh the page. If this repeats, restart the local backend.</p><code>{this.state.error.message}</code><button onClick={() => window.location.reload()}>Refresh</button></main>
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><AppErrorBoundary><AuthGate /></AppErrorBoundary></StrictMode>,
)
