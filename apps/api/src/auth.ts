import { betterAuth, APIError } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config.js'
import { hashPassword, normalizeEmail, verifyPassword } from './crypto.js'
import { prisma } from './prisma.js'

export const BETTER_AUTH_BASE_PATH = '/api/auth/better'
export const SESSION_COOKIE = 'gip_session'

function githubOAuthConfig() {
  return {
    clientId: process.env.GITHUB_CLIENT_ID?.trim() || config.githubOAuth.clientId,
    clientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() || config.githubOAuth.clientSecret,
    callbackUrl: process.env.GITHUB_CALLBACK_URL?.trim() || config.githubOAuth.callbackUrl,
  }
}

export function githubOAuthEnabled(): boolean {
  const oauth = githubOAuthConfig()
  return Boolean(oauth.clientId && oauth.clientSecret)
}

export function createBetterAuth() {
  const oauth = githubOAuthConfig()
  return betterAuth({
    appName: 'GPT Image Playground',
    baseURL: config.betterAuthUrl,
    basePath: BETTER_AUTH_BASE_PATH,
    secret: config.sessionSecret,
    trustedOrigins: config.webOrigins,
    database: prismaAdapter(prisma, {
      provider: 'postgresql',
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 200,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    socialProviders: githubOAuthEnabled()
      ? {
          github: {
            clientId: oauth.clientId,
            clientSecret: oauth.clientSecret,
            scope: ['user:email'],
            ...(oauth.callbackUrl ? { redirectURI: oauth.callbackUrl } : {}),
          },
        }
      : undefined,
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['github'],
        requireLocalEmailVerified: false,
      },
    },
    user: {
      additionalFields: {
        isPlatformAdmin: {
          type: 'boolean',
          required: false,
          defaultValue: false,
          input: false,
        },
        disabledAt: {
          type: 'date',
          required: false,
          input: false,
        },
      },
    },
    session: {
      expiresIn: config.sessionTtlSeconds,
      updateAge: 24 * 60 * 60,
    },
    advanced: {
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: config.cookieSecure,
      },
      cookies: {
        session_token: {
          name: SESSION_COOKIE,
        },
        session_data: {
          name: `${SESSION_COOKIE}_data`,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              email: normalizeEmail(String(user.email)),
              emailVerified: true,
            },
          }),
          after: async (user) => {
            const email = normalizeEmail(user.email)
            const otherUserCount = await prisma.user.count({ where: { id: { not: user.id } } })
            if (otherUserCount === 0 || config.adminEmails.includes(email)) {
              await prisma.user.update({
                where: { id: user.id },
                data: { isPlatformAdmin: true },
              }).catch(() => undefined)
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { disabledAt: true },
            })
            if (user?.disabledAt) {
              throw new APIError('FORBIDDEN', { message: '账号已被禁用' })
            }
          },
        },
      },
    },
  })
}

export type AppAuth = ReturnType<typeof createBetterAuth>

export function betterAuthHeaders(request: FastifyRequest, options: { assumeTrustedOrigin?: boolean } = {}): Headers {
  const headers = fromNodeHeaders(request.headers)
  if (!headers.get('host') && request.headers.host) headers.set('host', request.headers.host)
  if (options.assumeTrustedOrigin && !headers.get('origin')) {
    headers.set('origin', new URL(config.betterAuthUrl).origin)
  }
  return headers
}

export function setBetterAuthCookies(reply: FastifyReply, response: Response): void {
  const headerBag = response.headers as Headers & { getSetCookie?: () => string[] }
  const cookies = headerBag.getSetCookie?.() ?? []
  if (cookies.length === 0) {
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === 'set-cookie') cookies.push(value)
    })
  }
  if (cookies.length > 0) reply.header('Set-Cookie', cookies)
}

export async function parseBetterAuthJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message
      : payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`
    const error = new APIError(response.status === 403 ? 'FORBIDDEN' : response.status === 401 ? 'UNAUTHORIZED' : 'BAD_REQUEST', { message })
    error.statusCode = response.status
    throw error
  }
  return payload as T
}
