/**
 * The bridge's local web UI: a single self-contained page showing each
 * endpoint's sign-in state, credit balance, and model list — plus, for a
 * failover pool, one row per member with a button that proves whether that
 * account can actually answer a turn.
 *
 * It follows the same trust model as the upstream plugin's status route
 * (`src/dsh/web-status.ts`), which is the important part:
 *
 * - it binds loopback only, and
 * - every request must name a loopback `Host` and, if a browser sent one, a
 *   loopback `Origin`. The `Host` check is what defeats DNS rebinding, because
 *   a rebinding page carries the attacker's domain in `Host`.
 *
 * Unlike the shim it does **not** require a bearer token. It cannot: a browser
 * navigating to a URL cannot attach an `Authorization` header. The loopback
 * pair above is therefore the whole boundary, which is exactly why the token
 * is never placed in this document — a page that cannot be authenticated must
 * not be able to read the secret that authenticates the other one.
 *
 * Probing is the one action this page can take, and it is the one that spends
 * money, so it is gated separately: the page carries a per-process nonce that
 * a `POST /api/pool/test` must repeat in a header. A cross-origin page cannot
 * read the nonce (this server sends no CORS headers), and a custom header
 * forces a preflight it will not pass, so "any local page can burn credits by
 * posting to the UI port" is not a thing that can happen. The nonce is not a
 * secret worth protecting — it authenticates nothing upstream — but it does
 * bind the action to a document this server handed out.
 *
 * @module workbuddy-bridge/standalone/ui
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { listenOnPreferredPort } from '../core/listen.ts'
import { hostIsLoopback, originIsLoopback } from '../core/loopback.ts'
import type { ShimLogger } from '../core/shim.ts'
import { AccountStoreError, type AccountManagement } from './account-store.ts'
import { ProviderManagementError, type ProviderManagement } from './provider-store.ts'
import type { WorkBuddyRequestRecord } from './request-log.ts'

/** One credit package, as the UI shows it. */
export interface UiCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  endTimeMs?: number
}

/** One aggregate credit answer. Mirrors `WorkBuddyCredits` without the token path. */
export interface UiCredits {
  total: number
  accounts: readonly UiCreditAccount[]
  unlimited?: true
  cycleResetTime?: string
}

/** One model row, flattened for display. */
export interface UiModel {
  id: string
  name: string
  /** Normalized rate, e.g. `x0.79`; absent when the upstream declared none. */
  credits?: string
  free?: true
  /** Upstream promo labels, verbatim. */
  badges?: readonly string[]
  /** The upstream's price cannot be vouched for; show "needs refresh". */
  rateUnknown?: true
  contextWindow?: number
  defaultContextWindow?: number
  maxContextWindow?: number
  maxTokens?: number
  supportsImages: boolean
  reasoning?: {
    supports: boolean
    efforts?: readonly string[]
    canDisableThinking?: boolean
  }
}

/** One member of a failover pool, as the UI shows it. */
export interface UiPoolMember {
  /** Position in the pool's member list, 0-based — what a test request names. */
  index: number
  /** 1-based position among the product's accounts. */
  accountIndex: number
  /** The account's nickname, or a positional label while none is known. */
  label: string
  /** The account uid (email or user id), when known. */
  uid?: string
  signedIn: boolean
  /**
   * The account's own endpoint, so a row can be matched to its card. Absent
   * since per-account endpoints were removed — a member has no endpoint of
   * its own to name; the pool card is the only address an agent uses.
   */
  baseUrl?: string
  /** Whether this member will answer the next request. */
  head: boolean
  /** Turns this member served successfully since the bridge started. */
  successes: number
  /** Attempts on this member that failed. */
  failures: number
  /** Failures since this member last succeeded. */
  consecutiveFailures: number
  lastAttemptAtMs?: number
  /** The last attempt's class, for a status pill. */
  lastOutcome?: 'ok' | 'credential-error' | 'upstream-error'
  /** One line describing the last attempt. */
  lastOutcomeDetail?: string
  credits?: UiCredits
  creditsError?: string
  /**
   * Whether the page can edit this member, and under which provider id. A
   * custom-pool member is a provider card of its own, so the pool row can
   * carry the same Edit/Remove controls that card does.
   */
  editId?: string
}

/**
 * A pool's membership, as one block on its card.
 *
 * Carried on the endpoint rather than as separate endpoint rows because a
 * pool member is not addressable the way an account is: its credits, its
 * failures and its test result only mean anything in relation to the pool
 * that routes to it.
 */
export interface UiPool {
  /** Which member answers next, 0-based. */
  headIndex: number
  members: readonly UiPoolMember[]
  /**
   * What a member is: an account of one product, or a custom provider.
   * Absent means accounts, so an older host document renders unchanged.
   */
  kind?: 'accounts' | 'providers'
}

/**
 * One recent turn, as a card shows it.
 *
 * The record's internal `id` and `endpoint` key are dropped: the card *is* the
 * endpoint, and the id exists to keep two identical-looking turns apart in the
 * log, not to be rendered.
 */
export type UiRequestRow = Omit<WorkBuddyRequestRecord, 'id' | 'endpoint'>

/** One served endpoint, as the UI shows it. */
export interface UiEndpoint {
  /** Absent means a WorkBuddy account or pool, for backward compatibility. */
  kind?: 'openai-compatible'
  provider: string
  displayName: string
  /** The OpenAI-compatible base URL an agent would use. */
  baseUrl: string
  /**
   * The WSL-facing base URL, when `--wsl` re-exposes this endpoint on the
   * WSL virtual switch. Absent when the bridge runs without `--wsl`.
   */
  wslBaseUrl?: string
  /** The bearer token for this endpoint — shown so the user can copy it. */
  token?: string
  /** The account uid (email or user id), when known. */
  uid?: string
  signedIn: boolean
  nickname?: string
  domain?: string
  /** Which stored copy the credential came from. */
  source?: string
  expiresAtMs?: number
  /** Where the served models came from: live fetch, saved cache, or fallback. */
  catalogSource?: string
  catalogFetchedAtMs?: number
  /** A diagnosable credential problem, when there is one. */
  error?: string
  credits?: UiCredits
  creditsError?: string
  models: readonly UiModel[]
  /** Present only on a failover pool: its members and who answers next. */
  pool?: UiPool
  /** The most recent turns this endpoint served, newest first. Metadata only. */
  requests: readonly UiRequestRow[]
}

/** The whole document `/api/state` returns. */
export interface UiState {
  version: 1
  startedAtMs: number
  nowMs: number
  endpoints: readonly UiEndpoint[]
  /**
   * A persistent banner the host sets in its state callback — set by the
   * standalone runner when a provider change was saved and became active but
   * its endpoint publication (descriptor write or WSL forwarder binding)
   * failed, cleared when publication later succeeds. A fixed, safe string the
   * runner owns; never error text, so no redaction question can arise.
   */
  providerWarning?: string
}

/** What the page asks the bridge to test: one pool member. */
export interface UiProbeRequest {
  /** The pool endpoint's provider id, e.g. `workbuddy-ai-pool`. */
  provider: string
  /** 0-based member index within that pool. */
  index: number
  /** Model to test with; the account's first model when absent. */
  model?: string
}

/** What one probe produced, attributed back to the member that was asked. */
export interface UiProbeResult {
  provider: string
  index: number
  /** The account's nickname, so a result can be read without the page. */
  label: string
  model: string
  ok: boolean
  /** HTTP status, or 0 when the turn never completed. */
  status: number
  latencyMs: number
  detail: string
}

/**
 * A request the caller got wrong, with the status to answer it with.
 *
 * Separate from an ordinary `Error` because "there is no pool at that
 * provider" and "the upstream refused this account" are different answers: the
 * first is a 404 the page should surface as a bug, the second is a 200 with
 * `ok: false` and is the whole point of the feature.
 */
export class UiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'UiRequestError'
  }
}

/**
 * The provider-management contract, owned by the store module and re-exported
 * here so the UI's surface is self-contained for embedders. The store's
 * `ProviderManagementError` is imported as a value: known manager rejections
 * are matched by `instanceof` against that one class, never structurally, so
 * a raw error that merely names itself alike cannot smuggle its message to
 * the page.
 */
export type {
  ManagedProvider,
  ManagedProviderSnapshot,
  ProviderManagement,
} from './provider-store.ts'
export { ProviderManagementError } from './provider-store.ts'

/**
 * The account-management contract, re-exported from the store module for the
 * same reason as the provider one: the UI's surface stays self-contained, and
 * `AccountStoreError` is matched by `instanceof` so a look-alike error can
 * never carry its message to a page with no authentication.
 */
export type { AccountManagement, StoredAccount } from './account-store.ts'
export { AccountStoreError } from './account-store.ts'

/**
 * A running UI server.
 */
