/**
 * Loopback endpoint for a custom OpenAI-compatible provider configured by
 * the user (see `provider-config.ts`). It shares the neutral loopback
 * surface from `core/shim.ts` — bind, per-process bearer, Host/Origin
 * gates, `/healthz`, `/v1/models` — and forwards chat turns to the
 * provider's `baseUrl + /chat/completions` as-is:
 *
 * - the request body is forwarded **unchanged** (no WorkBuddy preparation,
 *   no forced streaming), and
 * - only its own `Content-Type`, `Accept`, and `Authorization: Bearer` are
 *   sent upstream — never the downstream bearer or any WorkBuddy header.
 *
 * The upstream API key is resolved from the provider's `apiKeyEnv`
 * environment variable **per request**, so signing in or rotating the key
 * needs no bridge restart. A provider without `apiKeyEnv` is forwarded
 * without an `Authorization` header at all, and a provider whose key is
 * currently missing serves an empty model list and refuses chat turns.
 *
 * Error policy (downstream diagnostics): upstream error responses keep
 * their HTTP status, and their payload is reduced to a bounded structured
 * OpenAI-style subset — `{error: {message, type, code, param}}` — when the
 * upstream sent a JSON object shaped like one, or a fixed safe message
 * otherwise. Arbitrary upstream text, the resolved API key, and echoed
 * request material are never passed through, and nothing from the wire is
 * ever written to logs.
 *
 * @module workbuddy-bridge/openai-provider
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  createLoopbackEndpoint,
  isJsonContentType,
  readBody,
  writeJson,
  writeOpenAIError,
  type LoopbackEndpoint,
  type ShimLogger,
} from '../core/shim.ts'
import type { ProviderConfigEntry } from './provider-config.ts' // kept for re-export/legacy docs

/** How long the upstream may take to send response headers. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000

/** Upper bound on upstream error body bytes read for diagnostics. */
export const UPSTREAM_ERROR_BODY_LIMIT = 16 * 1024

/** Fixed marker logged instead of an unconfigured (unvalidated) model id. */
export const UNCONFIGURED_MODEL_MARKER = '<unconfigured>'

/** Diagnostic hooks the bridge task can wire into its request log. */
export interface OpenAIProviderLogger extends ShimLogger {
  /** A chat turn reached a verdict: outcome, status, and timing metadata only. */
  request?: (entry: { outcome: 'ok' | 'error', status: number, model: string, durationMs: number }) => void
}

/**
 * One request-scoped provider configuration: everything a chat turn needs,
 * captured together before the body is read, so a concurrent edit can never
 * give a single turn a half-old configuration — old URL with a new key, old
 * models with a new URL, anything of the sort. The key lives here in memory
 * only; it never reaches a log, a descriptor, or an error message.
 */
interface GenericSnapshot {
  id: string
  baseUrl: string
  models: string[]
  /**
   * Where this request's upstream credential comes from. `env` names an
   * environment variable resolved when the snapshot is captured; `stored` is
   * a key captured with the snapshot (managed providers); `none` sends no
   * credential at all.
   */
  auth:
    | { kind: 'env'; envName: string; key?: string; missing?: boolean }
    | { kind: 'stored'; key: string }
    | { kind: 'none' }
}

/** Constructor dependencies. */
export interface OpenAICompatibleShimOptions {
  /**
   * The provider configuration, read per request. Either a fixed value (the
   * legacy file-config case) or a `getSnapshot` accessor — the bridge's
   * managed runtimes pass one so an edit swaps the configuration for new
   * requests while a request that already started keeps the snapshot it
   * resolved. In-flight snapshot stability is the caller's job; the shim
   * reads this once per request and uses that snapshot throughout.
   */
  provider?: Omit<GenericSnapshot, 'auth'> & {
    apiKeyEnv?: string
    apiKey?: string
  }
  getSnapshot?: () => Omit<GenericSnapshot, 'auth'> & {
    apiKeyEnv?: string
    apiKey?: string
  }
  /**
   * Resolve an environment variable name to its current value. Defaults to
   * `process.env`; injectable so tests (and the host) do not touch the real
   * environment.
   */
  resolveApiKeyEnv?: (name: string) => string | undefined
  logger?: OpenAIProviderLogger
  /**
   * How long the upstream may take to send response headers. Defaults to
   * {@link UPSTREAM_HEADERS_TIMEOUT_MS}; injectable so tests can compress
   * the deadline and prove bodies outlive it. Does not bound the body.
   */
  headersTimeoutMs?: number
}

