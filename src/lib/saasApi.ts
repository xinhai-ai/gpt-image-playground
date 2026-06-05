import type { ApiProfile, AppMode, AppSettings, FavoriteCollection, TaskParams, TaskProgressPhase, TaskRecord } from '../types'
import { dataUrlToBlob } from './canvasImage'
import { readRuntimeEnv } from './runtimeEnv'

const RAW_API_BASE_URL = readRuntimeEnv(import.meta.env.VITE_API_BASE_URL)

export type SaasImagePurpose = 'input' | 'mask' | 'generated' | 'thumbnail'

export interface SaasSession {
  user: {
    id: string
    email: string
    name?: string
    isPlatformAdmin?: boolean
    disabledAt?: string | null
    createdAt: string
  }
  tenant: {
    id: string
    name: string
    slug: string
    role: string
    createdAt: string
  }
  providerProfiles: Array<{
    id: string
    name: string
    provider: string
    model: string
  }>
}

export type SaasProviderProfile = SaasSession['providerProfiles'][number]

export interface SaasTaskOutputImage {
  imageId: string
  providerImageUrl?: string
  dataUrl?: string
  contentType: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
  uploadUrl?: string
  uploadHeaders?: Record<string, string>
  uploadExpiresAt?: string
}

export interface SaasImageUploadResponse {
  imageId: string
  objectKey?: string
  contentType?: string
  byteSize?: number
  sha256?: string | null
  sourceSha256?: string | null
  width?: number | null
  height?: number | null
  status?: string
  duplicate?: boolean
}

export interface SaasCreateTaskResponse {
  task: TaskRecord
  images: SaasTaskOutputImage[]
}

export interface SaasSyncedSettings {
  activeProfileId?: string
  clearInputAfterSubmit?: boolean
  persistInputOnRestart?: boolean
  reuseTaskApiProfileTemporarily?: boolean
  alwaysShowRetryButton?: boolean
  taskCompletionNotification?: boolean
  enterSubmit?: boolean
  referenceImageEditAction?: AppSettings['referenceImageEditAction']
  zipDownloadRoutes?: AppSettings['zipDownloadRoutes']
  agentScrollToBottomAfterSubmit?: boolean
  agentMaxToolRounds?: number
  agentWebSearch?: boolean
  profileConfig?: Record<string, Partial<Pick<ApiProfile, 'timeout' | 'codexCli' | 'streamImages' | 'streamPartialImages' | 'responseFormatB64Json'>>>
}

export interface SaasClientPreferences {
  version: 1
  settings?: SaasSyncedSettings
  params?: TaskParams
  favoriteCollections?: FavoriteCollection[]
  defaultFavoriteCollectionId?: string | null
  taskFavorites?: Record<string, string[]>
  ui?: {
    appMode?: AppMode
    agentSidebarCollapsed?: boolean
    agentAssetTab?: 'references' | 'outputs'
    agentAssetPanelCollapsed?: boolean
    dismissedCodexCliPrompts?: string[]
    supportPromptDismissed?: boolean
  }
  updatedAt?: number
}

export class SaasApiError extends Error {
  status: number
  payload: unknown
  task?: TaskRecord

  constructor(status: number, message: string, payload: unknown) {
    super(message)
    this.name = 'SaasApiError'
    this.status = status
    this.payload = payload
    if (payload && typeof payload === 'object' && 'task' in payload) {
      this.task = (payload as { task?: TaskRecord }).task
    }
  }
}

export function getSaasApiBaseUrl(): string {
  return RAW_API_BASE_URL.replace(/\/+$/, '')
}

export function isSaasMode(): boolean {
  return Boolean(getSaasApiBaseUrl())
}

function buildUrl(path: string): string {
  const base = getSaasApiBaseUrl()
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    try {
      return { error: await response.text() }
    } catch {
      return { error: `HTTP ${response.status}` }
    }
  }
}

function getPayloadErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    if (typeof record.error === 'string' && record.error.trim()) return record.error
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    if (Array.isArray(record.detail)) return record.detail.map(String).join('\n')
  }
  return fallback
}

export async function saasRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(buildUrl(path), {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) {
    const payload = await readErrorPayload(response)
    throw new SaasApiError(response.status, getPayloadErrorMessage(payload, `HTTP ${response.status}`), payload)
  }
  return response.json() as Promise<T>
}

export function getCurrentSession(): Promise<SaasSession> {
  return saasRequest<SaasSession>('/auth/me')
}

export function register(email: string, password: string, tenantName?: string): Promise<SaasSession> {
  return saasRequest<SaasSession>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, tenantName }),
  })
}

export function login(email: string, password: string): Promise<SaasSession> {
  return saasRequest<SaasSession>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function logout(): Promise<{ ok: true }> {
  return saasRequest<{ ok: true }>('/auth/logout', { method: 'POST' })
}

export interface AccountSession {
  id: string
  current: boolean
  ip: string | null
  userAgent: string | null
  lastSeenAt: string
  createdAt: string
  expiresAt: string
}

export interface AccountDetail {
  user: {
    id: string
    email: string
    name: string
    isPlatformAdmin: boolean
    createdAt: string
  }
  tenant: {
    id: string
    name: string
    slug: string
    role: string
    createdAt: string
  }
  security: {
    hasPassword: boolean
    oauthProviders: string[]
  }
  usage: {
    tasks: number
    images: number
    storageBytes: number
  }
  sessions: AccountSession[]
}

export function getAccountDetail(): Promise<AccountDetail> {
  return saasRequest<AccountDetail>('/account')
}

export function updateAccountName(name: string): Promise<{ user: { id: string; name: string } }> {
  return saasRequest('/account', {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export function changeAccountPassword(input: {
  currentPassword?: string
  newPassword: string
  logoutOtherSessions?: boolean
}): Promise<{ ok: true; hasPassword: true; revokedSessions: number }> {
  return saasRequest('/account/password', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function revokeOtherSessions(): Promise<{ ok: true; revokedSessions: number }> {
  return saasRequest('/account/sessions/revoke-others', {
    method: 'POST',
  })
}

export function getSaasClientPreferences(): Promise<{ preferences: SaasClientPreferences | null; updatedAt: string | null }> {
  return saasRequest('/preferences/client')
}

export function updateSaasClientPreferences(preferences: SaasClientPreferences): Promise<{ preferences: SaasClientPreferences; updatedAt: string }> {
  return saasRequest('/preferences/client', {
    method: 'PUT',
    body: JSON.stringify(preferences),
  })
}

export interface OAuthOptions {
  emailPassword?: {
    registrationEnabled: boolean
  }
  github?: {
    enabled: boolean
  }
  google?: {
    enabled: boolean
  }
}

export function getOAuthOptions(): Promise<OAuthOptions> {
  return saasRequest<OAuthOptions>('/auth/oauth-options')
}

export function getGitHubOAuthStartUrl(redirectPath = '/'): string {
  const search = new URLSearchParams()
  if (redirectPath) search.set('redirect', redirectPath)
  const suffix = search.toString()
  return buildUrl(`/auth/github/start${suffix ? `?${suffix}` : ''}`)
}

export function getGoogleOAuthStartUrl(redirectPath = '/'): string {
  const search = new URLSearchParams()
  if (redirectPath) search.set('redirect', redirectPath)
  const suffix = search.toString()
  return buildUrl(`/auth/google/start${suffix ? `?${suffix}` : ''}`)
}

export function saasProviderProfileToApiProfile(profile: SaasProviderProfile): ApiProfile {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: '',
    apiKey: '',
    model: profile.model,
    timeout: 600,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    responseFormatB64Json: false,
    streamImages: false,
    streamPartialImages: 1,
  }
}

function apiProfileConfig(profile: Partial<ApiProfile>): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (profile.timeout !== undefined) config.timeout = profile.timeout
  if (profile.codexCli !== undefined) config.codexCli = profile.codexCli
  if (profile.streamImages !== undefined) config.streamImages = profile.streamImages
  if (profile.streamPartialImages !== undefined) config.streamPartialImages = profile.streamPartialImages
  if (profile.responseFormatB64Json !== undefined) config.responseFormatB64Json = profile.responseFormatB64Json
  return config
}

function apiProfilePayload(profile: Partial<ApiProfile>): Record<string, unknown> {
  const config = apiProfileConfig(profile)
  return {
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiMode: profile.apiMode,
    ...(profile.apiKey?.trim() ? { apiKey: profile.apiKey } : {}),
    ...(Object.keys(config).length ? { config } : {}),
  }
}

export function listSaasProviderProfiles(): Promise<{ providerProfiles: SaasProviderProfile[] }> {
  return saasRequest<{ providerProfiles: SaasProviderProfile[] }>('/provider-profiles')
}

async function uploadBlobToSignedUrl(uploadUrl: string, blob: Blob, headers?: Record<string, string>): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || headers?.['Content-Type'] || 'image/png',
      ...headers,
    },
    body: blob,
  })
  if (!response.ok) throw new Error(`S3 上传失败：HTTP ${response.status}`)
}

