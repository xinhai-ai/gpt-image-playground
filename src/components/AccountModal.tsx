import { useEffect, useState } from 'react'
import {
  changeAccountPassword,
  getAccountDetail,
  revokeOtherSessions,
  updateAccountName,
  type AccountDetail,
} from '../lib/saasApi'
import { useStore } from '../store'
import { formatBytes, formatDateTime } from '../lib/format'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { TextInput } from './ui/TextInput'
import { GithubIcon } from './icons'

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      <span className="min-w-0 break-words text-right text-gray-800 dark:text-gray-100">{value}</span>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">{children}</h4>
}

const ROLE_LABELS: Record<string, string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  MEMBER: '成员',
}

export default function AccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [detail, setDetail] = useState<AccountDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 修改资料
  const [name, setName] = useState('')
  const [savingName, setSavingName] = useState(false)

  // 密码
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [logoutOthers, setLogoutOthers] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const next = await getAccountDetail()
      setDetail(next)
      setName(next.user.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
    // 关闭后重置表单
    return () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setLogoutOthers(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const hasPassword = detail?.security.hasPassword ?? false

  const saveName = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === detail?.user.name) return
    setSavingName(true)
    try {
      await updateAccountName(trimmed)
      showToast('昵称已更新', 'success')
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSavingName(false)
    }
  }

  const savePassword = async () => {
    if (newPassword.length < 8) {
      showToast('新密码至少 8 位', 'error')
      return
    }
    if (newPassword !== confirmPassword) {
      showToast('两次输入的新密码不一致', 'error')
      return
    }
    if (hasPassword && !currentPassword) {
      showToast('请输入当前密码', 'error')
      return
    }
    setSavingPassword(true)
    try {
      const result = await changeAccountPassword({
        currentPassword: hasPassword ? currentPassword : undefined,
        newPassword,
        logoutOtherSessions: logoutOthers,
      })
      showToast(
        hasPassword
          ? `密码已修改${result.revokedSessions ? `，已退出其他 ${result.revokedSessions} 个设备` : ''}`
          : '密码已设置',
        'success',
      )
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setLogoutOthers(false)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSavingPassword(false)
    }
  }

  const revokeOthers = () => {
    setConfirmDialog({
      title: '退出其他设备',
      message: '确定退出除当前设备外的全部登录会话吗？其他设备需要重新登录。',
      confirmText: '退出其他设备',
      tone: 'danger',
      action: () => {
        void (async () => {
          try {
            const result = await revokeOtherSessions()
            showToast(result.revokedSessions ? `已退出其他 ${result.revokedSessions} 个设备` : '没有其他设备会话', 'success')
            await load()
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), 'error')
          }
        })()
      },
    })
  }

  const otherSessionCount = detail ? detail.sessions.filter((session) => !session.current).length : 0

  return (
    <Modal open={open} onClose={onClose} title="个人中心" size="lg">
      {loading && (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500 dark:text-gray-400">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/20 dark:border-t-blue-400" />
          加载中...
        </div>
      )}
      {!loading && error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      )}
      {!loading && detail && (
        <div className="space-y-6">
          {/* 个人信息 */}
          <section>
            <SectionTitle>个人信息</SectionTitle>
            <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
              <div className="mb-3">
                <span className="mb-1 block text-sm text-gray-500 dark:text-gray-400">昵称</span>
                <div className="flex gap-2">
                  <TextInput value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="设置一个昵称" />
                  <Button
                    className="shrink-0 px-4"
                    disabled={savingName || !name.trim() || name.trim() === detail.user.name}
                    onClick={() => void saveName()}
                  >
                    {savingName ? '保存中' : '保存'}
                  </Button>
                </div>
              </div>
              <InfoRow label="邮箱" value={detail.user.email} />
              <InfoRow label="角色" value={detail.user.isPlatformAdmin ? '平台管理员' : (ROLE_LABELS[detail.tenant.role] ?? detail.tenant.role)} />
              <InfoRow label="租户" value={detail.tenant.name} />
              <InfoRow label="注册时间" value={formatDateTime(detail.user.createdAt)} />
            </div>
          </section>

          {/* 用量 */}
          <section>
            <SectionTitle>用量</SectionTitle>
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-2xl border border-gray-200 bg-white p-3 text-center dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="text-xs text-gray-500 dark:text-gray-400">任务</div>
                <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{detail.usage.tasks}</div>
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-3 text-center dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="text-xs text-gray-500 dark:text-gray-400">图片</div>
                <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{detail.usage.images}</div>
              </div>
              <div className="rounded-2xl border border-gray-200 bg-white p-3 text-center dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="text-xs text-gray-500 dark:text-gray-400">存储</div>
                <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{formatBytes(detail.usage.storageBytes)}</div>
              </div>
            </div>
          </section>

          {/* 登录方式 */}
          {detail.security.oauthProviders.length > 0 && (
            <section>
              <SectionTitle>已绑定登录方式</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {detail.security.oauthProviders.map((provider) => (
                  <span
                    key={provider}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-sm text-gray-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  >
                    {provider === 'github' ? <GithubIcon className="h-4 w-4" /> : null}
                    {provider === 'github' ? 'GitHub' : provider}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* 密码 */}
          <section>
            <SectionTitle>{hasPassword ? '修改密码' : '设置密码'}</SectionTitle>
            <div className="space-y-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
              {!hasPassword && (
                <p className="text-xs text-gray-500 dark:text-gray-400">你当前通过第三方登录，设置密码后即可使用邮箱 + 密码登录。</p>
              )}
              {hasPassword && (
                <label className="block">
                  <span className="mb-1 block text-sm text-gray-600 dark:text-gray-300">当前密码</span>
                  <TextInput type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
                </label>
              )}
              <label className="block">
                <span className="mb-1 block text-sm text-gray-600 dark:text-gray-300">新密码（至少 8 位）</span>
                <TextInput type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-gray-600 dark:text-gray-300">确认新密码</span>
                <TextInput type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </label>
              {hasPassword && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  <input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500/30 dark:border-white/20" checked={logoutOthers} onChange={(event) => setLogoutOthers(event.target.checked)} />
                  同时退出其他设备
                </label>
              )}
              <Button disabled={savingPassword} onClick={() => void savePassword()}>
                {savingPassword ? '保存中...' : hasPassword ? '修改密码' : '设置密码'}
              </Button>
            </div>
          </section>

          {/* 登录设备 */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <SectionTitle>登录设备（{detail.sessions.length}）</SectionTitle>
              {otherSessionCount > 0 && (
                <Button tone="secondary" size="sm" onClick={revokeOthers}>
                  退出其他设备
                </Button>
              )}
            </div>
            <div className="space-y-2">
              {detail.sessions.map((session) => (
                <div
                  key={session.id}
                  className="rounded-2xl border border-gray-200 bg-white p-3 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-800 dark:text-gray-100">{session.ip ?? '未知 IP'}</span>
                    {session.current && (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">当前设备</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400" title={session.userAgent ?? ''}>
                    {session.userAgent ?? '未知设备'}
                  </div>
                  <div className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">最近活跃：{formatDateTime(session.lastSeenAt)}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </Modal>
  )
}


