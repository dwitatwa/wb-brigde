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
 * **Membership is editable while running.** An account added from the page
 * joins the pool without a restart, so the head is tracked by the member's
 * identity rather than by position: appending or removing an account must not
 * silently redirect live traffic to a different one. Members that name no
 * identity keep the historical position-based behaviour.
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
  /**
   * A stable label for this member, used to keep the head on the same account
   * when the member list changes. Absent means the member is addressed by
   * position, which is what every pre-existing caller does.
   *
   * Must be unique among the members of one pool and must not change for the
   * life of the member; the account's uid is the natural choice.
   */
  id?: string
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
 * - `session_dead` — this credential cannot be renewed, or the gateway has
 *   restricted the account itself; another may be fine
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
 *
 * The member list is replaceable through {@link setMembers}, which is what
 * lets an account added from the page serve from the next request without the
 * listener being rebuilt. The head survives that call: it is stored as an
 * identity when members name one, so appending an account cannot move live
 * traffic onto it.
 */
export class WorkBuddyFailoverPool {
  /** Where the next request starts; advances past failed members. */
  private head = 0
  /** The identity the head belongs to, when the members name one. */
  private headId: string | undefined
  private members: readonly WorkBuddyPoolMember[]
  /** Per-member traffic record, parallel to `members`. */
  private observed: WorkBuddyPoolMemberHealth[]

  /**
   * An empty membership is allowed: accounts arrive only by upload, so a pool
   * exists before the first one does. Every request answers the shim's 401
   * until a member is added, which is the same state a pool whose every
   * account is signed out reports.
   */
  constructor(members: readonly WorkBuddyPoolMember[]) {
    this.members = members
    this.observed = WorkBuddyFailoverPool.freshRecords(members.length)
  }

  /** One all-zero traffic record per member. */
  private static freshRecords(count: number): WorkBuddyPoolMemberHealth[] {
    return Array.from({ length: count }, (_unused, index) => ({
      index,
      lastAttemptAtMs: 0,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
    }))
  }

  /**
   * Replace the member list, keeping the head on the same account.
   *
   * Traffic records follow a member's identity when it has one, so an account
   * that has already served keeps its success and failure counts across an
   * edit. A member with no identity is matched by position, which is the
   * behaviour every caller had before membership could change.
   *
   * An empty list is accepted: the last account can be removed from the page,
   * and the endpoint must survive that so the URL a client was configured with
   * keeps working once an account is added again.
   */
  setMembers(members: readonly WorkBuddyPoolMember[]): void {
    const previous = this.members
    const carried = new Map<string, WorkBuddyPoolMemberHealth>()
    for (const [index, member] of previous.entries()) {
      const record = this.observed[index]
      if (record === undefined) continue
      const id = member.id ?? `#${index}`
      carried.set(id, record)
    }
    this.members = members
    this.observed = members.map((member, index) => {
      const record = carried.get(member.id ?? `#${index}`)
      return {
        index,
        lastAttemptAtMs: record?.lastAttemptAtMs ?? 0,
        ...record?.lastOutcome === undefined ? {} : { lastOutcome: record.lastOutcome },
        consecutiveFailures: record?.consecutiveFailures ?? 0,
        successes: record?.successes ?? 0,
        failures: record?.failures ?? 0,
      }
    })
    // Re-anchor the head: by identity when the old head named one, otherwise
    // by position clamped to the new length.
    if (this.headId !== undefined) {
      const index = members.findIndex(member => member.id === this.headId)
      this.head = index < 0 ? 0 : index
      if (index < 0) this.headId = undefined
      return
    }
    this.head = members.length === 0 ? 0 : Math.min(this.head, members.length - 1)
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
   *
   * The member list is read once into a local, so a membership change mid-turn
   * cannot make one request see two different pools. The head start and the
   * traffic records are captured with it for the same reason: `setMembers`
   * replaces all three, and a turn that began before the change must finish
   * against the pool it started on.
   */
  async chatStream(
    _credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
    onAttempt?: (attempt: WorkBuddyPoolAttempt) => void,
  ): Promise<WorkBuddyChatResult> {
    const members = this.members
    const observed = this.observed
    const start = this.head
    let last: WorkBuddyChatResult | undefined
    for (let offset = 0; offset < members.length; offset += 1) {
      // A caller that hung up mid-failover must not burn through the rest of
      // the pool on a request nobody is waiting for any more.
      if (signal?.aborted === true) {
        return last ?? { ok: false, status: 0, kind: 'server', message: 'transport error: request aborted before an account could answer' }
      }
      const index = (start + offset) % members.length
      const member = members[index]!
      let credential: WorkBuddyCredential
      try {
        credential = await member.store.resolve()
      } catch (error: unknown) {
        const outcome: WorkBuddyPoolAttempt['outcome'] = { state: 'credential-error', message: messageOf(error) }
        last = { ok: false, status: 401, kind: 'session_dead', message: messageOf(error) }
        note(observed, index, outcome)
        onAttempt?.({ index, outcome })
        continue
      }
      const result = await member.client.chatStream(credential, bodyJson, signal)
      if (result.ok) {
        // Stick: a healthy member keeps serving until it fails. Only the live
        // pool is re-anchored — a turn that outlived a membership change must
        // not move the head of a list it no longer describes.
        if (this.members === members) {
          this.head = index
          this.headId = member.id
        }
        const outcome: WorkBuddyPoolAttempt['outcome'] = { state: 'ok' }
        note(observed, index, outcome)
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
      note(observed, index, outcome)
      onAttempt?.({ index, outcome })
      if (!POOL_FAILOVER_KINDS.has(result.kind)) return result
    }
    return last ?? { ok: false, status: 0, kind: 'server', message: 'the account pool is empty' }
  }

}

/**
 * Fold one attempt into that member's record.
 *
 * Recorded by the router itself rather than by the caller's `onAttempt`
 * hook, because the UI reads it whether or not anybody is listening to the
 * hook — and a record that only exists when a diagnostic is attached would
 * be empty exactly when an operator first opens the page.
 *
 * Takes the record array rather than reading `this`, so a turn that began
 * before a membership change writes to the records of the pool it started
 * on. `setMembers` carries those records forward by identity, so the write is
 * not lost when the turn outlives the change.
 */
function note(
  observed: WorkBuddyPoolMemberHealth[],
  index: number,
  outcome: WorkBuddyPoolAttempt['outcome'],
): void {
  const entry = observed[index]
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
