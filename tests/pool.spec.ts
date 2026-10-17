import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/core/auth.ts'
import type { WorkBuddyChatResult } from '../src/core/upstream.ts'
import { WorkBuddyBridge } from '../src/standalone/bridge.ts'
import { POOL_FAILOVER_KINDS, WorkBuddyFailoverPool, type WorkBuddyPoolMember } from '../src/standalone/pool.ts'

/**
 * The failover pool: one endpoint over several accounts, advancing past a
 * member whose failure another account could survive. The rotator is
 * unit-tested against stub members because the interesting behaviour — which
 * failure kinds advance the head and which do not — is a property of the
 * router, not of the upstream; the bridge-level test then pins that the
 * endpoint actually appears and shuts down.
 */

const previousHome = process.env['WORKBUDDY_BRIDGE_HOME']
let home: string | undefined

afterEach(async () => {
  if (previousHome === undefined) delete process.env['WORKBUDDY_BRIDGE_HOME']
  else process.env['WORKBUDDY_BRIDGE_HOME'] = previousHome
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true })
    home = undefined
  }
})

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'token',
  refreshToken: '',
  expiresAtMs: Number.MAX_SAFE_INTEGER,
  domain: 'www.workbuddy.ai',
  uid: 'uid',
  source: 'desktop',
}

function ok(): WorkBuddyChatResult {
  return { ok: true, response: new Response('data: [DONE]\n\n', { status: 200 }) }
}

function upstreamFail(kind: 'hard_credit' | 'soft_rate' | 'session_dead' | 'server' | 'client' | 'not_found', status: number): WorkBuddyChatResult {
  return { ok: false, status, kind, message: `upstream ${kind}` }
}

function member(script: Array<WorkBuddyChatResult>, storeError?: Error): { member: WorkBuddyPoolMember; calls: Array<string> } {
  const calls: Array<string> = []
  return {
    calls,
    member: {
      store: {
        resolve: storeError === undefined ? async () => CREDENTIAL : async () => { throw storeError },
      },
      client: {
        chatStream: async () => {
          const next = script.shift()
          calls.push(next === undefined ? 'exhausted' : next.ok ? 'ok' : next.kind)
          return next ?? upstreamFail('server', 502)
        },
      },
    },
  }
}

