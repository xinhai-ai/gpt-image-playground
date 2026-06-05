import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'
import { prisma } from '../src/prisma.js'
import { ensureBucket, ensureThumbnailForImage, readObjectBytes } from '../src/storage.js'

const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

function cookieHeader(response: { headers: Record<string, string | string[] | undefined> }): string {
  const setCookie = response.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('Missing session cookie')
  return raw.split(';')[0]!
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
      email: 'uploader@example.com',
      password: 'correct-password',
    },
  })
  expect(response.statusCode).toBe(200)
  return cookieHeader(response)
}

describeWithDb('storage upload routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await clearDb()
    await ensureBucket()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
  })

  it('uploads through the API, preprocesses the original, and writes a WebP thumbnail', async () => {
    const cookie = await register(app)
    const boundary = `test-${Date.now()}`
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
    const payload = response.json() as {
      imageId: string
      contentType: string
      byteSize: number
      sha256: string
      width: number
      height: number
      status: string
    }
    expect(payload.contentType).toBe('image/png')
    expect(payload.byteSize).toBeGreaterThan(0)
    expect(payload.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(payload.width).toBe(1)
    expect(payload.height).toBe(1)
    expect(payload.status).toBe('READY')

    const image = await prisma.imageAsset.findUniqueOrThrow({ where: { id: payload.imageId } })
    const original = await readObjectBytes(image.bucket, image.objectKey)
    expect(original.byteLength).toBe(payload.byteSize)

    const thumbnail = await ensureThumbnailForImage(image)
    expect(thumbnail.contentType).toBe('image/webp')
    expect(thumbnail.byteSize).toBeGreaterThan(0)
    const thumbnailBytes = await readObjectBytes(thumbnail.bucket, thumbnail.objectKey)
    expect(Buffer.from(thumbnailBytes.subarray(0, 4)).toString('ascii')).toBe('RIFF')
  })
})