export type OpenAICompatibleShim = LoopbackEndpoint

/**
 * Read an upstream response body incrementally, up to `limit` bytes, then
 * stop consuming and cancel the rest. Returns the bounded prefix as text.
 */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      size += value.byteLength
      chunks.push(value)
      if (size >= limit) break
    }
  } catch {
    // A failing diagnostic read must never mask the status code.
  } finally {
    // Stop the upstream from producing more bytes we will not use.
    await reader.cancel().catch(() => {})
  }
  const merged = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
  // Trim to the limit on a character boundary-ish basis; the payload only
  // feeds a bounded diagnostic, so a split code point at the cut is harmless.
  return merged.subarray(0, limit).toString('utf8')
}

/**
 * Reduce an upstream error body to a bounded, secret-safe diagnostic:
 * a structured OpenAI-style subset when the body parses as a JSON object
 * with an `error` object, a fixed message otherwise. Every retained string
 * field (`message`, `type`, `code`, `param`) passes the same sanitizer: the
 * resolved API key is redacted and the value is length-capped. Non-string
 * scalars on those fields are dropped (the subset is string-typed), and
 * arbitrary echoed material is dropped for unstructured bodies rather than
 * sanitized hopefully.
 */
const ERROR_FIELD_CAP = 800

function sanitizeErrorField(value: string, resolvedKey: string | undefined): string {
  let out = value
  if (resolvedKey !== undefined && resolvedKey !== '') {
    out = out.split(resolvedKey).join('[redacted]')
  }
  return out.length > ERROR_FIELD_CAP ? out.slice(0, ERROR_FIELD_CAP) : out
}

function buildUpstreamError(
  boundedText: string,
  status: number,
  resolvedKey: string | undefined,
): UpstreamErrorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(boundedText)
  } catch {
    parsed = undefined
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const error = (parsed as { error?: unknown })['error']
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const shaped = error as Record<string, unknown>
      // One sanitizer for every retained field: none of them is trusted.
      const message = typeof shaped['message'] === 'string' ? sanitizeErrorField(shaped['message'], resolvedKey) : undefined
      const type = typeof shaped['type'] === 'string' ? sanitizeErrorField(shaped['type'], resolvedKey) : undefined
      const code = typeof shaped['code'] === 'string' ? sanitizeErrorField(shaped['code'], resolvedKey) : undefined
      const param = typeof shaped['param'] === 'string' ? sanitizeErrorField(shaped['param'], resolvedKey) : undefined
      if (message !== undefined || type !== undefined || code !== undefined || param !== undefined) {
        return {
          message: message ?? `upstream returned http ${status}`,
          type: type ?? 'upstream_error',
          ...code === undefined ? {} : { code },
          ...param === undefined ? {} : { param },
        }
      }
    }
  }
  // Unstructured or non-JSON body: do not forward arbitrary text at all.
  return { message: `upstream returned http ${status}`, type: 'upstream_error' }
}

/** The sanitized OpenAI-style error body the bridge answers with. */
export interface UpstreamErrorPayload {
  message: string
  type: string
  code?: string
  param?: string
}

/**
 * One upstream turn, after the response headers arrived: the bytes are still
 * unread, so the caller decides how to forward them.
 */
export interface UpstreamTurnResponse {
  kind: 'response'
  status: number
  contentType: string
  body: ReadableStream<Uint8Array> | null
}

