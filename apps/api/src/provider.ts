import type { ImageAsset, ProviderProfile } from '@prisma/client'
import { decryptSecret } from './crypto.js'
import { assertSafeOutboundUrl } from './security.js'

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export interface ProviderCallInput {
  profile: ProviderProfile
  prompt: string
  params: TaskParams
  inputImages: ProviderImageInput[]
  maskImage?: ProviderImageInput | null
}

export type ProviderImageInput = ImageAsset & {
  readUrl?: string
  bytes: Uint8Array
  dataUrl: string
}

export interface ProviderImageResult {
  providerImageUrl?: string
  dataUrl?: string
  contentType: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}

export interface ProviderCallResult {
  images: ProviderImageResult[]
  rawImageUrls?: string[]
  rawResponsePayload?: string
  actualParams?: Partial<TaskParams>
}

const MIME_MAP: Record<TaskParams['output_format'], string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

function getOutputContentType(params: TaskParams): string {
  return MIME_MAP[params.output_format] || 'image/png'
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '') || 'https://api.openai.com/v1'
  return `${base}/${path.replace(/^\/+/, '')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function asConfig(profile: ProviderProfile): Record<string, unknown> {
  return isRecord(profile.config) ? profile.config : {}
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function isHttpUrl(value: unknown): value is `http://${string}` | `https://${string}` {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!isRecord(source)) return {}
  const actualParams: Partial<TaskParams> = {}
  if (typeof source.size === 'string') actualParams.size = source.size
  if (source.quality === 'auto' || source.quality === 'low' || source.quality === 'medium' || source.quality === 'high') {
    actualParams.quality = source.quality
  }
  if (source.output_format === 'png' || source.output_format === 'jpeg' || source.output_format === 'webp') {
    actualParams.output_format = source.output_format
  }
  if (typeof source.output_compression === 'number') actualParams.output_compression = source.output_compression
  if (source.moderation === 'auto' || source.moderation === 'low') actualParams.moderation = source.moderation
  if (typeof source.n === 'number') actualParams.n = source.n
  return actualParams
}

function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

function requestedImageCount(params: TaskParams): number {
  const n = Number.isFinite(params.n) ? Math.trunc(params.n) : 1
  return Math.max(1, Math.min(10, n))
}

function singleImageInput(input: ProviderCallInput): ProviderCallInput {
  return {
    ...input,
    params: {
      ...input.params,
      n: 1,
    },
  }
}

interface ProviderRequestFailure {
  requestIndex: number
  message: string
  rawResponsePayload?: string
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Provider request failed'
}

function getErrorRawResponsePayload(error: unknown): string | undefined {
  if (error instanceof Error && 'rawResponsePayload' in error) {
    const rawResponsePayload = (error as Error & { rawResponsePayload?: unknown }).rawResponsePayload
    return typeof rawResponsePayload === 'string' && rawResponsePayload ? rawResponsePayload : undefined
  }
  return undefined
}

function serializeProviderRequestFailure(error: unknown, requestIndex: number): ProviderRequestFailure {
  return {
    requestIndex,
    message: getErrorMessage(error),
    rawResponsePayload: getErrorRawResponsePayload(error),
  }
}

function combineRawResponsePayloads(payloads: string[], failures: ProviderRequestFailure[]): string | undefined {
  if (!payloads.length && !failures.length) return undefined
  return JSON.stringify({
    payloads,
    failedRequests: failures,
  })
}

function mergeProviderResults(
  results: ProviderCallResult[],
  requestedCount: number,
  failures: ProviderRequestFailure[] = [],
): ProviderCallResult {
  const images = results.flatMap((result) => result.images).slice(0, requestedCount)
  const rawImageUrls = results.flatMap((result) => result.rawImageUrls ?? [])
  const rawResponsePayloads = results
    .map((result) => result.rawResponsePayload)
    .filter((payload): payload is string => Boolean(payload))

  return {
    images,
    rawImageUrls: rawImageUrls.length ? rawImageUrls.slice(0, requestedCount) : undefined,
    rawResponsePayload: combineRawResponsePayloads(rawResponsePayloads, failures),
    actualParams: mergeActualParams(...results.map((result) => result.actualParams), { n: images.length }),
  }
}