export interface WorkBuddyUiServer {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The UI origin, e.g. `http://127.0.0.1:41000`; valid after ready. */
  url(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyUiOptions {
  /** Build the current state document. Called per request. */
  state: () => Promise<UiState>
  /**
   * Test one pool member with a real chat turn.
   *
   * Absent means the page renders without test buttons — a read-only UI, which
   * is what an embedder that cannot afford upstream calls should pass.
   */
  probe?: (request: UiProbeRequest) => Promise<UiProbeResult>
  /**
   * Provider management (add/edit/remove custom OpenAI-compatible providers).
   *
   * Absent means the page is read-only: no editor, no management routes — an
   * embedder that hands out a fixed configuration keeps its read-only UI.
   */
  providers?: ProviderManagement
  /**
   * WorkBuddy account management: the bridge-owned account folder, plus a
   * rescan that picks up an account signed in since the bridge started.
   *
   * Absent means the page shows no account controls at all — an embedder that
   * does not manage accounts keeps the read-only UI it had.
   */
  accounts?: AccountManagement
  /**
   * Exact extra origins the UI is served from, e.g. the WSL forwarder's URL
   * when the bridge was started with `--wsl`. Called per request so a
   * late-bound forwarder port is seen.
   *
   * Purely host-controlled: the request's own Host or Origin can never add
   * itself to this list. A browser Origin that matches an entry exactly is
   * trusted to *load* the page and poll state; management routes additionally
   * demand the nonce. A merely-loopback Origin (any local port) is trusted for
   * page/state as before, but never for management.
   */
  allowedUiOrigins?: () => string[]
  /**
   * Preferred loopback port, so the page keeps the address the operator has
   * bookmarked. A taken port falls back to an ephemeral one.
   */
  port?: number
  logger?: ShimLogger
}

/**
 * Strip anything token-shaped before it crosses to the browser.
 *
 * Ported from the upstream status route. Every error string that reaches the
 * page goes through this: an upstream failure can echo back request material,
 * and a page with no authentication must not become a way to read a credential
 * out of a diagnostic.
 */
export function redactForBrowser(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/**
 * Apply {@link redactForBrowser} to every string field that can carry an error.
 *
 * Done as one pass over the finished document rather than at each throw site,
 * so a future field cannot forget it: the choke point is the response, not the
 * producer.
 */
function redactState(state: UiState): UiState {
  return {
    ...state,
    endpoints: state.endpoints.map(endpoint => ({
      ...endpoint,
      ...endpoint.error === undefined ? {} : { error: redactForBrowser(endpoint.error) },
      ...endpoint.creditsError === undefined ? {} : { creditsError: redactForBrowser(endpoint.creditsError) },
      ...endpoint.pool === undefined ? {} : {
        pool: {
          ...endpoint.pool,
          members: endpoint.pool.members.map(member => ({
            ...member,
            ...member.creditsError === undefined ? {} : { creditsError: redactForBrowser(member.creditsError) },
            ...member.lastOutcomeDetail === undefined
              ? {}
              : { lastOutcomeDetail: redactForBrowser(member.lastOutcomeDetail) },
          })),
        },
      },
    })),
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  // no-store on every JSON answer, errors included: a cached 403 or a cached
  // provider list would outlive the state it described, and a shared cache is
  // not part of this threat model but a browser back/forward cache is.
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Host gate for every route: the Host header must name the loopback
 * interface. A DNS-rebinding page carries its own domain in Host, so this is
 * what defeats rebinding; the WSL forwarder rewrites Host to the loopback
 * target, so forwarded requests pass here too.
 */
function hostGate(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host)
}

/**
 * Origin gate for page/state: absent (non-browser) or loopback passes as
 * before; otherwise the Origin must exactly match one of the host-configured
 * UI origins (the WSL forwarder URL). No arbitrary loopback port and no
 * substring match — a sibling local server's port is not this UI.
 */
function pageOriginAllowed(req: IncomingMessage, allowedUiOrigins: (() => string[]) | undefined): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin.trim() === '') return true
  if (originIsLoopback(origin)) return true
  const allowed = allowedUiOrigins?.() ?? []
  return allowed.some(entry => entry.trim() === origin.trim())
}

/**
 * Origin gate for management routes: stricter than the page's. A browser
 * Origin is only trusted when it exactly matches a host-configured UI origin;
 * "merely loopback" is not enough, because any local page can send loopback
 * origins and the nonce alone must not become the whole boundary for a route
 * that stores credentials. An absent Origin (non-browser caller, or a page
 * whose client sent no Origin) still passes — the nonce carries that request.
 */
function managementOriginAllowed(req: IncomingMessage, allowedUiOrigins: (() => string[]) | undefined): boolean {
  const origin = req.headers.origin
  if (origin === undefined || origin.trim() === '') return true
  const allowed = allowedUiOrigins?.() ?? []
  return allowed.some(entry => entry.trim() === origin.trim()) || entryMatchesSelf(req, origin)
}

/** The served loopback origin itself is always a trusted management origin. */
function entryMatchesSelf(req: IncomingMessage, origin: string): boolean {
  const address = selfAddress(req)
  return address !== undefined && origin.trim() === `http://127.0.0.1:${address}`
}

function selfAddress(req: IncomingMessage): number | undefined {
  const host = req.headers.host
  if (host === undefined) return undefined
  const { hostname, port } = new URL(`http://${host.trim()}`)
  return hostname === '127.0.0.1' && port !== '' ? Number(port) : undefined
}

/** Largest probe body accepted; the page sends a provider name and an index. */
const PROBE_BODY_LIMIT = 8 * 1024

/** Largest management body accepted; a provider description with model list. */
const MANAGEMENT_BODY_LIMIT = 64 * 1024

/**
 * Largest account body accepted; one sign-in file, which is a few kilobytes.
 *
 * Larger than a probe body because the file is carried whole, but far below
 * the management limit: an auth document has no reason to approach this, and
 * an oversized one is refused rather than buffered.
 */
const ACCOUNT_BODY_LIMIT = 128 * 1024

/** Header the page repeats the nonce in. Custom, so it forces a preflight. */
const PROBE_HEADER = 'x-bridge-ui'

/** Read a request body with a size cap. */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new UiRequestError(413, 'request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Validate a probe body into a request, or answer with what is wrong. */
function parseProbeRequest(raw: string): UiProbeRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UiRequestError(400, 'body must be JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UiRequestError(400, 'body must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const provider = record['provider']
  const index = record['index']
  const model = record['model']
  if (typeof provider !== 'string' || provider === '') {
    throw new UiRequestError(400, 'provider must be a non-empty string')
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new UiRequestError(400, 'index must be a non-negative integer')
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new UiRequestError(400, 'model must be a string when present')
  }
  return { provider, index, ...model === undefined || model === '' ? {} : { model } }
}

/**
 * Validate a management save body at the transport boundary.
 *
 * Field-level rules (URL shape, model syntax, reserved ids) belong to the
 * manager — the store owns them and its errors carry precise messages. Here
 * only the shape the route forwards is checked, and only enough that a
 * non-object or a wrong-typed revision never reaches the manager. Unknown
 * keys are passed through: rejecting them here would duplicate the manager's
 * schema, and the manager already rejects what it does not know.
 */
function parseSaveBody(raw: string): Record<string, unknown> {
  const record = parseManagementBody(raw)
  const requireNonEmptyString = (key: string): string => {
    const value = record[key]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new UiRequestError(400, `${key} must be a non-empty string`)
    }
    return value
  }
  requireNonEmptyString('displayName')
  requireNonEmptyString('baseUrl')
  const models = record['models']
  if (!Array.isArray(models) || models.some(model => typeof model !== 'string' || model.trim() === '')) {
    throw new UiRequestError(400, 'models must be an array of non-empty strings')
  }
  if (record['authMode'] !== 'api-key' && record['authMode'] !== 'none') {
    throw new UiRequestError(400, 'authMode must be "api-key" or "none"')
  }
  const apiKey = record['apiKey']
  if (apiKey !== undefined && typeof apiKey !== 'string') {
    throw new UiRequestError(400, 'apiKey must be a string when present')
  }
  return record
}

/**
 * Validate a management body at the transport boundary: object with a
 * non-empty string revision. Field-level rules (URL shape, model syntax,
 * reserved ids) belong to the manager — the store owns them and its errors
 * carry precise messages.
 */
function parseManagementBody(raw: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UiRequestError(400, 'body must be JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UiRequestError(400, 'body must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record['revision'] !== 'string' || record['revision'] === '') {
    throw new UiRequestError(400, 'revision must be a non-empty string')
  }
  return record
}

function parseRemoveBody(raw: string): { revision: string, id: string } {
  const record = parseManagementBody(raw)
  const id = record['id']
  if (typeof id !== 'string' || id === '') {
    throw new UiRequestError(400, 'id must be a non-empty string')
  }
  return { revision: record['revision'] as string, id }
}

/**
 * The account routes, as one set so the gate and the error handling cannot
 * drift apart: every one of them is management, and every one of them needs
 * the nonce.
 */
const ACCOUNT_ROUTES: ReadonlySet<string> = new Set([
  '/api/accounts/rescan',
  '/api/accounts/import',
  '/api/accounts/remove',
])

/**
 * Validate an import body: the file's text plus an optional origin label.
 *
 * The text is the file's own bytes and is deliberately not parsed here — the
 * store classifies it, and a parse failure at this layer would duplicate rules
 * the store already owns. Only the envelope's shape is checked, so a missing
 * `text` never reaches the store as `undefined`.
 */
function parseAccountImportBody(raw: string): { text: string, origin?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UiRequestError(400, 'body must be JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UiRequestError(400, 'body must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const text = record['text']
  if (typeof text !== 'string' || text.trim() === '') {
    throw new UiRequestError(400, 'text must be the sign-in file\'s contents')
  }
  const origin = record['origin']
  if (origin !== undefined && typeof origin !== 'string') {
    throw new UiRequestError(400, 'origin must be a string when present')
  }
  return { text, ...origin === undefined || origin === '' ? {} : { origin: origin.slice(0, 200) } }
}

/** Validate a remove body: the account uid. */
function parseAccountRemoveBody(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UiRequestError(400, 'body must be JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UiRequestError(400, 'body must be a JSON object')
  }
  const uid = (parsed as Record<string, unknown>)['uid']
  if (typeof uid !== 'string' || uid === '') {
    throw new UiRequestError(400, 'uid must be a non-empty string')
  }
  return uid
}

/**
 * Start the UI server.
 *
 * Returns `ready` rather than awaiting the listen, so a caller can hold the
 * handle before the port is known — the same shape the shim exposes.
 */
export function createWorkBuddyUiServer(options: WorkBuddyUiOptions): WorkBuddyUiServer {
  const { state, probe, providers, accounts, allowedUiOrigins, logger } = options
  // Minted per process, not per page: the page is re-served on every load, and
  // a token that changed under a reload would make an open tab's test buttons
  // fail for no reason the user could see.
  const nonce = randomUUID()
  const page = PAGE
    .replace('"__UI_NONCE__"', JSON.stringify(nonce))
    .replace('"__MANAGE__"', JSON.stringify(providers !== undefined))
    .replace('"__MANAGE_ACCOUNTS__"', JSON.stringify(accounts !== undefined))
  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })
  // A remembered port keeps the operator's bookmark working; a taken one
  // falls back rather than refusing to serve the page.
  const ready = listenOnPreferredPort(server, options.port, '127.0.0.1')

  const url = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('workbuddy UI has no listening address')
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Host first: a rebinding page names its own domain in Host, and the WSL
      // forwarder rewrites Host to the loopback target, so forwarded requests
      // pass this unchanged.
      if (!hostGate(req)) {
        writeJson(res, 403, { error: 'request-not-trusted' })
        return
      }
      const path = (req.url ?? '/').split('?')[0]
      if (req.method === 'GET') {
        if (path === '/' || path === '/index.html') {
          if (!pageOriginAllowed(req, allowedUiOrigins)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(page),
            'Cache-Control': 'no-store',
          })
          res.end(page)
          return
        }
        if (path === '/api/state') {
          if (!pageOriginAllowed(req, allowedUiOrigins)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          writeJson(res, 200, redactState(await state()))
          return
        }
        if (path === '/api/providers') {
          if (!managementGate(req, nonce)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          if (providers === undefined) {
            writeJson(res, 501, { error: 'provider management is not available' })
            return
          }
          writeJson(res, 200, await providers.list())
          return
        }
        if (path === '/api/accounts') {
          if (!managementGate(req, nonce)) {
            writeJson(res, 403, { error: 'request-not-trusted' })
            return
          }
          if (accounts === undefined) {
            writeJson(res, 404, { error: `no such route: ${req.method} ${path}` })
            return
          }
          writeJson(res, 200, { accounts: await accounts.list() })
          return
        }
        writeJson(res, 404, { error: `no such route: ${req.method} ${path}` })
        return
      }
      if (req.method === 'POST' && path === '/api/pool/test') {
        // The nonce check comes first and answers like the host gate: a
        // request that cannot prove it came from this page learns nothing
        // about which routes exist. Probing stays a loopback-browser feature:
        // the WSL origin is for reading the page, not spending credits.
        if (req.headers[PROBE_HEADER] !== nonce || !originIsLoopback(req.headers.origin)) {
          writeJson(res, 403, { error: 'request-not-trusted' })
          return
        }
        if (probe === undefined) {
          writeJson(res, 501, { error: 'probing is not available' })
          return
        }
        // JSON only: a cross-origin HTML form can send `text/plain` without a
        // preflight, and this is the second gate behind the nonce.
        const type = req.headers['content-type']
        if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
          writeJson(res, 415, { error: 'Content-Type must be application/json' })
          return
        }
        const request = parseProbeRequest(await readBody(req, PROBE_BODY_LIMIT))
        const result = await probe(request)
        writeJson(res, 200, { ...result, detail: redactForBrowser(result.detail) })
        return
      }
      if (req.method === 'POST' && (path === '/api/providers/save' || path === '/api/providers/remove')) {
        if (!managementGate(req, nonce)) {
          writeJson(res, 403, { error: 'request-not-trusted' })
          return
        }
        if (providers === undefined) {
          writeJson(res, 501, { error: 'provider management is not available' })
          return
        }
        const type = req.headers['content-type']
        if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
          writeJson(res, 415, { error: 'Content-Type must be application/json' })
          return
        }
        const raw = await readBody(req, MANAGEMENT_BODY_LIMIT)
        if (path === '/api/providers/save') {
          writeJson(res, 200, await providers.save(parseSaveBody(raw)))
        } else {
          writeJson(res, 200, await providers.remove(parseRemoveBody(raw)))
        }
        return
      }
      if (req.method === 'POST' && ACCOUNT_ROUTES.has(path ?? '')) {
        // Same gate as provider management: the page nonce plus an exact
        // origin match. These routes write and delete credential files, so
        // they must not be reachable by a merely-loopback page.
        if (!managementGate(req, nonce)) {
          writeJson(res, 403, { error: 'request-not-trusted' })
          return
        }
        if (accounts === undefined) {
          // Absent means this bridge has no account surface at all, so the
          // route does not exist for it — answering 501 would advertise a
          // feature the operator turned off.
          writeJson(res, 404, { error: `no such route: ${req.method} ${path}` })
          return
        }
        const type = req.headers['content-type']
        if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
          writeJson(res, 415, { error: 'Content-Type must be application/json' })
          return
        }
        if (path === '/api/accounts/rescan') {
          // No body needed; the scan reads the sources itself. The body limit
          // is still applied so a huge payload cannot be used as a wedge.
          await readBody(req, ACCOUNT_BODY_LIMIT)
          writeJson(res, 200, await accounts.rescan())
          return
        }
        const raw = await readBody(req, ACCOUNT_BODY_LIMIT)
        if (path === '/api/accounts/import') {
          const body = parseAccountImportBody(raw)
          writeJson(res, 200, await accounts.import(body))
        } else {
          writeJson(res, 200, await accounts.remove(parseAccountRemoveBody(raw)))
        }
        return
      }
      writeJson(res, 405, { error: 'method not allowed' })
    } catch (error: unknown) {
      if (error instanceof UiRequestError) {
        writeJson(res, error.status, { error: error.message })
        return
      }
      if (isManagementRoute(req) && !res.headersSent) {
        // Known manager rejections carry their own status and a message
        // written to be shown; matched by instanceof against the store's
        // class, never structurally — a raw error that merely names itself
        // alike could carry a key in its message. Anything else the manager
        // threw is answered generically and dropped entirely — not echoed to
        // the browser AND not written to the host log, because a failure in
        // the middle of a save can quote the key being saved, and no regex
        // redaction can be trusted on arbitrary user material. The generic
        // answer is all either side learns.
        if (error instanceof ProviderManagementError) {
          writeJson(res, error.status, { error: error.message })
          return
        }
        if (error instanceof AccountStoreError) {
          writeJson(res, error.status, { error: error.message })
          return
        }
        // The generic answer stays route-specific: a page that sees "provider
        // management failed" for a provider route is the contract this route
        // has always had, and an account route says its own name.
        writeJson(res, 500, { error: isAccountRoute(req) ? 'account management failed' : 'provider management failed' })
        return
      }
      logger?.warn('workbuddy-bridge: UI request failed', error)
      if (!res.headersSent) writeJson(res, 500, { error: 'internal' })
      else res.end()
    }
  }

  /** Which paths are management, so their error handling is secrecy-first. */
  function isManagementRoute(req: IncomingMessage): boolean {
    const path = (req.url ?? '/').split('?')[0]
    return req.method === 'GET' && (path === '/api/providers' || path === '/api/accounts')
      || req.method === 'POST' && (path === '/api/providers/save' || path === '/api/providers/remove')
      || isAccountRoute(req)
  }

  /** Whether this request addressed an account route. */
  function isAccountRoute(req: IncomingMessage): boolean {
    return req.method === 'POST' && ACCOUNT_ROUTES.has((req.url ?? '/').split('?')[0] ?? '')
  }

  /**
   * The management gate: the page nonce plus, when a browser sent an Origin,
   * an exact match against the host-configured UI origins (or this server's
   * own loopback origin). Merely-loopback origins are not management origins.
   */
  function managementGate(req: IncomingMessage, expected: string): boolean {
    if (req.headers[PROBE_HEADER] !== expected) return false
    return managementOriginAllowed(req, allowedUiOrigins)
  }

  return {
    ready,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}

