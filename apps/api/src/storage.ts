import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ImageAsset, ImagePurpose } from '@prisma/client'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { config } from './config.js'
import { assertSafeOutboundUrl } from './security.js'

const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 82
const PUBLIC_READ_URL_TTL_SECONDS = 365 * 24 * 60 * 60

function createS3Client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  })
}

const internalClient = createS3Client(config.s3.endpoint)
const publicClient = createS3Client(config.s3.publicEndpoint)

type NormalizedImageFormat = 'jpeg' | 'png' | 'webp'

export interface ProcessedImageUpload {
  contentType: string
  byteSize: number
  sha256: string
  width?: number
  height?: number
  thumbnailByteSize: number
}

export function objectKeyForImage(tenantId: string, imageId: string, purpose: ImagePurpose): string {
  const name = purpose === 'THUMBNAIL' ? 'thumbnail.webp' : 'original'
  return `tenants/${tenantId}/images/${imageId}/${name}`
}

export function thumbnailObjectKeyForImage(image: Pick<ImageAsset, 'id' | 'tenantId'>): string {
  return objectKeyForImage(image.tenantId, image.id, 'THUMBNAIL' as ImagePurpose)
}

export async function ensureBucket(): Promise<void> {
  try {
    await internalClient.send(new HeadBucketCommand({ Bucket: config.s3.bucket }))
  } catch {
    await internalClient.send(new CreateBucketCommand({ Bucket: config.s3.bucket }))
  }

  try {
    await internalClient.send(new PutBucketCorsCommand({
      Bucket: config.s3.bucket,
      CORSConfiguration: {
        CORSRules: [{
          AllowedHeaders: ['*'],
          AllowedMethods: ['GET', 'PUT', 'HEAD'],
          AllowedOrigins: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600,
        }],
      },
    }))
  } catch {
    // Some S3-compatible providers restrict CORS mutations; existing bucket settings remain usable.
  }
}

export async function createUploadUrl(image: Pick<ImageAsset, 'bucket' | 'objectKey' | 'contentType'>): Promise<{ uploadUrl: string; expiresAt: string }> {
  const uploadUrl = await getSignedUrl(
    publicClient,
    new PutObjectCommand({
      Bucket: image.bucket,
      Key: image.objectKey,
      ContentType: image.contentType,
    }),
    { expiresIn: config.s3.uploadUrlTtlSeconds },
  )
  return {
    uploadUrl,
    expiresAt: new Date(Date.now() + config.s3.uploadUrlTtlSeconds * 1000).toISOString(),
  }
}

