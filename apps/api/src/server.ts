import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import staticPlugin from '@fastify/static'
import { APIError } from 'better-auth'
import {
  ImagePurpose,
  ImageStatus,
  TaskImageRole,
  TaskStatus,
  TenantRole,
  type ImageAsset,
  Prisma,
  type ProviderProfile,
  type Task,
  type TaskImage,
  type Tenant,
  type TenantMember,
  type User,
} from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  BETTER_AUTH_BASE_PATH,
  SESSION_COOKIE,
  betterAuthHeaders,
  createBetterAuth,
  githubOAuthEnabled,
  parseBetterAuthJson,
  setBetterAuthCookies,
  type AppAuth,
} from './auth.js'
import { config } from './config.js'
import { decryptSecret, encryptSecret, hashPassword, normalizeEmail, verifyPassword } from './crypto.js'
import { prisma } from './prisma.js'
import { callProvider, type ProviderImageResult, type TaskParams } from './provider.js'
import { enforceRateLimit } from './rateLimit.js'
import { assertSafeOutboundUrl, normalizeOutboundHttpUrl } from './security.js'
import { copyRemoteImageToStorage, createReadUrl, createReadUrlForObject, createUploadUrl, deleteImageObjects, ensureBucket, ensureThumbnailForImage, objectKeyForImage, processAndUploadImage, readObjectBytes } from './storage.js'

const MAX_SERVER_UPLOAD_BYTES = config.image.maxUploadBytes
const MAX_AGENT_IMAGE_REFERENCES = 32
const TASK_EVENT_REPLAY_LIMIT = 500
const TASK_EVENT_SNAPSHOT_TASK_LIMIT = 200
const TASK_EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const TASK_EVENT_PRUNE_INTERVAL_MS = 60 * 60 * 1000
const TASK_WORKER_ID = `api-${randomUUID()}`
const AUTH_COOKIE_CLEAR_OPTIONS = {
  path: '/',
  sameSite: 'lax' as const,
  secure: config.cookieSecure,
}

type TaskEventPhase = 'queued' | 'started' | 'archiving' | 'done' | 'error'

type TaskUpdateEventPayload = {
  type: 'task.updated'
  phase: TaskEventPhase
  task: ReturnType<typeof serializeTask>
}

type TaskSnapshotEventPayload = {
  type: 'task.snapshot'
  tasks: ReturnType<typeof serializeTask>[]
  serverTime: number
}

type TaskConnectedEventPayload = {
  type: 'connected'
  workerId: string
  eventCursor: string | null
  serverTime: number
}

type TaskDeletedEventPayload = {
  type: 'task.deleted'
  taskId: string
  serverTime: number
}

type TaskEventPayload = TaskUpdateEventPayload
type TaskEventClientPayload = TaskEventPayload | TaskSnapshotEventPayload | TaskConnectedEventPayload | TaskDeletedEventPayload

type TaskEventClient = {
  id: string
  tenantId: string
  write: (payload: TaskEventClientPayload, eventId?: string) => void
  close: () => void
}

const taskEventClients = new Map<string, Set<TaskEventClient>>()
const queuedTaskIds: string[] = []
const activeTaskIds = new Set<string>()
let taskQueueDraining = false
let taskWorkerClosed = false
let taskRecoveryTimer: NodeJS.Timeout | null = null
let activeBetterAuth: AppAuth | null = null
let lastTaskEventPruneAt = 0
const cancelledTaskIds = new Set<string>()

type AuthContext = {
  user: User
  tenant: Tenant
  membership: TenantMember
}

type TaskWithRelations = Task & {
  providerProfile: ProviderProfile | null
  images: Array<TaskImage & { imageAsset: ImageAsset }>
}

type BetterAuthUserPayload = {
  id: string
  email: string
}

type BetterAuthSessionPayload = {
  user: BetterAuthUserPayload
  session: {
    token: string
    userId: string
    expiresAt: Date | string
  }
}

type BetterAuthSocialStartPayload = {
  url?: string
  redirect?: boolean
}

const taskParamsSchema = z.object({
  size: z.string().min(1).default('auto'),
  quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'),
  output_format: z.enum(['png', 'jpeg', 'webp']).default('png'),
  output_compression: z.number().int().min(0).max(100).nullable().default(null),
  moderation: z.enum(['auto', 'low']).default('auto'),
  n: z.number().int().min(1).max(10).default(1),
})

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  tenantName: z.string().min(1).max(80).optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200).optional(),
  newPassword: z.string().min(8).max(200),
  logoutOtherSessions: z.boolean().optional(),
})

const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/i).transform((value) => value.toLowerCase())

const uploadUrlSchema = z.object({
  contentType: z.string().min(1),
  byteSize: z.number().int().min(0).max(1024 * 1024 * 1024),
  purpose: z.enum(['input', 'mask', 'generated', 'thumbnail']),
  sha256: z.string().min(32).max(128).optional(),
  sourceSha256: sha256HexSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})

const uploadImageFormSchema = z.object({
  purpose: z.enum(['input', 'mask', 'generated', 'thumbnail']).default('input'),
  sourceSha256: sha256HexSchema.optional(),
})

const imageDeduplicateSchema = z.object({
  purpose: z.enum(['input', 'mask', 'generated', 'thumbnail']).default('input'),
  sourceSha256: sha256HexSchema,
  contentType: z.string().min(1).optional(),
  byteSize: z.number().int().min(0).max(1024 * 1024 * 1024).optional(),
})

const createTaskSchema = z.object({
  clientTaskId: z.string().min(1).max(128).optional(),
  prompt: z.string().min(1),
  params: taskParamsSchema,
  inputImageIds: z.array(z.string()).default([]),
  maskImageId: z.string().nullable().optional(),
  providerProfileId: z.string().nullable().optional(),
})

const completeImageSchema = z.object({
  imageId: z.string(),
  contentType: z.string().min(1).optional(),
  byteSize: z.number().int().min(0).optional(),
  sha256: z.string().min(32).max(128).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})

const agentResponsesSchema = z.object({
  providerProfileId: z.string().nullable().optional(),
  body: z.record(z.string(), z.unknown()),
})

const providerProfileCreateSchema = z.object({
  name: z.string().min(1).max(120),
  provider: z.string().min(1).max(80),
  baseUrl: z.string().max(500).default(''),
  model: z.string().min(1).max(200),
  apiMode: z.enum(['images', 'responses']).default('images'),
  apiKey: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

const providerProfilePatchSchema = providerProfileCreateSchema.partial().extend({
  clearApiKey: z.boolean().optional(),
})

const adminListQuerySchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

const adminLogQuerySchema = adminListQuerySchema.extend({
  action: z.string().optional(),
})

const adminUserPatchSchema = z.object({
  disabled: z.boolean().optional(),
  isPlatformAdmin: z.boolean().optional(),
})

const adminChannelCreateSchema = providerProfileCreateSchema.extend({
  disabled: z.boolean().optional(),
})

const adminChannelPatchSchema = providerProfilePatchSchema.extend({
  disabled: z.boolean().optional(),
})

function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  return schema.parse(body)
}

function requestPathname(url: string): string {
  try {
    return new URL(url, 'http://localhost').pathname
  } catch {
    return '/'
  }
}

function isApiPath(url: string): boolean {
  const pathname = requestPathname(url)
  return pathname === '/api' || pathname.startsWith('/api/')
}

function staticRequestPath(url: string): string | null {
  const pathname = requestPathname(url)
  if (pathname === '/' || pathname.endsWith('/')) return null
  let decoded = ''
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const trimmed = decoded.replace(/^\/+/, '')
  if (!trimmed || trimmed.includes('\0')) return null
  const normalized = path.posix.normalize(trimmed)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

async function isStaticFile(root: string, relativePath: string): Promise<boolean> {
  const rootPath = path.resolve(root)
  const absolutePath = path.resolve(rootPath, relativePath)
  if (absolutePath !== rootPath && !absolutePath.startsWith(`${rootPath}${path.sep}`)) return false
  try {
    return (await stat(absolutePath)).isFile()
  } catch {
    return false
  }
}

async function registerStaticFrontend(app: FastifyInstance): Promise<void> {
  const staticRoot = path.resolve(config.staticDir)
  const indexPath = path.join(staticRoot, 'index.html')
  if (!config.staticDir || !existsSync(indexPath)) {
    app.log.warn({ staticDir: config.staticDir }, 'Static frontend directory is missing; frontend serving disabled')
    app.setNotFoundHandler(async (request, reply) => {
      const error = isApiPath(request.url) ? '接口不存在' : '页面不存在'
      return reply.status(404).send({ error })
    })
    return
  }

  await app.register(staticPlugin, {
    root: staticRoot,
    prefix: '/',
    decorateReply: true,
    index: false,
    wildcard: false,
    cacheControl: false,
    setHeaders: (response, filePath) => {
      const relativePath = path.relative(staticRoot, filePath).split(path.sep).join('/')
      if (relativePath.startsWith('assets/')) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        response.setHeader('Cache-Control', 'no-cache')
      }
    },
  })

  app.setNotFoundHandler(async (request, reply) => {
    if (isApiPath(request.url)) {
      return reply.status(404).send({ error: '接口不存在' })
    }

    const relativePath = staticRequestPath(request.url)
    if (relativePath && await isStaticFile(staticRoot, relativePath)) {
      if (relativePath.startsWith('assets/')) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        reply.header('Cache-Control', 'public, max-age=3600')
      }
      return reply.sendFile(relativePath)
    }

    reply.header('Cache-Control', 'no-cache')
    return reply.type('text/html; charset=utf-8').sendFile('index.html')
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sendZodError(reply: FastifyReply, error: z.ZodError): void {
  reply.status(400).send({
    error: '请求参数无效',
    detail: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
  })
}

function isImageContentType(contentType: string): boolean {
  return /^image\/[a-z0-9.+-]+$/i.test(contentType)
}

type ClientImagePurpose = z.infer<typeof uploadImageFormSchema>['purpose']

function imagePurposeFromClient(value: ClientImagePurpose): ImagePurpose {
  switch (value) {
    case 'input': return ImagePurpose.INPUT
    case 'mask': return ImagePurpose.MASK
    case 'generated': return ImagePurpose.GENERATED
    case 'thumbnail': return ImagePurpose.THUMBNAIL
  }
}

function roleForPurpose(purpose: ImagePurpose): TaskImageRole {
  switch (purpose) {
    case ImagePurpose.INPUT: return TaskImageRole.INPUT
    case ImagePurpose.MASK: return TaskImageRole.MASK
    case ImagePurpose.THUMBNAIL: return TaskImageRole.THUMBNAIL
    case ImagePurpose.GENERATED: return TaskImageRole.OUTPUT
  }
}

function statusToClient(status: TaskStatus): 'running' | 'done' | 'error' {
  if (status === TaskStatus.DONE) return 'done'
  if (status === TaskStatus.ERROR) return 'error'
  return 'running'
}

function ms(date: Date | null | undefined): number | null {
  return date ? date.getTime() : null
}

function jsonArray(value: Prisma.JsonValue | null): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined
}

function groupCount(row: { _count?: unknown }): number {
  const count = row._count
  if (!count || typeof count !== 'object' || !('_all' in count)) return 0
  const value = (count as { _all?: unknown })._all
  return typeof value === 'number' ? value : 0
}

function groupByteSum(row: { _sum?: unknown }): number {
  const sum = row._sum
  if (!sum || typeof sum !== 'object' || !('byteSize' in sum)) return 0
  const value = (sum as { byteSize?: unknown }).byteSize
  return typeof value === 'number' ? value : 0
}

function serializeProviderProfile(profile: ProviderProfile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiMode: profile.apiMode,
    config: profile.config,
    hasApiKey: Boolean(profile.apiKeyEncrypted),
    disabledAt: profile.disabledAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  }
}

function serializeAdminChannel(profile: ProviderProfile & { _count?: { tasks: number } }) {
  return {
    ...serializeProviderProfile(profile),
    taskCount: profile._count?.tasks ?? 0,
  }
}

function isPlatformAdminUser(user: Pick<User, 'email' | 'isPlatformAdmin'>): boolean {
  return user.isPlatformAdmin || config.adminEmails.includes(normalizeEmail(user.email))
}

function serializeTask(task: TaskWithRelations) {
  const sortedImages = [...task.images].sort((a, b) => a.sortIndex - b.sortIndex)
  const inputImageIds = sortedImages
    .filter((item) => item.role === TaskImageRole.INPUT)
    .map((item) => item.imageAssetId)
  const maskImageId = sortedImages.find((item) => item.role === TaskImageRole.MASK)?.imageAssetId ?? null
  const outputImages = sortedImages
    .filter((item) => item.role === TaskImageRole.OUTPUT)
    .map((item) => item.imageAssetId)
  const outputTaskImages = sortedImages.filter((item) => item.role === TaskImageRole.OUTPUT)
  const actualParamsByImage = Object.fromEntries(outputTaskImages
    .filter((item) => item.actualParams)
    .map((item) => [item.imageAssetId, item.actualParams]))
  const revisedPromptByImage = Object.fromEntries(outputTaskImages
    .filter((item) => item.revisedPrompt?.trim())
    .map((item) => [item.imageAssetId, item.revisedPrompt]))
  const finishedAt = ms(task.finishedAt)
  const createdAt = task.createdAt.getTime()
  return {
    id: task.id,
    prompt: task.prompt,
    params: task.params as unknown as TaskParams,
    apiProvider: task.provider,
    apiProfileId: task.providerProfileId ?? undefined,
    apiProfileName: task.providerProfile?.name,
    apiMode: task.providerProfile?.apiMode,
    apiModel: task.providerProfile?.model,
    inputImageIds,
    maskTargetImageId: inputImageIds[0] ?? null,
    maskImageId,
    outputImages,
    rawImageUrls: jsonArray(task.rawImageUrls),
    actualParams: task.actualParams as Partial<TaskParams> | undefined,
    actualParamsByImage: Object.keys(actualParamsByImage).length ? actualParamsByImage : undefined,
    revisedPromptByImage: Object.keys(revisedPromptByImage).length ? revisedPromptByImage : undefined,
    status: statusToClient(task.status),
    error: task.error,
    createdAt,
    finishedAt,
    elapsed: finishedAt ? finishedAt - createdAt : null,
  }
}

function publicSession(auth: AuthContext, providerProfiles: ProviderProfile[] = []) {
  return {
    user: {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name || '',
      isPlatformAdmin: isPlatformAdminUser(auth.user),
      disabledAt: auth.user.disabledAt?.toISOString() ?? null,
      createdAt: auth.user.createdAt.toISOString(),
    },
    tenant: {
      id: auth.tenant.id,
      name: auth.tenant.name,
      slug: auth.tenant.slug,
      role: auth.membership.role,
      createdAt: auth.tenant.createdAt.toISOString(),
    },
    providerProfiles: providerProfiles.map(serializeProviderProfile),
  }
}

function sanitizeRedirectPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '/'
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return '/'
  return trimmed
}

