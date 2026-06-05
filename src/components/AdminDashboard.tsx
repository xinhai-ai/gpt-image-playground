import { useEffect, useMemo, useState } from 'react'
import {
  getAdminOverview,
  getAdminStorage,
  listAdminChannels,
  listAdminLogs,
  listAdminUsers,
  revokeAdminUserSessions,
  updateAdminChannel,
  updateAdminUser,
  type AdminChannel,
  type AdminOverview,
  type AdminStorage,
  type AdminUsageLog,
  type AdminUser,
} from '../lib/saasApi'
import { useSaasAuth } from './AuthGate'

type AdminTab = 'overview' | 'users' | 'logs' | 'channels' | 'storage'
const ADMIN_PAGE_SIZE = 50

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-gray-200 p-6 text-center text-sm text-gray-500 dark:border-white/[0.08] dark:text-gray-400">{text}</div>
}

export default function AdminDashboard({ onClose }: { onClose: () => void }) {
  const auth = useSaasAuth()
  const [tab, setTab] = useState<AdminTab>('overview')
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [logs, setLogs] = useState<AdminUsageLog[]>([])
  const [channels, setChannels] = useState<AdminChannel[]>([])
  const [storage, setStorage] = useState<AdminStorage | null>(null)
  const [userQuery, setUserQuery] = useState('')
  const [logQuery, setLogQuery] = useState('')
  const [userPage, setUserPage] = useState(1)
  const [userTotal, setUserTotal] = useState(0)
  const [logPage, setLogPage] = useState(1)
  const [logTotal, setLogTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const isAdmin = Boolean(auth?.session.user.isPlatformAdmin)

  const load = async (options: { userPage?: number; logPage?: number } = {}) => {
    if (!isAdmin) return
    const nextUserPage = options.userPage ?? userPage
    const nextLogPage = options.logPage ?? logPage
    setLoading(true)
    setError('')
    try {
      const [nextOverview, nextUsers, nextLogs, nextChannels, nextStorage] = await Promise.all([
        getAdminOverview(),
        listAdminUsers({ q: userQuery || undefined, page: nextUserPage, pageSize: ADMIN_PAGE_SIZE }),
        listAdminLogs({ q: logQuery || undefined, page: nextLogPage, pageSize: ADMIN_PAGE_SIZE }),
        listAdminChannels(),
        getAdminStorage(),
      ])
      setOverview(nextOverview)
      setUsers(nextUsers.users)
      setUserTotal(nextUsers.total)
      setLogs(nextLogs.logs)
      setLogTotal(nextLogs.total)
      setChannels(nextChannels.channels)
      setStorage(nextStorage)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  const statusText = useMemo(() => {
    const statuses = overview?.stats.taskStatuses ?? {}
    return Object.entries(statuses).map(([key, value]) => `${key}: ${value}`).join(' / ') || '-'
  }, [overview])

  const toggleUserDisabled = async (user: AdminUser) => {
    await updateAdminUser(user.id, { disabled: !user.disabledAt })
    await load()
  }

  const toggleUserAdmin = async (user: AdminUser) => {
    await updateAdminUser(user.id, { isPlatformAdmin: !user.isPlatformAdmin })
    await load()
  }

  const revokeUserSessions = async (user: AdminUser) => {
    await revokeAdminUserSessions(user.id)
    await load()
  }

  const toggleChannelDisabled = async (channel: AdminChannel) => {
    await updateAdminChannel(channel.id, { disabled: !channel.disabledAt })
    await load()
  }

  const searchUsers = () => {
    setUserPage(1)
    void load({ userPage: 1 })
  }

  const searchLogs = () => {
    setLogPage(1)
    void load({ logPage: 1 })
  }

  const goUserPage = (page: number) => {
    setUserPage(page)
    void load({ userPage: page })
  }

  const goLogPage = (page: number) => {
    setLogPage(page)
    void load({ logPage: page })
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gray-50 p-6 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <button onClick={onClose} className="mb-4 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-white/[0.08]">返回</button>
        <EmptyState text="当前账号没有后台管理权限" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold">后台管理</h1>
            <div className="text-xs text-gray-500 dark:text-gray-400">{auth?.session.user.email}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} className="rounded-lg border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50 dark:border-white/[0.08] dark:hover:bg-white/[0.04]">刷新</button>
            <button onClick={onClose} className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-700 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200">返回画廊</button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-3">
          {([
            ['overview', '概览'],
            ['users', '用户'],
            ['logs', '日志'],
            ['channels', '渠道'],
            ['storage', '存储'],
          ] as Array<[AdminTab, string]>).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`rounded-lg px-3 py-1.5 text-sm ${tab === value ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5">
        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        {loading && <div className="mb-4 text-sm text-gray-500">加载中...</div>}

        {tab === 'overview' && overview && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="用户" value={`${overview.stats.users} / 禁用 ${overview.stats.disabledUsers}`} />
              <Stat label="租户" value={overview.stats.tenants} />
              <Stat label="任务" value={`${overview.stats.tasks} / 今日 ${overview.stats.todayTasks}`} />
              <Stat label="活跃 Session" value={overview.stats.activeSessions} />
              <Stat label="图片" value={overview.stats.images} />
              <Stat label="存储" value={formatBytes(overview.stats.storageBytes)} />
              <Stat label="渠道" value={`${overview.stats.channels} / 停用 ${overview.stats.disabledChannels}`} />
              <Stat label="任务状态" value={statusText} />
            </div>
            <LogTable logs={overview.recentLogs} />
          </div>
        )}

        {tab === 'users' && (
          <div className="space-y-3">
            <SearchRow value={userQuery} onChange={setUserQuery} onSubmit={searchUsers} placeholder="搜索邮箱" />
            <UserTable users={users} onToggleDisabled={toggleUserDisabled} onToggleAdmin={toggleUserAdmin} onRevokeSessions={revokeUserSessions} currentUserId={auth?.session.user.id} />
            <Pagination page={userPage} pageSize={ADMIN_PAGE_SIZE} total={userTotal} onPageChange={goUserPage} />
          </div>
        )}

        {tab === 'logs' && (
          <div className="space-y-3">
            <SearchRow value={logQuery} onChange={setLogQuery} onSubmit={searchLogs} placeholder="搜索动作、目标、用户或租户" />
            <LogTable logs={logs} />
            <Pagination page={logPage} pageSize={ADMIN_PAGE_SIZE} total={logTotal} onPageChange={goLogPage} />
          </div>
        )}

        {tab === 'channels' && <ChannelTable channels={channels} onToggleDisabled={toggleChannelDisabled} />}

        {tab === 'storage' && storage && <StorageView storage={storage} />}
      </main>
    </div>
  )
}

function SearchRow({ value, onChange, onSubmit, placeholder }: { value: string; onChange: (value: string) => void; onSubmit: () => void; placeholder: string }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit()
      }}
      className="flex gap-2"
    >
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/[0.08] dark:bg-white/[0.03]" />
      <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">搜索</button>
    </form>
  )
}

function Pagination({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }) {
  if (total <= pageSize) return null
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="flex items-center justify-between gap-3 text-sm text-gray-500 dark:text-gray-400">
      <span>共 {total} 条，第 {page} / {maxPage} 页</span>
      <div className="flex gap-2">
        <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="rounded-lg border border-gray-200 px-3 py-1.5 disabled:opacity-40 dark:border-white/[0.08]">上一页</button>
        <button disabled={page >= maxPage} onClick={() => onPageChange(page + 1)} className="rounded-lg border border-gray-200 px-3 py-1.5 disabled:opacity-40 dark:border-white/[0.08]">下一页</button>
      </div>
    </div>
  )
}

function UserTable({ users, onToggleDisabled, onToggleAdmin, onRevokeSessions, currentUserId }: { users: AdminUser[]; onToggleDisabled: (user: AdminUser) => Promise<void>; onToggleAdmin: (user: AdminUser) => Promise<void>; onRevokeSessions: (user: AdminUser) => Promise<void>; currentUserId?: string }) {
  if (!users.length) return <EmptyState text="暂无用户" />
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-white/[0.08]">
          <tr><th className="px-3 py-2">用户</th><th className="px-3 py-2">租户</th><th className="px-3 py-2">用量</th><th className="px-3 py-2">最近活跃</th><th className="px-3 py-2">操作</th></tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-b border-gray-100 last:border-b-0 dark:border-white/[0.06]">
              <td className="px-3 py-2">
                <div className="font-medium">{user.email}</div>
                <div className="text-xs text-gray-500">{user.isPlatformAdmin ? '平台管理员' : '普通用户'}{user.disabledAt ? ' / 已禁用' : ''}</div>
              </td>
              <td className="px-3 py-2">{user.memberships.map((item) => item.tenant.name).join(', ') || '-'}</td>
              <td className="px-3 py-2">{user.counts.tasks} 任务 / {formatBytes(user.counts.storageBytes)}</td>
              <td className="px-3 py-2">{formatDate(user.lastSeenAt)}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-2">
                  <button disabled={user.id === currentUserId} onClick={() => void onToggleDisabled(user)} className="rounded-lg border border-gray-200 px-2 py-1 text-xs disabled:opacity-40 dark:border-white/[0.08]">{user.disabledAt ? '启用' : '禁用'}</button>
                  <button disabled={user.id === currentUserId} onClick={() => void onToggleAdmin(user)} className="rounded-lg border border-gray-200 px-2 py-1 text-xs disabled:opacity-40 dark:border-white/[0.08]">{user.isPlatformAdmin ? '撤销管理员' : '设为管理员'}</button>
                  <button disabled={user.id === currentUserId || user.counts.sessions === 0} onClick={() => void onRevokeSessions(user)} className="rounded-lg border border-gray-200 px-2 py-1 text-xs disabled:opacity-40 dark:border-white/[0.08]">清退会话</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LogTable({ logs }: { logs: AdminUsageLog[] }) {
  if (!logs.length) return <EmptyState text="暂无日志" />
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-white/[0.08]">
          <tr><th className="px-3 py-2">时间</th><th className="px-3 py-2">动作</th><th className="px-3 py-2">用户</th><th className="px-3 py-2">租户</th><th className="px-3 py-2">目标</th><th className="px-3 py-2">来源</th><th className="px-3 py-2">详情</th></tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id} className="border-b border-gray-100 last:border-b-0 dark:border-white/[0.06]">
              <td className="whitespace-nowrap px-3 py-2">{formatDate(log.createdAt)}</td>
              <td className="px-3 py-2 font-mono text-xs">{log.action}</td>
              <td className="px-3 py-2">{log.user?.email ?? '-'}</td>
              <td className="px-3 py-2">{log.tenant?.name ?? '-'}</td>
              <td className="px-3 py-2 font-mono text-xs">{log.targetType ?? '-'} {log.targetId ?? ''}</td>
              <td className="px-3 py-2 text-xs"><div>{log.ip ?? '-'}</div><div className="max-w-60 truncate text-gray-500" title={log.userAgent ?? ''}>{log.userAgent ?? ''}</div></td>
              <td className="max-w-80 px-3 py-2 font-mono text-xs text-gray-500"><div className="truncate" title={log.detail ? JSON.stringify(log.detail) : ''}>{log.detail ? JSON.stringify(log.detail) : '-'}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChannelTable({ channels, onToggleDisabled }: { channels: AdminChannel[]; onToggleDisabled: (channel: AdminChannel) => Promise<void> }) {
  if (!channels.length) return <EmptyState text="暂无渠道" />
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
      <table className="min-w-full text-left text-sm">
        <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-white/[0.08]">
          <tr><th className="px-3 py-2">渠道</th><th className="px-3 py-2">租户</th><th className="px-3 py-2">模型</th><th className="px-3 py-2">任务</th><th className="px-3 py-2">操作</th></tr>
        </thead>
        <tbody>
          {channels.map((channel) => (
            <tr key={channel.id} className="border-b border-gray-100 last:border-b-0 dark:border-white/[0.06]">
              <td className="px-3 py-2">
                <div className="font-medium">{channel.name}</div>
                <div className="text-xs text-gray-500">{channel.provider} / {channel.hasApiKey ? '有 Key' : '无 Key'}{channel.disabledAt ? ' / 已停用' : ''}</div>
              </td>
              <td className="px-3 py-2">{channel.tenant.name}</td>
              <td className="px-3 py-2">{channel.model}</td>
              <td className="px-3 py-2">{channel.taskCount}</td>
              <td className="px-3 py-2"><button onClick={() => void onToggleDisabled(channel)} className="rounded-lg border border-gray-200 px-2 py-1 text-xs dark:border-white/[0.08]">{channel.disabledAt ? '启用' : '停用'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StorageView({ storage }: { storage: AdminStorage }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="图片" value={storage.summary.images} />
        <Stat label="总存储" value={formatBytes(storage.summary.storageBytes)} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Breakdown title="按租户" rows={storage.byTenant.map((row) => [row.tenant.name, row.images, row.storageBytes])} />
        <Breakdown title="按用途" rows={storage.byPurpose.map((row) => [row.purpose, row.images, row.storageBytes])} />
        <Breakdown title="按状态" rows={storage.byStatus.map((row) => [row.status, row.images, row.storageBytes])} />
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.03]">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-white/[0.08]">
            <tr><th className="px-3 py-2">图片</th><th className="px-3 py-2">租户</th><th className="px-3 py-2">用户</th><th className="px-3 py-2">大小</th><th className="px-3 py-2">时间</th></tr>
          </thead>
          <tbody>
            {storage.recentImages.map((image) => (
              <tr key={image.id} className="border-b border-gray-100 last:border-b-0 dark:border-white/[0.06]">
                <td className="px-3 py-2"><div className="font-mono text-xs">{image.id}</div><div className="text-xs text-gray-500">{image.purpose} / {image.status} / {image.contentType}</div></td>
                <td className="px-3 py-2">{image.tenant.name}</td>
                <td className="px-3 py-2">{image.createdBy.email}</td>
                <td className="px-3 py-2">{formatBytes(image.byteSize)}</td>
                <td className="px-3 py-2">{formatDate(image.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Breakdown({ title, rows }: { title: string; rows: Array<[string, number, number]> }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <div className="space-y-2">
        {rows.map(([label, count, bytes]) => (
          <div key={label} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 text-gray-500">{count} / {formatBytes(bytes)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
