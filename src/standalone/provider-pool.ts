/**
 * The custom-provider pool: one endpoint, several OpenAI-compatible
 * providers, failover between them.
 *
 * This is the same arrangement the WorkBuddy account pool provides, applied
 * to providers instead of accounts: one published base URL, and the provider
 * that answers is chosen per request. A provider whose gateway is rate
 * limited, out of credit, or returning 5xx is stepped over for the next one,
 * so a single upstream's bad day is not the caller's outage.
 *
 * Selection is sticky-with-rotation, matching the account pool: the head
 * provider serves until it fails, then the head advances to the next provider
 * for everyone after it. Success keeps the head where it is, so a healthy
 * provider does not have its traffic scattered.
 *
 * Two differences from the account pool are deliberate:
 *
 * - **Membership is editable while running.** Providers are added, edited, and
 *   removed from the page, so the head is tracked by provider id rather than
 *   by position: reordering or removing a provider must not silently redirect
 *   live traffic to a different one.
 * - **A request only reaches providers that list its model.** A pool member
 *   offers its own model ids, so the eligible set is the members whose roster
 *   contains the requested id; rotation happens within that set.
 *
 * Failure classes are the HTTP status the provider answered with, not a
 * WorkBuddy-specific classifier: 401/402/403 (credential refused, payment
 * required, forbidden), 404 (this gateway has no such route), 429 (throttled),
 * and 5xx (that gateway is broken) are properties of the provider and worth
 * another member. A 400 is a property of the request and would be refused
 * identically everywhere, so it stops the chain.
 *
 * @module workbuddy-bridge/standalone/provider-pool
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UpstreamErrorKind } from '../core/upstream.ts'
import {
  createLoopbackEndpoint,
  isJsonContentType,
  readBody,
  writeJson,
  writeOpenAIError,
  type LoopbackEndpoint,
} from '../core/shim.ts'
import {
  startUpstreamTurn,
  writeUpstreamTurn,
  type UpstreamErrorPayload,
  type UpstreamTurnResponse,
} from './openai-provider.ts'
import type { WorkBuddyPoolAttempt, WorkBuddyPoolMemberHealth } from './pool.ts'

/** The published provider id of the pool endpoint. */
export const CUSTOM_POOL_ID = 'custom-pool'

/** One provider the pool can route to. */
export interface CustomPoolMember {
  id: string
  displayName: string
  /** Full API prefix; `/chat/completions` is appended per attempt. */
  baseUrl: string
  /** Model ids this provider offers. */
  models: readonly string[]
  /** A stored key, captured with the configuration (managed providers). */
  apiKey?: string
  /** An environment variable resolved per request (externally configured). */
  apiKeyEnv?: string
  /**
   * Whether the page may edit this member. False for a provider that came
   * from the caller's configuration file: it is read-only there.
   */
  managed: boolean
}

/**
 * One provider frozen for a single request, its credential resolved.
 *
 * Captured before the request body is read, so a concurrent edit can never
 * give one turn a half-old configuration — the defect the single-provider
 * shim already guards against, here applied to the whole member list.
 */
export interface CapturedPoolMember extends CustomPoolMember {
  /** The key this request would send, when one is available. */
  key?: string
  /** The environment variable that was not set, when a key was required. */
  missingEnv?: string
}

/** A request the pool refuses before any provider is attempted. */
export class CustomPoolRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'CustomPoolRequestError'
  }
}

/** Whether this provider can authenticate right now. */
export function poolMemberAvailable(member: CustomPoolMember): boolean {
  if (member.apiKey !== undefined && member.apiKey !== '') return true
  if (member.apiKeyEnv === undefined) return true
  const value = process.env[member.apiKeyEnv]
  return value !== undefined && value !== ''
}

/**
 * Freeze the member list for one request, resolving each provider's
 * credential exactly once. A stored key is copied by value; an environment
 * name is resolved here rather than at attempt time, so the credential and
 * the destination travel together.
 */
export function capturePoolMembers(
  members: readonly CustomPoolMember[],
  resolveEnv: (name: string) => string | undefined = name => process.env[name],
): CapturedPoolMember[] {
  return members.map(member => {
    if (member.apiKey !== undefined && member.apiKey !== '') {
      return { ...member, key: member.apiKey }
    }
    if (member.apiKeyEnv !== undefined) {
      const value = resolveEnv(member.apiKeyEnv)
      return value === undefined || value === ''
        ? { ...member, missingEnv: member.apiKeyEnv }
        : { ...member, key: value }
    }
    return { ...member }
  })
}

