import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ImagePurpose, ImageStatus } from '@prisma/client'
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

async function register(app: FastifyInstance, email = 'owner@example.com'): Promise<{
  cookie: string
  userId: string
  tenantId: string
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
    user: { id: string }
    tenant: { id: string }
    providerProfiles: Array<{ id: string }>
  }
  return {
    cookie: cookieHeader(response),
    userId: payload.user.id,
    tenantId: payload.tenant.id,
    profileId: payload.providerProfiles[0]!.id,
  }
}

describeWithDb('security controls', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await clearDb()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
  })

  it('rejects private provider base URLs', async () => {
    const session = await register(app)
    const response = await app.inject({
      method: 'POST',
      url: '/api/provider-profiles',
      headers: { cookie: session.cookie },
      payload: {
        name: 'Localhost',
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'gpt-image-2',
        apiMode: 'images',
        apiKey: 'sk-test',
      },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error?: string }).error).toContain('不允许')
  })

  it('rejects tampered session cookies', async () => {
    const session = await register(app)
    const tamperedCookie = `${session.cookie}x`
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: tamperedCookie },
    })
    expect(response.statusCode).toBe(401)
  })

  it('does not use pending images for provider requests', async () => {
    const session = await register(app)
    const imageId = randomUUID()
    await prisma.imageAsset.create({
      data: {
        id: imageId,
        tenantId: session.tenantId,
        bucket: 'gpt-image-assets',
        objectKey: `tenants/${session.tenantId}/images/${imageId}/original`,
        contentType: 'image/png',
        byteSize: 0,
        purpose: ImagePurpose.INPUT,
        status: ImageStatus.PENDING,
        createdByUserId: session.userId,
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: session.cookie },
      payload: {
        prompt: 'test',
        params: DEFAULT_TASK_PARAMS,
        inputImageIds: [imageId],
        maskImageId: null,
        providerProfileId: session.profileId,
      },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error?: string }).error).toContain('尚未完成上传')
  })
})
