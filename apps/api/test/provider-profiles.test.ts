import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'
import { decryptSecret } from '../src/crypto.js'
import { prisma } from '../src/prisma.js'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip

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

async function register(app: FastifyInstance, email: string): Promise<{ cookie: string; profileId: string }> {
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
  const payload = response.json() as { providerProfiles: Array<{ id: string }> }
  expect(payload.providerProfiles).toHaveLength(1)
  return {
    cookie: cookieHeader(response),
    profileId: payload.providerProfiles[0]!.id,
  }
}

describeWithDb('provider profile routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await clearDb()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
  })

  it('lets admins manage global channels without exposing API keys', async () => {
    const session = await register(app, 'owner@example.com')

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/channels',
      headers: { cookie: session.cookie },
      payload: {
        name: 'Primary OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-2',
        apiMode: 'images',
        apiKey: 'sk-test-secret',
        config: { timeout: 123 },
      },
    })
    expect(created.statusCode).toBe(201)
    const createdPayload = created.json() as { channel: { id: string; hasApiKey: boolean; apiKey?: string; apiKeyEncrypted?: string } }
    expect(createdPayload.channel.hasApiKey).toBe(true)
    expect(createdPayload.channel.apiKey).toBeUndefined()
    expect(createdPayload.channel.apiKeyEncrypted).toBeUndefined()

    const storedAfterCreate = await prisma.providerProfile.findUniqueOrThrow({
      where: { id: createdPayload.channel.id },
    })
    expect(storedAfterCreate.tenantId).toBeNull()
    expect(decryptSecret(storedAfterCreate.apiKeyEncrypted)).toBe('sk-test-secret')

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/admin/channels/${createdPayload.channel.id}`,
      headers: { cookie: session.cookie },
      payload: {
        name: 'Renamed OpenAI',
        apiKey: '',
      },
    })
    expect(patched.statusCode).toBe(200)
    const storedAfterEmptyPatch = await prisma.providerProfile.findUniqueOrThrow({
      where: { id: createdPayload.channel.id },
    })
    expect(storedAfterEmptyPatch.name).toBe('Renamed OpenAI')
    expect(decryptSecret(storedAfterEmptyPatch.apiKeyEncrypted)).toBe('sk-test-secret')

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookie },
    })
    expect(me.statusCode).toBe(200)
    const mePayload = me.json() as { providerProfiles: Array<Record<string, unknown>> }
    const profile = mePayload.providerProfiles.find((item) => item.id === createdPayload.channel.id)
    expect(profile).toMatchObject({
      id: createdPayload.channel.id,
      name: 'Renamed OpenAI',
      provider: 'openai',
      model: 'gpt-image-2',
      apiMode: 'images',
    })
    expect(profile?.baseUrl).toBeUndefined()
    expect(profile?.config).toBeUndefined()
    expect(profile?.hasApiKey).toBeUndefined()
    expect(profile?.apiKey).toBeUndefined()
    expect(profile?.apiKeyEncrypted).toBeUndefined()
  })

  it('exposes shared channels as read-only to regular users', async () => {
    const owner = await register(app, 'owner@example.com')
    const other = await register(app, 'other@example.com')

    expect(other.profileId).toBe(owner.profileId)

    const forbiddenCreate = await app.inject({
      method: 'POST',
      url: '/api/provider-profiles',
      headers: { cookie: other.cookie },
      payload: {
        name: 'Should not create',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-image-2',
        apiMode: 'images',
      },
    })
    expect(forbiddenCreate.statusCode).toBe(403)

    const isolatedPatch = await app.inject({
      method: 'PATCH',
      url: `/api/provider-profiles/${owner.profileId}`,
      headers: { cookie: other.cookie },
      payload: { name: 'Should not update' },
    })
    expect(isolatedPatch.statusCode).toBe(403)

    const otherList = await app.inject({
      method: 'GET',
      url: '/api/provider-profiles',
      headers: { cookie: other.cookie },
    })
    expect(otherList.statusCode).toBe(200)
    const otherPayload = otherList.json() as { providerProfiles: Array<{ id: string }> }
    expect(otherPayload.providerProfiles.some((profile) => profile.id === owner.profileId)).toBe(true)

    const deleteLast = await app.inject({
      method: 'DELETE',
      url: `/api/provider-profiles/${owner.profileId}`,
      headers: { cookie: owner.cookie },
    })
    expect(deleteLast.statusCode).toBe(403)
  })
})
