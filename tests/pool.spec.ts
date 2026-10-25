import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkBuddyCredential } from '../src/core/auth.ts'
import type { WorkBuddyChatResult } from '../src/core/upstream.ts'
import { AI_VARIANT } from '../src/core/variants.ts'
import type { ChatProbeResult, MemberProbeOptions } from '../src/standalone/account-probe.ts'
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

  /**
   * The UI's member table is only useful if the router remembers what it saw,
   * so these pin the record rather than any rendering: who served, who failed,
   * how badly, and where the head ended up.
   */
  it('records each member\'s traffic and where the head moved', async () => {
    const first = member([upstreamFail('hard_credit', 402)])
    const second = member([ok(), ok()])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])
    expect(pool.headIndex()).toBe(0)

    await pool.chatStream(CREDENTIAL, '{}')

    const health = pool.memberHealth()
    expect(pool.headIndex()).toBe(1)
    expect(health[0]).toMatchObject({ index: 0, successes: 0, failures: 1, consecutiveFailures: 1 })
    expect(health[0]?.lastOutcome).toMatchObject({ state: 'upstream-error', kind: 'hard_credit', status: 402 })
    expect(health[0]?.lastAttemptAtMs).toBeGreaterThan(0)
    expect(health[1]).toMatchObject({ index: 1, successes: 1, failures: 0, consecutiveFailures: 0 })
    expect(health[1]?.lastOutcome).toEqual({ state: 'ok' })
  })

  it('resets the consecutive-failure streak once a member succeeds again', async () => {
    const first = member([upstreamFail('soft_rate', 429), ok()])
    const second = member([upstreamFail('soft_rate', 429)])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])

    // Everyone fails: the head does not move, because nobody succeeded.
    await pool.chatStream(CREDENTIAL, '{}')
    expect(pool.headIndex()).toBe(0)
    expect(pool.memberHealth().map(entry => entry.consecutiveFailures)).toEqual([1, 1])

    // The same head answers next and succeeds, so its streak clears.
    await pool.chatStream(CREDENTIAL, '{}')
    expect(pool.memberHealth().map(entry => entry.consecutiveFailures)).toEqual([0, 1])
    expect(pool.memberHealth()[0]?.successes).toBe(1)
  })
})

/** Write one desktop auth file for the AI product and return its path. */
async function authFile(nickname: string, uid: string): Promise<string> {
  const path = join(home!, `auth-${uid}.info`)
  await writeFile(path, JSON.stringify({
    auth: { accessToken: `token-${uid}`, expiresAt: 4_102_344_000, domain: 'www.workbuddy.ai' },
    account: { nickname, uid },
  }), 'utf8')
  return path
}

describe('the pool endpoint in the bridge', () => {
  it('is the product\'s only endpoint, however many accounts serve it, and shuts down with the bridge', async () => {
    home = await mkdtemp(join(tmpdir(), 'wb-pool-'))
    process.env['WORKBUDDY_BRIDGE_HOME'] = home
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      variants: [AI_VARIANT],
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    try {
      const descriptor = await bridge.start()
      // One endpoint for the product: the pool. There are no per-account
      // endpoints to configure alongside it, and the pool's port and token
      // are its own.
      expect(descriptor.endpoints.length).toBe(1)
      expect(descriptor.endpoints[0]!.provider).toBe('workbuddy-ai-pool')
      expect(descriptor.endpoints[0]!.displayName).toContain('pool')
      expect(descriptor.endpoints[0]!.signedIn).toBe(true)
    } finally {
      await bridge.close()
      const ports = bridge.endpoints()
      expect(ports).toEqual([])
    }
  })

  it('serves one account through the pool, without per-account endpoints', async () => {
    home = await mkdtemp(join(tmpdir(), 'wb-pool-'))
    process.env['WORKBUDDY_BRIDGE_HOME'] = home
    const only = await authFile('alice', 'uid-a')
    const bridge = new WorkBuddyBridge({
      variants: [AI_VARIANT],
      authFiles: new Map([['workbuddy-ai', [only]]]),
    })
    try {
      const descriptor = await bridge.start()
      expect(descriptor.endpoints.map(endpoint => endpoint.provider)).toEqual(['workbuddy-ai-pool'])
      const state = await bridge.uiState()
      const pool = state.endpoints[0]!
      expect(pool.pool!.members.map(member => member.label)).toEqual(['alice'])
      expect(pool.pool!.headIndex).toBe(0)
    } finally {
      await bridge.close()
    }
  })
})

/**
 * The UI surface of a pool: what each member row knows, and what the test
 * button actually does. The probe is injected throughout — the real one talks
 * to the upstream, and what is worth pinning here is the *routing* (which
 * endpoint and which token a member test uses, and that it leaves the head
 * alone), not the upstream's answer.
 */
