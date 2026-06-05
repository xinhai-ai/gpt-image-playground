import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { getCurrentSession, getGitHubOAuthStartUrl, getGoogleOAuthStartUrl, getOAuthOptions, isSaasMode, login, logout, register, saasProviderProfileToApiProfile, sendEmailLoginCode, verifyEmailLoginCode, type OAuthOptions, type SaasSession } from '../lib/saasApi'
import { useStore } from '../store'
import { Button } from './ui/Button'
import { TextInput } from './ui/TextInput'
import { GithubIcon, GoogleIcon } from './icons'

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
  const [authMethod, setAuthMethod] = useState<'email-code' | 'password'>('email-code')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailCodeSent, setEmailCodeSent] = useState(false)
  const [emailCodeExpiresAt, setEmailCodeExpiresAt] = useState<number | null>(null)
  const [emailCodeCooldownUntil, setEmailCodeCooldownUntil] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [tenantName, setTenantName] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [oauthOptions, setOauthOptions] = useState<OAuthOptions | null>(null)
  const readySessionId = useRef<string | null>(null)
  const emailPasswordRegistrationEnabled = oauthOptions?.emailPassword?.registrationEnabled !== false
  const emailOtpEnabled = oauthOptions?.emailOtp?.enabled === true
  const emailCodeMode = emailOtpEnabled && authMethod === 'email-code'
  const registerMode = authMethod === 'password' && mode === 'register' && emailPasswordRegistrationEnabled
  const emailCodeCooldownSeconds = emailCodeCooldownUntil ? Math.max(0, Math.ceil((emailCodeCooldownUntil - now) / 1000)) : 0
  const emailCodeExpiresInSeconds = emailCodeExpiresAt ? Math.max(0, Math.ceil((emailCodeExpiresAt - now) / 1000)) : 0
  const emailCodeLength = Math.max(4, Math.min(10, oauthOptions?.emailOtp?.codeLength ?? 6))

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
    void Promise.all([
      getOAuthOptions()
        .then((options) => {
          if (!cancelled) setOauthOptions(options)
        })
        .catch(() => {
          if (!cancelled) setOauthOptions({ emailPassword: { registrationEnabled: true }, emailOtp: { enabled: false }, github: { enabled: false }, google: { enabled: false } })
        }),
      getCurrentSession()
        .then((nextSession) => {
          if (!cancelled) applySession(nextSession)
        })
        .catch(() => {
          if (!cancelled) setSession(null)
        }),
    ])
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!emailPasswordRegistrationEnabled && mode === 'register') setMode('login')
  }, [emailPasswordRegistrationEnabled, mode])

  useEffect(() => {
    if (oauthOptions && !emailOtpEnabled && authMethod === 'email-code') setAuthMethod('password')
  }, [authMethod, emailOtpEnabled, oauthOptions])

  useEffect(() => {
    if (!emailCodeSent && !emailCodeCooldownUntil) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [emailCodeCooldownUntil, emailCodeSent])

  useEffect(() => {
    setEmailCodeSent(false)
    setEmailCode('')
    setEmailCodeExpiresAt(null)
    setEmailCodeCooldownUntil(null)
    setNotice('')
  }, [email])

  useEffect(() => {
    if (!session || readySessionId.current === session.user.id) return
    readySessionId.current = session.user.id
    onReady()
  }, [onReady, session])

  if (!isSaasMode()) return <>{children}</>

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setNotice('')
    if (emailCodeMode) {
      if (!emailCodeSent) {
        await handleSendEmailCode()
        return
      }
      setSubmitting(true)
      try {
        const nextSession = await verifyEmailLoginCode(email, emailCode)
        applySession(nextSession)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSubmitting(false)
      }
      return
    }
    if (mode === 'register' && !emailPasswordRegistrationEnabled) {
      setError('邮箱密码注册已关闭')
      return
    }
    setSubmitting(true)
    try {
      const nextSession = registerMode
        ? await register(email, password, tenantName || undefined)
        : await login(email, password)
      applySession(nextSession)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleSendEmailCode = async () => {
    setError('')
    setNotice('')
    setSubmitting(true)
    try {
      const result = await sendEmailLoginCode(email)
      const nextNow = Date.now()
      setNow(nextNow)
      setEmailCode('')
      setEmailCodeSent(true)
      setEmailCodeExpiresAt(nextNow + result.expiresIn * 1000)
      setEmailCodeCooldownUntil(nextNow + result.cooldownSeconds * 1000)
      setNotice('验证码已发送，请查看邮箱')
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

  const handleGoogleLogin = () => {
    setError('')
    setSubmitting(true)
    const redirectPath = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
    window.location.href = getGoogleOAuthStartUrl(redirectPath)
  }

  const handleLogout = async () => {
    await logout()
    window.location.reload()
  }

  if (loading) {
    return (
      <div className="safe-area-top flex min-h-screen items-center justify-center bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <div className="flex items-center gap-2.5 text-sm text-gray-500 dark:text-gray-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/20 dark:border-t-blue-400" />
          正在加载账号...
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="safe-area-top flex min-h-screen items-center justify-center bg-gray-50 px-4 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-sm rounded-3xl border border-white/50 bg-white/90 p-6 shadow-[0_8px_40px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-confirm-in dark:border-white/[0.08] dark:bg-gray-900/90 dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] dark:ring-white/10"
        >
          <div className="mb-5">
            <h1 className="text-lg font-bold tracking-tight">GPT Image Playground</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">登录后进入画廊</p>
          </div>
          {emailOtpEnabled && (
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-gray-100/70 p-1 dark:border-white/[0.08] dark:bg-white/[0.04]">
              <button
                type="button"
                onClick={() => setAuthMethod('email-code')}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${authMethod === 'email-code' ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
              >
                验证码
              </button>
              <button
                type="button"
                onClick={() => setAuthMethod('password')}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${authMethod === 'password' ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
              >
                密码
              </button>
            </div>
          )}
          {authMethod === 'password' && emailPasswordRegistrationEnabled && (
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-gray-100/70 p-1 dark:border-white/[0.08] dark:bg-white/[0.04]">
              <button
                type="button"
                onClick={() => setMode('login')}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${mode === 'login' ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
              >
                登录
              </button>
              <button
                type="button"
                onClick={() => setMode('register')}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${mode === 'register' ? 'bg-white font-medium text-gray-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
              >
                注册
              </button>
            </div>
          )}
          {(oauthOptions?.github?.enabled || oauthOptions?.google?.enabled) && (
            <>
              <div className="mb-4 grid gap-2">
                {oauthOptions?.google?.enabled && (
                  <Button
                    type="button"
                    tone="secondary"
                    onClick={handleGoogleLogin}
                    disabled={submitting}
                    className="w-full"
                  >
                    <GoogleIcon className="h-4 w-4" />
                    使用 Google 登录
                  </Button>
                )}
                {oauthOptions?.github?.enabled && (
                  <Button
                    type="button"
                    tone="secondary"
                    onClick={handleGithubLogin}
                    disabled={submitting}
                    className="w-full"
                  >
                    <GithubIcon className="h-4 w-4" />
                    使用 GitHub 登录
                  </Button>
                )}
              </div>
              <div className="mb-4 flex items-center gap-3 text-xs text-gray-400">
                <div className="h-px flex-1 bg-gray-200 dark:bg-white/[0.08]" />
                <span>或</span>
                <div className="h-px flex-1 bg-gray-200 dark:bg-white/[0.08]" />
              </div>
            </>
          )}
          <label className="mb-3 block">
            <span className="mb-1 block text-sm font-medium">邮箱</span>
            <TextInput
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          {emailCodeMode ? (
            emailCodeSent && (
              <label className="mb-3 block">
                <span className="mb-1 flex items-center justify-between gap-3 text-sm font-medium">
                  <span>验证码</span>
                  <button
                    type="button"
                    onClick={handleSendEmailCode}
                    disabled={submitting || emailCodeCooldownSeconds > 0}
                    className="text-xs font-medium text-blue-500 disabled:text-gray-400 dark:text-blue-400"
                  >
                    {emailCodeCooldownSeconds > 0 ? `${emailCodeCooldownSeconds}s` : '重新发送'}
                  </button>
                </span>
                <TextInput
                  type="text"
                  inputMode="numeric"
                  value={emailCode}
                  onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, '').slice(0, emailCodeLength))}
                  autoComplete="one-time-code"
                  minLength={emailCodeLength}
                  maxLength={emailCodeLength}
                  required
                />
                {emailCodeExpiresInSeconds > 0 && (
                  <span className="mt-1 block text-xs text-gray-400">验证码 {emailCodeExpiresInSeconds}s 内有效</span>
                )}
              </label>
            )
          ) : (
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium">密码</span>
              <TextInput
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={registerMode ? 'new-password' : 'current-password'}
                minLength={registerMode ? 8 : undefined}
                required
              />
            </label>
          )}
          {registerMode && (
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium">租户名称</span>
              <TextInput
                type="text"
                value={tenantName}
                onChange={(event) => setTenantName(event.target.value)}
              />
            </label>
          )}
          {error && (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
              {notice}
            </div>
          )}
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? '提交中...' : emailCodeMode ? emailCodeSent ? '登录或注册' : '发送验证码' : registerMode ? '注册并进入' : '登录'}
          </Button>
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