async function callConcurrentSingleImageRequests(
  input: ProviderCallInput,
  requestCount: number,
  callSingle: (input: ProviderCallInput) => Promise<ProviderCallResult>,
): Promise<ProviderCallResult> {
  const requests = Array.from({ length: requestCount }, () => callSingle(singleImageInput(input)))
  const settled = await Promise.allSettled(requests)
  const failures = settled.flatMap((result, index) => result.status === 'rejected'
    ? [serializeProviderRequestFailure(result.reason, index)]
    : [])
  const fulfilled = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])

  if (!fulfilled.length && failures.length) {
    const firstRejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    const error = firstRejected?.reason instanceof Error ? firstRejected.reason : new Error(failures[0]!.message)
    ;(error as Error & { rawResponsePayload?: string }).rawResponsePayload = combineRawResponsePayloads([], failures)
    throw error
  }

  return mergeProviderResults(
    fulfilled,
    requestCount,
    failures,
  )
}

async function getApiErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown
    if (isRecord(payload)) {
      const error = payload.error
      if (isRecord(error) && typeof error.message === 'string') return error.message
      if (typeof error === 'string') return error
      if (typeof payload.message === 'string') return payload.message
      if (typeof payload.detail === 'string') return payload.detail
    }
  } catch {
    try {
      return await response.text()
    } catch {
      // fall through
    }
  }
  return `HTTP ${response.status}`
}

function getStringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecord(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) {
    return getStringValue(event, 'message') ?? '流式请求失败'
  }
  return null
}

function parseServerSentEventBlock(block: string): string | null {
  const dataLines: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    dataLines.push(line.slice(5).replace(/^ /, ''))
  }

  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return null
  return data
}

async function readJsonServerSentEvents(response: Response, onEvent: (event: Record<string, unknown>) => void | Promise<void>): Promise<void> {
  if (!response.body) throw new Error('Provider 未返回可读取的流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const processBlock = async (block: string) => {
    const data = parseServerSentEventBlock(block)
    if (!data) return

    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error('Provider 流式响应包含无法解析的 JSON 事件')
    }
    if (!isRecord(event)) return

    const errorMessage = getStreamEventErrorMessage(event)
    if (errorMessage) throw new Error(errorMessage)

    await onEvent(event)
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let separatorIndex = buffer.search(/\r?\n\r?\n/)
    while (separatorIndex >= 0) {
      const block = buffer.slice(0, separatorIndex)
      const separator = buffer.match(/\r?\n\r?\n/)?.[0] ?? '\n\n'
      buffer = buffer.slice(separatorIndex + separator.length)
      await processBlock(block)
      separatorIndex = buffer.search(/\r?\n\r?\n/)
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) await processBlock(buffer)
}

function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false
}

async function fetchProviderResponse<T>(
  url: string,
  init: RequestInit,
  timeoutSeconds: number,
  readResponse: (response: Response) => Promise<T>,
): Promise<T> {
  await assertSafeOutboundUrl(url, 'Provider API URL')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    return await readResponse(response)
  } finally {
    clearTimeout(timeout)
  }
}

function fetchJson(url: string, init: RequestInit, timeoutSeconds: number): Promise<unknown> {
  return fetchProviderResponse(url, init, timeoutSeconds, (response) => response.json())
}

function getTimeoutSeconds(profile: ProviderProfile): number {
  const timeout = asConfig(profile).timeout
  return typeof timeout === 'number' && Number.isFinite(timeout) ? Math.max(1, timeout) : 600
}

function imageExtension(contentType: string): string {
  if (contentType === 'image/jpeg') return 'jpg'
  return contentType.split('/')[1]?.replace(/[^a-z0-9]+/gi, '') || 'png'
}