function betterAuthInstance(): AppAuth {
  if (!activeBetterAuth) throw new Error('Better Auth 尚未初始化')
  return activeBetterAuth
}

function clearBetterAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, AUTH_COOKIE_CLEAR_OPTIONS)
  reply.clearCookie(`${SESSION_COOKIE}_data`, AUTH_COOKIE_CLEAR_OPTIONS)
}

function requestUserAgent(request: FastifyRequest): string | null {
  const userAgent = request.headers['user-agent']
  if (Array.isArray(userAgent)) return userAgent.join(', ')
  return userAgent ?? null
}

function apiErrorStatus(error: unknown): number | null {
  if (error instanceof APIError) return error.statusCode
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode
  }
  return null
}

function apiErrorMessage(error: unknown): string {
  if (error instanceof APIError) return error.message
  if (error && typeof error === 'object' && 'body' in error && isRecord(error.body) && typeof error.body.message === 'string') {
    return error.body.message
  }
  return errorMessage(error)
}

function sendBetterAuthError(reply: FastifyReply, error: unknown, messages: Partial<Record<number, string>> = {}): void {
  const status = apiErrorStatus(error) ?? 400
  reply.status(status).send({ error: messages[status] ?? apiErrorMessage(error) })
}

function tenantNameForEmail(email: string, tenantName?: string): string {
  return tenantName?.trim() || `${normalizeEmail(email).split('@')[0] || 'User'} Workspace`
}

async function getAuthForUserId(userId: string): Promise<AuthContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        orderBy: { createdAt: 'asc' },
        include: { tenant: true },
      },
    },
  })
  const membership = user?.memberships[0]
  if (!user || !membership) return null
  return {
    user,
    tenant: membership.tenant,
    membership,
  }
}

async function ensureUserTenantAndProvider(userId: string, email: string, tenantName?: string): Promise<AuthContext | null> {
  const normalizedEmail = normalizeEmail(email)
  const existing = await getAuthForUserId(userId)
  if (existing) {
    await ensureGlobalProviderProfile()
    if (!existing.user.isPlatformAdmin && config.adminEmails.includes(normalizedEmail)) {
      await prisma.user.update({
        where: { id: existing.user.id },
        data: { isPlatformAdmin: true },
      }).catch(() => undefined)
    }
    return getAuthForUserId(userId)
  }

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user) throw new Error('用户不存在')
    const membership = await tx.tenantMember.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } })
    if (membership) return
    const otherUserCount = await tx.user.count({ where: { id: { not: userId } } })
    if (!user.isPlatformAdmin && (otherUserCount === 0 || config.adminEmails.includes(normalizedEmail))) {
      await tx.user.update({
        where: { id: userId },
        data: { isPlatformAdmin: true },
      })
    }
    const tenant = await tx.tenant.create({
      data: {
        name: tenantNameForEmail(normalizedEmail, tenantName),
        slug: `tenant-${randomUUID().slice(0, 12)}`,
      },
    })
    await tx.tenantMember.create({
      data: {
        tenantId: tenant.id,
        userId,
        role: TenantRole.OWNER,
      },
    })
  })

  await ensureGlobalProviderProfile()
  return getAuthForUserId(userId)
}

async function getAuth(request: FastifyRequest, reply?: FastifyReply): Promise<AuthContext | null> {
  let session: BetterAuthSessionPayload | null
  try {
    session = await betterAuthInstance().api.getSession({
      headers: betterAuthHeaders(request),
    }) as BetterAuthSessionPayload | null
  } catch (error) {
    if (apiErrorStatus(error) === 401 || apiErrorStatus(error) === 403) {
      if (reply) clearBetterAuthCookies(reply)
      return null
    }
    throw error
  }
  if (!session?.user?.id) return null

  const auth = await ensureUserTenantAndProvider(session.user.id, session.user.email)
  if (!auth) {
    if (reply) clearBetterAuthCookies(reply)
    return null
  }
  if (auth.user.disabledAt) {
    await prisma.session.deleteMany({ where: { userId: auth.user.id } }).catch(() => undefined)
    if (reply) clearBetterAuthCookies(reply)
    return null
  }
  await prisma.session.updateMany({
    where: { token: session.session.token },
    data: {
      lastSeenAt: new Date(),
      ip: request.ip,
      ipAddress: request.ip,
      userAgent: requestUserAgent(request),
    },
  }).catch(() => undefined)
  return auth
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
  const auth = await getAuth(request, reply)
  if (!auth) {
    reply.status(401).send({ error: '请先登录' })
    return null
  }
  return auth
}

async function getCurrentSessionToken(request: FastifyRequest): Promise<string | null> {
  try {
    const session = await betterAuthInstance().api.getSession({
      headers: betterAuthHeaders(request),
    }) as BetterAuthSessionPayload | null
    return session?.session?.token ?? null
  } catch {
    return null
  }
}

async function userHasPassword(userId: string): Promise<boolean> {
  const account = await prisma.account.findFirst({
    where: { userId, providerId: 'credential', password: { not: null } },
    select: { id: true },
  })
  return Boolean(account)
}

async function requirePlatformAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AuthContext | null> {
  const auth = await requireAuth(request, reply)
  if (!auth) return null
  if (!isPlatformAdminUser(auth.user)) {
    reply.status(403).send({ error: '需要平台管理员权限' })
    return null
  }
  return auth
}

async function writeUsageLog(input: {
  request?: FastifyRequest
  auth?: AuthContext | null
  userId?: string | null
  tenantId?: string | null
  action: string
  targetType?: string
  targetId?: string
  detail?: unknown
}): Promise<void> {
  await prisma.usageLog.create({
    data: {
      tenantId: input.tenantId === undefined ? input.auth?.tenant.id : input.tenantId,
      userId: input.userId === undefined ? input.auth?.user.id : input.userId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      ...(input.detail !== undefined ? { detail: input.detail as Prisma.InputJsonValue } : {}),
      ip: input.request?.ip,
      userAgent: input.request?.headers['user-agent'],
    },
  }).catch((error) => {
    console.warn(`Failed to write usage log ${input.action}:`, error)
  })
}

type MultipartFilePart = {
  type: 'file'
  fieldname: string
  filename?: string
  mimetype?: string
  file: AsyncIterable<Buffer | Uint8Array | string>
}

type MultipartFieldPart = {
  type: 'field'
  fieldname: string
  value: unknown
}

type MultipartRequest = FastifyRequest & {
  parts: () => AsyncIterable<MultipartFilePart | MultipartFieldPart>
}

type ImageUploadBody = {
  bytes: Uint8Array
  contentType: string
  fields: Record<string, string>
}

async function readImageUploadBody(request: FastifyRequest): Promise<ImageUploadBody> {
  const fields: Record<string, string> = {}
  let file: { bytes: Uint8Array; contentType: string } | null = null

  for await (const part of (request as MultipartRequest).parts()) {
    if (part.type === 'field') {
      fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value ?? '')
      continue
    }
    if (file) throw new Error('一次只能上传一张图片')
    const chunks: Buffer[] = []
    let byteSize = 0
    for await (const chunk of part.file) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteSize += buffer.byteLength
      if (byteSize > MAX_SERVER_UPLOAD_BYTES) {
        throw new Error(`图片不能超过 ${Math.floor(MAX_SERVER_UPLOAD_BYTES / 1024 / 1024)}MB`)
      }
      chunks.push(buffer)
    }
    file = {
      bytes: Buffer.concat(chunks),
      contentType: part.mimetype && isImageContentType(part.mimetype) ? part.mimetype : 'image/png',
    }
  }

  if (!file) throw new Error('请选择要上传的图片')
  return { ...file, fields }
}

function imageUploadResponse(image: ImageAsset) {
  return {
    imageId: image.id,
    objectKey: image.objectKey,
    contentType: image.contentType,
    byteSize: image.byteSize,
    sha256: image.sha256,
    sourceSha256: image.sourceSha256,
    width: image.width,
    height: image.height,
    status: image.status,
  }
}

function sourceSha256ForUpload(bytes: Uint8Array, provided?: string | null): string {
  return provided?.trim().toLowerCase() || createHash('sha256').update(bytes).digest('hex')
}

async function findDuplicateImageAsset(
  tenantId: string,
  purpose: ImagePurpose,
  sourceSha256?: string | null,
): Promise<ImageAsset | null> {
  if (!sourceSha256) return null
  return prisma.imageAsset.findFirst({
    where: {
      tenantId,
      purpose,
      sourceSha256,
      status: ImageStatus.READY,
    },
    orderBy: { createdAt: 'asc' },
  })
}

async function processUploadIntoImage(
  image: ImageAsset,
  bytes: Uint8Array,
  contentType: string,
  purpose: ImagePurpose,
  sourceSha256?: string | null,
): Promise<ImageAsset> {
  try {
    const processed = await processAndUploadImage(image, bytes, contentType, purpose)
    return await prisma.imageAsset.update({
      where: { id: image.id },
      data: {
        status: ImageStatus.READY,
        contentType: processed.contentType,
        byteSize: processed.byteSize,
        sha256: processed.sha256,
        sourceSha256,
        width: processed.width,
        height: processed.height,
        error: null,
      },
    })
  } catch (error) {
    await prisma.imageAsset.update({
      where: { id: image.id },
      data: {
        status: ImageStatus.ERROR,
        error: errorMessage(error),
      },
    }).catch(() => undefined)
    throw error
  }
}

