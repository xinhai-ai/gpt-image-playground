import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'
import { prisma } from '../src/prisma.js'
import { ensureBucket } from '../src/storage.js'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

function cookieByName(response: { headers: Record<string, string | string[] | undefined> }, name: string): string {
  const setCookie = response.headers['set-cookie']
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`))
  if (!found) throw new Error(`Missing ${name} cookie`)
  return found.split(';')[0]!
}

function multipartImageBody(boundary: string, purpose = 'input'): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.png"\r\nContent-Type: image/png\r\n\r\n`),
    TINY_PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
}

async function clearDb() {
  await prisma.taskImage.deleteMany()
  await prisma.task.deleteMany()
  await prisma.imageAsset.deleteMany()
  await prisma.providerProfile.deleteMany()
  await prisma.oAuthAccount.deleteMany()
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
  return {
    cookie: cookieByName(response, 'gip_session'),
    profileId: payload.providerProfiles[0]!.id,
  }
}

async function createResponsesProvider(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/channels',
    headers: { cookie },
    payload: {
      name: 'Agent OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      apiMode: 'responses',
      apiKey: 'sk-test-provider',
    },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { channel: { id: string } }).channel.id
}

async function uploadTinyImage(app: FastifyInstance, cookie: string): Promise<string> {
  const boundary = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const response = await app.inject({
    method: 'POST',
    url: '/api/storage/images',
    headers: {
      cookie,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartImageBody(boundary),
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { imageId: string }).imageId
}

describeWithDb('GitHub OAuth and Agent image references', () => {
  let app: FastifyInstance
  const originalGitHubEnv = {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackUrl: process.env.GITHUB_CALLBACK_URL,
  }

  beforeEach(async () => {
    await clearDb()
    await ensureBucket()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
    vi.unstubAllGlobals()
    if (originalGitHubEnv.clientId === undefined) delete process.env.GITHUB_CLIENT_ID
    else process.env.GITHUB_CLIENT_ID = originalGitHubEnv.clientId
    if (originalGitHubEnv.clientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET
    else process.env.GITHUB_CLIENT_SECRET = originalGitHubEnv.clientSecret
    if (originalGitHubEnv.callbackUrl === undefined) delete process.env.GITHUB_CALLBACK_URL
    else process.env.GITHUB_CALLBACK_URL = originalGitHubEnv.callbackUrl
  })

  it('starts GitHub OAuth through Better Auth with a persisted state', async () => {
    await app.close()
    process.env.GITHUB_CLIENT_ID = 'github-client-id'
    process.env.GITHUB_CLIENT_SECRET = 'github-client-secret'
    process.env.GITHUB_CALLBACK_URL = 'http://localhost:8080/api/auth/better/callback/github'
    app = await buildApp()

    const options = await app.inject({
      method: 'GET',
      url: '/api/auth/oauth-options',
    })
    expect(options.statusCode).toBe(200)
    expect((options.json() as { github: { enabled: boolean } }).github.enabled).toBe(true)

    const start = await app.inject({
      method: 'GET',
      url: '/api/auth/github/start?redirect=%2Fagent%3Ftab%3Dchat',
    })
    expect(start.statusCode).toBe(302)
    expect(start.headers['set-cookie']).toBeTruthy()
    const authorizeUrl = new URL(start.headers.location as string)
    expect(authorizeUrl.origin).toBe('https://github.com')
    expect(authorizeUrl.searchParams.get('client_id')).toBe('github-client-id')
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://localhost:8080/api/auth/better/callback/github')
    expect(authorizeUrl.searchParams.get('scope')).toContain('user:email')
    const state = authorizeUrl.searchParams.get('state')
    expect(state).toBeTruthy()
    const verification = await prisma.verification.findFirst({
      where: { identifier: state! },
    })
    expect(verification?.value).toContain('/agent?tab=chat')
  })

  it('resolves Agent image_id placeholders to tenant-scoped original image data', async () => {
    const owner = await register(app, 'owner@example.com')
    const other = await register(app, 'other@example.com')
    const providerProfileId = await createResponsesProvider(app, owner.cookie)
    const imageId = await uploadTinyImage(app, owner.cookie)

    let upstreamBody: Record<string, unknown> | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(input.toString()).toBe('https://api.openai.com/v1/responses')
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(`data: ${JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp-1', output: [] },
      })}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/responses',
      headers: { cookie: owner.cookie },
      payload: {
        providerProfileId,
        body: {
          model: 'gpt-5.5',
          stream: true,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: 'use this image' },
              { type: 'input_image', image_id: imageId },
            ],
          }],
          tools: [{
            type: 'image_generation',
            input_image_mask: { image_id: imageId },
          }],
        },
      },
    })
    expect(response.statusCode).toBe(200)
    expect((response.json() as { id: string }).id).toBe('resp-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(upstreamBody?.stream).toBe(true)
    const serialized = JSON.stringify(upstreamBody)
    expect(serialized).not.toContain('image_id')
    expect(serialized).toContain('data:image/png;base64,')

    const isolated = await app.inject({
      method: 'POST',
      url: '/api/agent/responses',
      headers: { cookie: other.cookie },
      payload: {
        providerProfileId,
        body: {
          model: 'gpt-5.5',
          input: [{ role: 'user', content: [{ type: 'input_image', image_id: imageId }] }],
        },
      },
    })
    expect(isolated.statusCode).toBe(400)
    expect((isolated.json() as { error?: string }).error).toContain('不属于当前租户')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
