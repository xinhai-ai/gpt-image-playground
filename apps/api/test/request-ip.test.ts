import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { getClientIp } from '../src/requestIp.js'

function requestWith(headers: Record<string, string | string[] | undefined>, ip = '127.0.0.1'): FastifyRequest {
  return { headers, ip } as FastifyRequest
}

describe('getClientIp', () => {
  it('prefers CF-Connecting-IP over proxy and socket addresses', () => {
    expect(getClientIp(requestWith({
      'cf-connecting-ip': '203.0.113.10',
      'x-real-ip': '198.51.100.20',
      'x-forwarded-for': '198.51.100.21, 198.51.100.22',
    }))).toBe('203.0.113.10')
  })

  it('falls back to X-Forwarded-For first hop and then request.ip', () => {
    expect(getClientIp(requestWith({
      'x-forwarded-for': '198.51.100.21, 198.51.100.22',
    }))).toBe('198.51.100.21')
    expect(getClientIp(requestWith({}))).toBe('127.0.0.1')
  })
})
