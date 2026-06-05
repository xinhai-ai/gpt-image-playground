import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'

const originalRegistrationEnabled = process.env.EMAIL_PASSWORD_REGISTRATION_ENABLED

async function buildAppWithRegistration(enabled: boolean): Promise<FastifyInstance> {
  process.env.EMAIL_PASSWORD_REGISTRATION_ENABLED = enabled ? 'true' : 'false'
  return buildApp()
}

afterEach(() => {
  if (originalRegistrationEnabled == null) {
    delete process.env.EMAIL_PASSWORD_REGISTRATION_ENABLED
  } else {
    process.env.EMAIL_PASSWORD_REGISTRATION_ENABLED = originalRegistrationEnabled
  }
})

describe('auth options', () => {
  it('reports whether email password registration is enabled', async () => {
    const app = await buildAppWithRegistration(false)
    try {
      const response = await app.inject({ method: 'GET', url: '/api/auth/oauth-options' })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        emailPassword: {
          registrationEnabled: false,
        },
      })
    } finally {
      await app.close()
    }
  })

  it('rejects custom and direct email password registration when disabled', async () => {
    const app = await buildAppWithRegistration(false)
    try {
      const payload = {
        email: 'blocked@example.com',
        password: 'correct-password',
        name: 'Blocked',
        tenantName: 'Blocked',
      }
      const custom = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload,
      })
      expect(custom.statusCode).toBe(403)
      expect(custom.json()).toMatchObject({ error: '邮箱密码注册已关闭' })

      const direct = await app.inject({
        method: 'POST',
        url: '/api/auth/better/sign-up/email',
        payload,
      })
      expect(direct.statusCode).toBe(403)
      expect(direct.json()).toMatchObject({ error: '邮箱密码注册已关闭' })
    } finally {
      await app.close()
    }
  })
})