function encodeObjectKey(objectKey: string): string {
  return objectKey
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function shouldUsePublicReadUrl(object: Pick<ImageAsset, 'bucket'> & { objectKey: string }): boolean {
  if (!config.s3.publicImageBaseUrl || object.bucket !== config.s3.bucket) return false
  if (object.objectKey.endsWith('/thumbnail.webp')) return config.s3.publicThumbnailReads
  if (object.objectKey.endsWith('/original')) return config.s3.publicOriginalReads
  return false
}

function createPublicReadUrl(objectKey: string): { readUrl: string; expiresAt: string } {
  const base = config.s3.publicImageBaseUrl.replace(/\/+$/, '')
  return {
    readUrl: `${base}/${encodeObjectKey(objectKey)}`,
    expiresAt: new Date(Date.now() + PUBLIC_READ_URL_TTL_SECONDS * 1000).toISOString(),
  }
}

export async function createReadUrlForObject(object: Pick<ImageAsset, 'bucket'> & { objectKey: string }): Promise<{ readUrl: string; expiresAt: string }> {
  if (shouldUsePublicReadUrl(object)) return createPublicReadUrl(object.objectKey)

  const readUrl = await getSignedUrl(
    publicClient,
    new GetObjectCommand({
      Bucket: object.bucket,
      Key: object.objectKey,
    }),
    { expiresIn: config.s3.readUrlTtlSeconds },
  )
  return {
    readUrl,
    expiresAt: new Date(Date.now() + config.s3.readUrlTtlSeconds * 1000).toISOString(),
  }
}

export function createReadUrl(image: Pick<ImageAsset, 'bucket' | 'objectKey'>): Promise<{ readUrl: string; expiresAt: string }> {
  return createReadUrlForObject(image)
}

export async function uploadBuffer(image: Pick<ImageAsset, 'bucket' | 'objectKey'>, body: Uint8Array, contentType: string): Promise<void> {
  await internalClient.send(new PutObjectCommand({
    Bucket: image.bucket,
    Key: image.objectKey,
    Body: body,
    ContentType: contentType,
  }))
}

function contentTypeForFormat(format: NormalizedImageFormat): string {
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

function extensionFormat(value: string | undefined): NormalizedImageFormat | null {
  if (value === 'jpeg' || value === 'jpg') return 'jpeg'
  if (value === 'webp') return 'webp'
  if (value === 'png') return 'png'
  return null
}

function chooseNormalizedFormat(contentType: string, metadataFormat: string | undefined, purpose: ImagePurpose): NormalizedImageFormat {
  if (purpose === 'MASK') return 'png'
  return extensionFormat(metadataFormat) ?? extensionFormat(contentType.split('/')[1]?.toLowerCase()) ?? 'png'
}

function normalizeImagePipeline(input: Buffer, format: NormalizedImageFormat) {
  const pipeline = sharp(input, { failOn: 'none', limitInputPixels: config.image.maxPixels }).rotate()
  if (format === 'jpeg') return pipeline.jpeg({ quality: 95, mozjpeg: true })
  if (format === 'webp') return pipeline.webp({ quality: 95 })
  return pipeline.png()
}

export async function processAndUploadImage(
  image: Pick<ImageAsset, 'id' | 'tenantId' | 'bucket' | 'objectKey'>,
  inputBytes: Uint8Array,
  declaredContentType: string,
  purpose: ImagePurpose,
): Promise<ProcessedImageUpload> {
  const input = Buffer.from(inputBytes)
  const metadata = await sharp(input, { failOn: 'none', limitInputPixels: config.image.maxPixels }).metadata()
  const format = chooseNormalizedFormat(declaredContentType, metadata.format, purpose)
  const normalized = await normalizeImagePipeline(input, format).toBuffer({ resolveWithObject: true })
  const original = new Uint8Array(normalized.data)
  const contentType = contentTypeForFormat(format)
  await uploadBuffer(image, original, contentType)

  const thumbnail = await sharp(original, { failOn: 'none', limitInputPixels: config.image.maxPixels })
    .resize({
      width: THUMBNAIL_MAX_SIZE,
      height: THUMBNAIL_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer()
  await uploadBuffer({
    bucket: image.bucket,
    objectKey: thumbnailObjectKeyForImage(image),
  }, thumbnail, 'image/webp')

  return {
    contentType,
    byteSize: original.byteLength,
    sha256: createHash('sha256').update(original).digest('hex'),
    width: normalized.info.width,
    height: normalized.info.height,
    thumbnailByteSize: thumbnail.byteLength,
  }
}

async function objectExists(bucket: string, objectKey: string): Promise<{ byteSize?: number } | null> {
  try {
    const result = await internalClient.send(new HeadObjectCommand({
      Bucket: bucket,
      Key: objectKey,
    }))
    return {
      byteSize: typeof result.ContentLength === 'number' ? result.ContentLength : undefined,
    }
  } catch {
    return null
  }
}

export async function readObjectBytes(bucket: string, objectKey: string): Promise<Uint8Array> {
  const result = await internalClient.send(new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
  }))
  if (!result.Body) throw new Error('S3 对象为空')
  return result.Body.transformToByteArray()
}

export async function ensureThumbnailForImage(image: Pick<ImageAsset, 'id' | 'tenantId' | 'bucket' | 'objectKey'>): Promise<{
  bucket: string
  objectKey: string
  contentType: 'image/webp'
  byteSize?: number
}> {
  const objectKey = thumbnailObjectKeyForImage(image)
  const existing = await objectExists(image.bucket, objectKey)
  if (existing) {
    return {
      bucket: image.bucket,
      objectKey,
      contentType: 'image/webp',
      byteSize: existing.byteSize,
    }
  }

  const original = await readObjectBytes(image.bucket, image.objectKey)
  const thumbnail = await sharp(original, { failOn: 'none', limitInputPixels: config.image.maxPixels })
    .rotate()
    .resize({
      width: THUMBNAIL_MAX_SIZE,
      height: THUMBNAIL_MAX_SIZE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer()
  await uploadBuffer({ bucket: image.bucket, objectKey }, thumbnail, 'image/webp')
  return {
    bucket: image.bucket,
    objectKey,
    contentType: 'image/webp',
    byteSize: thumbnail.byteLength,
  }
}

export async function copyRemoteImageToStorage(
  image: Pick<ImageAsset, 'id' | 'tenantId' | 'bucket' | 'objectKey' | 'contentType' | 'purpose'>,
  remoteUrl: string,
): Promise<{ contentType: string; byteSize: number; sha256: string; width?: number; height?: number }> {
  await assertSafeOutboundUrl(remoteUrl, '图片 URL')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(remoteUrl, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
    }

    const headerContentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const contentType = headerContentType?.startsWith('image/')
      ? headerContentType
      : image.contentType || 'image/png'
    const body = await readResponseBytes(response, config.image.maxUploadBytes)
    return processAndUploadImage(image, body, contentType, image.purpose)
  } finally {
    clearTimeout(timeout)
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`图片不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`)
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer())

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`图片不能超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`)
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
