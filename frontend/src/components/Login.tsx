import { useState } from 'react'
import { login, register } from '../api'
import type { AuthUser } from '../auth'

interface LoginProps {
  onLoggedIn: (user: AuthUser) => void
}

export function Login({ onLoggedIn }: LoginProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isRegister, setIsRegister] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const data = isRegister
        ? await register(username, password)
        : await login(username, password)
      onLoggedIn(data.user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-xl">
        <h1 className="mb-2 font-display text-2xl font-semibold tracking-tight text-cyan-400">
          AQUA
        </h1>
        <p className="mb-6 text-sm text-slate-400">
          {isRegister
            ? 'Create the first account (only available when no users exist yet).'
            : 'Sign in to continue'}
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="mb-1 block text-xs text-slate-500">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="admin"
              required
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-xs text-slate-500">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2.5 text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="••••••••"
              required
              minLength={isRegister ? 6 : undefined}
            />
            {isRegister && (
              <p className="mt-1 text-xs text-slate-500">At least 6 characters</p>
            )}
          </div>
          {error && (
            <p className="rounded-lg bg-rose-900/40 px-3 py-2 text-sm text-rose-300">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-cyan-600 py-2.5 font-medium text-white hover:bg-cyan-500 disabled:opacity-70"
          >
            {loading ? '…' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <button
          type="button"
          onClick={() => {
            setIsRegister(!isRegister)
            setError('')
          }}
          className="mt-4 w-full text-center text-sm text-slate-400 hover:text-slate-300"
        >
          {isRegister ? 'Already have an account? Sign in' : 'First time? Create account'}
        </button>
      </div>
    </div>
  )
}