function imageBlob(image: ProviderImageInput): Blob {
  const bytes = new Uint8Array(image.bytes.byteLength)
  bytes.set(image.bytes)
  return new Blob([bytes.buffer], { type: image.contentType || 'image/png' })
}

function getApiKey(profile: ProviderProfile): string {
  const apiKey = decryptSecret(profile.apiKeyEncrypted)
  if (!apiKey) throw new Error(`服务端 Provider 配置「${profile.name}」缺少 API Key`)
  return apiKey
}

function createAuthHeaders(profile: ProviderProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey(profile)}`,
  }
}

function createOpenAIImageBody(input: ProviderCallInput, forceN = input.params.n): Record<string, unknown> {
  const { profile, params, prompt } = input
  const profileConfig = asConfig(profile)
  const body: Record<string, unknown> = {
    model: profile.model,
    prompt,
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (!profileConfig.codexCli) body.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) {
    body.output_compression = params.output_compression
  }
  if (forceN > 1) body.n = forceN
  if (profileConfig.responseFormatB64Json) body.response_format = 'b64_json'
  return body
}

function parseImagesPayload(payload: unknown, params: TaskParams): ProviderCallResult {
  const contentType = getOutputContentType(params)
  const record = isRecord(payload) ? payload : {}
  const data = Array.isArray(record.data) ? record.data : []
  if (data.length === 0) {
    return {
      images: [],
      rawResponsePayload: JSON.stringify(payload, null, 2),
    }
  }

  const images: ProviderImageResult[] = []
  const rawImageUrls: string[] = []
  for (const item of data) {
    if (!isRecord(item)) continue
    const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
    const actualParams = mergeActualParams(pickActualParams(record), pickActualParams(item))
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
      images.push({
        dataUrl: normalizeBase64Image(item.b64_json, contentType),
        contentType,
        actualParams,
        revisedPrompt,
      })
      continue
    }
    if (isHttpUrl(item.url)) {
      rawImageUrls.push(item.url)
      images.push({
        providerImageUrl: item.url,
        contentType,
        actualParams,
        revisedPrompt,
      })
    }
  }
  return {
    images,
    rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined,
    actualParams: mergeActualParams(pickActualParams(record), images[0]?.actualParams, { n: images.length }),
    rawResponsePayload: images.length ? undefined : JSON.stringify(payload, null, 2),
  }
}

async function callOpenAIImagesSingle(input: ProviderCallInput): Promise<ProviderCallResult> {
  const { profile, inputImages, maskImage } = input
  const isEdit = inputImages.length > 0
  const headers = createAuthHeaders(profile)
  const timeoutSeconds = getTimeoutSeconds(profile)

  if (isEdit) {
    const formData = new FormData()
    for (const [key, value] of Object.entries(createOpenAIImageBody(input))) {
      if (value !== undefined && value !== null) formData.append(key, String(value))
    }
    for (let index = 0; index < inputImages.length; index++) {
      const image = inputImages[index]!
      formData.append('image[]', imageBlob(image), `input-${index + 1}.${imageExtension(image.contentType)}`)
    }
    if (maskImage) {
      formData.append('mask', imageBlob(maskImage), `mask.${imageExtension(maskImage.contentType)}`)
    }
    const payload = await fetchJson(joinUrl(profile.baseUrl, 'images/edits'), {
      method: 'POST',
      headers,
      body: formData,
    }, timeoutSeconds)
    return parseImagesPayload(payload, input.params)
  }

  const payload = await fetchJson(joinUrl(profile.baseUrl, 'images/generations'), {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createOpenAIImageBody(input)),
  }, timeoutSeconds)
  return parseImagesPayload(payload, input.params)
}

async function callOpenAIImages(input: ProviderCallInput): Promise<ProviderCallResult> {
  const n = requestedImageCount(input.params)
  if (n <= 1) return callOpenAIImagesSingle(input)
  return callConcurrentSingleImageRequests(input, n, callOpenAIImagesSingle)
}

function getResponsesImageResultBase64(result: unknown): string | undefined {
  if (typeof result === 'string' && result.trim()) return result
  if (!isRecord(result)) return undefined
  for (const key of ['b64_json', 'base64', 'image', 'data']) {
    const value = result[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function createResponsesInput(prompt: string, inputImages: ProviderImageInput[]): unknown {
  const text = `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImages.length) return text
  return [{
    role: 'user',
    content: [
      { type: 'input_text', text },
      ...inputImages.map((image) => ({
        type: 'input_image',
        image_url: image.dataUrl,
      })),
    ],
  }]
}