/**
 * The page itself.
 *
 * Deliberately self-contained: no CDN, no fonts, no build step. A page whose
 * whole job is to report on a local bridge must work with the network down,
 * and the host's CSP allowlist would not survive a redesign anyway.
 *
 * The client script uses string concatenation rather than template literals so
 * this file needs no escaping gymnastics, and every value is passed through
 * `esc()` — model names come from the upstream and are rendered as text.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkBuddy Bridge</title>
<style>
  :root {
    --bg: #16161a; --panel: #1e1e24; --panel-2: #26262e; --line: #33333d;
    --fg: #e8e8ee; --muted: #9a9aa8; --dim: #6f6f7d;
    --accent: #a89cf0; --ok: #5dcaa5; --warn: #ef9f27; --bad: #f09595;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f6f8; --panel: #ffffff; --panel-2: #f0f0f4; --line: #dcdce4;
      --fg: #1c1c22; --muted: #5c5c6a; --dim: #8a8a98;
      --accent: #534ab7; --ok: #0f6e56; --warn: #854f0b; --bad: #a32d2d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 18px 24px; border-bottom: 1px solid var(--line);
  }
  h1 { font-size: 15px; font-weight: 500; margin: 0; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 12px; }
  .dim { color: var(--dim); font-size: 12px; }
  button {
    font: inherit; font-size: 12px; color: var(--fg); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; padding: 5px 12px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  main { padding: 24px; display: flex; flex-direction: column; gap: 20px; max-width: 1100px; }
  .account-toggle-bar { display: flex; justify-content: center; padding: 4px 0; }
  .account-toggle { font: inherit; font-size: 12px; color: var(--muted); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; padding: 6px 16px; cursor: pointer;
  }
  .account-toggle:hover { border-color: var(--accent); color: var(--fg); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .connection { display: flex; gap: 16px; flex-wrap: wrap; padding: 10px 20px 14px; }
  .connection label { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 260px; }
  .connection .conn-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .connection input {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    color: var(--fg); background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 6px; padding: 5px 8px; width: 100%; box-sizing: border-box;
  }
  .connection input:focus { outline: none; border-color: var(--accent); }
  /* The head carries the title and the tab strip; the hairline under the strip
     is the border, so the two rows read as one unit rather than two blocks. */
  .card-head { padding: 16px 20px 0; border-bottom: 1px solid var(--line); }
  .card-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding-bottom: 12px; }
  .card-title h2 { font-size: 14px; font-weight: 500; margin: 0; }
  .tabs { display: flex; gap: 20px; }
  .tab {
    font: inherit; font-size: 12px; color: var(--muted); background: none;
    border: 0; border-bottom: 2px solid transparent; border-radius: 0;
    padding: 7px 0 9px; margin-bottom: -1px; cursor: pointer;
  }
  .tab:hover { color: var(--fg); border-bottom-color: var(--line); }
  .tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
  .tab .count { color: var(--dim); font-variant-numeric: tabular-nums; }
  .panel.hidden { display: none; }
  .meta { padding: 12px 20px 0; color: var(--dim); font-size: 12px; }
  .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 20px 0; }
  .pill {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
  }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .notice { margin: 14px 20px 0; padding: 10px 12px; border-radius: 8px; font-size: 12px;
            background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); }
  .notice.bad { color: var(--bad); }
  .credits { display: flex; gap: 28px; flex-wrap: wrap; padding: 14px 20px; }
  .credit-num { font-size: 22px; font-weight: 500; }
  .credit-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 20px; border-top: 1px solid var(--line); font-size: 13px; }
  th { font-weight: 500; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--panel-2);
         border: 1px solid var(--line); color: var(--muted); margin-right: 4px; }
  .tag.free { color: var(--ok); border-color: var(--ok); }
  .yes { color: var(--ok); } .no { color: var(--dim); }
  button:disabled { opacity: .45; cursor: default; }
  button:disabled:hover { border-color: var(--line); }
  .pill.head { color: var(--accent); border-color: var(--accent); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .members td { vertical-align: top; }
  .members tr.head td { background: var(--panel-2); }
  /* One line per snippet: an upstream refusal can be a paragraph of repeated
     HTML text, and four wrapped lines in a status cell make the table
     unscannable. The untruncated string stays in the tooltip. */
  .members .sub { max-width: 34ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A column of pills, left-aligned: without this the flex column stretches
     every pill to the column's width and the whole row reads as a bar chart. */
  .who { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
  .who .name { font-size: 13px; }
  .sub { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dim);
         max-width: 30ch; overflow-wrap: anywhere; }
  .result { font-size: 12px; }
  .result.ok { color: var(--ok); }
  .result.bad { color: var(--bad); }
  .result .detail { color: var(--muted); font-size: 11px; display: block; margin-top: 2px;
                    max-width: 40ch; overflow-wrap: anywhere; }
  .model-pick {
    font: inherit; font-size: 12px; color: var(--fg); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; max-width: 22ch;
  }
  /* Fixed layout so the columns line up down the table instead of being sized
     by whichever model name or error text happens to be longest. Widths are in
     px and total well under the card, so the leftover goes to the flexible
     columns rather than overflowing. */
  .requests { table-layout: fixed; }
  .requests td { vertical-align: middle; padding-top: 6px; padding-bottom: 6px; }
  .requests tbody tr:hover td { background: var(--panel-2); }
  .requests .col-time { width: 100px; }
  .requests .col-model { width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .requests .col-result { width: 160px; }
  .requests .col-took { width: 84px; }
  .requests .pill { margin-right: 6px; }
  .code { color: var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .chip {
    display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 4px;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
  }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.bad { color: var(--bad); border-color: var(--bad); }
  .chip.warn { color: var(--warn); border-color: var(--warn); }
  .chip .code { color: inherit; opacity: .7; margin-left: 4px; }
  .arrow { color: var(--dim); margin: 0 6px; }
  /* --- provider management --- */
  .add-bar { display: flex; justify-content: flex-start; padding: 2px 0; }
  .dialog-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 20;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  /* A hidden attribute alone is not enough here: the author display:flex rule
     above beats the UA stylesheet's [hidden] rule, and both dialogs would sit
     open over the page from the first paint, blocking every click below them. */
  .dialog-backdrop[hidden] { display: none; }
  .dialog {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    width: 520px; max-width: 100%; max-height: 90vh; overflow: auto; padding: 20px;
    box-shadow: 0 12px 40px rgba(0,0,0,.4);
  }
  .dialog h2 { font-size: 14px; font-weight: 500; margin: 0 0 12px; }
  .dialog .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .dialog .field > span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .dialog .field .hint { font-size: 11px; color: var(--dim); text-transform: none; letter-spacing: 0; }
  .dialog input, .dialog textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    color: var(--fg); background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 8px; width: 100%; box-sizing: border-box;
  }
  .dialog textarea { font-family: inherit; min-height: 90px; resize: vertical; }
  .dialog input:focus, .dialog textarea:focus { outline: none; border-color: var(--accent); }
  .dialog .radio-row { display: flex; gap: 16px; align-items: center; }
  .dialog .radio-row label { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--fg); }
  .dialog .error-line { color: var(--bad); font-size: 12px; margin: 0 0 10px; min-height: 1em;
                        overflow-wrap: anywhere; }
  .dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  .dialog .buttons .primary { color: var(--bg); background: var(--accent); border-color: var(--accent); }
  .dialog .buttons .danger { color: var(--bg); background: var(--bad); border-color: var(--bad); }
  .dialog .confirm-text { font-size: 13px; color: var(--fg); margin: 0 0 6px; overflow-wrap: anywhere; }
  .dialog .confirm-sub { font-size: 12px; color: var(--muted); margin: 0 0 10px; overflow-wrap: anywhere; }
  /* A persistent publication warning, fixed above everything so it survives
     the #app poll rewrite and stays visible over cards and dialogs alike. */
  #provider-warning {
    position: sticky; top: 0; z-index: 10; display: none;
    padding: 10px 24px; font-size: 12px; color: var(--warn);
    background: var(--panel-2); border-bottom: 1px solid var(--warn);
    overflow-wrap: anywhere;
  }
  #provider-warning.active { display: block; }
  .dialog p { overflow-wrap: anywhere; }
  footer { padding: 0 24px 32px; }
</style>
</head>
<body>
<header>
  <h1>WorkBuddy Bridge</h1>
  <span class="muted" id="version"></span>
  <span class="spacer"></span>
  <span class="dim" id="updated"></span>
  <button id="refresh">Refresh</button>
  <button id="rescan-accounts" hidden>Rescan accounts</button>
  <button id="manage-accounts" hidden>Accounts</button>
  <button id="add-provider" hidden>Add provider</button>
</header>
<!-- Publication warning: lives outside #app so the poll rewrite can never
     drop it, and the text is a host-owned safe status string, never error
     detail. Rendered via textContent by the poll's render() pass. -->
<div id="provider-warning" role="alert"></div>
<main id="app"></main>
<footer><p class="dim" id="pool-note"></p></footer>
<!-- The editor and its confirmation live outside #app on purpose: the 5s poll
     rewrites #app's innerHTML, and a dialog whose DOM was rebuilt under the
     user would drop the sentence being typed. -->
<div id="editor-backdrop" class="dialog-backdrop" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="editor-title">
    <h2 id="editor-title"></h2>
    <div class="error-line" id="editor-error" role="alert"></div>
    <label class="field"><span>Name</span>
      <input id="editor-name" type="text" autocomplete="off" spellcheck="false">
    </label>
    <label class="field"><span>API base URL</span>
      <input id="editor-baseurl" type="text" autocomplete="off" spellcheck="false"
             placeholder="https://api.example.com/v1">
    </label>
    <label class="field"><span>API key</span>
      <span class="hint" id="editor-key-hint"></span>
      <input id="editor-key" type="password" autocomplete="new-password" spellcheck="false">
    </label>
    <div class="field"><span>Models (one per line)</span>
      <textarea id="editor-models" spellcheck="false" aria-label="Models, one per line"></textarea>
    </div>
    <fieldset class="field" style="border:0;padding:0;margin:0 0 12px;">
      <legend style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:0;">Authentication</legend>
      <div class="radio-row">
        <label><input type="radio" name="editor-authmode" id="editor-auth-key" value="api-key"> API key</label>
        <label><input type="radio" name="editor-authmode" id="editor-auth-none" value="none"> No authentication</label>
      </div>
    </fieldset>
    <div class="buttons">
      <button id="editor-cancel">Cancel</button>
      <button id="editor-save" class="primary">Save</button>
    </div>
  </div>
</div>
<div id="accounts-backdrop" class="dialog-backdrop" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="accounts-title">
    <h2 id="accounts-title">Accounts</h2>
    <div class="error-line" id="accounts-error" role="alert"></div>
    <p class="confirm-sub">A stored sign-in file lets you keep an account in the pool, or take it out,
       without touching the WorkBuddy app's own folder. Remove deletes only this bridge's copy.</p>
    <div id="accounts-list"></div>
    <label class="field"><span>Add a sign-in file</span>
      <span class="hint">Choose a <code>workbuddy-desktop-ai*.info</code> file from this computer.
        A file sealed by a different WorkBuddy install cannot be read here.</span>
      <input id="accounts-file" type="file" accept=".info,application/json">
    </label>
    <div class="buttons">
      <button id="accounts-close">Close</button>
      <button id="accounts-import" class="primary">Add file</button>
    </div>
  </div>
</div>
<div id="remove-backdrop" class="dialog-backdrop" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title">
    <h2 id="remove-title">Remove provider</h2>
    <div class="error-line" id="remove-error" role="alert"></div>
    <p class="confirm-text" id="remove-text"></p>
    <p class="confirm-sub">Active requests through this provider stop. Its entry and saved key are deleted;
       add it again if you change your mind.</p>
    <div class="buttons">
      <button id="remove-cancel">Cancel</button>
      <button id="remove-confirm" class="danger">Remove</button>
    </div>
  </div>
</div>
<script>
var UI_NONCE = "__UI_NONCE__";
var MANAGE = "__MANAGE__";
var MANAGE_ACCOUNTS = "__MANAGE_ACCOUNTS__";
function esc(v) {
  return String(v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}
function fmtTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '';
  var d = new Date(ms);
  return d.toLocaleString();
}
function fmtClock(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '';
  /* 24-hour and zero-padded: a log column should be a constant width and
     scannable down the seconds, which "8:06:46 AM" is not. */
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}
function fmtLatency(ms) {
  if (typeof ms !== 'number' || ms < 0) return '';
  /* Sub-second turns are the common case here, and "0.1s" hides whether that
     was 60 ms or 140 ms. */
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
}
/* Upstream refusals are sometimes a whole HTML page (an openresty 401). The
   row is for reading, so markup and runs of whitespace go and the words stay;
   the untruncated original is still in the tooltip. */
function plain(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/<[^>]*>/g, ' ')
    /* A diagnostic string is often cut mid-tag before it gets here, so the
       unterminated tail needs removing too — otherwise "<p" survives as text. */
    .replace(/<[^>]*$/, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}
/* A diagnostic notice, readable: plain text, a bounded prefix, raw in the title. */
function noticeOf(text, bad) {
  return '<div class="notice' + (bad ? ' bad' : '') + '" title="' + esc(text) + '">'
    + esc(clip(plain(text), 240)) + '</div>';
}
/* Upstream refusals can be a wall of HTML; the row shows a readable prefix and
   keeps the whole thing in the title attribute. */
function clip(text, max) {
  var s = String(text === undefined || text === null ? '' : text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function creditsBlock(ep) {
  var html = '';
  if (ep.creditsError) {
    return noticeOf('Could not read credits: ' + ep.creditsError, true);
  }
  if (!ep.credits) return '';
  var c = ep.credits;
  html += '<div class="credits">';
  html += '<div><div class="credit-num">' + (c.unlimited ? 'Unlimited' : fmtNum(c.total)) + '</div>'
        + '<div class="credit-label">' + (c.unlimited ? 'quota' : 'credits remaining') + '</div></div>';
  if (c.cycleResetTime) {
    html += '<div><div class="credit-num">' + esc(c.cycleResetTime) + '</div>'
          + '<div class="credit-label">cycle reset</div></div>';
  }
  html += '</div>';
  if (c.accounts && c.accounts.length) {
    html += '<table><thead><tr><th>Package</th><th class="num">Remaining</th><th class="num">Size</th><th>Ends</th></tr></thead><tbody>';
    for (var i = 0; i < c.accounts.length; i++) {
      var a = c.accounts[i];
      html += '<tr><td>' + esc(a.packageName) + '</td>'
            + '<td class="num">' + (a.unlimited ? 'Unlimited' : fmtNum(a.remain)) + '</td>'
            + '<td class="num">' + (a.unlimited ? '' : fmtNum(a.size)) + '</td>'
            + '<td class="dim">' + esc(fmtTime(a.endTimeMs)) + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  return html;
}
function modelsTable(models, generic) {
  if (generic) {
    if (!models.length) return '<div class="notice">No models. Set the configured API key environment variable.</div>';
    var configured = '<table><thead><tr><th>Configured model ID</th></tr></thead><tbody>';
    for (var c = 0; c < models.length; c++) configured += '<tr><td class="mono">' + esc(models[c].id) + '</td></tr>';
    return configured + '</tbody></table>';
  }
  if (!models.length) {
    return '<div class="notice">No models. This product has no usable credential, so the list is empty by design rather than broken.</div>';
  }
  var html = '<table><thead><tr><th>Model</th><th>Id</th><th class="num">Rate</th>'
           + '<th class="num">Context</th><th class="num">Max out</th><th>Images</th><th>Notes</th></tr></thead><tbody>';
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var tags = '';
    if (m.free) tags += '<span class="tag free">free</span>';
    if (m.rateUnknown) tags += '<span class="tag">price needs refresh</span>';
    if (m.badges) for (var b = 0; b < m.badges.length; b++) tags += '<span class="tag">' + esc(m.badges[b]) + '</span>';
    if (m.reasoning && m.reasoning.supports) {
      var eff = m.reasoning.efforts && m.reasoning.efforts.length ? m.reasoning.efforts.join('/') : 'default';
      tags += '<span class="tag">reasoning: ' + esc(eff) + '</span>';
    }
    var ctx = m.contextWindow ? fmtNum(m.contextWindow) : '';
    if (m.maxContextWindow && m.maxContextWindow > (m.contextWindow || 0)) {
      ctx = fmtNum(m.contextWindow) + ' <span class="dim">(max ' + fmtNum(m.maxContextWindow) + ')</span>';
    }
    html += '<tr>'
          + '<td>' + esc(m.name) + '</td>'
          + '<td class="mono">' + esc(m.id) + '</td>'
          + '<td class="num">' + esc(m.credits || '') + '</td>'
          + '<td class="num">' + ctx + '</td>'
          + '<td class="num">' + (m.maxTokens ? fmtNum(m.maxTokens) : '') + '</td>'
          + '<td class="' + (m.supportsImages ? 'yes' : 'no') + '">' + (m.supportsImages ? 'yes' : 'no') + '</td>'
          + '<td>' + tags + '</td>'
          + '</tr>';
  }
  return html + '</tbody></table>';
}
/* Per-member test results, keyed provider#index. Kept outside the rendered
   DOM so the 5s poll cannot wipe a result the user is still reading. */
var tests = {};
var lastState = null;
function testKey(provider, index) { return provider + '#' + index; }
function testOf(provider, index) { return tests[testKey(provider, index)]; }
function memberLabel(pool, index) {
  var m = pool.members[index];
  return m ? m.label : 'account ' + (index + 1);
}
function creditsCell(m) {
  if (m.credits) return m.credits.unlimited ? 'Unlimited' : fmtNum(m.credits.total);
  if (m.creditsError) {
    return '<span class="no" title="' + esc(m.creditsError) + '">error</span>';
  }
  return '<span class="no">—</span>';
}
function attemptCell(m) {
  if (m.lastOutcome === undefined) return '<span class="no">no routed traffic yet</span>';
  var when = m.lastAttemptAtMs ? fmtTime(m.lastAttemptAtMs) : '';
  var pill = m.lastOutcome === 'ok'
    ? '<span class="pill ok">ok</span>'
    : '<span class="pill bad">' + esc(m.lastOutcome === 'credential-error' ? 'credential' : 'upstream') + '</span>';
  var detail = m.lastOutcomeDetail
    ? '<span class="sub" title="' + esc(m.lastOutcomeDetail) + '">' + esc(clip(plain(m.lastOutcomeDetail), 90)) + '</span>'
    : '';
  return '<div class="who">' + pill + '<span class="sub">' + esc(when) + '</span>' + detail + '</div>';
}
function resultCell(provider, index) {
  var t = testOf(provider, index);
  if (t === undefined) return '';
  if (t.running) return '<span class="result">testing…</span>';
  var cls = t.ok ? 'ok' : 'bad';
  var head = t.ok
    ? 'pass · ' + (typeof t.latencyMs === 'number' ? (t.latencyMs / 1000).toFixed(1) + 's' : '')
    : 'fail';
  return '<span class="result ' + cls + '">' + head
    + '<span class="detail" title="' + esc((t.model ? t.model + ' · ' : '') + (t.detail || '')) + '">'
    + esc(clip(plain(t.detail), 140)) + '</span></span>';
}
/*
 * Which model a test asks for. Kept outside the DOM for the same reason as the
 * results: the 5s re-render rebuilds the select, and losing the choice between
 * polls would make "test bob on this model" impossible to hold still.
 * An empty value means "whatever this account lists first", which is the only
 * default that cannot be wrong for an account whose roster differs.
 */
var chosenModels = {};
function modelPicker(ep) {
  if (!ep.models || !ep.models.length) return '';
  var chosen = chosenModels[ep.provider] || '';
  var html = '<select class="model-pick" data-model-provider="' + esc(ep.provider) + '">'
    + '<option value="">default model</option>';
  for (var i = 0; i < ep.models.length; i++) {
    var id = ep.models[i].id;
    html += '<option value="' + esc(id) + '"' + (id === chosen ? ' selected' : '') + '>' + esc(id) + '</option>';
  }
  return html + '</select>';
}
function poolBlock(ep) {
  var p = ep.pool;
  if (!p || !p.members || !p.members.length) return '';
  var providers = p.kind === 'providers';
  var html = '<div class="notice">One endpoint over ' + p.members.length + (providers ? ' providers' : ' accounts')
    + '. The next request is answered by '
    + '<strong>' + esc(memberLabel(p, p.headIndex)) + '</strong>. A test runs against that '
    + (providers ? 'provider' : 'account') + ' only — it does not move the head.</div>';
  /* The test controls live here rather than in the card head: they act on the
     member table below them, and a header control that does nothing on the
     Models tab would be a dead button. */
  html += '<div class="toolbar">' + modelPicker(ep)
    + '<button class="test-all" data-test-all="' + esc(ep.provider) + '">Test all</button></div>';
  html += '<table class="members"><thead><tr><th>' + (providers ? 'Provider' : 'Account') + '</th><th>State</th>'
        + '<th class="num">Credits</th><th>Last routed turn</th><th>Test</th>'
        + (providers ? '<th>Manage</th>' : '') + '</tr></thead><tbody>';
  for (var i = 0; i < p.members.length; i++) {
    var m = p.members[i];
    var t = testOf(ep.provider, m.index);
    var busy = t !== undefined && t.running;
    var state = '<div class="who">'
      + '<span class="pill ' + (m.signedIn ? 'ok' : 'bad') + '">'
      + (m.signedIn ? (providers ? 'ready' : 'signed in') : (providers ? 'no key' : 'signed out')) + '</span>';
    if (m.head) {
      state += m.signedIn
        ? '<span class="pill head">next</span>'
        : '<span class="pill warn">next · ' + (providers ? 'no key' : 'signed out') + '</span>';
    }
    if (m.consecutiveFailures > 0) {
      state += '<span class="pill bad">' + m.consecutiveFailures + ' fail in a row</span>';
    }
    state += '<span class="sub">' + fmtNum(m.successes) + ' ok / ' + fmtNum(m.failures) + ' failed</span></div>';
    html += '<tr' + (m.head ? ' class="head"' : '') + '>'
          + '<td><div class="who"><span class="name">' + esc(m.label) + '</span>'
          + (m.uid ? '<span class="sub">' + esc(m.uid) + '</span>' : '')
          + '</div></td>'
          + '<td>' + state + '</td>'
          + '<td class="num">' + (providers ? '<span class="no">—</span>' : creditsCell(m)) + '</td>'
          + '<td>' + attemptCell(m) + '</td>'
          + '<td><button class="test" data-test-provider="' + esc(ep.provider) + '" data-test-index="' + m.index + '"'
          + (busy ? ' disabled' : '') + '>' + (busy ? 'testing…' : 'Test') + '</button>'
          + resultCell(ep.provider, m.index) + '</td>'
          + (providers ? '<td>' + manageCell(m) + '</td>' : '')
          + '</tr>';
  }
  return html + '</tbody></table>';
}
/* A pool row that is also a provider card gets the same controls here, so a
   provider can be edited from the pool it belongs to as well as from its own
   card. An externally configured provider has no entry to edit, so it gets the
   same read-only note its card carries. */
function manageCell(m) {
  if (m.editId) {
    return '<button data-edit-provider="' + esc(m.editId) + '">Edit</button> '
      + '<button data-remove-provider="' + esc(m.editId) + '">Remove</button>';
  }
  return '<span class="pill">externally configured · read-only</span>';
}
/* One member's attempt, as a chip. The class carries the verdict so the chain
   reads at a glance: green answered, red refused, amber could not sign in. */
function attemptChip(at) {
  var ok = at.outcome === 'ok';
  var label = ok ? 'ok' : (at.outcome === 'credential-error' ? 'no credential' : at.outcome);
  var cls = ok ? 'ok' : (at.outcome === 'credential-error' ? 'warn' : 'bad');
  var code = !ok && at.status ? '<span class="code">' + esc(String(at.status)) + '</span>' : '';
  return '<span class="chip ' + cls + '">' + esc(at.account) + ' ' + esc(label) + code + '</span>';
}
function attemptsCell(row) {
  var list = row.attempts || [];
  if (!list.length) return '<span class="no">—</span>';
  var parts = [];
  for (var i = 0; i < list.length; i++) parts.push(attemptChip(list[i]));
  return parts.join('<span class="arrow">\u2192</span>');
}
function requestsTable(ep) {
  var rows = ep.requests || [];
  if (!rows.length) {
    return '<div class="notice">No requests yet. This log is metadata only — model, account, '
      + 'outcome, timing — and lives in memory.</div>';
  }
  /* A pool row answers a different question than an account row, so the table
     has one extra column for it: what the router tried, in order. The account
     is not a column anywhere — the card's own title already names it. */
  var pooled = ep.pool !== undefined;
  var html = '<table class="requests"><thead><tr>'
    + '<th class="col-time">Time</th>'
    + '<th class="col-model">Model</th>'
    + (pooled ? '<th class="col-tried">Tried</th>' : '')
    + '<th class="col-result">Result</th>'
    + '<th class="col-took num">Took</th>'
    + '</tr></thead><tbody>';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var ok = r.outcome === 'ok';
    var result = '<span class="pill ' + (ok ? 'ok' : 'bad') + '">' + esc(ok ? 'ok' : r.outcome) + '</span>'
      + (ok ? '' : '<span class="code">' + esc(String(r.status)) + '</span>');
    html += '<tr>'
      + '<td class="col-time mono">' + esc(fmtClock(r.atMs)) + '</td>'
      + '<td class="col-model mono" title="' + esc(r.model) + '">' + esc(r.model) + '</td>'
      + (pooled ? '<td class="col-tried">' + attemptsCell(r) + '</td>' : '')
      + '<td class="col-result">' + result + '</td>'
      + '<td class="col-took num mono">' + esc(fmtLatency(r.latencyMs)) + '</td>'
      + '</tr>';
  }
  return html + '</tbody></table>';
}
/*
 * Three sections per endpoint, one visible at a time: Account (who is signed
 * in, what is left, and for a pool who answers next), Models, and Logs.
 *
 * The choice is kept outside the DOM for the same reason as the test results:
 * the 5s poll rebuilds the card, and a tab that jumped back to Account on
 * every refresh would be unusable.
 */
var activeTabs = Object.create(null);
function tabOf(provider) { return activeTabs[provider] || 'account'; }
function tabStrip(ep) {
  var active = tabOf(ep.provider);
  var providerPool = ep.pool !== undefined && ep.pool.kind === 'providers';
  var tabs = [
    {
      id: 'account',
      label: providerPool ? 'Providers' : 'Account'
    },
    { id: 'models', label: 'Models', count: (ep.models || []).length },
    { id: 'logs', label: 'Logs', count: (ep.requests || []).length }
  ];
  var html = '<div class="tabs" role="tablist">';
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    html += '<button class="tab" role="tab" data-tab="' + tab.id + '"'
      + ' aria-selected="' + (tab.id === active ? 'true' : 'false') + '">'
      + esc(tab.label)
      + (tab.count === undefined ? '' : ' <span class="count">' + fmtNum(tab.count) + '</span>')
      + '</button>';
  }
  return html + '</div>';
}
function panel(name, active, inner) {
  return '<div class="panel' + (name === active ? '' : ' hidden') + '"'
    + ' data-panel="' + name + '" role="tabpanel">' + inner + '</div>';
}
function accountPanel(ep) {
  if (ep.pool && ep.pool.kind === 'providers') {
    var providerNotice = 'One endpoint over ' + ep.pool.members.length + ' custom providers with failover. '
      + 'A request goes to the provider that offers its model; when that provider refuses in a way another '
      + 'could survive, the next one is tried. Models come from the saved configurations and changes are live at once. '
      + 'The Local bridge API key above is the local bridge token, not any upstream key.';
    return (ep.error ? noticeOf(ep.error, true) : '') + '<div class="notice">' + providerNotice + '</div>' + poolBlock(ep);
  }
  var html = '';
  var meta = [];
  if (ep.catalogSource) meta.push('catalog: ' + ep.catalogSource);
  if (ep.catalogFetchedAtMs) meta.push('fetched ' + fmtTime(ep.catalogFetchedAtMs));
  if (meta.length) html += '<div class="meta">' + esc(meta.join('  ·  ')) + '</div>';
  if (ep.error) html += noticeOf(ep.error, true);
  html += poolBlock(ep);
  return html;
}
function renderCard(ep) {
  var active = tabOf(ep.provider);
  var providerPool = ep.pool !== undefined && ep.pool.kind === 'providers';
  var html = '<section class="card" data-provider="' + esc(ep.provider) + '">';
  html += '<div class="card-head"><div class="card-title">';
  html += '<h2>' + esc(ep.displayName) + '</h2>';
  var status = providerPool
    ? (ep.signedIn ? 'configured' : 'no usable key')
    : (ep.signedIn ? 'signed in' : 'signed out');
  var generic = providerPool;
  html += '<span class="pill ' + (ep.signedIn ? 'ok' : 'bad') + '">' + status + '</span>';
  if (ep.nickname) html += '<span class="pill">' + esc(ep.nickname) + '</span>';
  if (ep.domain) html += '<span class="pill">' + esc(ep.domain) + '</span>';
  /* Every card is a pool card now, so the card-level Edit/Remove buttons go:
     the provider pool's members are edited from the table below, and an
     account pool is managed from the WorkBuddy app, not this page. */
  html += '</div>';
  if (ep.baseUrl || ep.token) {
    html += '<div class="connection">';
    if (ep.baseUrl) {
      html += '<label><span class="conn-label">Base URL</span>'
        + '<input readonly value="' + esc(ep.baseUrl) + '" onclick="this.select()"></label>';
    }
    if (ep.wslBaseUrl) {
      html += '<label><span class="conn-label">WSL URL</span>'
        + '<input readonly value="' + esc(ep.wslBaseUrl) + '" onclick="this.select()"></label>';
    }
    if (ep.token) {
      /* "Local bridge API key", not just "API Key": the editor below also has
         an API-key field for the upstream credential, and the two must not be
         mistakable for each other. */
      html += '<label><span class="conn-label">Local bridge API key</span>'
        + '<input readonly value="' + esc(ep.token) + '" onclick="this.select()"></label>';
    }
    html += '</div>';
  }
  html += tabStrip(ep);
  html += '</div>';
  html += panel('account', active, accountPanel(ep));
  html += panel('models', active, modelsTable(ep.models || [], generic));
  html += panel('logs', active, requestsTable(ep));
  html += '</section>';
  return html;
}
function render(state) {
  lastState = state;
  /* The publication warning is host-owned text (a fixed safe status string,
     never error detail) set on the state document after a mutation whose
     publication failed, and cleared when publication later succeeds. It is
     set via textContent outside #app, so it persists across polls. */
  var banner = document.getElementById('provider-warning');
  if (state.providerWarning) {
    banner.textContent = state.providerWarning;
    banner.className = 'active';
  } else {
    banner.textContent = '';
    banner.className = '';
  }
  var poolEndpoints = (state.endpoints || []).filter(function (ep) { return ep.pool !== undefined; });
  var providerPoolShown = poolEndpoints.some(function (ep) { return ep.pool.kind === 'providers'; });
  var accountPoolShown = poolEndpoints.some(function (ep) { return ep.pool.kind !== 'providers'; });
  document.getElementById('pool-note').textContent = providerPoolShown
    ? "A test sends one real chat turn through that provider's own upstream — it spends a few credits there and does not move the pool's head."
    : accountPoolShown
      ? "A test sends one real chat turn through that account's own upstream path — it spends a few credits and does not move the pool's head."
      : '';
  document.getElementById('version').textContent = 'v' + (state.version === 1 ? '1' : '?');
  document.getElementById('updated').textContent = 'updated ' + new Date(state.nowMs).toLocaleTimeString();
  document.getElementById('add-provider').hidden = !MANAGE;
  document.getElementById('manage-accounts').hidden = !MANAGE_ACCOUNTS;
  document.getElementById('rescan-accounts').hidden = !MANAGE_ACCOUNTS;
  var app = document.getElementById('app');
  if (!state.endpoints || !state.endpoints.length) {
    app.innerHTML = '<div class="notice">' + (MANAGE
      ? 'No endpoints are being served. Add a provider to serve one.'
      : 'No endpoints are being served.') + '</div>';
    return;
  }
  /* Every card is a pool card. The custom-provider pool comes first: it is
     the endpoint an agent should use when several providers exist, so it must
     not sit below the other cards. */
  var pools = (state.endpoints || []).slice();
  pools.sort(function (a, b) {
    return (b.pool && b.pool.kind === 'providers' ? 1 : 0) - (a.pool && a.pool.kind === 'providers' ? 1 : 0);
  });
  var html = '';
  for (var p = 0; p < pools.length; p++) html += renderCard(pools[p]);
  app.innerHTML = html;
}

/*
 * Run one probe. The "done" callback lets "Test all" chain the accounts one at
 * a time — serial on purpose: firing every account at once would spend several
 * turns of quota to answer a question one turn at a time answers better, and a
 * burst from one machine across several identities is exactly the pattern the
 * pool's own notes warn about.
 */
function runTest(provider, index, done) {
  var key = testKey(provider, index);
  var body = { provider: provider, index: index };
  var chosen = chosenModels[provider];
  if (chosen) body.model = chosen;
  tests[key] = { running: true };
  if (lastState) render(lastState);
  fetch('/api/pool/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': UI_NONCE },
    body: JSON.stringify(body)
  })
    .then(function (r) {
      return r.json().then(function (body) { return { status: r.status, body: body }; });
    })
    .then(function (res) {
      tests[key] = res.status === 200
        ? res.body
        : { ok: false, detail: (res.body && res.body.error) || ('HTTP ' + res.status) };
    })
    .catch(function (e) {
      tests[key] = { ok: false, detail: e.message };
    })
    .then(function () {
      tests[key].running = false;
      if (lastState) render(lastState);
      // A passing test just spent a credit: re-read the state so the row's
      // balance is not stale for up to five seconds.
      load();
      if (done) done();
    });
}
function runAll(provider) {
  var ep = null;
  if (lastState && lastState.endpoints) {
    for (var i = 0; i < lastState.endpoints.length; i++) {
      if (lastState.endpoints[i].provider === provider) ep = lastState.endpoints[i];
    }
  }
  if (!ep || !ep.pool) return;
  var queue = ep.pool.members.map(function (m) { return m.index; });
  function step() {
    if (!queue.length) return;
    runTest(provider, queue.shift(), step);
  }
  step();
}
document.getElementById('app').addEventListener('click', function (event) {
  /* "closest", not event.target directly: a tab's label carries a count span,
     and clicking the number must switch the tab like clicking the word. */
  var button = event.target && event.target.closest ? event.target.closest('button') : null;
  if (!button) return;
  /* A tab switch is a class toggle rather than a re-render: it keeps the
     scroll position, and it cannot race the 5s poll into showing the wrong
     panel. The choice is recorded so the next poll rebuilds it open. */
  if (button.dataset.tab !== undefined) {
    var card = button.closest('.card');
    if (!card) return;
    activeTabs[card.getAttribute('data-provider') || ''] = button.dataset.tab;
    var tabs = card.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', tabs[i] === button ? 'true' : 'false');
    }
    var panels = card.querySelectorAll('.panel');
    for (var p = 0; p < panels.length; p++) {
      panels[p].classList.toggle('hidden', panels[p].getAttribute('data-panel') !== button.dataset.tab);
    }
    return;
  }
  if (button.dataset.testProvider !== undefined) {
    runTest(button.dataset.testProvider, Number(button.dataset.testIndex));
    return;
  }
  if (button.dataset.testAll !== undefined) runAll(button.dataset.testAll);
  /* Managed cards: Edit prefills the editor, Remove opens its confirmation. */
  if (button.dataset.editProvider !== undefined) openEditor(button.dataset.editProvider);
  if (button.dataset.removeProvider !== undefined) openRemove(button.dataset.removeProvider);
});
document.getElementById('app').addEventListener('change', function (event) {
  var target = event.target;
  if (target && target.dataset && target.dataset.modelProvider !== undefined) {
    chosenModels[target.dataset.modelProvider] = target.value;
  }
});

