import type { FastifyRequest } from 'fastify'

function firstHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value.find((item) => item.trim()) : value
  const trimmed = raw?.trim()
  return trimmed || null
}

function firstForwardedIp(value: string | string[] | undefined): string | null {
  const raw = firstHeaderValue(value)
  if (!raw) return null
  return raw.split(',')[0]?.trim() || null
}

export function getClientIp(request: FastifyRequest): string {
  return (
    firstHeaderValue(request.headers['cf-connecting-ip']) ||
    firstHeaderValue(request.headers['x-real-ip']) ||
    firstForwardedIp(request.headers['x-forwarded-for']) ||
    request.ip
  )
}