function parseResponsesPayload(payload: unknown, params: TaskParams): ProviderCallResult {
  const contentType = getOutputContentType(params)
  const output = isRecord(payload) && Array.isArray(payload.output) ? payload.output : []
  const images: ProviderImageResult[] = []
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'image_generation_call') continue
    const b64 = getResponsesImageResultBase64(item.result)
    const actualParams = mergeActualParams(pickActualParams(item))
    const revisedPrompt = typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined
    if (b64) {
      images.push({
        dataUrl: normalizeBase64Image(b64, contentType),
        contentType,
        actualParams,
        revisedPrompt,
      })
      continue
    }
    const result = item.result
    if (isRecord(result) && isHttpUrl(result.url)) {
      images.push({
        providerImageUrl: result.url,
        contentType,
        actualParams,
        revisedPrompt,
      })
    }
  }
  return {
    images,
    actualParams: mergeActualParams(images[0]?.actualParams, { n: images.length }),
    rawResponsePayload: images.length ? undefined : JSON.stringify(payload, null, 2),
  }
}

function getResponsesStreamPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  const response = event.response
  if (isRecord(response)) return response

  const item = event.item
  if (isRecord(item) && item.type === 'image_generation_call') {
    return { output: [item] }
  }

  return null
}

async function parseResponsesStreamResponse(response: Response, params: TaskParams): Promise<ProviderCallResult> {
  let completedPayload: Record<string, unknown> | null = null
  const outputItems: unknown[] = []

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    const payload = getResponsesStreamPayload(event)
    if (!payload) return

    if (type === 'response.output_item.done' && Array.isArray(payload.output)) {
      outputItems.push(...payload.output)
      return
    }

    completedPayload = payload
  })

  const payload = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) {
    return {
      images: [],
      rawResponsePayload: '流式接口未返回最终图片数据',
    }
  }

  const result = parseResponsesPayload(payload, params)
  if (!result.images.length && outputItems.length) {
    const fallback = parseResponsesPayload({ output: outputItems }, params)
    if (fallback.images.length) return fallback
  }
  return result
}

async function callOpenAIResponsesSingle(input: ProviderCallInput): Promise<ProviderCallResult> {
  const { profile, params } = input
  const profileConfig = asConfig(profile)
  const imageTool: Record<string, unknown> = {
    type: 'image_generation',
    action: input.inputImages.length > 0 ? 'edit' : 'generate',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (!profileConfig.codexCli) imageTool.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) {
    imageTool.output_compression = params.output_compression
  }
  if (input.maskImage) {
    imageTool.input_image_mask = { image_url: input.maskImage.dataUrl }
  }

  const result = await fetchProviderResponse(joinUrl(profile.baseUrl, 'responses'), {
    method: 'POST',
    headers: {
      ...createAuthHeaders(profile),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: profile.model,
      input: createResponsesInput(input.prompt, input.inputImages),
      tools: [imageTool],
      tool_choice: 'required',
      stream: true,
    }),
  }, getTimeoutSeconds(profile), async (response) => {
    if (isEventStreamResponse(response)) return parseResponsesStreamResponse(response, params)
    return parseResponsesPayload(await response.json(), params)
  })
  return result
}

async function callOpenAIResponses(input: ProviderCallInput): Promise<ProviderCallResult> {
  const n = requestedImageCount(input.params)
  if (n <= 1) return callOpenAIResponsesSingle(input)
  return callConcurrentSingleImageRequests(input, n, callOpenAIResponsesSingle)
}

