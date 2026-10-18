/**
 * A bounded, in-memory log of the turns an agent sent through the bridge.
 *
 * A pool hides which account answered, and a single endpoint hides nothing but
 * says nothing either: without a log, "the pool is failing" is a claim with no
 * evidence behind it. This keeps exactly the evidence that answers it — when,
 * which endpoint, which account, which model, what came back, how long it
 * took, and for a pooled turn the failover chain — and nothing else.
 *
 * **Metadata only, by construction.** No prompt, no system message, no
 * completion, not even a preview: this log is rendered on the web UI, which is
 * loopback-only and unauthenticated, and conversation text is a bigger secret
 * than the bearer token that page is already designed not to see. The one
 * place request material is kept is `failure-capture.ts`, which writes a
 * single *failing* exchange to disk for diagnosis — a different job with a
 * different lifetime.
 *
 * In memory and bounded on purpose: a fixed ring means a long-running bridge
 * cannot grow, and a restart clears it in step with the pool's head and
 * failure streaks, so the log never describes routing state that no longer
 * exists.
 *
 * @module workbuddy-bridge/standalone/request-log
 */

import type { UpstreamErrorKind } from '../core/upstream.ts'
import type { WorkBuddyPoolAttempt } from './pool.ts'

/** How many turns one process remembers. */
export const REQUEST_LOG_LIMIT = 200

/** How many rows one endpoint's card shows. */
export const REQUEST_ROWS_PER_CARD = 20

/** One member's part in a pooled turn. */
export interface WorkBuddyRequestAttempt {
  /** The account's nickname, or a positional label. */
  account: string
  /** `ok`, a failure class, or the account's credential refusing to resolve. */
  outcome: 'ok' | 'credential-error' | UpstreamErrorKind
  /** The upstream's status for a failed attempt. */
  status?: number
}

/** One turn, as the log remembers it. */
export interface WorkBuddyRequestRecord {
  /** Monotonic id, so two identical-looking turns stay distinguishable. */
  id: number
  atMs: number
  /**
   * Stable key of the endpoint the agent addressed: `<provider>#<account>` for
   * an account endpoint, `<provider>-pool` for a pool. Two accounts of one
   * product share a provider id, so the account has to be part of the key.
   */
  endpoint: string
  /** The account that answered, for an endpoint that fronts one account. */
  account?: string
  model: string
  /** The upstream's status: 200 when the turn was accepted. */
  status: number
  outcome: 'ok' | UpstreamErrorKind
  /** Wall time until the shim had a verdict — the first byte, not the last. */
  latencyMs: number
  /** The failover chain, in attempt order; present only when more than one was tried. */
  attempts?: readonly WorkBuddyRequestAttempt[]
}

/** Pull `model` out of a request body without assuming it parses. */
export function modelOfBody(bodyJson: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyJson)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>)['model']
      if (typeof model === 'string' && model !== '') return model
    }
  } catch {
    // A body that does not parse is a request-level failure the caller will
    // see anyway; the model name is cosmetic here.
  }
  return '(unknown)'
}

/**
 * Flatten one pool attempt for the log.
 *
 * The attempt's message is dropped deliberately: it is upstream error text
 * that can echo request material, and `failure-capture.ts` already keeps it
 * for the failures that need it. What survives is the class and the status,
 * which is what makes a chain readable.
 */
export function attemptRecord(
  attempt: WorkBuddyPoolAttempt,
  labelOf: (index: number) => string,
): WorkBuddyRequestAttempt {
  const account = labelOf(attempt.index)
  switch (attempt.outcome.state) {
    case 'ok':
      return { account, outcome: 'ok' }
    case 'credential-error':
      return { account, outcome: 'credential-error' }
    case 'upstream-error':
      return { account, outcome: attempt.outcome.kind, status: attempt.outcome.status }
  }
}

/**
 * A fixed-size ring of recent turns, newest last.
 *
 * `record()` is called on the hot path of every request, so it does no I/O and
 * cannot throw: a log that fails a turn would be worse than no log.
 */
export class WorkBuddyRequestLog {
  private readonly entries: WorkBuddyRequestRecord[] = []
  private nextId = 1

  constructor(private readonly limit: number = REQUEST_LOG_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('a request log needs a positive size')
  }

  /** How many turns are remembered. */
  get size(): number {
    return this.entries.length
  }

  /** Add one turn, dropping the oldest when the ring is full. */
  record(input: Omit<WorkBuddyRequestRecord, 'id' | 'atMs'>): WorkBuddyRequestRecord {
    const entry: WorkBuddyRequestRecord = { id: this.nextId, atMs: Date.now(), ...input }
    this.nextId += 1
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    return entry
  }

  /** One endpoint's most recent turns, newest first. */
  recent(endpoint: string, limit: number = REQUEST_ROWS_PER_CARD): readonly WorkBuddyRequestRecord[] {
    const rows: WorkBuddyRequestRecord[] = []
    for (let index = this.entries.length - 1; index >= 0 && rows.length < limit; index -= 1) {
      const entry = this.entries[index]
      if (entry !== undefined && entry.endpoint === endpoint) rows.push(entry)
    }
    return rows
  }
}
