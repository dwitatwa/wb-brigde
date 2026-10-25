/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the WorkBuddy wire quirks (forced streaming, string
 * `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process or a DNS-rebinding page can reach 127.0.0.1), so every
 * request must carry a loopback Host header, browser-sent Origins must be
 * loopback, chat POSTs must be application/json, and the Authorization
 * header must carry the shim's per-process shared secret. The plugin's
 * own client satisfies all four by construction; local attackers cannot
 * read the secret out of the plugin process's memory.
 *
 * The inbound surface (bind, secret, gates, route skeleton, body reading)
 * is shared with the custom OpenAI-compatible provider endpoint, which
 * registers itself through {@link createLoopbackEndpoint}; the WorkBuddy
 * wire behavior below is unchanged.
 *
 * @module dsh-workbuddy-connect/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddyCatalog } from './catalog.ts'
import { listenOnPreferredPort } from './listen.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { extractDisplayErrorMessage, prepareChatBody, upstreamErrorCode, WorkBuddyUpstreamClient, type UpstreamErrorKind } from './upstream.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /**
   * Preferred loopback port, so a restart can keep the address clients are
   * already configured with. A taken port falls back to an ephemeral one.
   */
  port?: number
  /**
   * Preferred bearer secret, so a restart can keep the token clients already
   * hold. Absent means a fresh random secret for this process.
   */
  token?: string
}

/**
 * The neutral loopback endpoint the WorkBuddy shim and the custom
 * OpenAI-compatible provider endpoint are both built on. It owns the
 * listener, the per-process secret, the inbound gates, the shared route
 * skeleton, and body reading; the flavor supplies only what routes exist.
 */
export interface LoopbackEndpoint {
  ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

/** Dependencies of {@link createLoopbackEndpoint}. */
export interface LoopbackEndpointOptions {
  /** GET /healthz and the model list route are always available. */
  listModels(): { id: string, ownedBy: string }[]
  /**
   * Handle a chat-completions POST. The gates have already passed; the
   * handler owns reading the body and writing the response.
   */
  handleChat(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** A GET route beyond /healthz and the model list, or undefined. */
  extraGetRoute?(url: string, res: ServerResponse): boolean
  /**
   * Serve the additional bare `/models` alias (WorkBuddy's surface keeps the
   * original `/v1/models`-only shape; only flavors that opt in get it).
   */
  serveModelsAlias?: boolean
  /**
   * Preferred loopback port. Absent or `0` means "let the OS choose".
   *
   * A preference, not a requirement: a caller that wants a stable address
   * across restarts passes the port it last bound, and a taken port falls
   * back to an ephemeral one rather than failing to start. This keeps the
   * default behaviour unchanged — no caller that omits this field can be
   * affected by another process holding a particular port.
   */
  port?: number
  /**
   * Preferred bearer secret. Absent means a fresh per-process random secret.
   *
   * Supplying one is what makes the published token stable across restarts;
   * an empty string is treated as absent, so a damaged saved value can never
   * turn into an empty bearer that any request would satisfy.
   */
  token?: string
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/**
 * Read a request body with a size cap; over-limit bodies fail the request.
 * By default the socket is destroyed on an over-limit body (WorkBuddy
 * behavior); callers that must still answer the client pass
 * `{ destroyOnLimit: false }`, which pauses the request instead so the
 * failure response can be written.
 */
function readBody(req: IncomingMessage, options: { destroyOnLimit?: boolean } = {}): Promise<Buffer> {
  const destroyOnLimit = options.destroyOnLimit ?? true
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        if (destroyOnLimit) req.destroy()
        else req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export { isJsonContentType, readBody, REQUEST_BODY_LIMIT, writeJson, writeOpenAIError }

/**
 * Start the neutral loopback endpoint: loopback bind, per-process bearer,
 * Host/Origin gates, health/model routes, and dispatch to the flavor's chat
 * handler. Used directly by {@link createWorkBuddyShim} and by the custom
 * provider endpoint in the standalone layer.
 */
export function createLoopbackEndpoint(options: LoopbackEndpointOptions): LoopbackEndpoint {
  // Shared secret. Random per process unless the caller supplied one, which
  // is how a standalone runner keeps the published token stable across
  // restarts. A local attacker who can hit the port still cannot forge it
  // without reading wherever the caller stored it.
  const preferredToken = options.token?.trim() ?? ''
  const SHARED_SECRET = preferredToken === '' ? randomBytes(32).toString('base64url') : preferredToken

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  // A preferred port is a convenience: a restart keeps the address clients
  // already hold. When it is unavailable the OS picks one instead, and the
  // caller republishes whatever actually bound.
  const ready: Promise<void> = listenOnPreferredPort(server, options.port, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host, and
      // browser-sent origins must be loopback too. The plugin's own client
      // always satisfies both; DNS-rebinding pages and cross-origin POSTs
      // do not.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/' || (options.serveModelsAlias === true && (url === '/models' || url === '/models/')))) {
        writeJson(res, 200, {
          object: 'list',
          data: options.listModels().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: model.ownedBy,
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await options.handleChat(req, res)
        return
      }
      if (req.method === 'GET' && options.extraGetRoute?.(url, res)) return
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}

/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { store, client, catalog } = options
  const logger = options.logger

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      const detail = extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400)
      // The upstream's numeric code rides along because its display text alone
      // is ambiguous: `11128` is "conversation id missing" on the international
      // chat but "Illegal API invocation from an unapproved channel" for a
      // rejected `developer` role, and unrelated codes share the same
      // 「请求被拦截」 wording. Without the number a report cannot be diagnosed.
      const code = upstreamErrorCode(result.message)
      const codeNote = code === undefined ? '' : ` [code ${code}]`
      // The host adapter classifies any error text containing a bare
      // `401`/`403` word as AUTH, which would mask business errors (safety
      // review, illegal request) behind an "invalid API key" banner. Only
      // session failures keep the status note — every 401 classifies as
      // session_dead, so genuine auth errors stay recognisable. Known
      // residue: an extracted display text that itself names 403 still trips
      // the host heuristic; the real text wins over hiding the number.
      const statusNote = (result.status === 401 || result.status === 403) && result.kind !== 'session_dead'
        ? ''
        : ` (http ${result.status})`
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `workbuddy upstream ${result.kind}${statusNote}: ${detail}${codeNote}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-workbuddy-connect: upstream stream failed mid-flight', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  const endpoint = createLoopbackEndpoint({
    listModels: () => catalog.current().map(model => ({ id: model.id, ownedBy: 'workbuddy' })),
    handleChat: chatCompletions,
    ...options.port === undefined ? {} : { port: options.port },
    ...options.token === undefined ? {} : { token: options.token },
  })

  return endpoint
}