/* ------------------------------------------------------------------ *
 * Provider management. Everything here lives OUTSIDE #app: the editor *
 * and its confirmation are fixed DOM, so the 5s poll can never rebuild *
 * them under a sentence being typed. The key field is a password input *
 * that is only read into a request body — never into render strings,  *
 * state objects, or storage — and a close/cancel clears it.           *
 * ------------------------------------------------------------------ */
/* Managed ids, from /api/providers. The state document stays metadata-only
   about management: cards look it up here rather than carrying it. */
var managedIds = {};
var providersList = {};
var providerRevision = null;
/* The revision each open dialog acts on, pinned when the dialog opens. The
   5s poll keeps adopting newer snapshots, but a dialog the user has already
   based edits on must not silently ride them: a save that ships a stale
   revision would overwrite whatever changed between open and save (the
   reviewer's r1-editor / r2-poll scenario). A conflict therefore fails and
   asks for a reopen; it never auto-adopts. */
var editorRevision = null;
var removalRevision = null;
var lastFocus = null;
var removeTarget = null;
var editingId = null;
function editorEl(id) { return document.getElementById(id); }

function openEditor(id) {
  editingId = id || null;
  var p = id ? providersList[id] : null;
  editorRevision = providerRevision;
  editorEl('editor-title').textContent = p ? 'Edit provider' : 'Add provider';
  editorEl('editor-name').value = p ? p.displayName : '';
  editorEl('editor-baseurl').value = p ? p.baseUrl : '';
  /* The key is never round-tripped: blank keeps what is saved. */
  editorEl('editor-key').value = '';
  editorEl('editor-key-hint').textContent = p && p.hasApiKey
    ? 'Leave blank to keep the saved key'
    : '';
  editorEl('editor-models').value = p ? p.models.join('\\n') : '';
  editorEl(p && p.authMode === 'none' ? 'editor-auth-none' : 'editor-auth-key').checked = true;
  editorEl('editor-error').textContent = '';
  editorEl('editor-save').disabled = false;
  showBackdrop('editor-backdrop');
  editorEl('editor-name').focus();
}
function showBackdrop(id) {
  var backdrop = editorEl(id);
  backdrop.hidden = false;
  lastFocus = document.activeElement;
  /* Focus the dialog itself so Tab cycles inside it (simple focus trap). */
  var dialog = backdrop.querySelector('.dialog');
  var focusables = dialog.querySelectorAll('button, input, textarea');
  if (focusables.length) focusables[0].focus();
}
function closeEditor() {
  editorEl('editor-backdrop').hidden = true;
  /* The key never outlives the dialog: blank it on close as well as cancel. */
  editorEl('editor-key').value = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}