async function defaultProviderData() {
  return {
    tenantId: null,
    name: config.defaultProvider.name,
    provider: config.defaultProvider.provider,
    baseUrl: config.defaultProvider.baseUrl,
    model: config.defaultProvider.model,
    apiMode: config.defaultProvider.apiMode,
    apiKeyEncrypted: encryptSecret(config.defaultProvider.apiKey),
    config: {
      timeout: 600,
    },
  }
}

async function ensureGlobalProviderProfile(): Promise<ProviderProfile> {
  const existing = await prisma.providerProfile.findFirst({
    where: { tenantId: null },
    orderBy: { createdAt: 'asc' },
  })
  if (existing) return existing
  return prisma.providerProfile.create({ data: await defaultProviderData() })
}

async function listProviderProfiles(): Promise<ProviderProfile[]> {
  await ensureGlobalProviderProfile()
  return prisma.providerProfile.findMany({
    where: {
      tenantId: null,
      disabledAt: null,
    },
    orderBy: { createdAt: 'asc' },
  })
}

async function getProviderProfileForTask(providerProfileId?: string | null): Promise<ProviderProfile> {
  if (providerProfileId) {
    const requested = await prisma.providerProfile.findFirst({
      where: {
        id: providerProfileId,
        tenantId: null,
      },
    })
    if (requested) return requested
  }
  return ensureGlobalProviderProfile()
}

function providerProfileUpdateData(body: z.infer<typeof providerProfilePatchSchema>): Prisma.ProviderProfileUpdateInput {
  const data: Prisma.ProviderProfileUpdateInput = {}
  if (body.name !== undefined) data.name = body.name.trim()
  if (body.provider !== undefined) data.provider = body.provider.trim()
  if (body.baseUrl !== undefined) data.baseUrl = normalizeOutboundHttpUrl(body.baseUrl, 'Provider Base URL')
  if (body.model !== undefined) data.model = body.model.trim()
  if (body.apiMode !== undefined) data.apiMode = body.apiMode
  if (body.config !== undefined) data.config = body.config as Prisma.InputJsonValue
  if (body.clearApiKey) {
    data.apiKeyEncrypted = null
  } else if (body.apiKey !== undefined && body.apiKey.trim()) {
    data.apiKeyEncrypted = encryptSecret(body.apiKey)
  }
  return data
}

async function loadImageAssets(tenantId: string, ids: string[]): Promise<ImageAsset[]> {
  if (ids.length === 0) return []
  const assets = await prisma.imageAsset.findMany({
    where: {
      tenantId,
      id: { in: ids },
    },
  })
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  return ids.map((id) => byId.get(id)).filter((asset): asset is ImageAsset => Boolean(asset))
}

async function maybeFinishTask(taskId: string, tenantId: string): Promise<TaskWithRelations> {
  const task = await prisma.task.findFirstOrThrow({
    where: { id: taskId, tenantId },
    include: {
      providerProfile: true,
      images: {
        include: { imageAsset: true },
      },
    },
  })
  const outputImages = task.images.filter((image) => image.role === TaskImageRole.OUTPUT)
  const allOutputsReady = outputImages.length > 0 && outputImages.every((image) => image.imageAsset.status === ImageStatus.READY)
  if (!allOutputsReady || task.status !== TaskStatus.RUNNING) return task
  return prisma.task.update({
    where: { id: task.id },
    data: {
      status: TaskStatus.DONE,
      error: null,
      finishedAt: new Date(),
      workerId: null,
      workerLeaseExpiresAt: null,
    },
    include: {
      providerProfile: true,
      images: {
        include: { imageAsset: true },
      },
    },
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPrismaRecordNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
}

function isProviderBaseUrlInputError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Provider Base URL')
}

async function generateThumbnailBestEffort(image: Pick<ImageAsset, 'id' | 'tenantId' | 'bucket' | 'objectKey'>): Promise<void> {
  try {
    await ensureThumbnailForImage(image)
  } catch (error) {
    console.warn(`Failed to generate thumbnail for image ${image.id}:`, error)
  }
}

async function imageForProvider(image: ImageAsset): Promise<ImageAsset & { readUrl: string; bytes: Uint8Array; dataUrl: string }> {
  const bytes = await readObjectBytes(image.bucket, image.objectKey)
  const dataUrl = `data:${image.contentType || 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`
  return {
    ...image,
    bytes,
    dataUrl,
    readUrl: (await createReadUrl(image)).readUrl,
  }
}

function providerApiUrl(profile: ProviderProfile, path: string): string {
  return `${profile.baseUrl.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1'}/${path.replace(/^\/+/, '')}`
}

async function upstreamErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>
      const error = record.error
      if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
        return (error as Record<string, string>).message
      }
      if (typeof record.error === 'string') return record.error
      if (typeof record.message === 'string') return record.message
    }
  } catch {
    try {
      return await response.text()
    } catch {
      // fall through
    }
  }
  return `HTTP ${response.status}`
}

class AgentImageReferenceError extends Error {}

async function readAgentImageReferenceDataUrl(
  auth: AuthContext,
  imageId: string,
  cache: Map<string, string>,
  resolvedImageIds: Set<string>,
): Promise<string> {
  const cached = cache.get(imageId)
  if (cached) return cached
  if (resolvedImageIds.size >= MAX_AGENT_IMAGE_REFERENCES) {
    throw new AgentImageReferenceError(`Agent 单次请求最多引用 ${MAX_AGENT_IMAGE_REFERENCES} 张图片`)
  }

  const image = await prisma.imageAsset.findFirst({
    where: {
      id: imageId,
      tenantId: auth.tenant.id,
    },
  })
  if (!image) throw new AgentImageReferenceError('Agent 引用图片不存在或不属于当前租户')
  if (image.status !== ImageStatus.READY) throw new AgentImageReferenceError('Agent 引用图片尚未完成上传或预处理')

  const providerImage = await imageForProvider(image)
  cache.set(imageId, providerImage.dataUrl)
  resolvedImageIds.add(imageId)
  return providerImage.dataUrl
}

async function resolveAgentBodyValue(
  auth: AuthContext,
  value: unknown,
  cache: Map<string, string>,
  resolvedImageIds: Set<string>,
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveAgentBodyValue(auth, item, cache, resolvedImageIds)))
  }
  if (!isRecord(value)) return value

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[key] = await resolveAgentBodyValue(auth, item, cache, resolvedImageIds)
  }

  if (typeof output.image_id === 'string' && output.image_id.trim()) {
    const imageId = output.image_id.trim()
    output.image_url = await readAgentImageReferenceDataUrl(auth, imageId, cache, resolvedImageIds)
    delete output.image_id
  }

  return output
}

async function resolveAgentBodyImageIds(auth: AuthContext, body: Record<string, unknown>): Promise<{
  body: Record<string, unknown>
  imageIds: string[]
}> {
  const resolvedImageIds = new Set<string>()
  const resolved = await resolveAgentBodyValue(auth, body, new Map(), resolvedImageIds)
  if (!isRecord(resolved)) throw new AgentImageReferenceError('Agent 请求体无效')
  return {
    body: resolved,
    imageIds: [...resolvedImageIds],
  }
}

function taskWorkerConcurrency(): number {
  return Math.max(1, Math.min(16, Math.trunc(config.taskWorker.concurrency || 1)))
}

function taskLeaseMs(): number {
  return Math.max(60, Math.trunc(config.taskWorker.leaseSeconds || 1800)) * 1000
}

function taskRecoverIntervalMs(): number {
  return Math.max(15, Math.trunc(config.taskWorker.recoverIntervalSeconds || 60)) * 1000
}

function decodeDataUrl(dataUrl: string, fallbackContentType: string): { bytes: Uint8Array; contentType: string } {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) throw new Error('Provider 返回了无效的图片 data URL')
  const contentType = match[1]?.trim() || fallbackContentType || 'image/png'
  const encoded = match[3] ?? ''
  const bytes = match[2]
    ? Buffer.from(encoded, 'base64')
    : Buffer.from(decodeURIComponent(encoded), 'utf8')
  return { bytes, contentType }
}

async function loadTaskWithRelations(taskId: string, tenantId?: string): Promise<TaskWithRelations | null> {
  return prisma.task.findFirst({
    where: {
      id: taskId,
      ...(tenantId ? { tenantId } : {}),
    },
    include: {
      providerProfile: true,
      images: {
        include: { imageAsset: true },
      },
    },
  })
}

function parseTaskEventCursor(value: unknown): bigint | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  try {
    return BigInt(raw.trim())
  } catch {
    return null
  }
}

function markTaskCancelled(taskId: string): void {
  cancelledTaskIds.add(taskId)
  setTimeout(() => {
    cancelledTaskIds.delete(taskId)
  }, taskLeaseMs()).unref()
}

function isTaskCancelled(taskId: string): boolean {
  return cancelledTaskIds.has(taskId)
}

function writeTaskEventToClients(tenantId: string, payload: TaskEventClientPayload, eventId?: string): void {
  const clients = taskEventClients.get(tenantId)
  if (!clients?.size) return
  for (const client of [...clients]) {
    try {
      client.write(payload, eventId)
    } catch {
      client.close()
    }
  }
}

function maybePruneOldTaskEvents(): void {
  const now = Date.now()
  if (now - lastTaskEventPruneAt < TASK_EVENT_PRUNE_INTERVAL_MS) return
  lastTaskEventPruneAt = now
  void prisma.taskEvent.deleteMany({
    where: {
      createdAt: {
        lt: new Date(now - TASK_EVENT_RETENTION_MS),
      },
    },
  }).catch((error) => {
    console.warn('Failed to prune old task events:', error)
  })
}

