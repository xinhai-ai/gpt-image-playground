import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { getCurrentSession, getGitHubOAuthStartUrl, getOAuthOptions, isSaasMode, login, logout, register, saasProviderProfileToApiProfile, type OAuthOptions, type SaasSession } from '../lib/saasApi'
import { useStore } from '../store'

interface SaasAuthContextValue {
  session: SaasSession
  logout: () => Promise<void>
}

const SaasAuthContext = createContext<SaasAuthContextValue | null>(null)

export function useSaasAuth() {
  return useContext(SaasAuthContext)
}

export default function AuthGate({ children, onReady }: { children: ReactNode; onReady: () => void }) {
  const [session, setSession] = useState<SaasSession | null>(null)
  const [loading, setLoading] = useState(isSaasMode())
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tenantName, setTenantName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [oauthOptions, setOauthOptions] = useState<OAuthOptions | null>(null)
  const readySessionId = useRef<string | null>(null)

  const applySession = (nextSession: SaasSession) => {
    const profiles = nextSession.providerProfiles.map(saasProviderProfileToApiProfile)
    if (profiles.length > 0) {
      const state = useStore.getState()
      const activeProfileId = profiles.some((profile) => profile.id === state.settings.activeProfileId)
        ? state.settings.activeProfileId
        : profiles[0]!.id
      state.setSettings({
        profiles,
        activeProfileId,
      })
    }
    setSession(nextSession)
  }

  useEffect(() => {
    if (!isSaasMode()) return
    let cancelled = false
    void getOAuthOptions()
      .then((options) => {
        if (!cancelled) setOauthOptions(options)
      })
      .catch(() => {
        if (!cancelled) setOauthOptions({ github: { enabled: false } })
      })
    void getCurrentSession()
      .then((nextSession) => {
        if (!cancelled) applySession(nextSession)
      })
      .catch(() => {
        if (!cancelled) setSession(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!session || readySessionId.current === session.user.id) return
    readySessionId.current = session.user.id
    onReady()
  }, [onReady, session])

  if (!isSaasMode()) return <>{children}</>

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const nextSession = mode === 'login'
        ? await login(email, password)
        : await register(email, password, tenantName || undefined)
      applySession(nextSession)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleGithubLogin = () => {
    setError('')
    setSubmitting(true)
    const redirectPath = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
    window.location.href = getGitHubOAuthStartUrl(redirectPath)
  }

  const handleLogout = async () => {
    await logout()
    window.location.reload()
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 flex items-center justify-center">
        <div className="text-sm text-gray-500 dark:text-gray-400">正在加载账号...</div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 flex items-center justify-center px-4">
        <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 p-5 shadow-sm">
          <div className="mb-5">
            <h1 className="text-lg font-bold">GPT Image Playground</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">登录后进入画廊</p>
          </div>
          <div className="mb-4 grid grid-cols-2 rounded-lg bg-gray-100 dark:bg-white/[0.05] p-1">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`rounded-md px-3 py-1.5 text-sm ${mode === 'login' ? 'bg-white dark:bg-white/10 font-medium shadow-sm' : 'text-gray-500'}`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`rounded-md px-3 py-1.5 text-sm ${mode === 'register' ? 'bg-white dark:bg-white/10 font-medium shadow-sm' : 'text-gray-500'}`}
            >
              注册
            </button>
          </div>
          {oauthOptions?.github.enabled && (
            <>
              <button
                type="button"
                onClick={handleGithubLogin}
                disabled={submitting}
                className="mb-4 w-full rounded-md border border-gray-300 dark:border-white/[0.12] bg-white dark:bg-gray-950 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
              >
                使用 GitHub 登录
              </button>
              <div className="mb-4 flex items-center gap-3 text-xs text-gray-400">
                <div className="h-px flex-1 bg-gray-200 dark:bg-white/[0.08]" />
                <span>或</span>
                <div className="h-px flex-1 bg-gray-200 dark:bg-white/[0.08]" />
              </div>
            </>
          )}
          <label className="mb-3 block">
            <span className="mb-1 block text-sm font-medium">邮箱</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              className="w-full rounded-md border border-gray-300 dark:border-white/[0.12] bg-white dark:bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </label>
          <label className="mb-3 block">
            <span className="mb-1 block text-sm font-medium">密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
              className="w-full rounded-md border border-gray-300 dark:border-white/[0.12] bg-white dark:bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </label>
          {mode === 'register' && (
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium">租户名称</span>
              <input
                type="text"
                value={tenantName}
                onChange={(event) => setTenantName(event.target.value)}
                className="w-full rounded-md border border-gray-300 dark:border-white/[0.12] bg-white dark:bg-gray-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
            </label>
          )}
          {error && <div className="mb-3 rounded-md bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? '提交中...' : mode === 'login' ? '登录' : '注册并进入'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <SaasAuthContext.Provider value={{ session, logout: handleLogout }}>
      {children}
    </SaasAuthContext.Provider>
  )
}
