import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { buildApp } from '../src/server.js'
import { prisma } from '../src/prisma.js'
import { ensureBucket, readObjectBytes } from '../src/storage.js'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

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
  await prisma.taskEvent.deleteMany()
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

async function register(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: 'async-owner@example.com',
      password: 'correct-password',
      tenantName: 'async',
    },
  })
  expect(response.statusCode).toBe(200)
  return cookieHeader(response)
}

async function createProvider(app: FastifyInstance, cookie: string, overrides: {
  apiMode?: 'images' | 'responses'
  config?: Record<string, unknown>
} = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/channels',
    headers: { cookie },
    payload: {
      name: 'Async OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-image-2',
      apiMode: overrides.apiMode ?? 'images',
      apiKey: 'sk-test-provider',
      ...(overrides.config ? { config: overrides.config } : {}),
    },
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { channel: { id: string } }).channel.id
}

async function waitForTask(app: FastifyInstance, cookie: string, taskId: string): Promise<{
  status: string
  outputImages: string[]
}> {
  for (let index = 0; index < 80; index++) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    const task = (response.json() as { task: { status: string; outputImages: string[] } }).task
    if (task.status !== 'running') return task
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for async task')
}

async function readSseUntilSnapshot(app: FastifyInstance, cookie: string): Promise<string> {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/events?cursor=0`, {
    headers: { cookie },
    signal: controller.signal,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing SSE response body')
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (let index = 0; index < 20; index++) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('"type":"task.snapshot"')) break
    }
  } finally {
    controller.abort()
    reader.cancel().catch(() => undefined)
  }
  return text
}

describeWithDb('async SaaS task execution', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await clearDb()
    await ensureBucket()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
    vi.unstubAllGlobals()
  })

  it('returns immediately, runs in the worker, and archives generated images server-side', async () => {
    const cookie = await register(app)
    const providerProfileId = await createProvider(app, cookie)
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      expect(input.toString()).toBe('https://api.openai.com/v1/images/generations')
      return new Response(JSON.stringify({
        data: [{
          b64_json: TINY_PNG_BASE64,
          revised_prompt: 'tiny generated image',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie },
      payload: {
        prompt: 'make a tiny image',
        params: DEFAULT_TASK_PARAMS,
        inputImageIds: [],
        maskImageId: null,
        providerProfileId,
      },
    })
    expect(created.statusCode).toBe(202)
    const createdPayload = created.json() as { task: { id: string; status: string; outputImages: string[] }; images: unknown[] }
    expect(createdPayload.task.status).toBe('running')
    expect(createdPayload.task.outputImages).toEqual([])
    expect(createdPayload.images).toEqual([])

    const doneTask = await waitForTask(app, cookie, createdPayload.task.id)
    expect(doneTask.status).toBe('done')
    expect(doneTask.outputImages).toHaveLength(1)

    const image = await prisma.imageAsset.findUniqueOrThrow({ where: { id: doneTask.outputImages[0]! } })
    expect(image.status).toBe('READY')
    expect(image.byteSize).toBeGreaterThan(0)
    expect(image.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect((await readObjectBytes(image.bucket, image.objectKey)).byteLength).toBe(image.byteSize)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await prisma.taskEvent.count({ where: { taskId: createdPayload.task.id } })).toBeGreaterThanOrEqual(3)

    vi.unstubAllGlobals()
    const sseText = await readSseUntilSnapshot(app, cookie)
    expect(sseText).toContain('id:')
    expect(sseText).toContain('"type":"task.updated"')
    expect(sseText).toContain('"type":"task.snapshot"')
    expect(sseText).toContain(createdPayload.task.id)
  })

  it('runs OpenAI-compatible image count as concurrent single-image generation requests', async () => {
    const cookie = await register(app)
    const providerProfileId = await createProvider(app, cookie)
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(input.toString()).toBe('https://api.openai.com/v1/images/generations')
      const body = JSON.parse(String(init?.body ?? '{}')) as { n?: number }
      expect(body.n).toBeUndefined()
      return new Response(JSON.stringify({
        data: [{
          b64_json: TINY_PNG_BASE64,
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie },
      payload: {
        prompt: 'make two tiny images',
        params: { ...DEFAULT_TASK_PARAMS, n: 2 },
        inputImageIds: [],
        maskImageId: null,
        providerProfileId,
      },
    })
    expect(created.statusCode).toBe(202)
    const createdPayload = created.json() as { task: { id: string } }

    const doneTask = await waitForTask(app, cookie, createdPayload.task.id)
    expect(doneTask.status).toBe('done')
    expect(doneTask.outputImages).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deletes tasks on the backend and cleans orphaned output records', async () => {
    const cookie = await register(app)
    const providerProfileId = await createProvider(app, cookie)
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(JSON.stringify({
      data: [{
        b64_json: TINY_PNG_BASE64,
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie },
      payload: {
        prompt: 'make one image then delete it',
        params: DEFAULT_TASK_PARAMS,
        inputImageIds: [],
        maskImageId: null,
        providerProfileId,
      },
    })
    expect(created.statusCode).toBe(202)
    const createdPayload = created.json() as { task: { id: string } }
    const doneTask = await waitForTask(app, cookie, createdPayload.task.id)
    expect(doneTask.status).toBe('done')
    expect(doneTask.outputImages).toHaveLength(1)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${createdPayload.task.id}`,
      headers: { cookie },
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toMatchObject({
      ok: true,
      deletedTaskId: createdPayload.task.id,
      deletedImageIds: doneTask.outputImages,
      alreadyDeleted: false,
    })

    const missing = await app.inject({
      method: 'GET',
      url: `/api/tasks/${createdPayload.task.id}`,
      headers: { cookie },
    })
    expect(missing.statusCode).toBe(404)
    expect(await prisma.taskImage.count({ where: { taskId: createdPayload.task.id } })).toBe(0)
    expect(await prisma.taskEvent.count({ where: { taskId: createdPayload.task.id } })).toBe(0)
    expect(await prisma.imageAsset.findUnique({ where: { id: doneTask.outputImages[0]! } })).toBeNull()
    expect(await prisma.usageLog.count({ where: { action: 'task.delete', targetId: createdPayload.task.id } })).toBe(1)

    const deletedAgain = await app.inject({
      method: 'DELETE',
      url: `/api/tasks/${createdPayload.task.id}`,
      headers: { cookie },
    })
    expect(deletedAgain.statusCode).toBe(200)
    expect(deletedAgain.json()).toMatchObject({
      ok: true,
      deletedTaskId: createdPayload.task.id,
      deletedImageIds: [],
      alreadyDeleted: true,
    })
  })

  it('runs Responses image count as concurrent single-image response requests', async () => {
    const cookie = await register(app)
    const providerProfileId = await createProvider(app, cookie, { apiMode: 'responses' })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      expect(input.toString()).toBe('https://api.openai.com/v1/responses')
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean; tools?: Array<{ type?: string }> }
      expect(body.stream).toBe(true)
      expect(body.tools?.[0]?.type).toBe('image_generation')
      const streamBody = [
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'image_generation_call',
            result: TINY_PNG_BASE64,
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp-test', output: [] },
        })}\n\n`,
      ].join('')
      return new Response(streamBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie },
      payload: {
        prompt: 'make two tiny response images',
        params: { ...DEFAULT_TASK_PARAMS, n: 2 },
        inputImageIds: [],
        maskImageId: null,
        providerProfileId,
      },
    })
    expect(created.statusCode).toBe(202)
    const createdPayload = created.json() as { task: { id: string } }

    const doneTask = await waitForTask(app, cookie, createdPayload.task.id)
    expect(doneTask.status).toBe('done')
    expect(doneTask.outputImages).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
