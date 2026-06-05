import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { Redis } from 'ioredis'
import nodemailer from 'nodemailer'
import { config } from './config.js'
import { normalizeEmail } from './crypto.js'

type EmailOtpRecord = {
  email: string
  codeHash: string
  nonce: string
  attempts: number
  createdAt: number
  expiresAt: number
}

type EmailOtpVerification =
  | { ok: true; email: string }
  | { ok: false; error: string; status: number }

const OTP_KEY_PREFIX = 'gpt-image:auth:email-otp'
const OTP_COOLDOWN_PREFIX = 'gpt-image:auth:email-otp-cooldown'
let redisClient: Redis | null = null
let mailTransporter: nodemailer.Transporter | null = null

export function emailOtpConfigured(): boolean {
  return Boolean(config.auth.emailOtpEnabled && config.redis.url && config.smtp.host && config.smtp.from)
}

export function emailOtpUnavailableReason(): string {
  if (!config.auth.emailOtpEnabled) return '邮箱验证码登录未开启'
  if (!config.redis.url) return 'Redis 未配置'
  if (!config.smtp.host || !config.smtp.from) return 'SMTP 未配置'
  return '邮箱验证码登录不可用'
}

export async function closeEmailOtpResources(): Promise<void> {
  if (redisClient) {
    const client = redisClient
    redisClient = null
    client.disconnect()
  }
  mailTransporter = null
}

export async function sendEmailOtp(emailInput: string): Promise<{ expiresIn: number; cooldownSeconds: number }> {
  assertEmailOtpConfigured()
  const email = normalizeEmail(emailInput)
  const redis = await getRedisClient()
  const emailKey = hashEmail(email)
  const cooldownKey = `${OTP_COOLDOWN_PREFIX}:${emailKey}`
  const cooldownSet = await redis.set(cooldownKey, '1', 'EX', config.auth.emailOtpCooldownSeconds, 'NX')
  if (!cooldownSet) {
    throw new EmailOtpError(429, `验证码发送过于频繁，请 ${config.auth.emailOtpCooldownSeconds} 秒后再试`)
  }

  const code = createOtpCode()
  const nonce = createHash('sha256').update(`${email}:${Date.now()}:${Math.random()}`).digest('hex')
  const now = Date.now()
  const record: EmailOtpRecord = {
    email,
    nonce,
    codeHash: hashCode(email, code, nonce),
    attempts: 0,
    createdAt: now,
    expiresAt: now + config.auth.emailOtpTtlSeconds * 1000,
  }

  try {
    await redis.set(otpKey(email), JSON.stringify(record), 'EX', config.auth.emailOtpTtlSeconds)
    await sendOtpEmail(email, code)
  } catch (error) {
    await Promise.all([
      redis.del(otpKey(email)).catch(() => undefined),
      redis.del(cooldownKey).catch(() => undefined),
    ])
    if (error instanceof EmailOtpError) throw error
    throw new EmailOtpError(502, '验证码邮件发送失败')
  }

  return {
    expiresIn: config.auth.emailOtpTtlSeconds,
    cooldownSeconds: config.auth.emailOtpCooldownSeconds,
  }
}

export async function verifyEmailOtp(emailInput: string, codeInput: string): Promise<EmailOtpVerification> {
  assertEmailOtpConfigured()
  const email = normalizeEmail(emailInput)
  const code = normalizeCode(codeInput)
  if (!code) return { ok: false, status: 400, error: '验证码格式不正确' }

  const redis = await getRedisClient()
  const key = otpKey(email)
  const raw = await redis.get(key)
  if (!raw) return { ok: false, status: 400, error: '验证码已过期或不存在' }

  const record = parseRecord(raw)
  if (!record || record.email !== email || record.expiresAt <= Date.now()) {
    await redis.del(key).catch(() => undefined)
    return { ok: false, status: 400, error: '验证码已过期或不存在' }
  }
  if (record.attempts >= config.auth.emailOtpMaxAttempts) {
    await redis.del(key).catch(() => undefined)
    return { ok: false, status: 400, error: '验证码尝试次数过多，请重新获取' }
  }

  const valid = safeEqual(record.codeHash, hashCode(email, code, record.nonce))
  if (!valid) {
    const ttl = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000))
    await redis.set(key, JSON.stringify({ ...record, attempts: record.attempts + 1 }), 'EX', ttl)
    return { ok: false, status: 400, error: '验证码不正确' }
  }

  await Promise.all([
    redis.del(key).catch(() => undefined),
    redis.del(`${OTP_COOLDOWN_PREFIX}:${hashEmail(email)}`).catch(() => undefined),
  ])
  return { ok: true, email }
}