/** One upstream turn that produced no usable response. */
export interface UpstreamTurnFailure {
  kind: 'failure'
  /**
   * `cancelled` — the downstream client went away; nothing should be written.
   * `timeout` — no response headers in time. `unreachable` — the connection
   * failed. `redirect` — a 3xx we refuse to follow. `upstream` — the upstream
   * answered with a non-2xx status.
   */
  reason: 'cancelled' | 'timeout' | 'unreachable' | 'redirect' | 'upstream'
  /** The status the bridge answers the downstream client with. */
  status: number
  error: UpstreamErrorPayload
  /**
   * Whether a *different* provider could plausibly answer the same request.
   *
   * Per-provider properties are retryable: a rate limit, a dead or unpaid
   * key, a 5xx from that gateway, a wrong path, or an unreachable host. The
   * request itself is not: a malformed body or an unsupported parameter would
   * be refused identically everywhere, so retrying only multiplies the wait.
   */
  retryable: boolean
  /** The upstream's own status, when it answered at all. */
  upstreamStatus?: number
}

export type UpstreamTurnResult = UpstreamTurnResponse | UpstreamTurnFailure

/**
 * Whether an upstream HTTP status is a property of *that* provider rather
 * than of the request, and so is worth retrying elsewhere.
 */
export function upstreamStatusRetryable(status: number): boolean {
  return status === 401
    || status === 402
    || status === 403
    || status === 404
    || status === 429
    || status >= 500
}

/**
 * Send one chat turn to one provider and stop at the response headers.
 *
 * This is the whole hardened transport in one place, shared by the
 * single-provider shim and the multi-provider pool: manual redirect refusal
 * (the key must never be replayed to an unvetted `Location`), a
 * headers-only deadline that never cuts a long body, downstream cancellation
 * linked through the returned stream, and a bounded, secret-redacted
 * diagnostic for a failed turn.
 *
 * `signal` is the downstream cancellation; the header deadline is internal
 * and per attempt, so a pool retrying a timed-out provider does not abort the
 * whole request.
 */
