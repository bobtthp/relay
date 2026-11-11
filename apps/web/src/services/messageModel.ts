type LocalModel = { configured: boolean; agent?: 'Codex' | 'Claude'; model: string | null }

export function messageModelSelection(action: 'message' | 'push', agent: 'Codex' | 'Claude', selectedModel: string, selectedEffort: string, useLocalForPush: boolean, local: LocalModel) {
  if (action === 'message' || !useLocalForPush) return { model: selectedModel, effort: selectedEffort }
  if (!local.configured || !local.model) throw new Error('请先配置本地模型 / Please configure a local model first')
  if ((local.agent ?? 'Codex') !== agent) throw new Error(`本地模型配置属于 ${local.agent}，请配置 ${agent} 本地模型或切换 Agent / Configure a custom ${agent} provider or switch agents`)
  return { model: `relay-local:${local.model}`, effort: '' }
}
