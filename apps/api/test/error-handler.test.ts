import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/server.js'

// 这些用例只验证全局错误处理的响应结构，不触达数据库。
describe('global error handler', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp()
  })

  afterEach(async () => {
    await app.close()
  })

  it('normalizes malformed JSON to { error } instead of Fastify default shape', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    })
    expect(response.statusCode).toBe(400)
    const body = response.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
    // 不应泄漏 Fastify 默认的 { statusCode, error, message } 结构
    expect(body.statusCode).toBeUndefined()
    expect(body.message).toBeUndefined()
  })

  it('returns a consistent { error } shape for unknown API routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(response.statusCode).toBe(404)
    const body = response.json() as Record<string, unknown>
    expect(typeof body.error).toBe('string')
    expect(body.statusCode).toBeUndefined()
  })

  it('keeps the health check working', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })
})