function imageFileName(blob: Blob, fallbackContentType = 'image/png'): string {
  const contentType = blob.type || fallbackContentType
  const extension = contentType === 'image/jpeg'
    ? 'jpg'
    : contentType.split('/')[1]?.replace(/[^a-z0-9]+/gi, '') || 'png'
  return `image.${extension}`
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function isSha256Hex(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

async function hashBlobSha256(blob: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function getBlobSourceSha256(blob: Blob, provided?: string): Promise<string | undefined> {
  if (isSha256Hex(provided)) return provided.toLowerCase()
  return hashBlobSha256(blob)
}

async function findDuplicateSaasImage(blob: Blob, purpose: SaasImagePurpose, sourceSha256?: string): Promise<SaasImageUploadResponse | null> {
  if (!sourceSha256) return null
  const result = await saasRequest<{
    duplicate: boolean
    image: SaasImageUploadResponse | null
  }>('/storage/images/deduplicate', {
    method: 'POST',
    body: JSON.stringify({
      purpose,
      sourceSha256,
      contentType: blob.type || 'image/png',
      byteSize: blob.size,
    }),
  })
  return result.duplicate && result.image ? result.image : null
}

export async function uploadImageBlobToSaas(blob: Blob, purpose: SaasImagePurpose, metadata: { sha256?: string; width?: number; height?: number } = {}): Promise<string> {
  const sourceSha256 = await getBlobSourceSha256(blob, metadata.sha256)
  const duplicate = await findDuplicateSaasImage(blob, purpose, sourceSha256)
  if (duplicate) return duplicate.imageId
  const formData = new FormData()
  formData.append('purpose', purpose)
  if (sourceSha256) formData.append('sourceSha256', sourceSha256)
  formData.append('file', blob, imageFileName(blob))
  const uploaded = await saasRequest<SaasImageUploadResponse>('/storage/images', {
    method: 'POST',
    body: formData,
  })
  return uploaded.imageId
}

export interface UploadProgressOptions {
  /** 上传进度回调，progress 为 0-1；total 未知时不会触发 */
  onProgress?: (progress: number) => void
  signal?: AbortSignal
}

/**
 * 带上传进度的图片上传。fetch 无法上报上传进度，故使用 XMLHttpRequest。
 */
export function uploadImageBlobToSaasWithProgress(
  blob: Blob,
  purpose: SaasImagePurpose,
  options: UploadProgressOptions = {},
): Promise<string> {
  const { onProgress, signal } = options
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

  return (async () => {
    const sourceSha256 = await getBlobSourceSha256(blob)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const duplicate = await findDuplicateSaasImage(blob, purpose, sourceSha256)
    if (duplicate) {
      onProgress?.(1)
      return duplicate.imageId
    }
    return uploadImageBlobToSaasWithProgressRequest(blob, purpose, { ...options, sourceSha256 })
  })()
}

function uploadImageBlobToSaasWithProgressRequest(
  blob: Blob,
  purpose: SaasImagePurpose,
  options: UploadProgressOptions & { sourceSha256?: string } = {},
): Promise<string> {
  const { onProgress, signal, sourceSha256 } = options
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))

  return new Promise<string>((resolve, reject) => {
    const formData = new FormData()
    formData.append('purpose', purpose)
    if (sourceSha256) formData.append('sourceSha256', sourceSha256)
    formData.append('file', blob, imageFileName(blob))

    const xhr = new XMLHttpRequest()
    xhr.open('POST', buildUrl('/storage/images'))
    xhr.withCredentials = true
    xhr.responseType = 'text'

    const onAbort = () => xhr.abort()
    signal?.addEventListener('abort', onAbort)
    const cleanup = () => signal?.removeEventListener('abort', onAbort)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(Math.min(1, event.loaded / event.total))
      }
    }

    xhr.onload = () => {
      cleanup()
      const parsePayload = (): unknown => {
        try {
          return JSON.parse(xhr.responseText)
        } catch {
          return { error: xhr.responseText || `HTTP ${xhr.status}` }
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const payload = parsePayload() as { imageId?: string }
        if (payload && typeof payload.imageId === 'string') {
          resolve(payload.imageId)
        } else {
          reject(makeSaasError(xhr.status, parsePayload()))
        }
        return
      }
      reject(makeSaasError(xhr.status, parsePayload()))
    }

    xhr.onerror = () => {
      cleanup()
      reject(new SaasApiError(xhr.status || 0, '网络错误，上传失败', null))
    }
    xhr.onabort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }

    xhr.send(formData)
  })
}

