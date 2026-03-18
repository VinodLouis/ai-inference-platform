import type { InferenceJob, SessionState, User } from '../types'

const TOKEN_KEY = 'aip_token'
const USER_KEY = 'aip_user'

export function loadSession (): SessionState {
  const token = localStorage.getItem(TOKEN_KEY) || ''
  const rawUser = localStorage.getItem(USER_KEY)

  let user: User | null = null
  if (rawUser) {
    try {
      user = JSON.parse(rawUser) as User
    } catch {
      user = null
    }
  }

  return { token, user }
}

export function saveSession (token: string, user: User | null): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  }

  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
  }
}

export function clearSession (): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

function historyKeyForEmail (email: string): string {
  return `aip_history_${email || 'unknown'}`
}

export function loadUserHistory (email: string): InferenceJob[] {
  if (!email) return []

  const raw = localStorage.getItem(historyKeyForEmail(email))
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as InferenceJob[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveUserHistory (email: string, history: InferenceJob[]): void {
  if (!email) return
  localStorage.setItem(historyKeyForEmail(email), JSON.stringify(history || []))
}
