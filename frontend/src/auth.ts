const AQUA_TOKEN_KEY = 'aqua-token'
const AQUA_USER_KEY = 'aqua-user'
const AQUA_LOGIN_AT_KEY = 'aqua-login-at'
const AQUA_LAST_AUTH_SUCCESS_KEY = 'aqua-last-auth-success'
const LOGIN_GRACE_MS = 5000
const RECENT_AUTH_SUCCESS_MS = 30000

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
  try {
    sessionStorage.setItem(AQUA_LOGIN_AT_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}

/** True if we're within the short grace period after login (don't treat 401 as session expired). */
export function isWithinLoginGrace(): boolean {
  try {
    const t = sessionStorage.getItem(AQUA_LOGIN_AT_KEY)
    if (!t) return false
    const at = parseInt(t, 10)
    return !isNaN(at) && Date.now() - at < LOGIN_GRACE_MS
  } catch {
    return false
  }
}

/** Record that we just got a successful response (2xx); used to avoid logging out on a single stray 401. */
export function setLastAuthSuccess(): void {
  try {
    sessionStorage.setItem(AQUA_LAST_AUTH_SUCCESS_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}

/** True if we had a successful auth request recently (don't treat one 401 as session expired). */
export function hasRecentAuthSuccess(withinMs: number = RECENT_AUTH_SUCCESS_MS): boolean {
  try {
    const t = sessionStorage.getItem(AQUA_LAST_AUTH_SUCCESS_KEY)
    if (!t) return false
    const at = parseInt(t, 10)
    return !isNaN(at) && Date.now() - at < withinMs
  } catch {
    return false
  }
}

export function clearToken(): void {
  localStorage.removeItem(AQUA_TOKEN_KEY)
  localStorage.removeItem(AQUA_USER_KEY)
  try {
    sessionStorage.removeItem(AQUA_LOGIN_AT_KEY)
    sessionStorage.removeItem(AQUA_LAST_AUTH_SUCCESS_KEY)
  } catch {
    /* ignore */
  }
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