function makeSaasError(status: number, payload: unknown): SaasApiError {
  return new SaasApiError(status, getPayloadErrorMessage(payload, `HTTP ${status}`), payload)
}

async function uploadExistingImageBlobToSaas(imageId: string, blob: Blob): Promise<void> {
  const formData = new FormData()
  formData.append('file', blob, imageFileName(blob))
  await saasRequest(`/storage/images/${encodeURIComponent(imageId)}/upload`, {
    method: 'POST',
    body: formData,
  })
}

export async function uploadDataUrlToSaas(dataUrl: string, purpose: SaasImagePurpose, options: UploadProgressOptions = {}): Promise<string> {
  const blob = await dataUrlToBlob(dataUrl)
  return uploadImageBlobToSaasWithProgress(blob, purpose, options)
}

export function listSaasTasks(): Promise<{ tasks: TaskRecord[] }> {
  return saasRequest<{ tasks: TaskRecord[] }>('/tasks')
}

export function getSaasTask(taskId: string): Promise<{ task: TaskRecord }> {
  return saasRequest<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(taskId)}`)
}

export type SaasTaskEvent = {
  type: 'task.updated'
  phase: TaskProgressPhase
  task: TaskRecord
  progress?: {
    message: string
    providerEventType?: string
    requestIndex?: number
  }
} | {
  type: 'task.snapshot'
  tasks: TaskRecord[]
  serverTime: number
} | {
  type: 'connected'
  workerId: string
  eventCursor: string | null
  serverTime: number
} | {
  type: 'task.deleted'
  taskId: string
  serverTime: number
}

export function createSaasTaskEventSource(cursor?: string | null): EventSource {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return new EventSource(buildUrl(`/tasks/events${query}`), { withCredentials: true })
}

export function deleteSaasTask(taskId: string): Promise<{
  ok: true
  deletedTaskId: string
  deletedImageIds: string[]
  alreadyDeleted?: boolean
}> {
  return saasRequest(`/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
  })
}

