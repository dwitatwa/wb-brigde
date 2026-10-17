/**
 * The account pool: one endpoint, several accounts, failover between them.
 *
 * The pool exists because a single account's quota is a single point of
 * failure: when it runs out of credits or trips a rate limit, every request
 * an agent pinned to it fails until the cycle resets. A pool endpoint
 * spreads that risk — requests enter through one shim, and the account that
 * answers is chosen per request, advancing to the next member whenever the
 * current one fails in a way another account could survive.
 *
 * Selection is sticky-with-rotation: the head member serves until it fails,
 * then the head moves to the next member for everyone after it. Success
 * keeps the head where it is, so a healthy account does not have its
 * requests scattered across the pool.
 *
 * Requests are stateless per turn upstream — each carries a fresh
 * conversation-header family — so two consecutive turns of one conversation
 * may legitimately be served by different accounts. That is the trade the
 * caller accepts by using a pool at all: pooled credits, but usage that is
 * correlated across accounts and harder to attribute per account.
 *
 * @module workbuddy-bridge/standalone/pool
 */

import type { WorkBuddyCredential } from '../core/auth.ts'
import type { WorkBuddyUpstreamClient, UpstreamErrorKind, WorkBuddyChatResult } from '../core/upstream.ts'

/**
 * The store surface the pool needs from each member. Structural, so tests
 * can stand in stubs; the real bridge passes each account runtime's pieces.
 */
export interface WorkBuddyPoolMember {
  /** Resolves this member's credential, refreshing it when due. */
  store: Pick<import('../core/auth.ts').WorkBuddyCredentialStore, 'resolve'>
  /** Sends this member's chat turn upstream. */
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
}

/**
 * Upstream failure classes where a different account could plausibly
 * succeed, and are therefore worth failing over on:
 *
 * - `hard_credit` — this account's quota is gone; another account's is not
 * - `soft_rate` — this account is throttled; another is not
 * - `session_dead` — this credential cannot be renewed; another may be fine
 * - `server` — a 5xx may be account-scoped (per-account channel state), and
 *   retrying the identical request on another account is what the upstream's
 *   own 「请重新发送」 advice asks for
 *
 * Everything else stays on the failing member: a `client` (400) failure is a
 * property of the *request*, so every account would answer it identically,
 * and a transport error is a property of the *network*, which is shared.
 */
export const POOL_FAILOVER_KINDS: ReadonlySet<UpstreamErrorKind> = new Set([
  'hard_credit',
  'soft_rate',
  'session_dead',
  'server',
])

/** Why a pool member could not be attempted, surfaced for diagnosis. */
export interface WorkBuddyPoolAttempt {
  /** Position in the member list, 0-based. */
  index: number
  /** What this member's attempt produced, or why it was skipped. */
  outcome:
    | { state: 'ok' }
    | { state: 'credential-error'; message: string }
    | { state: 'upstream-error'; status: number; kind: UpstreamErrorKind; message: string }
}

/**
 * What the pool has observed about one member's traffic.
 *
 * Exists for the UI: a pool is one endpoint over several accounts, so the
 * only way an operator can see *which* account is carrying the load — or
 * which one has started failing — is for the router to remember. Counts are
 * since process start; nothing here is persisted, because a restart genuinely
 * resets the head and the evidence that shaped it.
 */
export interface WorkBuddyPoolMemberHealth {
  /** Position in the member list, 0-based — what a test request names. */
  index: number
  /** When this member was last attempted, or 0 before any traffic. */
  lastAttemptAtMs: number
  /** The last attempt's outcome, or undefined before any traffic. */
  lastOutcome?: WorkBuddyPoolAttempt['outcome']
  /** Failures since this member last succeeded; what makes it look unhealthy. */
  consecutiveFailures: number
  /** Turns this member served successfully. */
  successes: number
  /** Attempts on this member that failed. */
  failures: number
}

/** Compact message text for a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error)
}

/**
 * One pool endpoint's request router.
 *
 * Implements the two pieces the shim consumes — `store.resolve()` and
 * `client.chatStream()` — over the member list. `resolve()` exists only as
 * the shim's signed-in existence check: it answers with the head member's
 * credential when any member has one, so a pool where every account is
 * signed out still produces the shim's 401 rather than a confused 500. The
 * real per-attempt credential resolution happens inside {@link chatStream}.
 */