function openRemove(id) {
  var p = providersList[id];
  if (!p) return;
  removeTarget = id;
  removalRevision = providerRevision;
  editorEl('remove-text').textContent = 'Remove ' + p.displayName + ' (' + p.id + ')?';
  editorEl('remove-error').textContent = '';
  editorEl('remove-confirm').disabled = false;
  showBackdrop('remove-backdrop');
  editorEl('remove-cancel').focus();
}
function closeRemove() {
  editorEl('remove-backdrop').hidden = true;
  removeTarget = null;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}

function authModeOf() {
  return editorEl('editor-auth-none').checked ? 'none' : 'api-key';
}
/* Transport-shape validation only; the store owns URL shape, model syntax,
   reserved ids, and collisions, and its messages are written to be shown. */
function editorValidate() {
  if (editorEl('editor-name').value.trim() === '') return 'Name is required.';
  if (editorEl('editor-baseurl').value.trim() === '') return 'API base URL is required.';
  var lines = editorEl('editor-models').value.split('\\n').map(function (line) { return line.trim(); }).filter(function (line) { return line !== ''; });
  if (!lines.length) return 'At least one model is required.';
  return '';
}
function saveEditor() {
  var problem = editorValidate();
  /* The save carries the revision the dialog was opened with, not the one the
     poll has since adopted. A newer live revision means someone (another tab,
     another mutation) changed the roster under this dialog; sending the old
     fields with the new revision would overwrite it silently, so the conflict
     is refused and the dialog must be reopened instead. */
  if (editorRevision !== providerRevision) {
    editorEl('editor-error').textContent =
      'This provider changed since the dialog opened. Cancel and reopen to edit the current version.';
    editorEl('editor-save').disabled = true;
    return;
  }
  editorEl('editor-error').textContent = problem;
  if (problem) return;
  var body = {
    revision: editorRevision,
    displayName: editorEl('editor-name').value.trim(),
    baseUrl: editorEl('editor-baseurl').value.trim(),
    models: editorEl('editor-models').value.split('\\n').map(function (line) { return line.trim(); }).filter(function (line) { return line !== ''; }),
    authMode: authModeOf()
  };
  var editing = editorEl('editor-title').textContent === 'Edit provider';
  if (editing && editingId) body.id = editingId;
  var key = editorEl('editor-key').value;
  if (authModeOf() === 'api-key' && key !== '') body.apiKey = key;
  editorEl('editor-save').disabled = true;
  editorEl('editor-error').textContent = 'Saving...';
  postManagement('/api/providers/save', body)
    .then(function (snapshot) {
      applySnapshot(snapshot);
      closeEditor();
      load();
    })
    .catch(function (message) {
      editorEl('editor-error').textContent = message;
      editorEl('editor-save').disabled = false;
    });
}
function confirmRemove() {
  if (!removeTarget) return;
  /* Same pinning as the editor: remove with the revision the confirmation was
     opened against, never one a later poll adopted. */
  if (removalRevision !== providerRevision) {
    editorEl('remove-error').textContent =
      'The provider list changed since this was opened. Cancel and try again.';
    editorEl('remove-confirm').disabled = true;
    return;
  }
  editorEl('remove-confirm').disabled = true;
  editorEl('remove-error').textContent = 'Removing...';
  postManagement('/api/providers/remove', { revision: removalRevision, id: removeTarget })
    .then(function (snapshot) {
      applySnapshot(snapshot);
      closeRemove();
      load();
    })
    .catch(function (message) {
      editorEl('remove-error').textContent = message;
      editorEl('remove-confirm').disabled = false;
    });
}
/*
 * Account management: list the bridge's own sign-in copies, add one, remove
 * one, and rescan the sources for an account that was signed in since the
 * bridge started. The dialog lives outside #app for the same reason the
 * provider editor does — the 5s poll rewrites #app and would drop the file
 * input mid-selection.
 */