export function createSaasTask(input: {
  clientTaskId?: string
  prompt: string
  params: TaskParams
  inputImageIds: string[]
  maskImageId?: string | null
  providerProfileId?: string | null
}): Promise<SaasCreateTaskResponse> {
  return saasRequest<SaasCreateTaskResponse>('/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function archiveGeneratedImage(image: SaasTaskOutputImage): Promise<{ imageId: string; dataUrl?: string; blob?: Blob }> {
  let blob: Blob
  let dataUrl = image.dataUrl
  if (dataUrl) {
    blob = await dataUrlToBlob(dataUrl, image.contentType)
  } else if (image.providerImageUrl) {
    const response = await fetch(image.providerImageUrl, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Provider 图片下载失败：HTTP ${response.status}`)
    blob = await response.blob()
    dataUrl = await blobToDataUrl(blob)
  } else {
    throw new Error('生成结果缺少图片数据')
  }

  if (!blob.type) blob = new Blob([await blob.arrayBuffer()], { type: image.contentType })
  if (image.uploadUrl) {
    await uploadBlobToSignedUrl(image.uploadUrl, blob, image.uploadHeaders)
  } else {
    await uploadExistingImageBlobToSaas(image.imageId, blob)
  }
  return { imageId: image.imageId, dataUrl, blob }
}

export function completeSaasTaskImage(taskId: string, imageId: string, blob?: Blob): Promise<{ task: TaskRecord }> {
  void blob
  return saasRequest<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(taskId)}/images/complete`, {
    method: 'POST',
    body: JSON.stringify({
      imageId,
    }),
  })
}

export function serverCopySaasTaskImage(taskId: string, imageId: string): Promise<{ task: TaskRecord }> {
  return saasRequest<{ task: TaskRecord }>(`/tasks/${encodeURIComponent(taskId)}/images/${encodeURIComponent(imageId)}/server-copy`, {
    method: 'POST',
  })
}

export interface SaasImageReadUrl {
  imageId?: string
  variant?: 'original' | 'thumbnail'
  readUrl: string
  expiresAt?: string
  contentType?: string
  byteSize?: number
  width?: number | null
  height?: number | null
  status?: string
}

export function getSaasImageReadUrl(imageId: string, variant: 'original' | 'thumbnail' = 'original'): Promise<SaasImageReadUrl> {
  const suffix = variant === 'thumbnail' ? '?variant=thumbnail' : ''
  return saasRequest<SaasImageReadUrl>(`/storage/images/${encodeURIComponent(imageId)}/read-url${suffix}`)
}

async function fetchSaasImageVariantDataUrl(imageId: string, variant: 'original' | 'thumbnail'): Promise<string | undefined> {
  const signed = await getSaasImageReadUrl(imageId, variant)
  const response = await fetch(signed.readUrl, { cache: 'no-store' })
  if (!response.ok) throw new Error(`S3 图片读取失败：HTTP ${response.status}`)
  const blob = await response.blob()
  return blobToDataUrl(blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: signed.contentType || 'image/png' }))
}

export function fetchSaasImageDataUrl(imageId: string): Promise<string | undefined> {
  return fetchSaasImageVariantDataUrl(imageId, 'original')
}

export function fetchSaasImageThumbnailDataUrl(imageId: string): Promise<string | undefined> {
  return fetchSaasImageVariantDataUrl(imageId, 'thumbnail')
}

export interface AdminOverview {
  stats: {
    users: number
    disabledUsers: number
    tenants: number
    tasks: number
    todayTasks: number
    taskStatuses: Record<string, number>
    images: number
    storageBytes: number
    channels: number
    disabledChannels: number
    activeSessions: number
  }
  recentLogs: AdminUsageLog[]
}

export interface AdminUser {
  id: string
  email: string
  isPlatformAdmin: boolean
  disabledAt: string | null
  createdAt: string
  updatedAt: string
  lastSeenAt: string | null
  counts: {
    tasks: number
    images: number
    sessions: number
    storageBytes: number
  }
  memberships: Array<{
    id: string
    role: string
    tenant: {
      id: string
      name: string
      slug: string
    }
  }>
}