/**
 * The models the pool can actually serve: the union of every available
 * provider's roster, in member order, deduplicated. A provider whose key is
 * missing contributes nothing, because a request routed to it could only
 * fail — the same rule the single-provider endpoint applies.
 */
export function poolModelList(members: readonly CustomPoolMember[]): string[] {
  const seen = new Set<string>()
  for (const member of members) {
    if (!poolMemberAvailable(member)) continue
    for (const model of member.models) seen.add(model)
  }
  return [...seen]
}

/** The failure class a provider's HTTP status belongs to. */
export function errorKindForStatus(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'session_dead'
  if (status === 402) return 'hard_credit'
  if (status === 404) return 'not_found'
  if (status === 429) return 'soft_rate'
  if (status >= 500) return 'server'
  return 'client'
}

/** What one attempted provider produced. */
export type PoolAttemptResult<T> =
  | { state: 'ok'; value: T }
  | { state: 'credential-error'; message: string }
  | {
    state: 'upstream-error'
    status: number
    kind: UpstreamErrorKind
    message: string
    error: UpstreamErrorPayload
    retryable: boolean
  }

/** The verdict of one routed request: the winner, or the last failure. */
export interface PoolRouteOutcome<T> {
  value?: T
  failure?: {
    status: number
    kind: UpstreamErrorKind
    message: string
    error: UpstreamErrorPayload
  }
  /** Every provider tried, in attempt order — the chain the UI renders. */
  attempts: WorkBuddyPoolAttempt[]
}

/** Per-provider traffic record, kept across membership edits. */
interface MemberRecord {
  lastAttemptAtMs: number
  lastOutcome?: WorkBuddyPoolAttempt['outcome']
  consecutiveFailures: number
  successes: number
  failures: number
}

/**
 * The router behind the pool endpoint.
 *
 * Holds no listeners and no credentials of its own: it owns only the routing
 * state — who answers next and what each provider has done — while the
 * endpoint owns the listener and the transport. Membership is passed in on
 * every call rather than stored, so a page view can never move the head or
 * describe a list the next request would not see.
 */
export class CustomProviderFailoverPool {
  /** Where the next request starts, by id so a membership edit cannot move it. */
  private headMemberId: string | undefined
  private readonly observed = new Map<string, MemberRecord>()

  /** Drop routing state for providers that are no longer members. */
  prune(members: readonly CustomPoolMember[]): void {
    const present = new Set(members.map(member => member.id))
    for (const id of [...this.observed.keys()]) {
      if (!present.has(id)) this.observed.delete(id)
    }
    if (this.headMemberId !== undefined && !present.has(this.headMemberId)) {
      this.headMemberId = undefined
    }
  }

  /** The member that will answer the next request, 0-based. */
  headIndex(members: readonly CustomPoolMember[]): number {
    if (this.headMemberId === undefined) return 0
    const index = members.findIndex(member => member.id === this.headMemberId)
    return index < 0 ? 0 : index
  }

  /** One record per member, in member order. */
  memberHealth(members: readonly CustomPoolMember[]): readonly WorkBuddyPoolMemberHealth[] {
    return members.map((member, index) => {
      const record = this.observed.get(member.id)
      return {
        index,
        lastAttemptAtMs: record?.lastAttemptAtMs ?? 0,
        ...record?.lastOutcome === undefined ? {} : { lastOutcome: record.lastOutcome },
        consecutiveFailures: record?.consecutiveFailures ?? 0,
        successes: record?.successes ?? 0,
        failures: record?.failures ?? 0,
      }
    })
  }