export async function startUpstreamTurn(
  request: { baseUrl: string, apiKey?: string },
  rawBody: string,
  options: { signal?: AbortSignal, headersTimeoutMs?: number } = {},
): Promise<UpstreamTurnResult> {
  const headersTimeoutMs = options.headersTimeoutMs ?? UPSTREAM_HEADERS_TIMEOUT_MS
  const downstream = options.signal
  const controller = new AbortController()
  const onAbort = (): void => { controller.abort() }
  if (downstream?.aborted === true) {
    return {
      kind: 'failure',
      reason: 'cancelled',
      status: 499,
      error: { message: 'the client cancelled the request', type: 'cancelled' },
      retryable: false,
    }
  }
  downstream?.addEventListener('abort', onAbort, { once: true })
  let headersTimedOut = false
  const timer = setTimeout(() => {
    headersTimedOut = true
    controller.abort()
  }, headersTimeoutMs)
  // The downstream listener stays attached for the life of the request: after
  // the headers arrive the body is still streaming, and a client that hangs up
  // mid-stream must still abort the upstream read. `once` bounds it to a
  // single firing, and the controller dies with the request.
  const releaseTimer = (): void => { clearTimeout(timer) }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(request.apiKey === undefined ? {} : { 'Authorization': `Bearer ${request.apiKey}` }),
  }

  let upstream: Response
  try {
    upstream = await fetch(`${request.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal,
      // Never follow a redirect: the Authorization header (the resolved
      // key) must not be replayed to a Location we did not vet.
      redirect: 'manual',
    } satisfies RequestInit)
  } catch {
    releaseTimer()
    if (headersTimedOut) {
      return {
        kind: 'failure',
        reason: 'timeout',
        status: 504,
        error: { message: 'the upstream did not send response headers in time', type: 'upstream_timeout', code: 'upstream_timeout' },
        retryable: true,
      }
    }
    if (controller.signal.aborted && !headersTimedOut) {
      return {
        kind: 'failure',
        reason: 'cancelled',
        status: 499,
        error: { message: 'the client cancelled the request', type: 'cancelled', code: 'cancelled' },
        retryable: false,
      }
    }
    return {
      kind: 'failure',
      reason: 'unreachable',
      status: 502,
      error: { message: 'could not reach the upstream endpoint', type: 'upstream_unreachable', code: 'upstream_unreachable' },
      retryable: true,
    }
  }
  // Headers arrived; the body has no lifetime cap. Downstream cancellation
  // remains connected through the controller until the body completes.
  releaseTimer()

  if (upstream.status >= 300 && upstream.status < 400) {
    // Do not read the redirect body; release the connection.
    await upstream.body?.cancel().catch(() => {})
    return {
      kind: 'failure',
      reason: 'redirect',
      status: 502,
      error: { message: 'the upstream tried to redirect; refusing to follow it', type: 'upstream_redirect', code: 'upstream_redirect' },
      retryable: true,
      upstreamStatus: upstream.status,
    }
  }

  if (!upstream.ok) {
    // Preserve the upstream status. The diagnostic payload is bounded and
    // secret-safe per the module-level error policy; the resolved key is
    // redacted and unstructured bodies collapse to a fixed message.
    const bounded = await readBoundedBody(upstream, UPSTREAM_ERROR_BODY_LIMIT)
    return {
      kind: 'failure',
      reason: 'upstream',
      status: upstream.status,
      error: buildUpstreamError(bounded, upstream.status, request.apiKey),
      retryable: upstreamStatusRetryable(upstream.status),
      upstreamStatus: upstream.status,
    }
  }

  return {
    kind: 'response',
    status: upstream.status,
    contentType: upstream.headers.get('content-type') ?? '',
    body: upstream.body,
  }
}

/**
 * Forward one upstream response to the downstream client.
 *
 * Resolves once the response is committed to the wire — for a stream that is
 * after the headers are written, not after the last byte, so the caller can
 * record the turn without waiting for the body.
 */
export async function writeUpstreamTurn(
  res: ServerResponse,
  turn: UpstreamTurnResponse,
  onStreamError?: (error: unknown) => void,
): Promise<void> {
  if (turn.contentType.includes('text/event-stream')) {
    res.writeHead(turn.status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const body = Readable.fromWeb(turn.body as Parameters<typeof Readable.fromWeb>[0])
    // On an upstream failure mid-stream the stream simply ends: no synthetic
    // [DONE], so the client sees a truncated turn and its own retry/failure
    // handling applies.
    body.on('error', (error: unknown) => {
      onStreamError?.(error)
      if (res.writable) res.end()
    })
    body.pipe(res)
    return
  }

  if (turn.status === 204 || turn.status === 304) {
    res.writeHead(turn.status)
    res.end()
    return
  }

  // JSON (or anything else non-streaming): pass the bytes, content type, and
  // the actual upstream status through.
  const buffer = turn.body === null
    ? Buffer.alloc(0)
    : Buffer.from(await new Response(turn.body).arrayBuffer())
  res.writeHead(turn.status, { 'Content-Type': turn.contentType || 'application/json' })
  res.end(buffer)
}

/**
 * Start the custom-provider loopback endpoint. The bearer it requires is
 * the per-process shared secret from the neutral endpoint — the same
 * publication model as the WorkBuddy shim.
 */
export function createOpenAICompatibleShim(options: OpenAICompatibleShimOptions): OpenAICompatibleShim {
  if (options.provider === undefined && options.getSnapshot === undefined) {
    throw new Error('openai-provider shim needs provider or getSnapshot')
  }
  const resolveEnv = options.resolveApiKeyEnv ?? ((name: string) => process.env[name])
  const logger = options.logger
  const headersTimeoutMs = options.headersTimeoutMs ?? UPSTREAM_HEADERS_TIMEOUT_MS

  /** The raw config this request uses; resolved once per request. */
  function raw(): { id: string, baseUrl: string, models: string[], apiKeyEnv?: string, apiKey?: string } {
    return options.getSnapshot !== undefined ? options.getSnapshot() : options.provider!
  }

  /**
   * Freeze one request's configuration, credential included, before the body
   * is read. A stored key is copied by value into the snapshot; an env name
   * is resolved here, at capture time, not later at upstream time.
   */
  function current(): GenericSnapshot {
    const config = raw()
    let auth: GenericSnapshot['auth']
    if (config.apiKey !== undefined && config.apiKey !== '') {
      auth = { kind: 'stored', key: config.apiKey }
    } else if (config.apiKeyEnv !== undefined) {
      const value = resolveEnv(config.apiKeyEnv)
      auth = value === undefined || value === ''
        ? { kind: 'env', envName: config.apiKeyEnv, missing: true }
        : { kind: 'env', envName: config.apiKeyEnv, key: value }
    } else {
      auth = { kind: 'none' }
    }
    return {
      id: config.id,
      baseUrl: config.baseUrl,
      models: config.models,
      auth,
    }
  }

  /** Whether the frozen snapshot is credential-ready, and its key. */
  function credentialOf(snapshot: GenericSnapshot): { present: boolean, key: string | undefined, missingName?: string } {
    if (snapshot.auth.kind === 'stored') return { present: true, key: snapshot.auth.key }
    if (snapshot.auth.kind === 'none') return { present: true, key: undefined }
    if ('missing' in snapshot.auth && snapshot.auth.missing) {
      return { present: false, key: undefined, missingName: snapshot.auth.envName }
    }
    return { present: true, key: (snapshot.auth as { kind: 'env'; key?: string }).key }
  }

  /** Whether the provider can serve at all right now (the model list's view). */
  function isAvailable(config: { apiKeyEnv?: string, apiKey?: string }): boolean {
    if (config.apiKey !== undefined && config.apiKey !== '') return true
    if (config.apiKeyEnv === undefined) return true
    const value = resolveEnv(config.apiKeyEnv)
    return value !== undefined && value !== ''
  }

  function resolveModelList(): { id: string, ownedBy: string }[] {
    const config = raw()
    if (!isAvailable(config)) return []
    return config.models.map(id => ({ id, ownedBy: config.id }))
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    const finish = (outcome: 'ok' | 'error', status: number, model: string): void => {
      logger?.request?.({ outcome, status, model, durationMs: Date.now() - startedAt })
    }
    // One immutable snapshot for this whole request — configuration AND
    // credential captured together before anything else runs.
    const provider = current()
    const credential = credentialOf(provider)

    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      finish('error', 415, '')
      return
    }

    let raw: string
    try {
      raw = (await readBody(req, { destroyOnLimit: false })).toString('utf8')
    } catch (error: unknown) {
      writeOpenAIError(res, 413, 'request_too_large', String(error))
      finish('error', 413, '')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      writeOpenAIError(res, 400, 'invalid_request', 'request body must be valid JSON')
      finish('error', 400, '')
      return
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      writeOpenAIError(res, 400, 'invalid_request', 'request body must be a JSON object')
      finish('error', 400, '')
      return
    }
    const requestedModel = (body as { model?: unknown }).model
    const model = typeof requestedModel === 'string' ? requestedModel : ''
    if (model === '' || !provider.models.includes(model)) {
      // The raw model string is client input and may carry anything; only a
      // fixed marker reaches the log hook.
      writeOpenAIError(res, 400, 'model_not_configured', 'model is not offered by this provider')
      finish('error', 400, UNCONFIGURED_MODEL_MARKER)
      return
    }

    const apiKey = credential.key
    if (!credential.present) {
      // Name the env var only — never the value.
      writeOpenAIError(
        res,
        503,
        'api_key_missing',
        `the API key environment variable ${credential.missingName} is not set; set it and retry`,
      )
      finish('error', 503, model)
      return
    }

    // Late client cancellation must reach the upstream stream too. Once the
    // request body has been consumed, the request message's own 'close' has
    // effectively already happened, so the reliable downstream-gone signal is
    // the response's 'close' with nothing written to the end: a socket that
    // dies mid-stream (or before the first byte) closes the response without
    // having ended it. A normal completion ends the response first, so it is
    // not treated as a cancel.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    const turn = await startUpstreamTurn(
      { baseUrl: provider.baseUrl, ...(apiKey === undefined ? {} : { apiKey }) },
      raw,
      { signal: controller.signal, headersTimeoutMs },
    )
    if (turn.kind === 'failure') {
      // `cancelled` writes nothing: the client that would read it is gone.
      if (turn.reason !== 'cancelled') writeJson(res, turn.status, { error: turn.error })
      finish('error', turn.status, model)
      return
    }
    await writeUpstreamTurn(res, turn, error => {
      logger?.warn('openai-provider: upstream stream failed mid-flight', error)
    })
    finish('ok', turn.status, model)
  }

  return createLoopbackEndpoint({
    listModels: () => resolveModelList(),
    handleChat,
    serveModelsAlias: true,
  })
}

export { UPSTREAM_HEADERS_TIMEOUT_MS }