function mapFalEndpoint(model: string, isEdit: boolean): string {
  const normalized = model.trim().replace(/^\/+/, '').replace(/\/+$/, '') || 'openai/gpt-image-2'
  return isEdit && !normalized.endsWith('/edit') ? `${normalized}/edit` : normalized
}

function mapFalImageSize(size: string): unknown {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (!match) return 'auto'
  return { width: Number(match[1]), height: Number(match[2]) }
}

function mapFalQuality(quality: TaskParams['quality']): 'low' | 'medium' | 'high' {
  return quality === 'auto' ? 'high' : quality
}

function parseFalPayload(payload: unknown, params: TaskParams): ProviderCallResult {
  const contentType = getOutputContentType(params)
  const candidates: unknown[] = []
  if (isRecord(payload)) {
    if (Array.isArray(payload.images)) candidates.push(...payload.images)
    if (payload.image) candidates.push(payload.image)
    if (payload.url) candidates.push(payload.url)
  }
  const images: ProviderImageResult[] = []
  const rawImageUrls: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      if (isHttpUrl(candidate)) {
        rawImageUrls.push(candidate)
        images.push({ providerImageUrl: candidate, contentType })
      } else if (candidate.trim()) {
        images.push({ dataUrl: normalizeBase64Image(candidate, contentType), contentType })
      }
      continue
    }
    if (!isRecord(candidate)) continue
    const actualParams = typeof candidate.width === 'number' && typeof candidate.height === 'number'
      ? { size: `${Math.round(candidate.width)}x${Math.round(candidate.height)}` }
      : undefined
    if (isHttpUrl(candidate.url)) {
      rawImageUrls.push(candidate.url)
      images.push({ providerImageUrl: candidate.url, contentType, actualParams })
    } else if (typeof candidate.b64_json === 'string') {
      images.push({ dataUrl: normalizeBase64Image(candidate.b64_json, contentType), contentType, actualParams })
    } else if (typeof candidate.base64 === 'string') {
      images.push({ dataUrl: normalizeBase64Image(candidate.base64, contentType), contentType, actualParams })
    }
  }
  return {
    images,
    rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined,
    actualParams: mergeActualParams(images[0]?.actualParams, { n: images.length }),
    rawResponsePayload: images.length ? undefined : JSON.stringify(payload, null, 2),
  }
}

async function callFal(input: ProviderCallInput): Promise<ProviderCallResult> {
  const endpoint = mapFalEndpoint(input.profile.model, input.inputImages.length > 0)
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    image_size: input.inputImages.length > 0 && input.params.size === 'auto' ? 'auto' : mapFalImageSize(input.params.size),
    quality: mapFalQuality(input.params.quality),
    num_images: Math.min(4, Math.max(1, input.params.n || 1)),
    output_format: input.params.output_format,
  }
  if (input.inputImages.length) body.image_urls = input.inputImages.map((image) => image.readUrl ?? image.dataUrl)
  if (input.maskImage) body.mask_url = input.maskImage.readUrl ?? input.maskImage.dataUrl

  const payload = await fetchJson(joinUrl(input.profile.baseUrl || 'https://fal.run', endpoint), {
    method: 'POST',
    headers: {
      ...createAuthHeaders(input.profile),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, getTimeoutSeconds(input.profile))
  return parseFalPayload(payload, input.params)
}

export async function callProvider(input: ProviderCallInput): Promise<ProviderCallResult> {
  const provider = input.profile.provider.toLowerCase()
  const result = provider === 'fal' ? await callFal(input) : input.profile.apiMode === 'responses'
    ? await callOpenAIResponses(input)
    : await callOpenAIImages(input)

  if (!result.images.length) {
    const message = result.rawResponsePayload
      ? 'Provider 未返回可识别的图片数据'
      : 'Provider 未返回图片数据'
    const error = new Error(message)
    ;(error as Error & { rawResponsePayload?: string }).rawResponsePayload = result.rawResponsePayload
    throw error
  }
  return result
}
