const AQUA_TOKEN_KEY = 'aqua-token'
const AQUA_USER_KEY = 'aqua-user'

export interface AuthUser {
  username: string
  is_admin: boolean
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(AQUA_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  localStorage.setItem(AQUA_TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(AQUA_TOKEN_KEY)
  localStorage.removeItem(AQUA_USER_KEY)
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AQUA_USER_KEY)
    if (!raw) return null
    const u = JSON.parse(raw) as AuthUser
    return u?.username ? u : null
  } catch {
    return null
  }
}

export function setStoredUser(user: AuthUser): void {
  localStorage.setItem(AQUA_USER_KEY, JSON.stringify(user))
}

export function getAuthHeaders(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}
