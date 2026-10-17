import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyBridge } from '../src/standalone/bridge.ts'

/**
 * Multiple accounts of one product, served by one process.
 *
 * The whole feature rests on one structural claim: `startVariant` is
 * per-account, not per-variant, so N auth files produce N independent
 * runtimes — own store, own shim, own port, own token — while the variant's
 * catalog store stays shared, because its entries are keyed by account
 * identity already. These tests pin the observable consequences of that
 * split: distinct endpoints that can be told apart, and an unchanged
 * single-account surface.
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

function aiEndpoints(descriptor: { endpoints: Array<{ provider: string }> }): Array<Record<string, unknown>> {
  return descriptor.endpoints.filter(endpoint => endpoint.provider === 'workbuddy-ai') as never
}

describe('one bridge process serving several accounts', () => {
  it('starts one endpoint per product with no options at all (default invocation)', async () => {
    await useTempHome()
    // No authFiles, no discovery: the ordinary `workbuddy-bridge serve` path.
    // This regressed once — an empty account list was iterated as-is, so the
    // default invocation started zero endpoints and exited with "no variant
    // could start a loopback endpoint". The empty list must mean one runtime
    // with desktop discovery, never zero.
    const bridge = new WorkBuddyBridge()
    try {
      const descriptor = await bridge.start()
      expect(descriptor.endpoints.length).toBe(2)
      const providers = descriptor.endpoints.map(endpoint => endpoint.provider).sort()
      expect(providers).toEqual(['workbuddy', 'workbuddy-ai'])
      // Single-account mode keeps the bare product name — no account suffix.
      for (const endpoint of descriptor.endpoints) expect(endpoint.displayName).not.toContain('·')
    } finally {
      await bridge.close()
    }
  })

  it('starts one endpoint per auth file, each with its own port and token', async () => {
    await useTempHome()
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    try {
      const descriptor = await bridge.start()
      const endpoints = aiEndpoints(descriptor)
      expect(endpoints.length).toBe(2)
      const urls = new Set(endpoints.map(endpoint => endpoint.baseUrl))
      const tokens = new Set(endpoints.map(endpoint => endpoint.token))
      // Distinct shims mean distinct ports and distinct per-process secrets;
      // sharing either would mean the accounts share a credential plane.
      expect(urls.size).toBe(2)
      expect(tokens.size).toBe(2)
      for (const endpoint of endpoints) expect(endpoint.signedIn).toBe(true)
    } finally {
      await bridge.close()
    }
  })

  it('labels multi-account endpoints by nickname, keeping the provider id stable', async () => {
    await useTempHome()
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    try {
      const descriptor = await bridge.start()
      const names = aiEndpoints(descriptor).map(endpoint => endpoint.displayName).sort()
      // Both endpoints still answer to provider `workbuddy-ai` — tooling that
      // groups by provider keeps working — while the display name says whose
      // credentials each one speaks for.
      expect(names[0]).toContain('alice')
      expect(names[1]).toContain('bob')
      for (const endpoint of aiEndpoints(descriptor)) expect(endpoint.provider).toBe('workbuddy-ai')
    } finally {
      await bridge.close()
    }
  })

  it('keeps the single-account surface unchanged: bare product name, one endpoint', async () => {
    await useTempHome()
    const only = await authFile('alice', 'uid-a')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [only]]]),
    })
    try {
      const descriptor = await bridge.start()
      const endpoints = aiEndpoints(descriptor)
      expect(endpoints.length).toBe(1)
      // No suffix when there is nothing to disambiguate — the common case
      // must render exactly as it did before multi-account existed.
      expect(endpoints[0]!.displayName).not.toContain('·')
      expect(endpoints[0]!.displayName).not.toContain('alice')
    } finally {
      await bridge.close()
    }
  })

  it('shuts every account endpoint down on close', async () => {
    await useTempHome()
    const first = await authFile('alice', 'uid-a')
    const second = await authFile('bob', 'uid-b')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy-ai', [first, second]]]),
    })
    const descriptor = await bridge.start()
    const ports = aiEndpoints(descriptor).map(endpoint => new URL(endpoint.baseUrl as string).port)
    expect(ports.length).toBe(2)
    await bridge.close()
    // Every account's listener must be gone, not just the last one started —
    // close() iterates the runtime list, and this pins that the list holds
    // one entry per account.
    for (const port of ports) {
      const socket = await new Promise<import('node:net').Socket | undefined>(resolve => {
        const net = require('node:net') as typeof import('node:net')
        const s = net.connect({ host: '127.0.0.1', port: Number(port) }, () => { s.destroy(); resolve(s) })
        s.once('error', () => resolve(undefined))
      })
      expect(socket).toBeUndefined()
    }
  })
})