export class EmailOtpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'EmailOtpError'
    this.status = status
  }
}

function assertEmailOtpConfigured(): void {
  if (!emailOtpConfigured()) throw new EmailOtpError(503, emailOtpUnavailableReason())
}

async function getRedisClient(): Promise<Redis> {
  if (!config.redis.url) throw new EmailOtpError(503, 'Redis 未配置')
  if (!redisClient) {
    redisClient = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
    })
    redisClient.on('error', (error: unknown) => {
      console.warn('Redis error:', error)
    })
  }
  if (redisClient.status === 'wait') {
    try {
      await redisClient.connect()
    } catch {
      throw new EmailOtpError(503, 'Redis 连接失败')
    }
  }
  return redisClient
}

async function sendOtpEmail(email: string, code: string): Promise<void> {
  const transporter = getMailTransporter()
  const fromName = config.smtp.fromName.replace(/"/g, '\\"')
  await transporter.sendMail({
    to: email,
    from: `"${fromName}" <${config.smtp.from}>`,
    subject: 'GPT Image Playground 登录验证码',
    text: `你的登录验证码是：${code}\n\n验证码 ${Math.floor(config.auth.emailOtpTtlSeconds / 60)} 分钟内有效。如非本人操作，请忽略这封邮件。`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.6;color:#111827">
        <p>你的登录验证码是：</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:16px 0">${code}</p>
        <p>验证码 ${Math.floor(config.auth.emailOtpTtlSeconds / 60)} 分钟内有效。如非本人操作，请忽略这封邮件。</p>
      </div>
    `,
  })
}

function getMailTransporter(): nodemailer.Transporter {
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user || config.smtp.pass
        ? {
            user: config.smtp.user,
            pass: config.smtp.pass,
          }
        : undefined,
    })
  }
  return mailTransporter
}

function createOtpCode(): string {
  const length = Math.max(4, Math.min(10, config.auth.emailOtpCodeLength))
  const max = 10 ** length
  return String(randomInt(0, max)).padStart(length, '0')
}

function normalizeCode(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, '')
  const length = Math.max(4, Math.min(10, config.auth.emailOtpCodeLength))
  return new RegExp(`^\\d{${length}}$`).test(normalized) ? normalized : null
}

function hashEmail(email: string): string {
  return createHash('sha256').update(email).digest('hex')
}

function otpKey(email: string): string {
  return `${OTP_KEY_PREFIX}:${hashEmail(email)}`
}

function hashCode(email: string, code: string, nonce: string): string {
  return createHmac('sha256', config.sessionSecret)
    .update(`${email}:${code}:${nonce}`)
    .digest('hex')
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function parseRecord(raw: string): EmailOtpRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EmailOtpRecord>
    if (!parsed.email || !parsed.codeHash || !parsed.nonce || !parsed.expiresAt) return null
    return {
      email: parsed.email,
      codeHash: parsed.codeHash,
      nonce: parsed.nonce,
      attempts: Number(parsed.attempts) || 0,
      createdAt: Number(parsed.createdAt) || Date.now(),
      expiresAt: Number(parsed.expiresAt),
    }
  } catch {
    return null
  }
}
