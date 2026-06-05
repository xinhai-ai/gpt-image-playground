import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'
import { prisma } from '../src/prisma.js'

vi.mock('../src/emailOtp.js', () => {
  class EmailOtpError extends Error {
    status: number

    constructor(message: string, status = 400) {
      super(message)
      this.status = status
    }
  }

  return {
    closeEmailOtpResources: vi.fn(),
    emailOtpConfigured: () => true,
    emailOtpUnavailableReason: () => '',
    EmailOtpError,
    sendEmailOtp: vi.fn(async () => ({ ttlSeconds: 600, cooldownSeconds: 60 })),
    verifyEmailOtp: vi.fn(async (email: string, code: string) => (
      code === '123456'
        ? { ok: true, email }
        : { ok: false, status: 400, error: '验证码不正确' }
    )),
  }
})

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

describeWithDb('email code auth', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    await clearDb()
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
    await clearDb()
  })

  it('creates a Better Auth compatible session after email code verification', async () => {
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/email-code/verify',
      payload: { email: 'otp@example.com', code: '123456' },
    })
    expect(verify.statusCode).toBe(200)

    const cookie = cookieHeader(verify)
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    })

    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({
      user: { email: 'otp@example.com' },
      tenant: { role: 'OWNER' },
    })
  })
})
