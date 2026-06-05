import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/crypto.js'

describe('crypto helpers', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('correct horse battery staple')

    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true)
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false)
  })

  it('encrypts provider secrets without returning plaintext', () => {
    const encrypted = encryptSecret('sk-test-secret')

    expect(encrypted).toBeTruthy()
    expect(encrypted).not.toContain('sk-test-secret')
    expect(decryptSecret(encrypted)).toBe('sk-test-secret')
  })
})
