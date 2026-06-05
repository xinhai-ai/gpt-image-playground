import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { config } from './config.js'

const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'host.docker.internal',
])

function parseUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} 必须是有效 URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} 只允许 http 或 https`)
  }
  if (url.username || url.password) {
    throw new Error(`${label} 不能包含用户名或密码`)
  }
  return url
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase()
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:169.254.') ||
    normalized.startsWith('::ffff:192.168.')
  )
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIPv4(address)
  if (family === 6) return isPrivateIPv6(address)
  return true
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  return LOCAL_HOSTNAMES.has(normalized) || normalized.endsWith('.localhost') || normalized.endsWith('.local')
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
}

function assertAllowedHost(url: URL, label: string): void {
  if (config.security.allowPrivateProviderUrls) return
  const hostname = normalizeHostname(url.hostname)
  if (isLocalHostname(hostname)) {
    throw new Error(`${label} 不允许指向本机或内网地址`)
  }
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error(`${label} 不允许指向本机或内网地址`)
  }
}

export function normalizeOutboundHttpUrl(value: string, label = 'URL'): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const url = parseUrl(trimmed, label)
  assertAllowedHost(url, label)
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export async function assertSafeOutboundUrl(value: string, label = 'URL'): Promise<void> {
  const url = parseUrl(value, label)
  assertAllowedHost(url, label)
  const hostname = normalizeHostname(url.hostname)
  if (config.security.allowPrivateProviderUrls || isIP(hostname)) return

  const results = await lookup(hostname, { all: true, verbatim: true })
  if (!results.length || results.some((item) => isPrivateAddress(item.address))) {
    throw new Error(`${label} 解析到了本机或内网地址`)
  }
}
