const TOKEN_STORAGE_KEY = 'relay-access-token'

export const getRelayAccessToken = () => window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''

export const saveRelayAccessToken = (token: string) => window.localStorage.setItem(TOKEN_STORAGE_KEY, token)

export const clearRelayAccessToken = () => window.localStorage.removeItem(TOKEN_STORAGE_KEY)

export function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = getRelayAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return window.fetch(input, { ...init, headers })
}
