import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VARIANT } from '../src/core/variants.ts'
import { WorkBuddyBridge, type BridgeOptions } from '../src/standalone/bridge.ts'

/**
 * Stable endpoint addresses across restarts.
 *
 * The point of the identity document is that a client configured once keeps
 * working: same port, same bearer token. These tests start a bridge, stop it,
 * and start another one in the same home — the closest thing to a restart a
 * test can do without spawning processes.
 */

const previousHome = process.env['WORKBUDDY_BRIDGE_HOME']
let home: string | undefined
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close().catch(() => {})))
  if (previousHome === undefined) delete process.env['WORKBUDDY_BRIDGE_HOME']
  else process.env['WORKBUDDY_BRIDGE_HOME'] = previousHome
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true })
    home = undefined
  }
})

async function useTempHome(): Promise<void> {
  home = await mkdtemp(join(tmpdir(), 'wb-stable-'))
  process.env['WORKBUDDY_BRIDGE_HOME'] = home
}

/** Write one desktop auth file for the AI product. */
async function authFile(nickname: string, uid: string): Promise<string> {
  const path = join(home!, `auth-${uid}.info`)
  await writeFile(path, JSON.stringify({
    auth: { accessToken: `token-${uid}`, expiresAt: 4_102_344_000, domain: 'workbuddy.ai' },
    account: { nickname, uid },
  }), 'utf8')
  return path
}

/** One bridge over a single AI account; the pool is its only endpoint. */
async function startBridge(options: BridgeOptions = {}): Promise<{ bridge: WorkBuddyBridge, provider: string, baseUrl: string, token: string }> {
  const auth = await authFile('alice', 'uid-a')
  const bridge = new WorkBuddyBridge({
    variants: [AI_VARIANT],
    ...options,
    authFiles: new Map([['workbuddy-ai', [auth]]]),
  })
  cleanup.push(() => bridge.close())
  const descriptor = await bridge.start()
  const endpoint = descriptor.endpoints[0]
  if (endpoint === undefined) throw new Error('no endpoint started')
  return { bridge, provider: endpoint.provider, baseUrl: endpoint.baseUrl, token: endpoint.token }
}

describe('endpoint identity across restarts', () => {
  it('reuses the port and the token on the next start', async () => {
    await useTempHome()
    const first = await startBridge()
    await first.bridge.close()

    const second = await startBridge()
    expect(second.provider).toBe(first.provider)
    expect(second.baseUrl).toBe(first.baseUrl)
    expect(second.token).toBe(first.token)
  })

  it('keeps the token usable by a client that copied it before the restart', async () => {
    await useTempHome()
    const first = await startBridge()
    const copied = first.token
    const models = await fetch(`${first.baseUrl}/models`, { headers: { Authorization: `Bearer ${copied}` } })
    expect(models.status).toBe(200)
    await first.bridge.close()

    const second = await startBridge()
    // The whole point: the settings an agent already holds still work.
    const after = await fetch(`${second.baseUrl}/models`, { headers: { Authorization: `Bearer ${copied}` } })
    expect(after.status).toBe(200)
  })

  it('falls back to a fresh port and token when persistence is disabled', async () => {
    await useTempHome()
    const first = await startBridge()
    await first.bridge.close()

    const second = await startBridge({ persistEndpointIdentity: false })
    expect(second.token).not.toBe(first.token)
    // Ports can coincide by luck; the token is the reliable signal, and it
    // must never be reused in this mode.
    const third = await startBridge({ persistEndpointIdentity: false })
    expect(third.token).not.toBe(second.token)
  })

  it('reuses the port but never the token when tokens are not reusable', async () => {
    await useTempHome()
    const first = await startBridge()
    await first.bridge.close()

    // This is the `--no-descriptor` shape: addresses stay put, the secret does
    // not survive the process.
    const second = await startBridge({ reuseEndpointTokens: false })
    expect(second.baseUrl).toBe(first.baseUrl)
    expect(second.token).not.toBe(first.token)
  })

  it('keeps two products on their own remembered ports', async () => {
    await useTempHome()
    const cn = await authFile('cn-user', 'uid-cn')
    const ai = await authFile('ai-user', 'uid-ai')
    const make = (): WorkBuddyBridge => {
      const bridge = new WorkBuddyBridge({
        authFiles: new Map([['workbuddy', [cn]], ['workbuddy-ai', [ai]]]),
      })
      cleanup.push(() => bridge.close())
      return bridge
    }

    const firstDescriptor = await make().start()
    const firstUrls = new Map(firstDescriptor.endpoints.map(endpoint => [endpoint.provider, endpoint.baseUrl]))
    expect([...firstUrls.keys()].sort()).toEqual(['workbuddy-ai-pool', 'workbuddy-pool'])
    await cleanup.splice(0).reduce<Promise<void>>(async (previous, close) => {
      await previous
      await close()
    }, Promise.resolve())

    const secondDescriptor = await make().start()
    const secondUrls = new Map(secondDescriptor.endpoints.map(endpoint => [endpoint.provider, endpoint.baseUrl]))
    for (const [provider, url] of firstUrls) expect(secondUrls.get(provider)).toBe(url)
  })

  it('does not give two endpoints the same port', async () => {
    await useTempHome()
    const cn = await authFile('cn-user', 'uid-cn')
    const ai = await authFile('ai-user', 'uid-ai')
    const bridge = new WorkBuddyBridge({
      authFiles: new Map([['workbuddy', [cn]], ['workbuddy-ai', [ai]]]),
    })
    cleanup.push(() => bridge.close())
    const descriptor = await bridge.start()
    const urls = descriptor.endpoints.map(endpoint => endpoint.baseUrl)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('survives a corrupt identity document by starting fresh', async () => {
    await useTempHome()
    const { endpointIdentityPath } = await import('../src/standalone/endpoint-identity.ts')
    await writeFile(endpointIdentityPath(), '{ this is not json', 'utf8')
    // Starting must not depend on the cache being readable.
    const started = await startBridge()
    expect(started.token).not.toBe('')
    expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
  })
})
