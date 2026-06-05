function readEnv(name: string, fallback = ''): string {
  const value = process.env[name]
  return value == null || value.trim() === '' ? fallback : value.trim()
}

function readNumber(name: string, fallback: number): number {
  const raw = readEnv(name)
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function readBoolean(name: string, fallback = false): boolean {
  const value = readEnv(name)
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export const config = {
  host: readEnv('HOST', '0.0.0.0'),
  port: readNumber('PORT', 3001),
  staticDir: readEnv('STATIC_DIR', '/app/public'),
  webOrigins: readEnv('WEB_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  betterAuthUrl: readEnv('BETTER_AUTH_URL', readEnv('WEB_ORIGIN', 'http://localhost:5173').split(',')[0]?.trim() || 'http://localhost:5173'),
  cookieSecure: readBoolean('COOKIE_SECURE', false),
  sessionCookieName: readEnv('SESSION_COOKIE_NAME', 'gip_session'),
  sessionTtlSeconds: readNumber('SESSION_TTL_SECONDS', 60 * 60 * 24 * 30),
  sessionSecret: readEnv('SESSION_SECRET', 'dev-session-secret-change-me'),
  providerKeyEncryptionSecret: readEnv('PROVIDER_KEY_ENCRYPTION_SECRET', readEnv('SESSION_SECRET', 'dev-provider-secret-change-me')),
  adminEmails: readEnv('ADMIN_EMAILS')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  auth: {
    get emailPasswordRegistrationEnabled() {
      return readBoolean('EMAIL_PASSWORD_REGISTRATION_ENABLED', true)
    },
  },
  security: {
    allowPrivateProviderUrls: readBoolean('ALLOW_PRIVATE_PROVIDER_URLS', false),
    rateLimitEnabled: readBoolean('RATE_LIMIT_ENABLED', true),
  },
  image: {
    maxUploadBytes: readNumber('IMAGE_MAX_UPLOAD_BYTES', 64 * 1024 * 1024),
    maxPixels: readNumber('IMAGE_MAX_PIXELS', 67_108_864),
  },
  taskWorker: {
    concurrency: readNumber('TASK_WORKER_CONCURRENCY', 2),
    leaseSeconds: readNumber('TASK_WORKER_LEASE_SECONDS', 30 * 60),
    recoverIntervalSeconds: readNumber('TASK_WORKER_RECOVER_INTERVAL_SECONDS', 60),
  },
  githubOAuth: {
    clientId: readEnv('GITHUB_CLIENT_ID'),
    clientSecret: readEnv('GITHUB_CLIENT_SECRET'),
    callbackUrl: readEnv('GITHUB_CALLBACK_URL'),
  },
  googleOAuth: {
    clientId: readEnv('GOOGLE_CLIENT_ID'),
    clientSecret: readEnv('GOOGLE_CLIENT_SECRET'),
    callbackUrl: readEnv('GOOGLE_CALLBACK_URL'),
  },
  s3: {
    endpoint: readEnv('S3_ENDPOINT', 'http://localhost:9000'),
    publicEndpoint: readEnv('S3_PUBLIC_ENDPOINT', readEnv('S3_ENDPOINT', 'http://localhost:9000')),
    region: readEnv('S3_REGION', 'us-east-1'),
    bucket: readEnv('S3_BUCKET', 'gpt-image-assets'),
    accessKeyId: readEnv('S3_ACCESS_KEY_ID', 'minioadmin'),
    secretAccessKey: readEnv('S3_SECRET_ACCESS_KEY', 'minioadmin'),
    forcePathStyle: readBoolean('S3_FORCE_PATH_STYLE', true),
    uploadUrlTtlSeconds: readNumber('S3_UPLOAD_URL_TTL_SECONDS', 15 * 60),
    readUrlTtlSeconds: readNumber('S3_READ_URL_TTL_SECONDS', 10 * 60),
    publicImageBaseUrl: readEnv('PUBLIC_IMAGE_BASE_URL'),
    publicThumbnailReads: readBoolean('PUBLIC_THUMBNAIL_READS', false),
    publicOriginalReads: readBoolean('PUBLIC_ORIGINAL_READS', false),
  },
  defaultProvider: {
    name: readEnv('DEFAULT_PROVIDER_NAME', 'OpenAI'),
    provider: readEnv('DEFAULT_PROVIDER', 'openai'),
    baseUrl: readEnv('DEFAULT_PROVIDER_BASE_URL', 'https://api.openai.com/v1'),
    model: readEnv('DEFAULT_PROVIDER_MODEL', 'gpt-image-2'),
    apiMode: readEnv('DEFAULT_PROVIDER_API_MODE', 'images'),
    apiKey: readEnv('DEFAULT_PROVIDER_API_KEY', readEnv('OPENAI_API_KEY')),
  },
}

export type AppConfig = typeof config
