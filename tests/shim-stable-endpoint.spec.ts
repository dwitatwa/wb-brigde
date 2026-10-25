import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoopbackEndpoint, type LoopbackEndpointOptions } from '../src/core/shim.ts'

/**
 * The loopback endpoint's two stable-address options.
 *
 * These are the seam the standalone runner builds on: a preferred port and a
 * preferred bearer secret, both optional, both degrading to the historical
 * behaviour when absent or unusable. The tests are deliberately at this level
 * — no bridge, no descriptor — because the fallback rules belong to the
 * listener, not to the caller that happens to use it.
 */

const CLEANUP: Array<() => Promise<void>> = []
const SERVERS: Server[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(close => close().catch(() => {})))
  await Promise.all(SERVERS.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

/** A minimal endpoint with no chat surface; only the listener matters here. */
function start(options: Partial<LoopbackEndpointOptions> = {}): ReturnType<typeof createLoopbackEndpoint> {
  const endpoint = createLoopbackEndpoint({
    listModels: () => [{ id: 'm1', ownedBy: 'test' }],
    handleChat: async (_req, res) => { res.writeHead(200); res.end('{}') },
    ...options,
  })
  CLEANUP.push(() => endpoint.close())
  return endpoint
}

/** Occupy an OS-chosen port and return it. */
async function occupied(): Promise<number> {
  const server = createServer()
  SERVERS.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return address.port
}

function portOf(baseUrl: string): number {
  return Number(new URL(baseUrl).port)
}

describe('the loopback endpoint\'s preferred port', () => {
  it('binds the port it is given', async () => {
    const free = await occupied()
    // Free it again so the endpoint can take the number.
    const server = SERVERS.pop()!
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    const endpoint = start({ port: free })
    await endpoint.ready
    expect(portOf(endpoint.baseUrl())).toBe(free)
  })

  it('falls back to another port when the preferred one is taken', async () => {
    const taken = await occupied()
    const endpoint = start({ port: taken })
    await endpoint.ready
    expect(portOf(endpoint.baseUrl())).not.toBe(taken)
    expect(portOf(endpoint.baseUrl())).toBeGreaterThan(0)
  })

  it('still serves requests after a fallback', async () => {
    const taken = await occupied()
    const endpoint = start({ port: taken })
    await endpoint.ready
    const response = await fetch(`${endpoint.baseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${endpoint.token()}` },
    })
    expect(response.status).toBe(200)
  })

  it('picks an ephemeral port when none is preferred', async () => {
    const endpoint = start()
    await endpoint.ready
    expect(portOf(endpoint.baseUrl())).toBeGreaterThan(0)
  })
})

describe('the loopback endpoint\'s preferred token', () => {
  it('accepts the token it is given and rejects any other', async () => {
    const endpoint = start({ token: 'a-supplied-secret' })
    await endpoint.ready
    expect(endpoint.token()).toBe('a-supplied-secret')
    const good = await fetch(`${endpoint.baseUrl()}/v1/models`, {
      headers: { Authorization: 'Bearer a-supplied-secret' },
    })
    expect(good.status).toBe(200)
    const bad = await fetch(`${endpoint.baseUrl()}/v1/models`, {
      headers: { Authorization: 'Bearer something-else' },
    })
    expect(bad.status).toBe(401)
  })

  it('mints a random token when none is preferred', async () => {
    const first = start()
    const second = start()
    await Promise.all([first.ready, second.ready])
    expect(first.token()).not.toBe(second.token())
    expect(first.token().length).toBeGreaterThan(20)
  })

  it.each(['', '   '])('treats %j as no preference, never as an empty bearer', async value => {
    const endpoint = start({ token: value })
    await endpoint.ready
    expect(endpoint.token()).not.toBe('')
    expect(endpoint.token().trim()).not.toBe('')
    // An empty bearer must be refused rather than matching the minted secret.
    const response = await fetch(`${endpoint.baseUrl()}/v1/models`, { headers: { Authorization: 'Bearer ' } })
    expect(response.status).toBe(401)
  })

  it('does not let a supplied token weaken the other gates', async () => {
    const endpoint = start({ token: 'known' })
    await endpoint.ready
    // A correct bearer with a non-loopback Host is still refused: DNS
    // rebinding does not become possible just because the secret is stable.
    // Raw HTTP, because `fetch` refuses to override Host.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: portOf(endpoint.baseUrl()),
        path: '/v1/models',
        headers: { Authorization: 'Bearer known', Host: 'evil.example' },
      }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })
})