  /**
   * Send one request through the pool.
   *
   * `members` is the request's own captured snapshot, so the routing decision
   * and the credential always come from the same instant. Returns the first
   * success, otherwise the last failure; a non-retryable failure stops the
   * chain because every other provider would answer it identically.
   */
  async route<T>(
    members: readonly CapturedPoolMember[],
    model: string,
    attempt: (member: CapturedPoolMember, index: number) => Promise<PoolAttemptResult<T>>,
    signal?: AbortSignal,
  ): Promise<PoolRouteOutcome<T>> {
    this.prune(members)
    const offering = members.filter(member => member.models.includes(model))
    if (offering.length === 0) {
      throw new CustomPoolRequestError(400, 'model is not offered by any provider in the pool')
    }
    const attempts: WorkBuddyPoolAttempt[] = []
    let last: PoolRouteOutcome<T>['failure']
    for (const member of this.rotation(offering, members)) {
      // A caller that hung up mid-failover must not burn through the rest of
      // the pool on a request nobody is waiting for any more.
      if (signal?.aborted === true) {
        return {
          attempts,
          failure: last ?? {
            status: 499,
            kind: 'client',
            message: 'the request was cancelled before a provider could answer',
            error: { message: 'the client cancelled the request', type: 'cancelled' },
          },
        }
      }
      const index = members.findIndex(candidate => candidate.id === member.id)
      if (member.missingEnv !== undefined) {
        // Known before the call: name the variable, never a value.
        const message = `the API key environment variable ${member.missingEnv} is not set`
        const outcome: WorkBuddyPoolAttempt['outcome'] = { state: 'credential-error', message }
        last = { status: 503, kind: 'session_dead', message, error: { message, type: 'api_key_missing' } }
        this.note(member.id, outcome)
        attempts.push({ index, outcome })
        continue
      }
      const result = await attempt(member, index)
      if (result.state === 'ok') {
        // Stick: a healthy provider keeps serving until it fails.
        this.headMemberId = member.id
        const outcome: WorkBuddyPoolAttempt['outcome'] = { state: 'ok' }
        this.note(member.id, outcome)
        attempts.push({ index, outcome })
        return { value: result.value, attempts }
      }
      const outcome: WorkBuddyPoolAttempt['outcome'] = result.state === 'credential-error'
        ? { state: 'credential-error', message: result.message }
        : { state: 'upstream-error', status: result.status, kind: result.kind, message: result.message }
      last = result.state === 'credential-error'
        ? {
          status: 503,
          kind: 'session_dead',
          message: result.message,
          error: { message: result.message, type: 'api_key_missing' },
        }
        : { status: result.status, kind: result.kind, message: result.message, error: result.error }
      this.note(member.id, outcome)
      attempts.push({ index, outcome })
      if (result.state === 'upstream-error' && !result.retryable) return { attempts, failure: last }
    }
    return {
      attempts,
      failure: last ?? {
        status: 503,
        kind: 'server',
        message: 'the provider pool has no member to answer',
        error: { message: 'the provider pool has no member to answer', type: 'pool_empty' },
      },
    }
  }

  /**
   * The eligible providers in attempt order: rotation starts at the head and
   * wraps, so the head's preference survives a model that only some members
   * offer.
   */
  private rotation(
    offering: readonly CapturedPoolMember[],
    members: readonly CapturedPoolMember[],
  ): CapturedPoolMember[] {
    const start = this.headIndex(members)
    const distance = (member: CapturedPoolMember): number => {
      const index = members.findIndex(candidate => candidate.id === member.id)
      if (index < 0) return Number.MAX_SAFE_INTEGER
      return (index - start + members.length) % members.length
    }
    return [...offering].sort((left, right) => distance(left) - distance(right))
  }

  /** Fold one attempt into that provider's record. */
  private note(id: string, outcome: WorkBuddyPoolAttempt['outcome']): void {
    const record = this.observed.get(id) ?? {
      lastAttemptAtMs: 0,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
    }
    record.lastAttemptAtMs = Date.now()
    record.lastOutcome = outcome
    if (outcome.state === 'ok') {
      record.successes += 1
      record.consecutiveFailures = 0
    } else {
      record.failures += 1
      record.consecutiveFailures += 1
    }
    this.observed.set(id, record)
  }
}

/** One routed turn, as the host records it. Metadata only. */
export interface CustomPoolTurnRecord {
  endpoint: string
  model: string
  status: number
  outcome: 'ok' | 'error'
  durationMs: number
  /** Every provider tried, in attempt order. */
  attempts: readonly WorkBuddyPoolAttempt[]
  /** The member labels the attempts' indices refer to. */
  labels: readonly string[]
}

/** Constructor dependencies of {@link createCustomProviderPoolShim}. */
export interface CustomProviderPoolOptions {
  /**
   * The member list, read per request. The bridge returns its current
   * configuration snapshot here; the shim captures it before reading the
   * body, so one turn never spans two configurations.
   */
  getMembers: () => readonly CustomPoolMember[]
  resolveApiKeyEnv?: (name: string) => string | undefined
  /** How long one provider may take to send response headers. */
  headersTimeoutMs?: number
  /** Called once per routed turn with the failover chain. */
  onTurn?: (record: CustomPoolTurnRecord) => void
  /** Upstream stream failures, for the host log. */
  onStreamError?: (error: unknown) => void
  /** Preferred loopback port; a taken port falls back to an ephemeral one. */
  port?: number
  /** Preferred bearer secret; absent means a fresh random one for this process. */
  token?: string
}