export interface AdminUsageLog {
  id: string
  action: string
  targetType: string | null
  targetId: string | null
  detail?: unknown
  ip?: string | null
  userAgent?: string | null
  createdAt: string
  user?: { id: string; email: string } | null
  tenant?: { id: string; name: string } | null
}

export interface AdminChannel {
  id: string
  name: string
  provider: string
  baseUrl: string
  model: string
  apiMode: string
  config?: unknown
  hasApiKey: boolean
  disabledAt: string | null
  createdAt: string
  updatedAt: string
  taskCount: number
}

export interface AdminChannelInput {
  name?: string
  provider?: ApiProfile['provider']
  baseUrl?: string
  model?: string
  apiMode?: ApiProfile['apiMode']
  apiKey?: string
  clearApiKey?: boolean
  disabled?: boolean
  config?: Record<string, unknown>
  timeout?: number
  codexCli?: boolean
  streamImages?: boolean
  streamPartialImages?: number
  responseFormatB64Json?: boolean
}

export interface AdminStorage {
  summary: {
    images: number
    storageBytes: number
  }
  byTenant: Array<{ tenant: { id: string; name: string; slug: string }; images: number; storageBytes: number }>
  byPurpose: Array<{ purpose: string; images: number; storageBytes: number }>
  byStatus: Array<{ status: string; images: number; storageBytes: number }>
  recentImages: Array<{
    id: string
    purpose: string
    status: string
    contentType: string
    byteSize: number
    width?: number | null
    height?: number | null
    sha256?: string | null
    createdAt: string
    tenant: { id: string; name: string; slug: string }
    createdBy: { id: string; email: string }
  }>
}

function adminQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && String(value).trim()) search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function getAdminOverview(): Promise<AdminOverview> {
  return saasRequest<AdminOverview>('/admin/overview')
}

export function listAdminUsers(input: { q?: string; page?: number; pageSize?: number } = {}): Promise<{ total: number; page: number; pageSize: number; users: AdminUser[] }> {
  return saasRequest(`/admin/users${adminQuery(input)}`)
}

export function updateAdminUser(userId: string, patch: { disabled?: boolean; isPlatformAdmin?: boolean }): Promise<{ user: Pick<AdminUser, 'id' | 'email' | 'isPlatformAdmin' | 'disabledAt' | 'updatedAt'> }> {
  return saasRequest(`/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function revokeAdminUserSessions(userId: string): Promise<{ ok: true; revokedSessions: number }> {
  return saasRequest(`/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, {
    method: 'POST',
  })
}

export function listAdminLogs(input: { q?: string; action?: string; page?: number; pageSize?: number } = {}): Promise<{ total: number; page: number; pageSize: number; logs: AdminUsageLog[] }> {
  return saasRequest(`/admin/logs${adminQuery(input)}`)
}

export function listAdminChannels(): Promise<{ channels: AdminChannel[] }> {
  return saasRequest('/admin/channels')
}

function adminChannelPayload(input: AdminChannelInput): Record<string, unknown> {
  const payload = apiProfilePayload(input)
  if (input.config !== undefined) payload.config = input.config
  if (input.clearApiKey) payload.clearApiKey = true
  if (input.disabled !== undefined) payload.disabled = input.disabled
  return payload
}

export function createAdminChannel(input: AdminChannelInput): Promise<{ channel: AdminChannel }> {
  return saasRequest('/admin/channels', {
    method: 'POST',
    body: JSON.stringify(adminChannelPayload(input)),
  })
}

export function updateAdminChannel(profileId: string, patch: AdminChannelInput): Promise<{ channel: AdminChannel }> {
  return saasRequest(`/admin/channels/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    body: JSON.stringify(adminChannelPayload(patch)),
  })
}

export function deleteAdminChannel(profileId: string): Promise<{ ok: true }> {
  return saasRequest(`/admin/channels/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  })
}

export function getAdminStorage(): Promise<AdminStorage> {
  return saasRequest('/admin/storage')
}