var storedAccounts = [];
function openAccounts() {
  editorEl('accounts-error').textContent = '';
  editorEl('accounts-file').value = '';
  document.getElementById('accounts-backdrop').hidden = false;
  loadAccounts();
}
function closeAccounts() {
  document.getElementById('accounts-backdrop').hidden = true;
}
function loadAccounts() {
  if (!MANAGE_ACCOUNTS) return;
  fetch('/api/accounts', { headers: { 'X-Bridge-Ui': UI_NONCE }, cache: 'no-store' })
    .then(function (r) {
      if (r.status === 200) return r.json();
      throw new Error('HTTP ' + r.status);
    })
    .then(function (data) {
      storedAccounts = (data && data.accounts) || [];
      renderAccounts();
    })
    .catch(function (e) {
      editorEl('accounts-error').textContent = 'Could not read the account folder: ' + e.message;
    });
}
function renderAccounts() {
  var host = document.getElementById('accounts-list');
  if (!storedAccounts.length) {
    host.innerHTML = '<p class="dim" style="font-size:12px;margin:0 0 12px;">'
      + 'No stored accounts yet. The pool still uses every account the WorkBuddy app has signed in.</p>';
    return;
  }
  var html = '<table class="models" style="margin-bottom:12px;"><thead><tr>'
    + '<th>Account</th><th>Saved</th><th></th></tr></thead><tbody>';
  for (var i = 0; i < storedAccounts.length; i++) {
    var a = storedAccounts[i];
    html += '<tr><td title="' + esc(a.uid) + '">' + esc(clip(a.uid, 26)) + '</td>'
      + '<td class="dim">' + esc(fmtTime(a.savedAtMs) || 'unknown') + '</td>'
      + '<td><button data-remove-account="' + esc(a.uid) + '">Remove</button></td></tr>';
  }
  html += '</tbody></table>';
  host.innerHTML = html;
  var buttons = host.querySelectorAll('button[data-remove-account]');
  for (var b = 0; b < buttons.length; b++) {
    buttons[b].addEventListener('click', function (event) {
      removeAccount(event.currentTarget.getAttribute('data-remove-account'));
    });
  }
}
function removeAccount(uid) {
  if (!uid) return;
  editorEl('accounts-error').textContent = 'Removing...';
  postManagement('/api/accounts/remove', { uid: uid })
    .then(function () {
      editorEl('accounts-error').textContent = '';
      loadAccounts();
      load();
    })
    .catch(function (message) {
      editorEl('accounts-error').textContent = message;
    });
}
function importAccount() {
  var input = editorEl('accounts-file');
  var file = input.files && input.files[0];
  if (!file) {
    editorEl('accounts-error').textContent = 'Choose a sign-in file first.';
    return;
  }
  editorEl('accounts-error').textContent = 'Reading...';
  var reader = new FileReader();
  reader.onload = function () {
    editorEl('accounts-error').textContent = 'Adding...';
    postManagement('/api/accounts/import', { text: String(reader.result), origin: file.name })
      .then(function () {
        editorEl('accounts-error').textContent = '';
        input.value = '';
        loadAccounts();
        load();
      })
      .catch(function (message) {
        editorEl('accounts-error').textContent = message;
      });
  };
  reader.onerror = function () {
    editorEl('accounts-error').textContent = 'The file could not be read.';
  };
  reader.readAsText(file);
}
function rescanAccounts() {
  var button = editorEl('rescan-accounts');
  button.disabled = true;
  postManagement('/api/accounts/rescan', {})
    .then(function (result) {
      var added = (result && result.added) || [];
      button.textContent = added.length
        ? 'Added ' + added.length
        : 'No new accounts';
      load();
      setTimeout(function () { button.textContent = 'Rescan accounts'; }, 2500);
    })
    .catch(function (message) {
      button.textContent = 'Rescan failed';
      button.title = message;
      setTimeout(function () { button.textContent = 'Rescan accounts'; button.title = ''; }, 4000);
    })
    .then(function () { button.disabled = false; });
}
function postManagement(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': UI_NONCE },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (data) { return { status: r.status, data: data }; });
  }).then(function (res) {
    if (res.status === 200) return res.data;
    throw (res.data && res.data.error) || ('HTTP ' + res.status);
  });
}
function applySnapshot(snapshot) {
  providersList = {};
  for (var i = 0; i < snapshot.providers.length; i++) {
    providersList[snapshot.providers[i].id] = snapshot.providers[i];
  }
  managedIds = Object.assign({}, providersList);
  providerRevision = snapshot.revision;
}
/* The list is fetched separately from /api/state: management metadata and the
   card document have different lifetimes, and the cards only need the ids. */