export class WorkBuddyFailoverPool {
  /** Where the next request starts; advances past failed members. */
  private head = 0
  /** Per-member traffic record, parallel to `members`. */
  private readonly observed: WorkBuddyPoolMemberHealth[]

  constructor(private readonly members: readonly WorkBuddyPoolMember[]) {
    if (members.length === 0) throw new Error('a failover pool needs at least one account')
    this.observed = members.map((_member, index) => ({
      index,
      lastAttemptAtMs: 0,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
    }))
  }

  /** How many accounts the pool can draw from. */
  get size(): number {
    return this.members.length
  }

  /** The member that will answer the next request, 0-based. */
  headIndex(): number {
    return this.head
  }

  /** A copy of each member's traffic record, in member order. */
  memberHealth(): readonly WorkBuddyPoolMemberHealth[] {
    return this.observed.map(entry => ({ ...entry }))
  }

  /** The shim's signed-in existence check: any member's credential will do. */
  async resolve(): Promise<WorkBuddyCredential> {
    let lastError: unknown
    for (let offset = 0; offset < this.members.length; offset += 1) {
      const member = this.members[(this.head + offset) % this.members.length]!
      try {
        return await member.store.resolve()
      } catch (error: unknown) {
        lastError = error
      }
    }
    throw lastError ?? new Error('the account pool is empty')
  }

  /**
   * Send one chat turn through the pool.
   *
   * The `credential` argument is the shim's resolved head credential and is
   * deliberately ignored: each attempt resolves its own member's credential,
   * because the whole point is that the answering account is chosen by the
   * failure pattern, not by whoever happened to be head when the request
   * arrived. Returns the first success; otherwise the last failure seen.
   */
  async chatStream(
    _credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
    onAttempt?: (attempt: WorkBuddyPoolAttempt) => void,
  ): Promise<WorkBuddyChatResult> {
    let last: WorkBuddyChatResult | undefined
    for (let offset = 0; offset < this.members.length; offset += 1) {
      // A caller that hung up mid-failover must not burn through the rest of
      // the pool on a request nobody is waiting for any more.
      if (signal?.aborted === true) {
        return last ?? { ok: false, status: 0, kind: 'server', message: 'transport error: request aborted before an account could answer' }
      }
      const index = (this.head + offset) % this.members.length
      const member = this.members[index]!
      let credential: WorkBuddyCredential
      try {
        credential = await member.store.resolve()
      } catch (error: unknown) {
        const outcome: WorkBuddyPoolAttempt['outcome'] = { state: 'credential-error', message: messageOf(error) }
        last = { ok: false, status: 401, kind: 'session_dead', message: messageOf(error) }
        this.note(index, outcome)
        onAttempt?.({ index, outcome })
        continue
      }
      const result = await member.client.chatStream(credential, bodyJson, signal)
      if (result.ok) {
        // Stick: a healthy member keeps serving until it fails.
        this.head = index
        const outcome: WorkBuddyPoolAttempt['outcome'] = { state: 'ok' }
        this.note(index, outcome)
        onAttempt?.({ index, outcome })
        return result
      }
      last = result
      const outcome: WorkBuddyPoolAttempt['outcome'] = {
        state: 'upstream-error',
        status: result.status,
        kind: result.kind,
        message: result.message,
      }
      this.note(index, outcome)
      onAttempt?.({ index, outcome })
      if (!POOL_FAILOVER_KINDS.has(result.kind)) return result
    }
    return last ?? { ok: false, status: 0, kind: 'server', message: 'the account pool is empty' }
  }

  /**
   * Fold one attempt into that member's record.
   *
   * Recorded by the router itself rather than by the caller's `onAttempt`
   * hook, because the UI reads it whether or not anybody is listening to the
   * hook — and a record that only exists when a diagnostic is attached would
   * be empty exactly when an operator first opens the page.
   */
  private note(index: number, outcome: WorkBuddyPoolAttempt['outcome']): void {
    const entry = this.observed[index]
    if (entry === undefined) return
    entry.lastAttemptAtMs = Date.now()
    entry.lastOutcome = outcome
    if (outcome.state === 'ok') {
      entry.successes += 1
      entry.consecutiveFailures = 0
      return
    }
    entry.failures += 1
    entry.consecutiveFailures += 1
  }
}