describe('the failover rotator', () => {
  it('serves from the head and stays there while it succeeds', async () => {
    const first = member([ok(), ok()])
    const second = member([ok()])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])
    await pool.chatStream(CREDENTIAL, '{}')
    await pool.chatStream(CREDENTIAL, '{}')
    expect(first.calls).toEqual(['ok', 'ok'])
    expect(second.calls).toEqual([])
  })

  it('advances past a member that is out of credits, and sticks to the survivor', async () => {
    const first = member([upstreamFail('hard_credit', 402), upstreamFail('hard_credit', 402)])
    const second = member([ok(), ok()])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])
    const result = await pool.chatStream(CREDENTIAL, '{}')
    expect(result.ok).toBe(true)
    expect(first.calls).toEqual(['hard_credit'])
    expect(second.calls).toEqual(['ok'])
    // The head moved: the next request starts at the survivor without
    // re-sampling the dead account first.
    await pool.chatStream(CREDENTIAL, '{}')
    expect(first.calls).toEqual(['hard_credit'])
    expect(second.calls).toEqual(['ok', 'ok'])
  })

  it('fails over on every account-level kind', async () => {
    for (const kind of POOL_FAILOVER_KINDS) {
      const first = member([upstreamFail(kind, kind === 'session_dead' ? 401 : kind === 'soft_rate' ? 429 : kind === 'hard_credit' ? 402 : 502)])
      const second = member([ok()])
      const pool = new WorkBuddyFailoverPool([first.member, second.member])
      const result = await pool.chatStream(CREDENTIAL, '{}')
      expect(result.ok, kind).toBe(true)
      expect(second.calls, kind).toEqual(['ok'])
    }
  })

  it('does not fail over a request-level 400 — every account would refuse it identically', async () => {
    const first = member([upstreamFail('client', 400)])
    const second = member([ok()])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])
    const result = await pool.chatStream(CREDENTIAL, '{}')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: the pool must report the 400')
    expect(result.kind).toBe('client')
    expect(first.calls).toEqual(['client'])
    expect(second.calls).toEqual([])
  })

  it('wraps around and reports the last failure when every member fails', async () => {
    const first = member([upstreamFail('soft_rate', 429)])
    const second = member([upstreamFail('hard_credit', 402)])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])
    const result = await pool.chatStream(CREDENTIAL, '{}')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable: every member failed')
    // The last failure is the answer the caller sees: the pool tried
    // everyone, and inventing a better error than the real ones would only
    // hide which accounts are actually exhausted.
    expect(result.kind).toBe('hard_credit')
    expect(first.calls).toEqual(['soft_rate'])
    expect(second.calls).toEqual(['hard_credit'])
  })

  it('treats a member whose credential cannot resolve as failed and moves on', async () => {
    const first = member([], new Error('no signed-in account'))
    const second = member([ok()])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])
    const result = await pool.chatStream(CREDENTIAL, '{}')
    expect(result.ok).toBe(true)
    expect(first.calls).toEqual([])
    expect(second.calls).toEqual(['ok'])
  })

  it('stops burning members once the caller has aborted mid-failover', async () => {
    const first = member([upstreamFail('soft_rate', 429)])
    const second = member([ok()])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])
    const controller = new AbortController()
    controller.abort()
    const result = await pool.chatStream(CREDENTIAL, '{}', controller.signal)
    expect(result.ok).toBe(false)
    expect(first.calls).toEqual([])
    expect(second.calls).toEqual([])
  })

  it('answers the shim existence check from any member and 401s only when all are signed out', async () => {
    const dead = member([], new Error('no signed-in account'))
    const alive = member([ok()])
    const pool = new WorkBuddyFailoverPool([dead.member, alive.member])
    await expect(pool.resolve()).resolves.toMatchObject({ uid: 'uid' })

    const dead1 = member([], new Error('nope'))
    const dead2 = member([], new Error('also nope'))
    const allDead = new WorkBuddyFailoverPool([dead1.member, dead2.member])
    await expect(allDead.resolve()).rejects.toThrow('also nope')
  })
})

describe('the pool endpoint in the bridge', () => {
  async function authFile(nickname: string, uid: string): Promise<string> {
    const path = join(home!, `auth-${uid}.info`)
    await writeFile(path, JSON.stringify({
      auth: { accessToken: `token-${uid}`, expiresAt: 4_102_344_000, domain: 'www.workbuddy.ai' },
      account: { nickname, uid },
    }), 'utf8')
    return path
  }

  it('appears only for products with two or more accounts, and shuts down with the bridge', async () => {
    home = await mkdtemp(join(tmpdir(), 'wb-pool-'))
    process.env['WORKBUDDY_BRIDGE_HOME'] = home
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      variants: [{ ...(await import('../src/core/variants.ts')).AI_VARIANT }],
      pool: 'failover',
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    try {
      const descriptor = await bridge.start()
      const pools = descriptor.endpoints.filter(endpoint => endpoint.provider === 'workbuddy-ai-pool')
      expect(pools.length).toBe(1)
      expect(pools[0]!.displayName).toContain('pool')
      // The pool is a distinct endpoint: distinct port, distinct token, so
      // an agent pointed at it is configured against the pool, not against
      // whichever account happens to be head right now.
      const accounts = descriptor.endpoints.filter(endpoint => endpoint.provider === 'workbuddy-ai')
      expect(pools[0]!.baseUrl).not.toBe(accounts[0]!.baseUrl)
      expect(pools[0]!.token).not.toBe(accounts[0]!.token)
    } finally {
      await bridge.close()
    }
  })

  it('does not create a pool endpoint when the option is absent', async () => {
    home = await mkdtemp(join(tmpdir(), 'wb-pool-'))
    process.env['WORKBUDDY_BRIDGE_HOME'] = home
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    try {
      const descriptor = await bridge.start()
      expect(descriptor.endpoints.filter(endpoint => endpoint.provider.endsWith('-pool')).length).toBe(0)
    } finally {
      await bridge.close()
    }
  })
})
