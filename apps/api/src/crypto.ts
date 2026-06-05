import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { config } from './config.js'

const PASSWORD_KEY_BYTES = 32
const PASSWORD_PARAMS = {
  N: 16_384,
  r: 8,
  p: 1,
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, PASSWORD_KEY_BYTES, PASSWORD_PARAMS) as Buffer
  return `scrypt$${PASSWORD_PARAMS.N}$${PASSWORD_PARAMS.r}$${PASSWORD_PARAMS.p}$${base64Url(salt)}$${base64Url(key)}`
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  const parts = passwordHash.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts
  const expected = Buffer.from(keyRaw, 'base64url')
  const key = await scrypt(password, Buffer.from(saltRaw, 'base64url'), expected.length, {
    N: Number(nRaw),
    r: Number(rRaw),
    p: Number(pRaw),
  }) as Buffer
  return key.length === expected.length && timingSafeEqual(key, expected)
}

export function createSessionToken(): string {
  return base64Url(randomBytes(32))
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(`${config.sessionSecret}:${token}`).digest('hex')
}

function encryptionKey(): Buffer {
  return createHash('sha256').update(config.providerKeyEncryptionSecret).digest()
}

export function encryptSecret(value: string): string | null {
  if (!value.trim()) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${base64Url(iv)}:${base64Url(tag)}:${base64Url(ciphertext)}`
}

export function decryptSecret(value: string | null): string {
  if (!value) return ''
  const [version, ivRaw, tagRaw, ciphertextRaw] = value.split(':')
  if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw) return ''
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
