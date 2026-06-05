# SaaS Backend

The SaaS stack is implemented in `apps/api` with Fastify, TypeScript, Prisma, PostgreSQL, and S3-compatible object storage.

## Services

`docker compose up -d` starts:

- `api`: Fastify backend. The image builds the Vite frontend and serves it from the same origin as `/api`.
- `postgres`: Prisma database.
- `minio`: local S3-compatible storage.

## Endpoints

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
GET  /api/auth/oauth-options
GET  /api/auth/github/start
GET  /api/auth/github/callback
GET  /api/auth/better/*

GET  /api/tenants/current
GET  /api/tenants/current/members

GET    /api/provider-profiles

POST /api/storage/images
POST /api/storage/images/deduplicate
POST /api/storage/images/:imageId/upload
POST /api/storage/upload-url
POST /api/storage/images/:imageId/complete
GET  /api/storage/images/:imageId/read-url
GET  /api/storage/images/:imageId/read-url?variant=thumbnail

POST /api/tasks
GET  /api/tasks
GET  /api/tasks/events
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/images/complete
POST /api/tasks/:taskId/images/:imageId/server-copy

POST /api/agent/responses

GET   /api/admin/overview
GET   /api/admin/users
PATCH /api/admin/users/:userId
POST  /api/admin/users/:userId/revoke-sessions
GET   /api/admin/logs
GET   /api/admin/channels
POST  /api/admin/channels
PATCH /api/admin/channels/:profileId
DELETE /api/admin/channels/:profileId
GET   /api/admin/storage
```

The frontend enables this mode when `VITE_API_BASE_URL` is set. In Docker Compose, the API image builds the frontend with `VITE_API_BASE_URL=/api`, so the browser talks to the backend through the same origin. The legacy Nginx runtime injection image is not used by the SaaS Compose stack.

## GitHub OAuth

GitHub OAuth login is optional. Configure these environment variables on the `api` service:

```text
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:8080/api/auth/better/callback/github
```

`GITHUB_CALLBACK_URL` must match the callback URL registered in the GitHub OAuth app. In Docker Compose, use the external web origin and port, for example `http://localhost:28080/api/auth/better/callback/github` when running with `WEB_PORT=28080`.

When enabled, `/api/auth/oauth-options` exposes only the enabled state to the frontend. OAuth secrets remain server-side. `/api/auth/github/start` is kept as the frontend-compatible start route, while Better Auth owns the OAuth state, callback, account linking, and session creation under `/api/auth/better/*`. The legacy `/api/auth/github/callback` route proxies to the Better Auth callback for deployments that still have the old callback path configured.

## Admin

The first registered user is marked as a platform administrator. Additional platform administrators can be bootstrapped with the comma-separated `ADMIN_EMAILS` environment variable.

In SaaS mode, platform administrators see the `后台` entry in the app header. The admin console covers:

- Overview stats for users, tenants, tasks, images, storage, channels, and active sessions.
- User listing, disable/enable actions, platform admin assignment, and forced session revocation.
- Usage logs for auth, provider profile, image, task, and admin actions, including IP, user agent, and structured detail.
- Global channel creation, editing, enable/disable, and deletion for provider profiles.
- Storage summary grouped by tenant, image purpose, and image status.

Provider profiles are platform-global (`tenantId = null`) and shared by all tenants. Users can list enabled channels and choose one by ID, but API keys, base URLs, models, modes, and provider config are managed only in the admin console. Disabled users cannot log in and existing sessions are revoked. Disabled channels cannot be used for task creation or agent proxy requests.

## Security And Performance Controls

- Authentication is handled by Better Auth with email/password and optional GitHub OAuth. Session cookies are HTTP-only, signed, same-site cookies backed by the database `Session` table rather than JWT. Disabled users have all sessions revoked.
- Auth, upload, task creation, and Agent proxy endpoints have in-process rate limits. Set `RATE_LIMIT_ENABLED=false` only behind an external limiter.
- GitHub OAuth uses Better Auth state verification and callback handling. OAuth login still checks disabled users before creating a session.
- Image generation tasks are executed asynchronously by the API service. `POST /api/tasks` creates a `RUNNING` task and returns immediately; the in-process worker calls the Provider, archives generated originals and WebP thumbnails to S3-compatible storage, and updates the task to `DONE` or `ERROR`.
- The task worker is controlled by `TASK_WORKER_CONCURRENCY`, `TASK_WORKER_LEASE_SECONDS`, and `TASK_WORKER_RECOVER_INTERVAL_SECONDS`. The lease lets a restarted API instance pick up stale `RUNNING` tasks without relying on the browser connection.
- The frontend subscribes to `GET /api/tasks/events` for SSE task updates and also periodically reconciles `GET /api/tasks`, so refreshes, tab closes, network drops, and SSE reconnects still recover server-side task state.
- Provider API keys never leave the backend response surface. User-facing provider profile responses include only metadata such as `hasApiKey`; channel create/update/delete routes are platform-admin only.
- Provider base URLs and provider-returned server-copy URLs are checked for SSRF risk. By default, localhost, private network, link-local, and metadata-style destinations are blocked. Set `ALLOW_PRIVATE_PROVIDER_URLS=true` only for trusted single-tenant/private deployments that need local model endpoints.
- API-side image preprocessing limits upload bytes with `IMAGE_MAX_UPLOAD_BYTES` and decoded image pixels with `IMAGE_MAX_PIXELS`.
- User uploads are deduplicated by tenant, purpose, and client-side `sourceSha256`. The browser hashes the file before upload and calls `/api/storage/images/deduplicate`; on a hit it reuses the existing `imageId` and skips upload, S3 writes, and thumbnail generation. The multipart upload endpoint recomputes the same source hash as a fallback for older clients.
- Compatibility signed-upload completion re-reads the S3 object and runs backend preprocessing before marking an image ready. Task creation only accepts `READY` input and mask images.
- API responses include basic hardening headers such as `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and a restrictive `Permissions-Policy`.

## Image Flow

Input images are uploaded by the browser to the API as multipart form data. Before upload, the frontend computes a SHA-256 hash of the user-provided bytes and asks the API whether the tenant already has a ready image with the same `sourceSha256` and purpose. Duplicate uploads reuse the existing `imageId`. New uploads are validated and preprocessed by the API, written as original image objects to S3-compatible storage, cached as WebP thumbnails, and stored as tenant-scoped metadata.

The original image object is stored at:

```text
tenants/{tenantId}/images/{imageId}/original
```

During API-side upload preprocessing, the API generates and caches a WebP preview at:

```text
tenants/{tenantId}/images/{imageId}/thumbnail.webp
```

`variant=thumbnail` returns a signed URL for the cached WebP preview and generates it on demand if it is missing. Omitting `variant` returns a signed URL for the original image.

The frontend uses the thumbnail variant for gallery previews. Original image signed URLs are fetched only for full-size reads and downloads. For generation requests, the frontend sends only image IDs; the API resolves those IDs to tenant-scoped original image objects, reads the original bytes, and assembles the provider request server-side.

Agent mode follows the same rule in SaaS mode. The frontend sends `image_id` placeholders for user references, generated references, batch references, and masks. `/api/agent/responses` resolves those placeholders to original image bytes before sending the Responses API request to the configured Provider profile.

Generated images are requested server-side through the configured provider profile. The API worker archives provider-returned base64/image bytes or provider URLs directly into S3-compatible storage, runs preprocessing, and writes cached WebP thumbnails. The browser no longer needs to stay open for task completion. The older `/complete` and `/server-copy` endpoints remain available for compatibility, but the SaaS frontend relies on the asynchronous worker and SSE updates. Provider calls use original image content, not thumbnail URLs.

`POST /api/storage/upload-url` remains available as a compatibility endpoint, but the SaaS frontend uses API-side multipart upload by default.