async function publishTaskEvent(tenantId: string, payload: TaskEventPayload): Promise<void> {
  let eventId: string | undefined
  try {
    const event = await prisma.taskEvent.create({
      data: {
        tenantId,
        taskId: payload.task.id,
        type: payload.type,
        phase: payload.phase,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    eventId = event.id.toString()
  } catch (error) {
    console.warn('Failed to persist task event:', error)
  }
  maybePruneOldTaskEvents()
  writeTaskEventToClients(tenantId, payload, eventId)
}

function publishTaskDeletedEvent(tenantId: string, taskId: string): void {
  writeTaskEventToClients(tenantId, {
    type: 'task.deleted',
    taskId,
    serverTime: Date.now(),
  })
}

function removeQueuedTaskId(taskId: string): void {
  let index = queuedTaskIds.indexOf(taskId)
  while (index !== -1) {
    queuedTaskIds.splice(index, 1)
    index = queuedTaskIds.indexOf(taskId)
  }
}

async function deleteTaskForTenant(tenantId: string, taskId: string): Promise<{
  deleted: boolean
  deletedImageIds: string[]
}> {
  const task = await loadTaskWithRelations(taskId, tenantId)
  if (!task) return { deleted: false, deletedImageIds: [] }

  markTaskCancelled(taskId)
  removeQueuedTaskId(taskId)

  const outputImagesById = new Map(task.images
    .filter((image) => image.role === TaskImageRole.OUTPUT)
    .map((image) => [image.imageAssetId, image.imageAsset]))
  const outputImageIds = [...outputImagesById.keys()]

  const deletedImageIds = await prisma.$transaction(async (tx) => {
    await tx.task.delete({ where: { id: task.id } })
    if (outputImageIds.length === 0) return []

    const referencedImages = await tx.taskImage.findMany({
      where: {
        tenantId,
        imageAssetId: { in: outputImageIds },
      },
      select: { imageAssetId: true },
    })
    const referencedImageIds = new Set(referencedImages.map((image) => image.imageAssetId))
    const orphanImageIds = outputImageIds.filter((imageId) => !referencedImageIds.has(imageId))
    if (orphanImageIds.length > 0) {
      await tx.imageAsset.deleteMany({
        where: {
          tenantId,
          id: { in: orphanImageIds },
        },
      })
    }
    return orphanImageIds
  }).catch((error) => {
    if (isPrismaRecordNotFoundError(error)) return []
    throw error
  })

  const imagesToDelete = deletedImageIds
    .map((imageId) => outputImagesById.get(imageId))
    .filter((image): image is ImageAsset => Boolean(image))
  await Promise.allSettled(imagesToDelete.map((image) => deleteImageObjects(image)))

  publishTaskDeletedEvent(tenantId, taskId)
  return {
    deleted: true,
    deletedImageIds,
  }
}

async function publishTaskById(taskId: string, phase: TaskEventPhase): Promise<void> {
  const task = await loadTaskWithRelations(taskId)
  if (!task) return
  await publishTaskEvent(task.tenantId, {
    type: 'task.updated',
    phase,
    task: serializeTask(task),
  })
}

async function latestTaskEventId(tenantId: string): Promise<bigint | null> {
  const event = await prisma.taskEvent.findFirst({
    where: { tenantId },
    orderBy: { id: 'desc' },
    select: { id: true },
  })
  return event?.id ?? null
}

async function loadTaskEventSnapshot(tenantId: string): Promise<ReturnType<typeof serializeTask>[]> {
  const recentTasks = await prisma.task.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: TASK_EVENT_SNAPSHOT_TASK_LIMIT,
    include: {
      providerProfile: true,
      images: {
        include: { imageAsset: true },
      },
    },
  })
  const recentIds = new Set(recentTasks.map((task) => task.id))
  const runningTasks = await prisma.task.findMany({
    where: {
      tenantId,
      status: TaskStatus.RUNNING,
      ...(recentIds.size ? { id: { notIn: [...recentIds] } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      providerProfile: true,
      images: {
        include: { imageAsset: true },
      },
    },
  })

  return [...runningTasks, ...recentTasks]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(serializeTask)
}

async function replayStoredTaskEvents(input: {
  tenantId: string
  cursor: bigint | null
  maxId?: bigint | null
  write: (payload: TaskEventClientPayload, eventId?: string) => void
}): Promise<void> {
  if (input.cursor == null) return
  const events = await prisma.taskEvent.findMany({
    where: {
      tenantId: input.tenantId,
      id: {
        gt: input.cursor,
        ...(input.maxId != null ? { lte: input.maxId } : {}),
      },
    },
    orderBy: { id: 'asc' },
    take: TASK_EVENT_REPLAY_LIMIT,
  })
  for (const event of events) {
    input.write(event.payload as unknown as TaskEventPayload, event.id.toString())
  }
}

function addTaskEventClient(client: TaskEventClient): void {
  const clients = taskEventClients.get(client.tenantId) ?? new Set<TaskEventClient>()
  clients.add(client)
  taskEventClients.set(client.tenantId, clients)
}

function removeTaskEventClient(client: TaskEventClient): void {
  const clients = taskEventClients.get(client.tenantId)
  if (!clients) return
  clients.delete(client)
  if (clients.size === 0) taskEventClients.delete(client.tenantId)
}

function enqueueTaskExecution(taskId: string): void {
  if (taskWorkerClosed) return
  if (activeTaskIds.has(taskId) || queuedTaskIds.includes(taskId)) return
  queuedTaskIds.push(taskId)
  void drainTaskQueue()
}

async function drainTaskQueue(): Promise<void> {
  if (taskQueueDraining || taskWorkerClosed) return
  taskQueueDraining = true
  try {
    while (!taskWorkerClosed && activeTaskIds.size < taskWorkerConcurrency() && queuedTaskIds.length > 0) {
      const taskId = queuedTaskIds.shift()
      if (!taskId || activeTaskIds.has(taskId)) continue
      activeTaskIds.add(taskId)
      void executeTaskInWorker(taskId)
        .catch((error) => {
          console.warn(`Task worker failed for ${taskId}:`, error)
        })
        .finally(() => {
          activeTaskIds.delete(taskId)
          void drainTaskQueue()
        })
    }
  } finally {
    taskQueueDraining = false
  }
}

async function claimTask(taskId: string): Promise<boolean> {
  const now = new Date()
  const result = await prisma.task.updateMany({
    where: {
      id: taskId,
      status: TaskStatus.RUNNING,
      OR: [
        { workerLeaseExpiresAt: null },
        { workerLeaseExpiresAt: { lt: now } },
        { workerId: TASK_WORKER_ID },
      ],
    },
    data: {
      attemptCount: { increment: 1 },
      workerId: TASK_WORKER_ID,
      workerStartedAt: now,
      workerLeaseExpiresAt: new Date(now.getTime() + taskLeaseMs()),
      error: null,
    },
  })
  return result.count === 1
}

async function clearStaleOutputImages(task: TaskWithRelations): Promise<void> {
  const staleOutputs = task.images.filter((image) =>
    image.role === TaskImageRole.OUTPUT &&
    image.imageAsset.status !== ImageStatus.READY
  )
  if (!staleOutputs.length) return
  await prisma.taskImage.deleteMany({
    where: {
      id: { in: staleOutputs.map((image) => image.id) },
    },
  })
  await prisma.imageAsset.deleteMany({
    where: {
      id: { in: staleOutputs.map((image) => image.imageAssetId) },
      status: { not: ImageStatus.READY },
    },
  })
}

async function archiveProviderImageResult(input: {
  task: Task
  result: ProviderImageResult
  index: number
}): Promise<ImageAsset> {
  const imageId = randomUUID()
  const image = await prisma.imageAsset.create({
    data: {
      id: imageId,
      tenantId: input.task.tenantId,
      bucket: config.s3.bucket,
      objectKey: objectKeyForImage(input.task.tenantId, imageId, ImagePurpose.GENERATED),
      contentType: input.result.contentType,
      byteSize: 0,
      purpose: ImagePurpose.GENERATED,
      status: ImageStatus.PENDING,
      createdByUserId: input.task.createdByUserId,
    },
  })
  try {
    await prisma.taskImage.create({
      data: {
        tenantId: input.task.tenantId,
        taskId: input.task.id,
        imageAssetId: image.id,
        role: TaskImageRole.OUTPUT,
        sortIndex: input.index,
        providerImageUrl: input.result.providerImageUrl,
        actualParams: input.result.actualParams ? input.result.actualParams as Prisma.InputJsonValue : undefined,
        revisedPrompt: input.result.revisedPrompt,
      },
    })
  } catch (error) {
    await prisma.imageAsset.delete({ where: { id: image.id } }).catch(() => undefined)
    await deleteImageObjects(image).catch(() => undefined)
    throw error
  }

  try {
    if (input.result.dataUrl) {
      const decoded = decodeDataUrl(input.result.dataUrl, input.result.contentType)
      return await processUploadIntoImage(image, decoded.bytes, decoded.contentType, ImagePurpose.GENERATED)
    }
    if (input.result.providerImageUrl) {
      const copied = await copyRemoteImageToStorage(image, input.result.providerImageUrl)
      return await prisma.imageAsset.update({
        where: { id: image.id },
        data: {
          status: ImageStatus.READY,
          contentType: copied.contentType,
          byteSize: copied.byteSize,
          sha256: copied.sha256,
          width: copied.width,
          height: copied.height,
          error: null,
        },
      })
    }
    throw new Error('Provider 未返回可归档的图片数据')
  } catch (error) {
    await prisma.imageAsset.update({
      where: { id: image.id },
      data: {
        status: ImageStatus.ERROR,
        error: errorMessage(error),
      },
    }).catch(() => undefined)
    throw error
  }
}

async function markTaskError(taskId: string, error: unknown, rawResponsePayload?: string): Promise<void> {
  const failedTask = await prisma.task.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.ERROR,
      error: errorMessage(error),
      rawResponsePayload,
      finishedAt: new Date(),
      workerId: null,
      workerLeaseExpiresAt: null,
    },
    include: {
      providerProfile: true,
      images: {
        include: { imageAsset: true },
      },
    },
  })
  await publishTaskEvent(failedTask.tenantId, {
    type: 'task.updated',
    phase: 'error',
    task: serializeTask(failedTask),
  })
}

async function executeTaskInWorker(taskId: string): Promise<void> {
  const claimed = await claimTask(taskId)
  if (!claimed) return
  if (isTaskCancelled(taskId)) return

  let task = await loadTaskWithRelations(taskId)
  if (!task) return
  await publishTaskById(taskId, 'started')

  try {
    if (isTaskCancelled(taskId)) return
    const existingOutputs = task.images.filter((image) => image.role === TaskImageRole.OUTPUT)
    if (existingOutputs.length > 0 && existingOutputs.every((image) => image.imageAsset.status === ImageStatus.READY)) {
      const finished = await maybeFinishTask(task.id, task.tenantId)
      await publishTaskEvent(task.tenantId, {
        type: 'task.updated',
        phase: 'done',
        task: serializeTask(finished),
      })
      return
    }
    await clearStaleOutputImages(task)
    task = await loadTaskWithRelations(taskId)
    if (!task) return
    if (isTaskCancelled(taskId)) return

    const providerProfile = task.providerProfile
    if (!providerProfile) throw new Error('任务使用的 Provider 配置已不存在')
    if (providerProfile.disabledAt) throw new Error(`Provider 配置「${providerProfile.name}」已被后台停用`)

    const inputImages = task.images
      .filter((image) => image.role === TaskImageRole.INPUT)
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map((image) => image.imageAsset)
    const maskImage = task.images.find((image) => image.role === TaskImageRole.MASK)?.imageAsset ?? null
    const pendingImages = [...inputImages, ...(maskImage ? [maskImage] : [])].filter((image) => image.status !== ImageStatus.READY)
    if (pendingImages.length) throw new Error('输入图片尚未完成上传或预处理')

    const inputImagesWithUrls = await Promise.all(inputImages.map(imageForProvider))
    const maskImageWithUrl = maskImage ? await imageForProvider(maskImage) : null
    const providerResult = await callProvider({
      profile: providerProfile,
      prompt: task.prompt,
      params: task.params as unknown as TaskParams,
      inputImages: inputImagesWithUrls,
      maskImage: maskImageWithUrl,
    })

    if (isTaskCancelled(taskId)) return
    await prisma.task.update({
      where: { id: task.id },
      data: {
        rawImageUrls: providerResult.rawImageUrls ?? Prisma.JsonNull,
        actualParams: providerResult.actualParams ?? Prisma.JsonNull,
        rawResponsePayload: providerResult.rawResponsePayload,
      },
    })
    if (isTaskCancelled(taskId)) return
    await publishTaskById(taskId, 'archiving')

    for (let index = 0; index < providerResult.images.length; index++) {
      if (isTaskCancelled(taskId)) return
      await archiveProviderImageResult({
        task,
        result: providerResult.images[index]!,
        index,
      })
    }

    if (isTaskCancelled(taskId)) return
    const finishedTask = await prisma.task.update({
      where: { id: task.id },
      data: {
        status: TaskStatus.DONE,
        error: null,
        finishedAt: new Date(),
        workerId: null,
        workerLeaseExpiresAt: null,
      },
      include: {
        providerProfile: true,
        images: {
          include: { imageAsset: true },
        },
      },
    })
    await writeUsageLog({
      userId: task.createdByUserId,
      tenantId: task.tenantId,
      action: 'task.complete',
      targetType: 'task',
      targetId: task.id,
      detail: {
        providerProfileId: providerProfile.id,
        provider: providerProfile.provider,
        model: providerProfile.model,
        imageCount: providerResult.images.length,
      },
    })
    await publishTaskEvent(task.tenantId, {
      type: 'task.updated',
      phase: 'done',
      task: serializeTask(finishedTask),
    })
  } catch (error) {
    if (isTaskCancelled(taskId) || isPrismaRecordNotFoundError(error)) return
    const rawResponsePayload = (error as Error & { rawResponsePayload?: string }).rawResponsePayload
    try {
      await markTaskError(taskId, error, rawResponsePayload)
    } catch (markError) {
      if (!isPrismaRecordNotFoundError(markError)) throw markError
    }
  } finally {
    cancelledTaskIds.delete(taskId)
  }
}