describe('the pool\'s UI surface', () => {
  /** A bridge over two AI accounts with a failover pool. */
  async function twoAccountBridge(
    probe: (options: MemberProbeOptions) => Promise<ChatProbeResult>,
  ): Promise<WorkBuddyBridge> {
    home = await mkdtemp(join(tmpdir(), 'wb-pool-ui-'))
    process.env['WORKBUDDY_BRIDGE_HOME'] = home
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    return new WorkBuddyBridge({
      variants: [AI_VARIANT],
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
      probe,
    })
  }

  const passingProbe = async (): Promise<ChatProbeResult> =>
    ({ ok: true, status: 200, latencyMs: 12, detail: 'HTTP 200, terminated' })

  it('shows every member, labelled by nickname, with the head marked', async () => {
    const bridge = await twoAccountBridge(passingProbe)
    try {
      await bridge.start()
      const state = await bridge.uiState()
      const pool = state.endpoints.find(endpoint => endpoint.provider === 'workbuddy-ai-pool')
      expect(pool?.pool?.members.map(member => member.label)).toEqual(['alice', 'bob'])
      expect(pool?.pool?.members.map(member => member.index)).toEqual([0, 1])
      expect(pool?.pool?.headIndex).toBe(0)
      expect(pool?.pool?.members.map(member => member.head)).toEqual([true, false])
      expect(pool?.pool?.members.every(member => member.signedIn)).toBe(true)
      // No traffic has been routed yet, so every count is zero and there is no
      // last attempt to describe.
      expect(pool?.pool?.members.map(member => [member.successes, member.failures])).toEqual([[0, 0], [0, 0]])
      expect(pool?.pool?.members[0]?.lastOutcome).toBeUndefined()
      expect(pool?.pool?.members[0]?.lastAttemptAtMs).toBeUndefined()
      // Members have no own endpoints since per-account endpoints were removed.
      expect(pool?.pool?.members.every(member => member.baseUrl === undefined)).toBe(true)
      // The log is wired per endpoint and starts empty — it is filled by real
      // turns, which this test deliberately does not send.
      expect(pool?.requests).toEqual([])
    } finally {
      await bridge.close()
    }
  })

  it('tests a member through the account\'s own upstream path, leaving the head alone', async () => {
    const seen: MemberProbeOptions[] = []
    const bridge = await twoAccountBridge(async options => {
      seen.push(options)
      return { ok: true, status: 200, latencyMs: 9, detail: 'HTTP 200' }
    })
    try {
      await bridge.start()
      const result = await bridge.probePoolMember({ provider: 'workbuddy-ai-pool', index: 1 })

      expect(result).toMatchObject({ provider: 'workbuddy-ai-pool', index: 1, label: 'bob', ok: true })
      // The probe runs in process through bob's own chat path (no HTTP
      // endpoint involved) and carries the model it asked about.
      expect(seen[0]?.sendTurn).toBeDefined()
      expect(seen[0]?.baseUrl).toBeUndefined()
      expect(seen[0]?.model).toBe(result.model)

      // A manual test is an observation, not a routing decision.
      const state = await bridge.uiState()
      expect(state.endpoints.find(endpoint => endpoint.provider === 'workbuddy-ai-pool')?.pool?.headIndex).toBe(0)
    } finally {
      await bridge.close()
    }
  })

  it('reports a failed turn as a result, not as an error', async () => {
    const bridge = await twoAccountBridge(async () => ({
      ok: false,
      status: 402,
      latencyMs: 30,
      detail: 'HTTP 402: quota exhausted',
    }))
    try {
      await bridge.start()
      await expect(bridge.probePoolMember({ provider: 'workbuddy-ai-pool', index: 0 }))
        .resolves.toMatchObject({ ok: false, status: 402, detail: 'HTTP 402: quota exhausted' })
    } finally {
      await bridge.close()
    }
  })

  it('refuses an unknown pool, an unknown member and an unknown model', async () => {
    const bridge = await twoAccountBridge(passingProbe)
    try {
      await bridge.start()
      await expect(bridge.probePoolMember({ provider: 'workbuddy', index: 0 }))
        .rejects.toMatchObject({ status: 404 })
      await expect(bridge.probePoolMember({ provider: 'workbuddy-ai-pool', index: 5 }))
        .rejects.toMatchObject({ status: 404 })
      await expect(bridge.probePoolMember({ provider: 'workbuddy-ai-pool', index: 0, model: 'no-such-model' }))
        .rejects.toMatchObject({ status: 400 })
    } finally {
      await bridge.close()
    }
  })

  it('refuses a second concurrent test of the same account', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const bridge = await twoAccountBridge(async () => {
      await gate
      return { ok: true, status: 200, latencyMs: 1, detail: 'HTTP 200' }
    })
    try {
      await bridge.start()
      const first = bridge.probePoolMember({ provider: 'workbuddy-ai-pool', index: 0 })
      await expect(bridge.probePoolMember({ provider: 'workbuddy-ai-pool', index: 0 }))
        .rejects.toMatchObject({ status: 409 })
      release?.()
      await expect(first).resolves.toMatchObject({ ok: true })
      // The guard is released, so the next test of the same account runs.
      await expect(bridge.probePoolMember({ provider: 'workbuddy-ai-pool', index: 0 }))
        .resolves.toMatchObject({ ok: true })
    } finally {
      await bridge.close()
    }
  })
})
