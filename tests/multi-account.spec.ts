import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyBridge } from '../src/standalone/bridge.ts'

/**
 * Several accounts of one product, served by one process.
 *
 * Each account is its own runtime — own store, own credential plane — while
 * the variant's catalog store stays shared, because its entries are keyed by
 * account identity already. The accounts have no endpoints of their own: the
 * product's failover pool is the only endpoint, whatever the account count,
 * so the URL an agent is configured with never changes when accounts come
 * and go. These tests pin the observable consequences of that split.
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

async function useTempHome(): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'wb-multi-'))
  process.env['WORKBUDDY_BRIDGE_HOME'] = home
}

/** Write a desktop auth file for a signed-in WorkBuddy AI account. */
async function authFile(nickname: string, uid: string): Promise<string> {
  const path = join(home!, `auth-${uid}.info`)
  await writeFile(path, JSON.stringify({
    auth: {
      accessToken: `token-${uid}`,
      // Far future, in seconds (`expiryToMs` multiplies values below 1e12).
      expiresAt: 4_102_344_000,
      domain: 'workbuddy.ai',
    },
    account: { nickname, uid },
  }), 'utf8')
  return path
}

function poolEndpoints(descriptor: { endpoints: Array<{ provider: string }> }): Array<Record<string, unknown>> {
  return descriptor.endpoints.filter(endpoint => endpoint.provider.endsWith('-pool')) as never
}

describe('one bridge process serving several accounts', () => {
  it('starts one pool endpoint per product with no options at all (default invocation)', async () => {
    await useTempHome()
    // No authFiles, no discovery: the ordinary `workbuddy-bridge serve` path.
    // The pool is the product's only endpoint, and it exists however many
    // accounts are signed in — here, none.
    const bridge = new WorkBuddyBridge()
    try {
      const descriptor = await bridge.start()
      expect(descriptor.endpoints.length).toBe(2)
      const providers = descriptor.endpoints.map(endpoint => endpoint.provider).sort()
      expect(providers).toEqual(['workbuddy-ai-pool', 'workbuddy-pool'])
      for (const endpoint of descriptor.endpoints) {
        expect(endpoint.displayName).toContain('pool')
      }
    } finally {
      await bridge.close()
    }
  })

  it('serves several auth files through one pool endpoint, one member each', async () => {
    await useTempHome()
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    try {
      const descriptor = await bridge.start()
      // Two pools: one per product, each its own endpoint. Only the AI pool
      // has signed-in members.
      const pools = poolEndpoints(descriptor)
      expect(pools).toHaveLength(2)
      expect(descriptor.endpoints).toHaveLength(2)
      const aiPool = pools.find(ep => ep['provider'] === 'workbuddy-ai-pool')!
      // The AI pool carries its own port and per-process secret.
      expect(aiPool['signedIn']).toBe(true)
      const state = await bridge.uiState()
      const pool = state.endpoints.find(ep => ep.provider === 'workbuddy-ai-pool')!
      expect(pool.pool!.members.map(member => member.label)).toEqual(['alice', 'bob'])
      expect(pool.pool!.members.map(member => member.signedIn)).toEqual([true, true])
      expect(pool.pool!.headIndex).toBe(0)
    } finally {
      await bridge.close()
    }
  })

  it('labels pool members by nickname', async () => {
    await useTempHome()
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    try {
      await bridge.start()
      const state = await bridge.uiState()
      const pool = state.endpoints.find(ep => ep.provider === 'workbuddy-ai-pool')!
      const labels = pool.pool!.members.map(member => member.label)
      expect(labels).toContain('alice')
      expect(labels).toContain('bob')
      expect(pool.provider).toBe('workbuddy-ai-pool')
    } finally {
      await bridge.close()
    }
  })

  it('serves a single account through the pool, with no per-account endpoint', async () => {
    await useTempHome()
    const only = await authFile('alice', 'uid-a')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [only]]]),
    })
    try {
      const descriptor = await bridge.start()
      // Two pools (one per product, however few members); only the AI pool is signed in.
      expect(descriptor.endpoints.map(endpoint => endpoint.provider)).toEqual(['workbuddy-pool', 'workbuddy-ai-pool'])
      expect(descriptor.endpoints[0]!.signedIn).toBe(false)
      expect(descriptor.endpoints[1]!.signedIn).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  it('shuts the pool down on close', async () => {
    await useTempHome()
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    await bridge.start()
    const port = new URL(bridge.endpoints()[0]!.baseUrl).port
    await bridge.close()
    // The pool's listener must be gone from the wire.
    const socket = await new Promise<import('node:net').Socket | undefined>(resolve => {
      const net = require('node:net') as typeof import('node:net')
      const s = net.connect({ host: '127.0.0.1', port: Number(port) }, () => { s.destroy(); resolve(s) })
      s.once('error', () => resolve(undefined))
    })
    expect(socket).toBeUndefined()
  })
})