async function recoverRunnableTasks(): Promise<void> {
  if (taskWorkerClosed) return
  const now = new Date()
  const tasks = await prisma.task.findMany({
    where: {
      status: TaskStatus.RUNNING,
      OR: [
        { workerLeaseExpiresAt: null },
        { workerLeaseExpiresAt: { lt: now } },
        { workerId: TASK_WORKER_ID },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  })
  for (const task of tasks) enqueueTaskExecution(task.id)
}

function startTaskRecoveryLoop(): void {
  if (taskRecoveryTimer || taskWorkerClosed) return
  void recoverRunnableTasks().catch((error) => console.warn('Failed to recover tasks:', error))
  taskRecoveryTimer = setInterval(() => {
    void recoverRunnableTasks().catch((error) => console.warn('Failed to recover tasks:', error))
  }, taskRecoverIntervalMs())
}

function stopTaskWorker(): void {
  taskWorkerClosed = true
  queuedTaskIds.splice(0, queuedTaskIds.length)
  if (taskRecoveryTimer) clearInterval(taskRecoveryTimer)
  taskRecoveryTimer = null
  for (const clients of taskEventClients.values()) {
    for (const client of [...clients]) client.close()
  }
  taskEventClients.clear()
}

function bodyForBetterAuthRequest(request: FastifyRequest): BodyInit | undefined {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  if (request.body == null) return undefined
  if (typeof request.body === 'string') return request.body
  if (Buffer.isBuffer(request.body)) return new Uint8Array(request.body)
  if (request.body instanceof URLSearchParams) return request.body
  return JSON.stringify(request.body)
}

async function sendBetterAuthResponse(reply: FastifyReply, response: Response) {
  setBetterAuthCookies(reply, response)
  response.headers.forEach((value, key) => {
    const normalized = key.toLowerCase()
    if (normalized === 'set-cookie' || normalized === 'content-length' || normalized === 'transfer-encoding') return
    reply.header(key, value)
  })
  reply.status(response.status)
  const bytes = Buffer.from(await response.arrayBuffer())
  return reply.send(bytes)
}

async function proxyBetterAuthRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  pathOverride?: string,
) {
  const targetUrl = new URL(pathOverride ?? request.url, config.betterAuthUrl)
  const headers = betterAuthHeaders(request, { assumeTrustedOrigin: true })
  if (request.body != null && !headers.get('content-type')) headers.set('content-type', 'application/json')
  const response = await betterAuthInstance().handler(new Request(targetUrl, {
    method: request.method,
    headers,
    body: bodyForBetterAuthRequest(request),
  }))
  return sendBetterAuthResponse(reply, response)
}

export async function buildApp() {
  taskWorkerClosed = false
  activeBetterAuth = createBetterAuth()
  const app = fastify({
    logger: true,
    bodyLimit: 64 * 1024 * 1024,
  })

  await app.register(cookie, {
    secret: config.sessionSecret,
  })
  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
  })
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: MAX_SERVER_UPLOAD_BYTES,
      fields: 8,
    },
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    return payload
  })

  app.addHook('onClose', async () => {
    stopTaskWorker()
  })

  // 全局错误处理：统一为 { error, detail? } 结构，避免泄漏 Fastify 默认的
  // { statusCode, error, message } 结构或未捕获异常的堆栈。
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      sendZodError(reply, error)
      return
    }
    // Fastify schema 校验错误
    if ((error as { validation?: unknown }).validation) {
      reply.status(400).send({ error: '请求参数无效', detail: [errorMessage(error)] })
      return
    }
    const status = apiErrorStatus(error)
    if (status && status >= 400 && status < 500) {
      reply.status(status).send({ error: apiErrorMessage(error) })
      return
    }
    // 请求体过大等由 Fastify 抛出且带有 statusCode 的错误
    const fastifyStatus = (error as { statusCode?: number }).statusCode
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      reply.status(fastifyStatus).send({ error: errorMessage(error) })
      return
    }
    request.log.error(error)
    reply.status(500).send({ error: '服务器内部错误' })
  })

  app.get('/api/health', async () => ({ ok: true }))

  app.route({
    method: ['GET', 'POST'],
    url: `${BETTER_AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => proxyBetterAuthRequest(request, reply),
  })

  app.post('/api/auth/register', async (request, reply) => {
    try {
      const body = parseBody(registerSchema, request.body)
      const email = normalizeEmail(body.email)
      if (!await enforceRateLimit(request, reply, {
        bucket: 'auth.register',
        keyParts: [email],
        max: 5,
        windowMs: 10 * 60_000,
      })) return
      const response = await betterAuthInstance().api.signUpEmail({
        body: {
          email,
          password: body.password,
          name: tenantNameForEmail(email, body.tenantName),
        },
        headers: betterAuthHeaders(request, { assumeTrustedOrigin: true }),
        asResponse: true,
      })
      setBetterAuthCookies(reply, response)
      const payload = await parseBetterAuthJson<{ user: BetterAuthUserPayload }>(response)
      const auth = await ensureUserTenantAndProvider(payload.user.id, payload.user.email, body.tenantName)
      if (!auth) return reply.status(500).send({ error: '注册后创建会话失败' })
      const providerProfiles = await listProviderProfiles()
      await writeUsageLog({
        request,
        auth,
        action: 'auth.register',
        targetType: 'user',
        targetId: auth.user.id,
        detail: { tenantId: auth.tenant.id },
      })
      return publicSession(auth, providerProfiles)
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      if (apiErrorStatus(error) === 422) return reply.status(409).send({ error: '邮箱已注册' })
      if (apiErrorStatus(error)) return sendBetterAuthError(reply, error)
      throw error
    }
  })

  app.post('/api/auth/login', async (request, reply) => {
    try {
      const body = parseBody(loginSchema, request.body)
      const email = normalizeEmail(body.email)
      if (!await enforceRateLimit(request, reply, {
        bucket: 'auth.login',
        keyParts: [email],
        max: 10,
        windowMs: 10 * 60_000,
      })) return
      const response = await betterAuthInstance().api.signInEmail({
        body: {
          email,
          password: body.password,
        },
        headers: betterAuthHeaders(request, { assumeTrustedOrigin: true }),
        asResponse: true,
      })
      setBetterAuthCookies(reply, response)
      const payload = await parseBetterAuthJson<{ user: BetterAuthUserPayload }>(response)
      const auth = await ensureUserTenantAndProvider(payload.user.id, payload.user.email)
      if (!auth) return reply.status(500).send({ error: '登录后创建会话失败' })
      const providerProfiles = await listProviderProfiles()
      await writeUsageLog({
        request,
        auth,
        action: 'auth.login',
        targetType: 'user',
        targetId: auth.user.id,
      })
      return publicSession(auth, providerProfiles)
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      if (apiErrorStatus(error)) {
        return sendBetterAuthError(reply, error, {
          401: '邮箱或密码不正确',
          403: '账号已被禁用',
        })
      }
      if (isProviderBaseUrlInputError(error)) return reply.status(400).send({ error: errorMessage(error) })
      throw error
    }
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const auth = await getAuth(request)
    try {
      const response = await betterAuthInstance().api.signOut({
        headers: betterAuthHeaders(request, { assumeTrustedOrigin: true }),
        asResponse: true,
      })
      setBetterAuthCookies(reply, response)
      await parseBetterAuthJson<{ success: boolean }>(response)
    } catch (error) {
      if (apiErrorStatus(error) && apiErrorStatus(error) !== 401) throw error
      clearBetterAuthCookies(reply)
    }
    await writeUsageLog({
      request,
      auth,
      action: 'auth.logout',
      targetType: 'user',
      targetId: auth?.user.id,
    })
    return { ok: true }
  })

  app.get('/api/auth/me', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const providerProfiles = await listProviderProfiles()
    return publicSession(auth, providerProfiles)
  })

  app.get('/api/account', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const currentToken = await getCurrentSessionToken(request)
    const [accounts, sessions, taskCount, imageAggregate] = await prisma.$transaction([
      prisma.account.findMany({
        where: { userId: auth.user.id },
        select: { providerId: true, createdAt: true },
      }),
      prisma.session.findMany({
        where: { userId: auth.user.id },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, token: true, ip: true, ipAddress: true, userAgent: true, lastSeenAt: true, createdAt: true, expiresAt: true },
      }),
      prisma.task.count({ where: { createdByUserId: auth.user.id } }),
      prisma.imageAsset.aggregate({ where: { createdByUserId: auth.user.id }, _count: { _all: true }, _sum: { byteSize: true } }),
    ])
    const oauthProviders = [...new Set(accounts.filter((account) => account.providerId !== 'credential').map((account) => account.providerId))]
    return {
      user: {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name || '',
        isPlatformAdmin: isPlatformAdminUser(auth.user),
        createdAt: auth.user.createdAt.toISOString(),
      },
      tenant: {
        id: auth.tenant.id,
        name: auth.tenant.name,
        slug: auth.tenant.slug,
        role: auth.membership.role,
        createdAt: auth.tenant.createdAt.toISOString(),
      },
      security: {
        hasPassword: await userHasPassword(auth.user.id),
        oauthProviders,
      },
      usage: {
        tasks: taskCount,
        images: imageAggregate._count._all,
        storageBytes: imageAggregate._sum.byteSize ?? 0,
      },
      sessions: sessions.map((session) => ({
        id: session.id,
        current: Boolean(currentToken && session.token === currentToken),
        ip: session.ip ?? session.ipAddress ?? null,
        userAgent: session.userAgent ?? null,
        lastSeenAt: session.lastSeenAt.toISOString(),
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
      })),
    }
  })

  app.patch('/api/account', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(80) }), request.body)
    const user = await prisma.user.update({
      where: { id: auth.user.id },
      data: { name: body.name },
      select: { id: true, name: true },
    })
    await writeUsageLog({ request, auth, action: 'account.update', targetType: 'user', targetId: user.id })
    return { user: { id: user.id, name: user.name } }
  })

  app.post('/api/account/password', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'account.password',
      keyParts: [auth.user.id],
      max: 10,
      windowMs: 10 * 60_000,
    })) return
    const body = parseBody(changePasswordSchema, request.body)
    const existing = await prisma.account.findFirst({
      where: { userId: auth.user.id, providerId: 'credential' },
    })

    if (existing?.password) {
      // 已有密码：必须校验当前密码
      if (!body.currentPassword) {
        return reply.status(400).send({ error: '请输入当前密码' })
      }
      const valid = await verifyPassword(body.currentPassword, existing.password)
      if (!valid) {
        return reply.status(400).send({ error: '当前密码不正确' })
      }
    }

    const passwordHash = await hashPassword(body.newPassword)
    if (existing) {
      await prisma.account.update({ where: { id: existing.id }, data: { password: passwordHash } })
    } else {
      await prisma.account.create({
        data: {
          accountId: auth.user.id,
          providerId: 'credential',
          userId: auth.user.id,
          password: passwordHash,
        },
      })
    }

    let revokedSessions = 0
    if (body.logoutOtherSessions) {
      const currentToken = await getCurrentSessionToken(request)
      const result = await prisma.session.deleteMany({
        where: {
          userId: auth.user.id,
          ...(currentToken ? { token: { not: currentToken } } : {}),
        },
      })
      revokedSessions = result.count
    }

    await writeUsageLog({
      request,
      auth,
      action: existing?.password ? 'account.password.change' : 'account.password.set',
      targetType: 'user',
      targetId: auth.user.id,
      detail: { revokedSessions },
    })
    return { ok: true, hasPassword: true, revokedSessions }
  })

  app.post('/api/account/sessions/revoke-others', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const currentToken = await getCurrentSessionToken(request)
    const result = await prisma.session.deleteMany({
      where: {
        userId: auth.user.id,
        ...(currentToken ? { token: { not: currentToken } } : {}),
      },
    })
    await writeUsageLog({
      request,
      auth,
      action: 'account.sessions.revoke_others',
      targetType: 'user',
      targetId: auth.user.id,
      detail: { revokedSessions: result.count },
    })
    return { ok: true, revokedSessions: result.count }
  })

  app.get('/api/auth/oauth-options', async () => ({
    github: {
      enabled: githubOAuthEnabled(),
    },
  }))

  app.get('/api/auth/github/start', async (request, reply) => {
    if (!githubOAuthEnabled()) return reply.status(400).send({ error: 'GitHub OAuth 未配置' })
    if (!await enforceRateLimit(request, reply, {
      bucket: 'auth.github.start',
      keyParts: [request.ip],
      max: 20,
      windowMs: 10 * 60_000,
    })) return

    const query = request.query as { redirect?: string }
    const redirectPath = sanitizeRedirectPath(query.redirect)
    try {
      const response = await betterAuthInstance().api.signInSocial({
        body: {
          provider: 'github',
          callbackURL: redirectPath,
          scopes: ['user:email'],
          disableRedirect: true,
        },
        headers: betterAuthHeaders(request, { assumeTrustedOrigin: true }),
        asResponse: true,
      })
      setBetterAuthCookies(reply, response)
      const payload = await parseBetterAuthJson<BetterAuthSocialStartPayload>(response)
      if (!payload.url) return reply.status(502).send({ error: 'GitHub OAuth 未返回授权地址' })
      return reply.status(302).header('Location', payload.url).send()
    } catch (error) {
      if (apiErrorStatus(error)) return sendBetterAuthError(reply, error)
      throw error
    }
  })

  app.get('/api/auth/github/callback', async (request, reply) => {
    if (!githubOAuthEnabled()) return reply.status(400).send({ error: 'GitHub OAuth 未配置' })
    if (!await enforceRateLimit(request, reply, {
      bucket: 'auth.github.callback',
      keyParts: [request.ip],
      max: 30,
      windowMs: 10 * 60_000,
    })) return
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    return proxyBetterAuthRequest(request, reply, `${BETTER_AUTH_BASE_PATH}/callback/github${query}`)
  })

  app.get('/api/tenants/current', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const providerProfiles = await listProviderProfiles()
    return {
      tenant: publicSession(auth, providerProfiles).tenant,
      providerProfiles: providerProfiles.map(serializeProviderProfile),
    }
  })

  app.get('/api/tenants/current/members', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const members = await prisma.tenantMember.findMany({
      where: { tenantId: auth.tenant.id },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    })
    return {
      members: members.map((member) => ({
        id: member.id,
        role: member.role,
        createdAt: member.createdAt.toISOString(),
        user: {
          id: member.user.id,
          email: member.user.email,
        },
      })),
    }
  })

  app.get('/api/provider-profiles', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const providerProfiles = await listProviderProfiles()
    return { providerProfiles: providerProfiles.map(serializeProviderProfile) }
  })

  app.post('/api/provider-profiles', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    return reply.status(403).send({ error: '渠道由平台管理员在后台配置' })
  })

  app.patch('/api/provider-profiles/:profileId', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    return reply.status(403).send({ error: '渠道由平台管理员在后台配置' })
  })

  app.delete('/api/provider-profiles/:profileId', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    return reply.status(403).send({ error: '渠道由平台管理员在后台配置' })
  })

  app.get('/api/admin/overview', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const [
      userCount,
      disabledUserCount,
      tenantCount,
      taskCount,
      todayTaskCount,
      taskStatusRows,
      imageAggregate,
      providerProfileCount,
      disabledProviderProfileCount,
      activeSessionCount,
      recentLogs,
    ] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.count({ where: { disabledAt: { not: null } } }),
      prisma.tenant.count(),
      prisma.task.count(),
      prisma.task.count({ where: { createdAt: { gte: today } } }),
      prisma.task.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: { _all: true } }),
      prisma.imageAsset.aggregate({ _count: { _all: true }, _sum: { byteSize: true } }),
      prisma.providerProfile.count(),
      prisma.providerProfile.count({ where: { disabledAt: { not: null } } }),
      prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
      prisma.usageLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: {
          user: { select: { id: true, email: true } },
          tenant: { select: { id: true, name: true } },
        },
      }),
    ])
    return {
      stats: {
        users: userCount,
        disabledUsers: disabledUserCount,
        tenants: tenantCount,
        tasks: taskCount,
        todayTasks: todayTaskCount,
        taskStatuses: Object.fromEntries(taskStatusRows.map((row) => [row.status, groupCount(row)])),
        images: imageAggregate._count._all,
        storageBytes: imageAggregate._sum.byteSize ?? 0,
        channels: providerProfileCount,
        disabledChannels: disabledProviderProfileCount,
        activeSessions: activeSessionCount,
      },
      recentLogs: recentLogs.map((log) => ({
        id: log.id,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        detail: log.detail,
        createdAt: log.createdAt.toISOString(),
        user: log.user,
        tenant: log.tenant,
      })),
    }
  })

  app.get('/api/admin/users', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    try {
      const query = parseBody(adminListQuerySchema, request.query)
      const where: Prisma.UserWhereInput = query.q?.trim()
        ? { email: { contains: query.q.trim(), mode: 'insensitive' } }
        : {}
      const skip = (query.page - 1) * query.pageSize
      const [total, users] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
          include: {
            memberships: {
              include: { tenant: true },
              orderBy: { createdAt: 'asc' },
            },
            sessions: {
              orderBy: { lastSeenAt: 'desc' },
              take: 1,
            },
            _count: {
              select: {
                tasks: true,
                images: true,
                sessions: true,
              },
            },
          },
        }),
      ])
      const storageRows = users.length
        ? await prisma.imageAsset.groupBy({
            by: ['createdByUserId'],
            where: { createdByUserId: { in: users.map((user) => user.id) } },
            _sum: { byteSize: true },
          })
        : []
      const storageByUser = new Map(storageRows.map((row) => [row.createdByUserId, row._sum.byteSize ?? 0]))
      return {
        total,
        page: query.page,
        pageSize: query.pageSize,
        users: users.map((user) => ({
          id: user.id,
          email: user.email,
          isPlatformAdmin: isPlatformAdminUser(user),
          disabledAt: user.disabledAt?.toISOString() ?? null,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
          lastSeenAt: user.sessions[0]?.lastSeenAt.toISOString() ?? null,
          counts: {
            tasks: user._count.tasks,
            images: user._count.images,
            sessions: user._count.sessions,
            storageBytes: storageByUser.get(user.id) ?? 0,
          },
          memberships: user.memberships.map((membership) => ({
            id: membership.id,
            role: membership.role,
            tenant: {
              id: membership.tenant.id,
              name: membership.tenant.name,
              slug: membership.tenant.slug,
            },
          })),
        })),
      }
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      throw error
    }
  })

  app.patch('/api/admin/users/:userId', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    const { userId } = request.params as { userId: string }
    try {
      const body = parseBody(adminUserPatchSchema, request.body)
      const existing = await prisma.user.findUnique({ where: { id: userId } })
      if (!existing) return reply.status(404).send({ error: '用户不存在' })
      if (existing.id === auth.user.id && body.disabled === true) {
        return reply.status(400).send({ error: '不能禁用当前登录的管理员账号' })
      }
      if (existing.id === auth.user.id && body.isPlatformAdmin === false) {
        return reply.status(400).send({ error: '不能撤销当前登录账号的管理员权限' })
      }
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: {
          ...(body.disabled !== undefined ? { disabledAt: body.disabled ? (existing.disabledAt ?? new Date()) : null } : {}),
          ...(body.isPlatformAdmin !== undefined ? { isPlatformAdmin: body.isPlatformAdmin } : {}),
        },
      })
      if (body.disabled === true) await prisma.session.deleteMany({ where: { userId: user.id } })
      await writeUsageLog({
        request,
        auth,
        action: 'admin.user.update',
        targetType: 'user',
        targetId: user.id,
        detail: {
          disabled: user.disabledAt != null,
          isPlatformAdmin: user.isPlatformAdmin,
        },
      })
      return {
        user: {
          id: user.id,
          email: user.email,
          isPlatformAdmin: isPlatformAdminUser(user),
          disabledAt: user.disabledAt?.toISOString() ?? null,
          updatedAt: user.updatedAt.toISOString(),
        },
      }
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      throw error
    }
  })

  app.post('/api/admin/users/:userId/revoke-sessions', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    const { userId } = request.params as { userId: string }
    const existing = await prisma.user.findUnique({ where: { id: userId } })
    if (!existing) return reply.status(404).send({ error: '用户不存在' })
    if (existing.id === auth.user.id) {
      return reply.status(400).send({ error: '不能在后台清退当前登录账号的会话' })
    }
    const result = await prisma.session.deleteMany({ where: { userId: existing.id } })
    await writeUsageLog({
      request,
      auth,
      action: 'admin.user.revoke_sessions',
      targetType: 'user',
      targetId: existing.id,
      detail: {
        revokedSessions: result.count,
      },
    })
    return { ok: true, revokedSessions: result.count }
  })

  app.get('/api/admin/logs', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    try {
      const query = parseBody(adminLogQuerySchema, request.query)
      const where: Prisma.UsageLogWhereInput = {
        ...(query.q?.trim()
          ? {
              OR: [
                { action: { contains: query.q.trim(), mode: 'insensitive' } },
                { targetType: { contains: query.q.trim(), mode: 'insensitive' } },
                { targetId: { contains: query.q.trim(), mode: 'insensitive' } },
                { user: { email: { contains: query.q.trim(), mode: 'insensitive' } } },
                { tenant: { name: { contains: query.q.trim(), mode: 'insensitive' } } },
              ],
            }
          : {}),
        ...(query.action?.trim() ? { action: query.action.trim() } : {}),
      }
      const skip = (query.page - 1) * query.pageSize
      const [total, logs] = await prisma.$transaction([
        prisma.usageLog.count({ where }),
        prisma.usageLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: query.pageSize,
          include: {
            user: { select: { id: true, email: true } },
            tenant: { select: { id: true, name: true } },
          },
        }),
      ])
      return {
        total,
        page: query.page,
        pageSize: query.pageSize,
        logs: logs.map((log) => ({
          id: log.id,
          action: log.action,
          targetType: log.targetType,
          targetId: log.targetId,
          detail: log.detail,
          ip: log.ip,
          userAgent: log.userAgent,
          createdAt: log.createdAt.toISOString(),
          user: log.user,
          tenant: log.tenant,
        })),
      }
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      throw error
    }
  })

  app.get('/api/admin/channels', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    await ensureGlobalProviderProfile()
    const profiles = await prisma.providerProfile.findMany({
      where: { tenantId: null },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { tasks: true },
        },
      },
    })
    return {
      channels: profiles.map(serializeAdminChannel),
    }
  })

  app.post('/api/admin/channels', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    try {
      const body = parseBody(adminChannelCreateSchema, request.body)
      const profile = await prisma.providerProfile.create({
        data: {
          tenantId: null,
          name: body.name.trim(),
          provider: body.provider.trim(),
          baseUrl: normalizeOutboundHttpUrl(body.baseUrl, 'Provider Base URL'),
          model: body.model.trim(),
          apiMode: body.apiMode,
          apiKeyEncrypted: body.apiKey?.trim() ? encryptSecret(body.apiKey) : null,
          disabledAt: body.disabled ? new Date() : null,
          ...(body.config !== undefined ? { config: body.config as Prisma.InputJsonValue } : {}),
        },
        include: {
          _count: {
            select: { tasks: true },
          },
        },
      })
      await writeUsageLog({
        request,
        auth,
        action: 'admin.channel.create',
        targetType: 'providerProfile',
        targetId: profile.id,
        detail: {
          disabled: profile.disabledAt != null,
          provider: profile.provider,
          model: profile.model,
        },
      })
      return reply.status(201).send({ channel: serializeAdminChannel(profile) })
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      if (isProviderBaseUrlInputError(error)) return reply.status(400).send({ error: errorMessage(error) })
      throw error
    }
  })

  app.patch('/api/admin/channels/:profileId', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    const { profileId } = request.params as { profileId: string }
    try {
      const body = parseBody(adminChannelPatchSchema, request.body)
      const existing = await prisma.providerProfile.findFirst({
        where: { id: profileId, tenantId: null },
      })
      if (!existing) return reply.status(404).send({ error: '渠道不存在' })
      if (body.disabled && !existing.disabledAt) {
        const remainingEnabledChannels = await prisma.providerProfile.count({
          where: {
            tenantId: null,
            disabledAt: null,
            id: { not: existing.id },
          },
        })
        if (remainingEnabledChannels === 0) return reply.status(400).send({ error: '至少需要保留一个启用渠道' })
      }
      const profile = await prisma.providerProfile.update({
        where: { id: existing.id },
        data: {
          ...providerProfileUpdateData(body),
          ...(body.disabled !== undefined ? { disabledAt: body.disabled ? (existing.disabledAt ?? new Date()) : null } : {}),
        },
        include: {
          _count: {
            select: { tasks: true },
          },
        },
      })
      await writeUsageLog({
        request,
        auth,
        action: 'admin.channel.update',
        targetType: 'providerProfile',
        targetId: profile.id,
        detail: {
          disabled: profile.disabledAt != null,
          provider: profile.provider,
          model: profile.model,
        },
      })
      return { channel: serializeAdminChannel(profile) }
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      if (isProviderBaseUrlInputError(error)) return reply.status(400).send({ error: errorMessage(error) })
      throw error
    }
  })

  app.delete('/api/admin/channels/:profileId', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    const { profileId } = request.params as { profileId: string }
    const existing = await prisma.providerProfile.findFirst({
      where: { id: profileId, tenantId: null },
      include: {
        _count: {
          select: { tasks: true },
        },
      },
    })
    if (!existing) return reply.status(404).send({ error: '渠道不存在' })
    const channelCount = await prisma.providerProfile.count({ where: { tenantId: null } })
    if (channelCount <= 1) return reply.status(400).send({ error: '至少需要保留一个渠道' })
    if (existing._count.tasks > 0) return reply.status(400).send({ error: '该渠道已有任务引用，请停用而不是删除' })
    await prisma.providerProfile.delete({ where: { id: existing.id } })
    await writeUsageLog({
      request,
      auth,
      action: 'admin.channel.delete',
      targetType: 'providerProfile',
      targetId: existing.id,
      detail: {
        provider: existing.provider,
        model: existing.model,
      },
    })
    return { ok: true }
  })

  app.get('/api/admin/storage', async (request, reply) => {
    const auth = await requirePlatformAdmin(request, reply)
    if (!auth) return
    const [total, byTenant, byPurpose, byStatus, recentImages] = await prisma.$transaction([
      prisma.imageAsset.aggregate({ _count: { _all: true }, _sum: { byteSize: true } }),
      prisma.imageAsset.groupBy({ by: ['tenantId'], orderBy: { tenantId: 'asc' }, _count: { _all: true }, _sum: { byteSize: true } }),
      prisma.imageAsset.groupBy({ by: ['purpose'], orderBy: { purpose: 'asc' }, _count: { _all: true }, _sum: { byteSize: true } }),
      prisma.imageAsset.groupBy({ by: ['status'], orderBy: { status: 'asc' }, _count: { _all: true }, _sum: { byteSize: true } }),
      prisma.imageAsset.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: {
          tenant: { select: { id: true, name: true, slug: true } },
          createdBy: { select: { id: true, email: true } },
        },
      }),
    ])
    const tenants = byTenant.length
      ? await prisma.tenant.findMany({
          where: { id: { in: byTenant.map((row) => row.tenantId) } },
          select: { id: true, name: true, slug: true },
        })
      : []
    const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]))
    return {
      summary: {
        images: total._count._all,
        storageBytes: total._sum.byteSize ?? 0,
      },
      byTenant: byTenant.map((row) => ({
        tenant: tenantById.get(row.tenantId) ?? { id: row.tenantId, name: row.tenantId, slug: row.tenantId },
        images: groupCount(row),
        storageBytes: groupByteSum(row),
      })),
      byPurpose: byPurpose.map((row) => ({
        purpose: row.purpose,
        images: groupCount(row),
        storageBytes: groupByteSum(row),
      })),
      byStatus: byStatus.map((row) => ({
        status: row.status,
        images: groupCount(row),
        storageBytes: groupByteSum(row),
      })),
      recentImages: recentImages.map((image) => ({
        id: image.id,
        purpose: image.purpose,
        status: image.status,
        contentType: image.contentType,
        byteSize: image.byteSize,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
        createdAt: image.createdAt.toISOString(),
        tenant: image.tenant,
        createdBy: image.createdBy,
      })),
    }
  })

  app.post('/api/storage/images', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'storage.upload',
      keyParts: [auth.user.id],
      max: 60,
      windowMs: 10 * 60_000,
    })) return
    try {
      const upload = await readImageUploadBody(request)
      const body = parseBody(uploadImageFormSchema, upload.fields)
      const purpose = imagePurposeFromClient(body.purpose)
      const sourceSha256 = sourceSha256ForUpload(upload.bytes, body.sourceSha256)
      const duplicate = await findDuplicateImageAsset(auth.tenant.id, purpose, sourceSha256)
      if (duplicate) {
        await writeUsageLog({
          request,
          auth,
          action: 'image.deduplicate',
          targetType: 'image',
          targetId: duplicate.id,
          detail: {
            purpose: duplicate.purpose,
            sourceSha256,
          },
        })
        return reply.status(200).send({ ...imageUploadResponse(duplicate), duplicate: true })
      }
      const imageId = randomUUID()
      const image = await prisma.imageAsset.create({
        data: {
          id: imageId,
          tenantId: auth.tenant.id,
          bucket: config.s3.bucket,
          objectKey: objectKeyForImage(auth.tenant.id, imageId, purpose),
          contentType: upload.contentType,
          byteSize: upload.bytes.byteLength,
          purpose,
          status: ImageStatus.PENDING,
          createdByUserId: auth.user.id,
          sourceSha256,
        },
      })
      const processed = await processUploadIntoImage(image, upload.bytes, upload.contentType, purpose, sourceSha256)
      await writeUsageLog({
        request,
        auth,
        action: 'image.upload',
        targetType: 'image',
        targetId: processed.id,
        detail: {
          purpose: processed.purpose,
          contentType: processed.contentType,
          byteSize: processed.byteSize,
        },
      })
      return reply.status(201).send(imageUploadResponse(processed))
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      return reply.status(400).send({ error: errorMessage(error) })
    }
  })

  app.post('/api/storage/images/deduplicate', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'storage.deduplicate',
      keyParts: [auth.user.id],
      max: 240,
      windowMs: 10 * 60_000,
    })) return
    try {
      const body = parseBody(imageDeduplicateSchema, request.body)
      if (body.contentType && !isImageContentType(body.contentType)) {
        return reply.status(400).send({ error: 'contentType 必须是 image/*' })
      }
      const purpose = imagePurposeFromClient(body.purpose)
      const duplicate = await findDuplicateImageAsset(auth.tenant.id, purpose, body.sourceSha256)
      if (!duplicate) return { duplicate: false, image: null }
      await writeUsageLog({
        request,
        auth,
        action: 'image.deduplicate_preflight',
        targetType: 'image',
        targetId: duplicate.id,
        detail: {
          purpose: duplicate.purpose,
          sourceSha256: body.sourceSha256,
          byteSize: body.byteSize,
        },
      })
      return {
        duplicate: true,
        image: imageUploadResponse(duplicate),
      }
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      return reply.status(400).send({ error: errorMessage(error) })
    }
  })

  app.post('/api/storage/upload-url', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'storage.upload_url',
      keyParts: [auth.user.id],
      max: 120,
      windowMs: 10 * 60_000,
    })) return
    try {
      const body = parseBody(uploadUrlSchema, request.body)
      if (!isImageContentType(body.contentType)) {
        return reply.status(400).send({ error: 'contentType 必须是 image/*' })
      }
      const purpose = imagePurposeFromClient(body.purpose)
      const sourceSha256 = body.sourceSha256 ?? (/^[a-f0-9]{64}$/i.test(body.sha256 ?? '') ? body.sha256!.toLowerCase() : null)
      const duplicate = await findDuplicateImageAsset(auth.tenant.id, purpose, sourceSha256)
      if (duplicate) {
        await writeUsageLog({
          request,
          auth,
          action: 'image.deduplicate_upload_url',
          targetType: 'image',
          targetId: duplicate.id,
          detail: {
            purpose: duplicate.purpose,
            sourceSha256,
          },
        })
        return {
          ...imageUploadResponse(duplicate),
          duplicate: true,
          uploadUrl: null,
          expiresAt: null,
          method: null,
          headers: {},
        }
      }
      const imageId = randomUUID()
      const image = await prisma.imageAsset.create({
        data: {
          id: imageId,
          tenantId: auth.tenant.id,
          bucket: config.s3.bucket,
          objectKey: objectKeyForImage(auth.tenant.id, imageId, purpose),
          contentType: body.contentType,
          byteSize: body.byteSize,
          sourceSha256,
          width: body.width,
          height: body.height,
          purpose,
          status: ImageStatus.PENDING,
          createdByUserId: auth.user.id,
        },
      })
      const signed = await createUploadUrl(image)
      return {
        imageId: image.id,
        objectKey: image.objectKey,
        uploadUrl: signed.uploadUrl,
        expiresAt: signed.expiresAt,
        method: 'PUT',
        headers: {
          'Content-Type': image.contentType,
        },
      }
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      throw error
    }
  })

  app.post('/api/storage/images/:imageId/upload', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'storage.upload_existing',
      keyParts: [auth.user.id],
      max: 120,
      windowMs: 10 * 60_000,
    })) return
    const { imageId } = request.params as { imageId: string }
    try {
      const existing = await prisma.imageAsset.findFirst({
        where: { id: imageId, tenantId: auth.tenant.id },
      })
      if (!existing) return reply.status(404).send({ error: '图片不存在' })
      const upload = await readImageUploadBody(request)
      const sourceSha256 = sourceSha256ForUpload(upload.bytes, existing.sourceSha256)
      const image = await processUploadIntoImage(existing, upload.bytes, upload.contentType, existing.purpose, sourceSha256)
      await writeUsageLog({
        request,
        auth,
        action: 'image.upload_existing',
        targetType: 'image',
        targetId: image.id,
        detail: {
          purpose: image.purpose,
          contentType: image.contentType,
          byteSize: image.byteSize,
        },
      })
      return imageUploadResponse(image)
    } catch (error) {
      return reply.status(400).send({ error: errorMessage(error) })
    }
  })

  app.post('/api/storage/images/:imageId/complete', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'storage.complete',
      keyParts: [auth.user.id],
      max: 120,
      windowMs: 10 * 60_000,
    })) return
    const { imageId } = request.params as { imageId: string }
    try {
      completeImageSchema.partial().parse({
        ...(request.body && typeof request.body === 'object' ? request.body as object : {}),
        imageId,
      })
      const existing = await prisma.imageAsset.findFirst({
        where: { id: imageId, tenantId: auth.tenant.id },
      })
      if (!existing) return reply.status(404).send({ error: '图片不存在' })
      const uploaded = await readObjectBytes(existing.bucket, existing.objectKey)
      const sourceSha256 = sourceSha256ForUpload(uploaded, existing.sourceSha256)
      const image = await processUploadIntoImage(existing, uploaded, existing.contentType, existing.purpose, sourceSha256)
      await writeUsageLog({
        request,
        auth,
        action: 'image.complete_upload_url',
        targetType: 'image',
        targetId: image.id,
        detail: {
          purpose: image.purpose,
          contentType: image.contentType,
          byteSize: image.byteSize,
        },
      })
      return imageUploadResponse(image)
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      return reply.status(400).send({ error: errorMessage(error) })
    }
  })

  app.get('/api/storage/images/:imageId/read-url', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const { imageId } = request.params as { imageId: string }
    const image = await prisma.imageAsset.findFirst({
      where: { id: imageId, tenantId: auth.tenant.id },
    })
    if (!image) return reply.status(404).send({ error: '图片不存在' })
    const query = request.query as { variant?: string }
    const variant = query.variant === 'thumbnail' ? 'thumbnail' : 'original'
    if (variant === 'thumbnail') {
      const thumbnail = await ensureThumbnailForImage(image)
      const signed = await createReadUrlForObject(thumbnail)
      return {
        imageId: image.id,
        variant,
        readUrl: signed.readUrl,
        expiresAt: signed.expiresAt,
        contentType: thumbnail.contentType,
        byteSize: thumbnail.byteSize,
        status: image.status,
      }
    }
    const signed = await createReadUrl(image)
    return {
      imageId: image.id,
      variant,
      readUrl: signed.readUrl,
      expiresAt: signed.expiresAt,
      contentType: image.contentType,
      byteSize: image.byteSize,
      status: image.status,
    }
  })

  app.get('/api/tasks', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const tasks = await prisma.task.findMany({
      where: { tenantId: auth.tenant.id },
      orderBy: { createdAt: 'desc' },
      include: {
        providerProfile: true,
        images: {
          include: { imageAsset: true },
        },
      },
    })
    return { tasks: tasks.map(serializeTask) }
  })

  app.get('/api/tasks/events', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return

    const query = request.query as { cursor?: string | string[] }
    const requestCursor = parseTaskEventCursor(request.headers['last-event-id']) ?? parseTaskEventCursor(query.cursor)
    const replayHighWatermark = await latestTaskEventId(auth.tenant.id)

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const writeRaw = (chunk: string) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(chunk)
    }
    const writePayload = (payload: TaskEventClientPayload, eventId?: string) => {
      if (eventId) writeRaw(`id: ${eventId}\n`)
      writeRaw(`data: ${JSON.stringify(payload)}\n\n`)
    }
    const client: TaskEventClient = {
      id: randomUUID(),
      tenantId: auth.tenant.id,
      write: writePayload,
      close: () => {
        removeTaskEventClient(client)
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end()
      },
    }
    const heartbeat = setInterval(() => {
      writeRaw(`: heartbeat ${Date.now()}\n\n`)
    }, 25_000)
    const cleanup = () => {
      clearInterval(heartbeat)
      removeTaskEventClient(client)
    }

    request.raw.on('close', cleanup)
    writePayload({
      type: 'connected',
      workerId: TASK_WORKER_ID,
      eventCursor: replayHighWatermark?.toString() ?? null,
      serverTime: Date.now(),
    })
    await replayStoredTaskEvents({
      tenantId: auth.tenant.id,
      cursor: requestCursor,
      maxId: replayHighWatermark,
      write: writePayload,
    })
    writePayload({
      type: 'task.snapshot',
      tasks: await loadTaskEventSnapshot(auth.tenant.id),
      serverTime: Date.now(),
    })
    addTaskEventClient(client)
    await replayStoredTaskEvents({
      tenantId: auth.tenant.id,
      cursor: replayHighWatermark,
      write: writePayload,
    })
  })

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const { taskId } = request.params as { taskId: string }
    const task = await prisma.task.findFirst({
      where: { id: taskId, tenantId: auth.tenant.id },
      include: {
        providerProfile: true,
        images: {
          include: { imageAsset: true },
        },
      },
    })
    if (!task) return reply.status(404).send({ error: '任务不存在' })
    return { task: serializeTask(task) }
  })

  app.delete('/api/tasks/:taskId', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const { taskId } = request.params as { taskId: string }
    const result = await deleteTaskForTenant(auth.tenant.id, taskId)
    if (result.deleted) {
      await writeUsageLog({
        request,
        auth,
        action: 'task.delete',
        targetType: 'task',
        targetId: taskId,
        detail: {
          deletedOutputImageCount: result.deletedImageIds.length,
        },
      })
    }
    return {
      ok: true,
      deletedTaskId: taskId,
      deletedImageIds: result.deletedImageIds,
      alreadyDeleted: !result.deleted,
    }
  })

  app.post('/api/tasks', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'task.create',
      keyParts: [auth.user.id],
      max: 30,
      windowMs: 10 * 60_000,
    })) return
    try {
      const body = parseBody(createTaskSchema, request.body)
      const providerProfile = await getProviderProfileForTask(body.providerProfileId)
      if (providerProfile.disabledAt) {
        return reply.status(400).send({ error: `Provider 配置「${providerProfile.name}」已被后台停用` })
      }
      const inputImages = await loadImageAssets(auth.tenant.id, body.inputImageIds)
      if (inputImages.length !== body.inputImageIds.length) {
        return reply.status(400).send({ error: '输入图片不存在或不属于当前租户' })
      }
      const maskImages = body.maskImageId ? await loadImageAssets(auth.tenant.id, [body.maskImageId]) : []
      const maskImage = body.maskImageId ? maskImages[0] : null
      if (body.maskImageId && !maskImage) {
        return reply.status(400).send({ error: '遮罩图片不存在或不属于当前租户' })
      }
      const pendingImages = [...inputImages, ...(maskImage ? [maskImage] : [])].filter((image) => image.status !== ImageStatus.READY)
      if (pendingImages.length) {
        return reply.status(400).send({ error: '输入图片尚未完成上传或预处理' })
      }

      const task = await prisma.task.create({
        data: {
          id: body.clientTaskId,
          tenantId: auth.tenant.id,
          prompt: body.prompt.trim(),
          params: body.params,
          provider: providerProfile.provider,
          providerProfileId: providerProfile.id,
          status: TaskStatus.RUNNING,
          createdByUserId: auth.user.id,
          images: {
            create: [
              ...inputImages.map((image, index) => ({
                tenantId: auth.tenant.id,
                imageAssetId: image.id,
                role: roleForPurpose(ImagePurpose.INPUT),
                sortIndex: index,
              })),
              ...(maskImage ? [{
                tenantId: auth.tenant.id,
                imageAssetId: maskImage.id,
                role: roleForPurpose(ImagePurpose.MASK),
                sortIndex: 0,
              }] : []),
            ],
          },
        },
        include: {
          providerProfile: true,
          images: {
            include: { imageAsset: true },
          },
        },
      })
      await writeUsageLog({
        request,
        auth,
        action: 'task.create',
        targetType: 'task',
        targetId: task.id,
        detail: {
          providerProfileId: providerProfile.id,
          provider: providerProfile.provider,
          model: providerProfile.model,
          inputImageCount: inputImages.length,
          hasMask: Boolean(maskImage),
        },
      })
      await publishTaskEvent(auth.tenant.id, {
        type: 'task.updated',
        phase: 'queued',
        task: serializeTask(task),
      })
      enqueueTaskExecution(task.id)
      return reply.status(202).send({
        task: serializeTask(task),
        images: [],
      })
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      throw error
    }
  })

  app.post('/api/tasks/:taskId/images/complete', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const { taskId } = request.params as { taskId: string }
    try {
      const body = parseBody(completeImageSchema, request.body)
      const taskImage = await prisma.taskImage.findFirst({
        where: {
          tenantId: auth.tenant.id,
          taskId,
          imageAssetId: body.imageId,
          role: TaskImageRole.OUTPUT,
        },
        include: { imageAsset: true },
      })
      if (!taskImage) return reply.status(404).send({ error: '任务图片不存在' })
      const image = await prisma.imageAsset.update({
        where: { id: body.imageId },
        data: {
          status: ImageStatus.READY,
          contentType: body.contentType ?? taskImage.imageAsset.contentType,
          byteSize: body.byteSize ?? taskImage.imageAsset.byteSize,
          sha256: body.sha256,
          width: body.width,
          height: body.height,
          error: null,
        },
      })
      await generateThumbnailBestEffort(image)
      const task = await maybeFinishTask(taskId, auth.tenant.id)
      await writeUsageLog({
        request,
        auth,
        action: 'image.complete',
        targetType: 'image',
        targetId: image.id,
        detail: {
          taskId,
          contentType: image.contentType,
          byteSize: image.byteSize,
        },
      })
      return { task: serializeTask(task) }
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      throw error
    }
  })

  app.post('/api/tasks/:taskId/images/:imageId/server-copy', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    const { taskId, imageId } = request.params as { taskId: string; imageId: string }
    const taskImage = await prisma.taskImage.findFirst({
      where: {
        tenantId: auth.tenant.id,
        taskId,
        imageAssetId: imageId,
        role: TaskImageRole.OUTPUT,
      },
      include: { imageAsset: true },
    })
    if (!taskImage) return reply.status(404).send({ error: '任务图片不存在' })
    if (!taskImage.providerImageUrl) return reply.status(400).send({ error: '此图片没有可供服务端转存的 Provider URL' })
    try {
      const copied = await copyRemoteImageToStorage(taskImage.imageAsset, taskImage.providerImageUrl)
      const image = await prisma.imageAsset.update({
        where: { id: imageId },
        data: {
          status: ImageStatus.READY,
          contentType: copied.contentType,
          byteSize: copied.byteSize,
          sha256: copied.sha256,
          width: copied.width,
          height: copied.height,
          error: null,
        },
      })
      await generateThumbnailBestEffort(image)
      const task = await maybeFinishTask(taskId, auth.tenant.id)
      await writeUsageLog({
        request,
        auth,
        action: 'image.server_copy',
        targetType: 'image',
        targetId: image.id,
        detail: {
          taskId,
          contentType: image.contentType,
          byteSize: image.byteSize,
        },
      })
      return { task: serializeTask(task) }
    } catch (error) {
      await prisma.imageAsset.update({
        where: { id: imageId },
        data: {
          status: ImageStatus.ERROR,
          error: errorMessage(error),
        },
      })
      return reply.status(502).send({ error: errorMessage(error) })
    }
  })

  app.post('/api/agent/responses', async (request, reply) => {
    const auth = await requireAuth(request, reply)
    if (!auth) return
    if (!await enforceRateLimit(request, reply, {
      bucket: 'agent.responses',
      keyParts: [auth.user.id],
      max: 60,
      windowMs: 10 * 60_000,
    })) return
    try {
      const body = parseBody(agentResponsesSchema, request.body)
      const providerProfile = await getProviderProfileForTask(body.providerProfileId)
      if (providerProfile.disabledAt) {
        return reply.status(400).send({ error: `Provider 配置「${providerProfile.name}」已被后台停用` })
      }
      const apiKey = decryptSecret(providerProfile.apiKeyEncrypted)
      if (!apiKey) return reply.status(400).send({ error: `服务端 Provider 配置「${providerProfile.name}」缺少 API Key` })
      const resolved = await resolveAgentBodyImageIds(auth, body.body)
      const upstreamBody = { ...resolved.body }
      delete upstreamBody.stream
      const upstreamUrl = providerApiUrl(providerProfile, 'responses')
      await assertSafeOutboundUrl(upstreamUrl, 'Provider API URL')
      await writeUsageLog({
        request,
        auth,
        action: 'agent.responses',
        targetType: 'providerProfile',
        targetId: providerProfile.id,
        detail: {
          provider: providerProfile.provider,
          model: providerProfile.model,
          imageCount: resolved.imageIds.length,
        },
      })
      const response = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(upstreamBody),
      })
      if (!response.ok) {
        return reply.status(response.status >= 500 ? 502 : response.status).send({
          error: await upstreamErrorMessage(response),
        })
      }
      return response.json()
    } catch (error) {
      if (error instanceof z.ZodError) return sendZodError(reply, error)
      if (error instanceof AgentImageReferenceError) return reply.status(400).send({ error: error.message })
      throw error
    }
  })

  await registerStaticFrontend(app)
  startTaskRecoveryLoop()
  return app
}

if (process.env.NODE_ENV !== 'test') {
  await ensureBucket()
  const app = await buildApp()
  await app.listen({ host: config.host, port: config.port })
}