function loadProviders() {
  if (!MANAGE) return;
  fetch('/api/providers', { headers: { 'X-Bridge-Ui': UI_NONCE }, cache: 'no-store' })
    .then(function (r) {
      if (r.status === 200) return r.json();
      throw new Error('HTTP ' + r.status);
    })
    .then(applySnapshot)
    .catch(function () { /* read-only rendering continues; retry on next poll */ })
    .then(function () { if (lastState) render(lastState); });
}
editorEl('editor-cancel').addEventListener('click', closeEditor);
editorEl('editor-save').addEventListener('click', saveEditor);
editorEl('remove-cancel').addEventListener('click', closeRemove);
editorEl('remove-confirm').addEventListener('click', confirmRemove);
editorEl('add-provider').addEventListener('click', function () { openEditor(null); });
editorEl('manage-accounts').addEventListener('click', openAccounts);
editorEl('accounts-close').addEventListener('click', closeAccounts);
editorEl('accounts-import').addEventListener('click', importAccount);
editorEl('rescan-accounts').addEventListener('click', rescanAccounts);
/* Escape cancels whichever dialog is open; Tab is trapped inside it so focus
   cannot wander behind the backdrop. */
document.addEventListener('keydown', function (event) {
  var openBackdrop = document.querySelector('.dialog-backdrop:not([hidden])');
  if (!openBackdrop) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (openBackdrop.id === 'editor-backdrop') closeEditor();
    else if (openBackdrop.id === 'accounts-backdrop') closeAccounts();
    else closeRemove();
    return;
  }
  if (event.key === 'Tab') {
    var focusables = openBackdrop.querySelectorAll('button, input, textarea');
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

var timer = null;
function load() {
  fetch('/api/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function (e) {
      document.getElementById('app').innerHTML =
        '<div class="notice bad">Could not reach the bridge: ' + esc(e.message) + '</div>';
    });
}
document.getElementById('refresh').addEventListener('click', load);
load();
loadProviders();
timer = setInterval(load, 5000);
/* Keep the managed roster fresh too; the card labels are the same either way,
   and Edit/Remove are what the ids gate. */
setInterval(loadProviders, 5000);
</script>
</body>
</html>
`
