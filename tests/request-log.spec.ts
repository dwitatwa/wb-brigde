import { describe, expect, it } from 'vitest'
import type { WorkBuddyPoolAttempt } from '../src/standalone/pool.ts'
import {
  attemptRecord,
  modelOfBody,
  WorkBuddyRequestLog,
  type WorkBuddyRequestAttempt,
} from '../src/standalone/request-log.ts'

/**
 * The request log is metadata-only evidence: what an agent sent, where it went,
 * what came back. These pin the two properties that make it safe to put on an
 * unauthenticated page — it holds no prompt, and it cannot grow — plus the
 * chain compaction that makes a pooled turn readable.
 */

describe('the request log', () => {
  it('keeps only the model name from the body, never the messages', () => {
    const body = JSON.stringify({
      model: 'model-x',
      messages: [
        { role: 'system', content: 'secret system prompt' },
        { role: 'user', content: 'secret question' },
      ],
    })
    expect(modelOfBody(body)).toBe('model-x')
  })

  it('answers "(unknown)" for a body that does not parse or names no model', () => {
    expect(modelOfBody('not json')).toBe('(unknown)')
    expect(modelOfBody('{}')).toBe('(unknown)')
    expect(modelOfBody('{"model":42}')).toBe('(unknown)')
    expect(modelOfBody('[]')).toBe('(unknown)')
  })

  it('drops the oldest entry when the ring is full', () => {
    const log = new WorkBuddyRequestLog(2)
    log.record({ endpoint: 'e', model: 'a', status: 200, outcome: 'ok', latencyMs: 1 })
    log.record({ endpoint: 'e', model: 'b', status: 200, outcome: 'ok', latencyMs: 1 })
    log.record({ endpoint: 'e', model: 'c', status: 200, outcome: 'ok', latencyMs: 1 })

    expect(log.size).toBe(2)
    expect(log.recent('e').map(row => row.model)).toEqual(['c', 'b'])
  })

  it('returns one endpoint\'s turns newest first, and nothing from another', () => {
    const log = new WorkBuddyRequestLog()
    log.record({ endpoint: 'workbuddy-ai#1', account: 'alice', model: 'a', status: 200, outcome: 'ok', latencyMs: 1 })
    log.record({ endpoint: 'workbuddy-ai-pool', model: 'b', status: 402, outcome: 'hard_credit', latencyMs: 2 })
    log.record({ endpoint: 'workbuddy-ai#1', account: 'alice', model: 'c', status: 200, outcome: 'ok', latencyMs: 3 })

    const alice = log.recent('workbuddy-ai#1')
    expect(alice.map(row => row.model)).toEqual(['c', 'a'])
    expect(alice.every(row => row.account === 'alice')).toBe(true)
    expect(log.recent('workbuddy-ai-pool').map(row => row.model)).toEqual(['b'])
    // The two accounts of one product must not see each other's turns.
    expect(log.recent('workbuddy-ai#2')).toEqual([])
  })

  it('honours the per-card row limit without dropping the newest', () => {
    const log = new WorkBuddyRequestLog()
    for (let index = 0; index < 5; index += 1) {
      log.record({ endpoint: 'e', model: `m${index}`, status: 200, outcome: 'ok', latencyMs: 1 })
    }
    expect(log.recent('e', 2).map(row => row.model)).toEqual(['m4', 'm3'])
  })

  it('gives every entry its own id, even when two turns look identical', () => {
    const log = new WorkBuddyRequestLog()
    const first = log.record({ endpoint: 'e', model: 'm', status: 200, outcome: 'ok', latencyMs: 1 })
    const second = log.record({ endpoint: 'e', model: 'm', status: 200, outcome: 'ok', latencyMs: 1 })
    expect(second.id).toBeGreaterThan(first.id)
    expect(second.atMs).toBeGreaterThanOrEqual(first.atMs)
  })

  it('rejects a ring that cannot hold anything', () => {
    expect(() => new WorkBuddyRequestLog(0)).toThrow(/positive size/u)
  })
})

describe('pool attempt compaction', () => {
  const labels = (index: number): string => ['alice', 'bob'][index] ?? `account ${index + 1}`

  it('maps each attempt class and drops the upstream message', () => {
    const upstream: WorkBuddyPoolAttempt['outcome'] = {
      state: 'upstream-error',
      status: 402,
      kind: 'hard_credit',
      message: 'quota exhausted: access_token=super-secret',
    }
    expect(attemptRecord({ index: 0, outcome: upstream }, labels))
      .toEqual({ account: 'alice', outcome: 'hard_credit', status: 402 })

    expect(attemptRecord({ index: 1, outcome: { state: 'ok' } }, labels))
      .toEqual({ account: 'bob', outcome: 'ok' })

    expect(attemptRecord({ index: 1, outcome: { state: 'credential-error', message: 'no signed-in account' } }, labels))
      .toEqual({ account: 'bob', outcome: 'credential-error' })
  })

  it('leaves no message text anywhere in a recorded chain', () => {
    const log = new WorkBuddyRequestLog()
    const attempts: WorkBuddyRequestAttempt[] = [
      attemptRecord({ index: 0, outcome: { state: 'upstream-error', status: 429, kind: 'soft_rate', message: 'slow down' } }, labels),
      attemptRecord({ index: 1, outcome: { state: 'ok' } }, labels),
    ]
    log.record({ endpoint: 'e-pool', model: 'm', status: 200, outcome: 'ok', latencyMs: 5, attempts })

    expect(JSON.stringify(log.recent('e-pool'))).not.toContain('slow down')
  })
})
