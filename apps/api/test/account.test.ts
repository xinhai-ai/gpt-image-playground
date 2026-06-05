import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'
import { prisma } from '../src/prisma.js'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }): string {
  const setCookie = response.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('Missing session cookie')
  return raw.split(';')[0]!
}

async function clearDb() {
  await prisma.userPreference.deleteMany()
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

async function register(app: FastifyInstance, email: string, password = 'correct-password') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password, tenantName: email.split('@')[0] },
  })
  expect(response.statusCode).toBe(200)
  return cookieHeader(response)
}

describeWithDb('account self-service', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await clearDb()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
  })

  it('returns account detail with hasPassword and current session', async () => {
    const cookie = await register(app, 'owner@example.com')
    const response = await app.inject({ method: 'GET', url: '/api/account', headers: { cookie } })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      security: { hasPassword: boolean; oauthProviders: string[] }
      sessions: Array<{ current: boolean }>
    }
    expect(body.security.hasPassword).toBe(true)
    expect(body.security.oauthProviders).toEqual([])
    expect(body.sessions.some((session) => session.current)).toBe(true)
  })

  it('rejects a wrong current password and accepts the correct one', async () => {
    const cookie = await register(app, 'owner@example.com')

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie },
      payload: { currentPassword: 'nope-nope', newPassword: 'brand-new-password' },
    })
    expect(wrong.statusCode).toBe(400)

    const ok = await app.inject({
      method: 'POST',
      url: '/api/account/password',
      headers: { cookie },
      payload: { currentPassword: 'correct-password', newPassword: 'brand-new-password' },
    })
    expect(ok.statusCode).toBe(200)

    // 旧密码失效、新密码可登录
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: 'correct-password' },
    })
    expect(oldLogin.statusCode).toBe(401)

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: 'brand-new-password' },
    })
    expect(newLogin.statusCode).toBe(200)
  })

  it('logs out other sessions while keeping the current one', async () => {
    const cookie = await register(app, 'owner@example.com')
    // 第二个会话
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: 'correct-password' },
    })

    const before = await app.inject({ method: 'GET', url: '/api/account', headers: { cookie } })
    expect((before.json() as { sessions: unknown[] }).sessions.length).toBeGreaterThanOrEqual(2)

    const revoke = await app.inject({
      method: 'POST',
      url: '/api/account/sessions/revoke-others',
      headers: { cookie },
    })
    expect(revoke.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: '/api/account', headers: { cookie } })
    const sessions = (after.json() as { sessions: Array<{ current: boolean }> }).sessions
    expect(sessions.length).toBe(1)
    expect(sessions[0]!.current).toBe(true)
  })

  it('stores client preferences per user and strips secret-looking fields', async () => {
    const ownerCookie = await register(app, 'owner@example.com')
    const otherCookie = await register(app, 'other@example.com')

    const empty = await app.inject({
      method: 'GET',
      url: '/api/preferences/client',
      headers: { cookie: ownerCookie },
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toMatchObject({ preferences: null, updatedAt: null })

    const save = await app.inject({
      method: 'PUT',
      url: '/api/preferences/client',
      headers: { cookie: ownerCookie },
      payload: {
        version: 1,
        settings: {
          activeProfileId: 'profile-a',
          apiKey: 'should-not-be-stored',
          profileConfig: {
            'profile-a': {
              timeout: 120,
              secret: 'hidden',
            },
          },
        },
        params: { size: '1024x1024', quality: 'high', output_format: 'webp', output_compression: 80, moderation: 'auto', n: 2 },
        favoriteCollections: [{ id: 'fav-a', name: 'A', createdAt: 1, updatedAt: 1 }],
        defaultFavoriteCollectionId: 'fav-a',
        taskFavorites: { 'task-a': ['fav-a'] },
        ui: { appMode: 'agent', accessToken: 'hidden-token' },
      },
    })
    expect(save.statusCode).toBe(200)
    const saved = save.json() as { preferences: Record<string, unknown>; updatedAt: string }
    expect(saved.updatedAt).toBeTruthy()
    expect(JSON.stringify(saved.preferences)).not.toContain('should-not-be-stored')
    expect(JSON.stringify(saved.preferences)).not.toContain('hidden-token')
    expect(saved.preferences).toMatchObject({
      version: 1,
      settings: {
        activeProfileId: 'profile-a',
        profileConfig: {
          'profile-a': {
            timeout: 120,
          },
        },
      },
      params: { size: '1024x1024', quality: 'high', output_format: 'webp', output_compression: 80, moderation: 'auto', n: 2 },
      defaultFavoriteCollectionId: 'fav-a',
      taskFavorites: { 'task-a': ['fav-a'] },
    })

    const loaded = await app.inject({
      method: 'GET',
      url: '/api/preferences/client',
      headers: { cookie: ownerCookie },
    })
    expect(loaded.statusCode).toBe(200)
    expect((loaded.json() as { preferences: unknown }).preferences).toEqual(saved.preferences)

    const other = await app.inject({
      method: 'GET',
      url: '/api/preferences/client',
      headers: { cookie: otherCookie },
    })
    expect(other.statusCode).toBe(200)
    expect(other.json()).toMatchObject({ preferences: null, updatedAt: null })
  })
})
