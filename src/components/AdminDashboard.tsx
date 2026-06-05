import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useStore } from '../store'
import { formatBytes, formatDateTime as formatDate } from '../lib/format'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { StatTile } from './ui/StatTile'
import { EmptyState } from './ui/EmptyState'
import { Pagination } from './ui/Pagination'
import { DataTable, type DataTableColumn } from './ui/DataTable'
import { TextInput } from './ui/TextInput'
import { ChevronLeftIcon, RefreshIcon } from './icons'

type AdminTab = 'overview' | 'users' | 'logs' | 'channels' | 'storage'
const ADMIN_PAGE_SIZE = 50

const TABS: Array<[AdminTab, string]> = [
  ['overview', '概览'],
  ['users', '用户'],
  ['logs', '日志'],
  ['channels', '渠道'],
  ['storage', '存储'],
]

export default function AdminDashboard({ onClose }: { onClose: () => void }) {
  const auth = useSaasAuth()
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const loadedTabs = useRef<Set<AdminTab>>(new Set())

  const isAdmin = Boolean(auth?.session.user.isPlatformAdmin)

  // 每个 tab 只加载自己的数据，避免一次性拉取全部、以及每次操作后全量刷新。
  const loadTab = async (target: AdminTab, options: { userPage?: number; logPage?: number; silent?: boolean } = {}) => {
    if (!isAdmin) return
    if (!options.silent) setLoading(true)
    setError('')
    try {
      switch (target) {
        case 'overview': {
          setOverview(await getAdminOverview())
          break
        }
        case 'users': {
          const nextPage = options.userPage ?? userPage
          const result = await listAdminUsers({ q: userQuery || undefined, page: nextPage, pageSize: ADMIN_PAGE_SIZE })
          setUsers(result.users)
          setUserTotal(result.total)
          break
        }
        case 'logs': {
          const nextPage = options.logPage ?? logPage
          const result = await listAdminLogs({ q: logQuery || undefined, page: nextPage, pageSize: ADMIN_PAGE_SIZE })
          setLogs(result.logs)
          setLogTotal(result.total)
          break
        }
        case 'channels': {
          setChannels((await listAdminChannels()).channels)
          break
        }
        case 'storage': {
          setStorage(await getAdminStorage())
          break
        }
      }
      loadedTabs.current.add(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!options.silent) setLoading(false)
    }
  }

  // 切换 tab 时按需加载（首次进入才拉取）。
  useEffect(() => {
    if (!isAdmin) return
    if (!loadedTabs.current.has(tab)) void loadTab(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, tab])

  const statusText = useMemo(() => {
    const labels: Record<string, string> = { RUNNING: '运行中', DONE: '完成', ERROR: '失败' }
    const statuses = overview?.stats.taskStatuses ?? {}
    return Object.entries(statuses).map(([key, value]) => `${labels[key] ?? key} ${value}`).join(' / ') || '-'
  }, [overview])

  // 执行变更操作：toast 反馈 + 仅刷新受影响的 tab（同时让概览失效，下次进入会重新拉取）。
  const runAction = async (label: string, affectedTab: AdminTab, action: () => Promise<unknown>) => {
    try {
      await action()
      loadedTabs.current.delete('overview')
      await loadTab(affectedTab, { silent: true })
      showToast(`${label}成功`, 'success')
    } catch (err) {
      showToast(`${label}失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  // Ask for confirmation before a destructive admin action.
  const confirmAction = (options: { title: string; message: string; confirmText: string; tone?: 'danger' | 'warning'; label: string; affectedTab: AdminTab; action: () => Promise<unknown> }) => {
    setConfirmDialog({
      title: options.title,
      message: options.message,
      confirmText: options.confirmText,
      tone: options.tone,
      action: () => void runAction(options.label, options.affectedTab, options.action),
    })
  }

  const toggleUserDisabled = (user: AdminUser) => {
    const disabling = !user.disabledAt
    confirmAction({
      title: disabling ? '禁用用户' : '启用用户',
      message: disabling
        ? `确定禁用 \`${user.email}\` 吗？该用户的所有会话将被清退，且无法登录。`
        : `确定重新启用 \`${user.email}\` 吗？`,
      confirmText: disabling ? '禁用' : '启用',
      tone: disabling ? 'danger' : undefined,
      label: disabling ? '禁用用户' : '启用用户',
      affectedTab: 'users',
      action: () => updateAdminUser(user.id, { disabled: disabling }),
    })
  }

  const toggleUserAdmin = (user: AdminUser) => {
    const granting = !user.isPlatformAdmin
    confirmAction({
      title: granting ? '设为管理员' : '撤销管理员',
      message: granting
        ? `确定授予 \`${user.email}\` 平台管理员权限吗？`
        : `确定撤销 \`${user.email}\` 的平台管理员权限吗？`,
      confirmText: granting ? '设为管理员' : '撤销',
      tone: granting ? 'warning' : 'danger',
      label: granting ? '设为管理员' : '撤销管理员',
      affectedTab: 'users',
      action: () => updateAdminUser(user.id, { isPlatformAdmin: granting }),
    })
  }

  const revokeUserSessions = (user: AdminUser) => {
    confirmAction({
      title: '清退会话',
      message: `确定清退 \`${user.email}\` 的全部登录会话吗？该用户需重新登录。`,
      confirmText: '清退会话',
      tone: 'danger',
      label: '清退会话',
      affectedTab: 'users',
      action: () => revokeAdminUserSessions(user.id),
    })
  }

  const toggleChannelDisabled = (channel: AdminChannel) => {
    const disabling = !channel.disabledAt
    confirmAction({
      title: disabling ? '停用渠道' : '启用渠道',
      message: disabling
        ? `确定停用渠道 \`${channel.name}\` 吗？停用后将无法用于新任务。`
        : `确定重新启用渠道 \`${channel.name}\` 吗？`,
      confirmText: disabling ? '停用' : '启用',
      tone: disabling ? 'danger' : undefined,
      label: disabling ? '停用渠道' : '启用渠道',
      affectedTab: 'channels',
      action: () => updateAdminChannel(channel.id, { disabled: disabling }),
    })
  }

  const searchUsers = () => {
    setUserPage(1)
    void loadTab('users', { userPage: 1 })
  }

  const searchLogs = () => {
    setLogPage(1)
    void loadTab('logs', { logPage: 1 })
  }

  const goUserPage = (page: number) => {
    setUserPage(page)
    void loadTab('users', { userPage: page })
  }

  const goLogPage = (page: number) => {
    setLogPage(page)
    void loadTab('logs', { logPage: page })
  }

  const refreshCurrentTab = () => {
    loadedTabs.current.delete(tab)
    void loadTab(tab)
  }

  if (!isAdmin) {
    return (
      <div className="safe-area-top min-h-screen bg-gray-50 px-4 py-6 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <div className="mx-auto max-w-7xl">
          <Button tone="secondary" onClick={onClose} className="mb-4">
            <ChevronLeftIcon className="h-4 w-4" />
            返回
          </Button>
          <EmptyState text="当前账号没有后台管理权限" />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="safe-area-top sticky top-0 z-20 border-b border-gray-200 bg-white/80 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/80">
        <div className="safe-area-x mx-auto flex max-w-7xl items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold tracking-tight">后台管理</h1>
            <div className="truncate text-xs text-gray-500 dark:text-gray-400">{auth?.session.user.email}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button tone="secondary" onClick={refreshCurrentTab} disabled={loading}>
              <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">刷新</span>
            </Button>
            <Button tone="secondary" onClick={onClose}>
              <ChevronLeftIcon className="h-4 w-4" />
              <span className="hidden sm:inline">返回画廊</span>
            </Button>
          </div>
        </div>
        <nav className="safe-area-x custom-scrollbar mx-auto flex max-w-7xl gap-1 overflow-x-auto pb-3">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={`shrink-0 rounded-lg px-3.5 py-1.5 text-sm transition-colors ${tab === value ? 'bg-blue-500 font-medium text-white dark:bg-blue-600' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="safe-area-x mx-auto max-w-7xl py-5">
        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}
        {loading && (
          <div className="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/20 dark:border-t-blue-400" />
            加载中...
          </div>
        )}

        {tab === 'overview' && overview && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatTile label="用户" value={`${overview.stats.users} / 禁用 ${overview.stats.disabledUsers}`} />
              <StatTile label="租户" value={overview.stats.tenants} />
              <StatTile label="任务" value={`${overview.stats.tasks} / 今日 ${overview.stats.todayTasks}`} />
              <StatTile label="活跃 Session" value={overview.stats.activeSessions} />
              <StatTile label="图片" value={overview.stats.images} />
              <StatTile label="存储" value={formatBytes(overview.stats.storageBytes)} />
              <StatTile label="渠道" value={`${overview.stats.channels} / 停用 ${overview.stats.disabledChannels}`} />
              <StatTile label="任务状态" value={statusText} />
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
      <TextInput value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <Button type="submit" className="shrink-0 px-4">搜索</Button>
    </form>
  )
}

function UserTable({ users, onToggleDisabled, onToggleAdmin, onRevokeSessions, currentUserId }: { users: AdminUser[]; onToggleDisabled: (user: AdminUser) => void; onToggleAdmin: (user: AdminUser) => void; onRevokeSessions: (user: AdminUser) => void; currentUserId?: string }) {
  const columns: Array<DataTableColumn<AdminUser>> = [
    {
      key: 'user',
      header: '用户',
      mobileHideLabel: true,
      render: (user) => (
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">{user.email}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {user.isPlatformAdmin ? '平台管理员' : '普通用户'}
            {user.disabledAt ? ' / 已禁用' : ''}
          </div>
        </div>
      ),
    },
    { key: 'tenant', header: '租户', render: (user) => user.memberships.map((item) => item.tenant.name).join(', ') || '-' },
    { key: 'usage', header: '用量', render: (user) => `${user.counts.tasks} 任务 / ${formatBytes(user.counts.storageBytes)}` },
    { key: 'lastSeen', header: '最近活跃', nowrap: true, render: (user) => formatDate(user.lastSeenAt) },
    {
      key: 'actions',
      header: '操作',
      render: (user) => (
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Button tone="secondary" size="sm" disabled={user.id === currentUserId} onClick={() => onToggleDisabled(user)}>
            {user.disabledAt ? '启用' : '禁用'}
          </Button>
          <Button tone="secondary" size="sm" disabled={user.id === currentUserId} onClick={() => onToggleAdmin(user)}>
            {user.isPlatformAdmin ? '撤销管理员' : '设为管理员'}
          </Button>
          <Button tone="secondary" size="sm" disabled={user.id === currentUserId || user.counts.sessions === 0} onClick={() => onRevokeSessions(user)}>
            清退会话
          </Button>
        </div>
      ),
    },
  ]
  return <DataTable columns={columns} rows={users} rowKey={(user) => user.id} emptyText="暂无用户" />
}

function LogTable({ logs }: { logs: AdminUsageLog[] }) {
  const columns: Array<DataTableColumn<AdminUsageLog>> = [
    { key: 'time', header: '时间', nowrap: true, render: (log) => formatDate(log.createdAt) },
    { key: 'action', header: '动作', render: (log) => <span className="font-mono text-xs">{log.action}</span> },
    { key: 'user', header: '用户', render: (log) => log.user?.email ?? '-' },
    { key: 'tenant', header: '租户', render: (log) => log.tenant?.name ?? '-' },
    { key: 'target', header: '目标', render: (log) => <span className="font-mono text-xs">{log.targetType ?? '-'} {log.targetId ?? ''}</span> },
    {
      key: 'source',
      header: '来源',
      render: (log) => (
        <div className="text-xs">
          <div>{log.ip ?? '-'}</div>
          <div className="max-w-60 truncate text-gray-500 dark:text-gray-400" title={log.userAgent ?? ''}>{log.userAgent ?? ''}</div>
        </div>
      ),
    },
    {
      key: 'detail',
      header: '详情',
      render: (log) => (
        <div className="max-w-80 truncate font-mono text-xs text-gray-500 dark:text-gray-400" title={log.detail ? JSON.stringify(log.detail) : ''}>
          {log.detail ? JSON.stringify(log.detail) : '-'}
        </div>
      ),
    },
  ]
  return <DataTable columns={columns} rows={logs} rowKey={(log) => log.id} emptyText="暂无日志" />
}

function ChannelTable({ channels, onToggleDisabled }: { channels: AdminChannel[]; onToggleDisabled: (channel: AdminChannel) => void }) {
  const columns: Array<DataTableColumn<AdminChannel>> = [
    {
      key: 'channel',
      header: '渠道',
      mobileHideLabel: true,
      render: (channel) => (
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">{channel.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {channel.provider} / {channel.hasApiKey ? '有 Key' : '无 Key'}
            {channel.disabledAt ? ' / 已停用' : ''}
          </div>
        </div>
      ),
    },
    { key: 'tenant', header: '租户', render: (channel) => channel.tenant.name },
    { key: 'model', header: '模型', render: (channel) => channel.model },
    { key: 'tasks', header: '任务', render: (channel) => channel.taskCount },
    {
      key: 'actions',
      header: '操作',
      render: (channel) => (
        <div className="sm:text-right">
          <Button tone="secondary" size="sm" onClick={() => onToggleDisabled(channel)}>
            {channel.disabledAt ? '启用' : '停用'}
          </Button>
        </div>
      ),
    },
  ]
  return <DataTable columns={columns} rows={channels} rowKey={(channel) => channel.id} emptyText="暂无渠道" />
}

function StorageView({ storage }: { storage: AdminStorage }) {
  const recentColumns: Array<DataTableColumn<AdminStorage['recentImages'][number]>> = [
    {
      key: 'image',
      header: '图片',
      mobileHideLabel: true,
      render: (image) => (
        <div>
          <div className="font-mono text-xs text-gray-900 dark:text-gray-100">{image.id}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{image.purpose} / {image.status} / {image.contentType}</div>
        </div>
      ),
    },
    { key: 'tenant', header: '租户', render: (image) => image.tenant.name },
    { key: 'user', header: '用户', render: (image) => image.createdBy.email },
    { key: 'size', header: '大小', nowrap: true, render: (image) => formatBytes(image.byteSize) },
    { key: 'time', header: '时间', nowrap: true, render: (image) => formatDate(image.createdAt) },
  ]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="图片" value={storage.summary.images} />
        <StatTile label="总存储" value={formatBytes(storage.summary.storageBytes)} />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Breakdown title="按租户" rows={storage.byTenant.map((row) => [row.tenant.name, row.images, row.storageBytes])} />
        <Breakdown title="按用途" rows={storage.byPurpose.map((row) => [row.purpose, row.images, row.storageBytes])} />
        <Breakdown title="按状态" rows={storage.byStatus.map((row) => [row.status, row.images, row.storageBytes])} />
      </div>
      <DataTable columns={recentColumns} rows={storage.recentImages} rowKey={(image) => image.id} emptyText="暂无图片" />
    </div>
  )
}

function Breakdown({ title, rows }: { title: string; rows: Array<[string, number, number]> }) {
  return (
    <Card>
      <h3 className="mb-2 text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
      <div className="space-y-2">
        {rows.length === 0 && <div className="text-sm text-gray-400 dark:text-gray-500">-</div>}
        {rows.map(([label, count, bytes]) => (
          <div key={label} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 text-gray-500 dark:text-gray-400">{count} / {formatBytes(bytes)}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}





