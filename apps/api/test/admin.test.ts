import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'
import { prisma } from '../src/prisma.js'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip

const DEFAULT_TASK_PARAMS = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }): string {
  const setCookie = response.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('Missing session cookie')
  return raw.split(';')[0]!
}

async function clearDb() {
  await prisma.taskImage.deleteMany()
  await prisma.task.deleteMany()
  await prisma.imageAsset.deleteMany()
  await prisma.providerProfile.deleteMany()
  await prisma.tenantMember.deleteMany()
  await prisma.session.deleteMany()
  await prisma.account.deleteMany()
  await prisma.verification.deleteMany()
  await prisma.usageLog.deleteMany()
  await prisma.tenant.deleteMany()
  await prisma.user.deleteMany()
}

async function register(app: FastifyInstance, email: string): Promise<{
  cookie: string
  userId: string
  isPlatformAdmin: boolean
  profileId: string
}> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email,
      password: 'correct-password',
      tenantName: email.split('@')[0],
    },
  })
  expect(response.statusCode).toBe(200)
  const payload = response.json() as {
    user: { id: string; isPlatformAdmin: boolean }
    providerProfiles: Array<{ id: string }>
  }
  expect(payload.providerProfiles).toHaveLength(1)
  return {
    cookie: cookieHeader(response),
    userId: payload.user.id,
    isPlatformAdmin: payload.user.isPlatformAdmin,
    profileId: payload.providerProfiles[0]!.id,
  }
}

describeWithDb('admin routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await clearDb()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
  })

  it('makes the first user a platform admin and blocks non-admin access', async () => {
    const admin = await register(app, 'admin@example.com')
    const user = await register(app, 'user@example.com')

    expect(admin.isPlatformAdmin).toBe(true)
    expect(user.isPlatformAdmin).toBe(false)

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/admin/overview',
      headers: { cookie: user.cookie },
    })
    expect(forbidden.statusCode).toBe(403)

    const users = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: admin.cookie },
    })
    expect(users.statusCode).toBe(200)
    const usersPayload = users.json() as { users: Array<{ id: string; email: string; isPlatformAdmin: boolean }> }
    expect(usersPayload.users.some((item) => item.id === admin.userId && item.isPlatformAdmin)).toBe(true)
    expect(usersPayload.users.some((item) => item.id === user.userId && !item.isPlatformAdmin)).toBe(true)
  })

  it('lets admins disable users but protects the current admin account', async () => {
    const admin = await register(app, 'admin@example.com')
    const user = await register(app, 'user@example.com')

    const selfDisable = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.userId}`,
      headers: { cookie: admin.cookie },
      payload: { disabled: true },
    })
    expect(selfDisable.statusCode).toBe(400)

    const selfRevoke = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${admin.userId}`,
      headers: { cookie: admin.cookie },
      payload: { isPlatformAdmin: false },
    })
    expect(selfRevoke.statusCode).toBe(400)

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user.userId}`,
      headers: { cookie: admin.cookie },
      payload: { disabled: true },
    })
    expect(disabled.statusCode).toBe(200)
    expect((disabled.json() as { user: { disabledAt: string | null } }).user.disabledAt).toBeTruthy()

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'user@example.com',
        password: 'correct-password',
      },
    })
    expect(login.statusCode).toBe(403)

    const staleSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: user.cookie },
    })
    expect(staleSession.statusCode).toBe(401)
  })

  it('lets admins revoke another user session but not their own', async () => {
    const admin = await register(app, 'admin@example.com')
    const user = await register(app, 'user@example.com')

    const selfRevoke = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${admin.userId}/revoke-sessions`,
      headers: { cookie: admin.cookie },
    })
    expect(selfRevoke.statusCode).toBe(400)

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${user.userId}/revoke-sessions`,
      headers: { cookie: admin.cookie },
    })
    expect(revoked.statusCode).toBe(200)
    expect((revoked.json() as { revokedSessions: number }).revokedSessions).toBeGreaterThanOrEqual(1)

    const staleSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: user.cookie },
    })
    expect(staleSession.statusCode).toBe(401)
  })

  it('lets admins disable channels and prevents using disabled channels for tasks', async () => {
    const admin = await register(app, 'admin@example.com')

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/channels',
      headers: { cookie: admin.cookie },
      payload: {
        name: 'Disabled test channel',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-2',
        apiMode: 'images',
        apiKey: 'sk-test-provider',
      },
    })
    expect(created.statusCode).toBe(201)
    const channelId = (created.json() as { channel: { id: string } }).channel.id

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${channelId}`,
      headers: { cookie: admin.cookie },
      payload: { disabled: true },
    })
    expect(disabled.statusCode).toBe(200)
    expect((disabled.json() as { channel: { disabledAt: string | null } }).channel.disabledAt).toBeTruthy()

    const channels = await app.inject({
      method: 'GET',
      url: '/api/admin/channels',
      headers: { cookie: admin.cookie },
    })
    expect(channels.statusCode).toBe(200)
    const channelsPayload = channels.json() as { channels: Array<{ id: string; disabledAt: string | null }> }
    expect(channelsPayload.channels.find((channel) => channel.id === channelId)?.disabledAt).toBeTruthy()

    const task = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: admin.cookie },
      payload: {
        prompt: 'test',
        params: DEFAULT_TASK_PARAMS,
        inputImageIds: [],
        maskImageId: null,
        providerProfileId: channelId,
      },
    })
    expect(task.statusCode).toBe(400)
    expect((task.json() as { error?: string }).error).toContain('已被后台停用')
  })

  it('lets admins update and delete unused global channels', async () => {
    const admin = await register(app, 'admin@example.com')

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/channels',
      headers: { cookie: admin.cookie },
      payload: {
        name: 'Temporary channel',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-2',
        apiMode: 'images',
        apiKey: 'sk-test-provider',
        config: { timeout: 120 },
      },
    })
    expect(created.statusCode).toBe(201)
    const channelId = (created.json() as { channel: { id: string; taskCount: number } }).channel.id

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${channelId}`,
      headers: { cookie: admin.cookie },
      payload: {
        name: 'Updated channel',
        model: 'gpt-image-3',
        clearApiKey: true,
      },
    })
    expect(updated.statusCode).toBe(200)
    const updatedPayload = updated.json() as { channel: { name: string; model: string; hasApiKey: boolean } }
    expect(updatedPayload.channel.name).toBe('Updated channel')
    expect(updatedPayload.channel.model).toBe('gpt-image-3')
    expect(updatedPayload.channel.hasApiKey).toBe(false)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/admin/channels/${channelId}`,
      headers: { cookie: admin.cookie },
    })
    expect(deleted.statusCode).toBe(200)
  })
})
