import type { FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { config } from './config.js'

type RateLimitEntry = {
  count: number
  resetAt: number
}

const buckets = new Map<string, RateLimitEntry>()

function stableKey(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('|'))
    .digest('hex')
}

function sweep(now: number): void {
  if (buckets.size < 1000) return
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key)
  }
}

export async function enforceRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    bucket: string
    keyParts?: Array<string | number | null | undefined>
    max: number
    windowMs: number
  },
): Promise<boolean> {
  if (!config.security.rateLimitEnabled) return true
  const now = Date.now()
  sweep(now)
  const key = `${input.bucket}:${stableKey([request.ip, ...(input.keyParts ?? [])])}`
  const current = buckets.get(key)
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + input.windowMs })
    return true
  }
  current.count += 1
  if (current.count <= input.max) return true

  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  reply
    .header('Retry-After', String(retryAfterSeconds))
    .status(429)
    .send({ error: '请求过于频繁，请稍后再试' })
  return false
}