export type CustomProviderPoolShim = LoopbackEndpoint & {
  /**
   * The router actually serving this listener. The host reads routing state
   * from here — a second router instance would report a head and traffic
   * counts that no request ever produced.
   */
  router: CustomProviderFailoverPool
}

/**
 * Start the pool endpoint: one loopback listener over every custom provider.
 *
 * The listener is permanent for the life of the bridge. Adding, editing, or
 * removing a provider swaps the member list the shim reads, so no provider
 * change ever opens or closes a port, and the published base URL and local
 * token stay stable across edits.
 */
export function createCustomProviderPoolShim(options: CustomProviderPoolOptions): CustomProviderPoolShim {
  const resolveEnv = options.resolveApiKeyEnv ?? ((name: string) => process.env[name])
  const pool = new CustomProviderFailoverPool()

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()
    // One immutable member/credential snapshot for this whole request, taken
    // before the body is read.
    const members = capturePoolMembers(options.getMembers(), resolveEnv)
    const finish = (outcome: 'ok' | 'error', status: number, model: string, attempts: readonly WorkBuddyPoolAttempt[]): void => {
      options.onTurn?.({
        endpoint: CUSTOM_POOL_ID,
        model,
        status,
        outcome,
        durationMs: Date.now() - startedAt,
        attempts,
        labels: members.map(member => member.displayName),
      })
    }

    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      finish('error', 415, '', [])
      return
    }
    let raw: string
    try {
      raw = (await readBody(req, { destroyOnLimit: false })).toString('utf8')
    } catch (error: unknown) {
      writeOpenAIError(res, 413, 'request_too_large', String(error))
      finish('error', 413, '', [])
      return
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      writeOpenAIError(res, 400, 'invalid_request', 'request body must be valid JSON')
      finish('error', 400, '', [])
      return
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      writeOpenAIError(res, 400, 'invalid_request', 'request body must be a JSON object')
      finish('error', 400, '', [])
      return
    }
    const requestedModel = (body as { model?: unknown }).model
    const model = typeof requestedModel === 'string' ? requestedModel : ''
    if (model === '' || !members.some(member => member.models.includes(model))) {
      // The raw model string is client input and may carry anything; only a
      // fixed marker reaches the log hook.
      writeOpenAIError(res, 400, 'model_not_configured', 'model is not offered by any provider in the pool')
      finish('error', 400, '', [])
      return
    }

    // Late client cancellation must reach the upstream stream too; the
    // response's 'close' without an end is the reliable downstream-gone
    // signal once the request body has been consumed.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    let outcome: PoolRouteOutcome<UpstreamTurnResponse>
    try {
      outcome = await pool.route(members, model, async member => {
        const turn = await startUpstreamTurn(
          { baseUrl: member.baseUrl, ...(member.key === undefined ? {} : { apiKey: member.key }) },
          raw,
          { signal: controller.signal, ...options.headersTimeoutMs === undefined ? {} : { headersTimeoutMs: options.headersTimeoutMs } },
        )
        if (turn.kind === 'response') return { state: 'ok', value: turn }
        if (turn.reason === 'cancelled') {
          return {
            state: 'upstream-error',
            status: turn.status,
            kind: 'client',
            message: turn.error.message,
            error: turn.error,
            retryable: false,
          }
        }
        return {
          state: 'upstream-error',
          status: turn.status,
          kind: errorKindForStatus(turn.upstreamStatus ?? turn.status),
          message: turn.error.message,
          error: turn.error,
          retryable: turn.retryable,
        }
      }, controller.signal)
    } catch (error: unknown) {
      if (error instanceof CustomPoolRequestError) {
        writeOpenAIError(res, error.status, 'model_not_configured', error.message)
        finish('error', error.status, model, [])
        return
      }
      throw error
    }

    if (outcome.value !== undefined) {
      await writeUpstreamTurn(res, outcome.value, options.onStreamError)
      finish('ok', outcome.value.status, model, outcome.attempts)
      return
    }
    const failure = outcome.failure!
    // `cancelled` writes nothing: the client that would read it is gone.
    if (failure.status !== 499) writeJson(res, failure.status, { error: failure.error })
    finish('error', failure.status, model, outcome.attempts)
  }

  const endpoint = createLoopbackEndpoint({
    listModels: () => poolModelList(options.getMembers()).map(id => ({ id, ownedBy: CUSTOM_POOL_ID })),
    handleChat,
    serveModelsAlias: true,
    ...options.port === undefined ? {} : { port: options.port },
    ...options.token === undefined ? {} : { token: options.token },
  })
  return { ...endpoint, router: pool }
}
