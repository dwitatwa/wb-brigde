import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listenOnPreferredPort } from '../src/core/listen.ts'
import {
  ENDPOINT_IDENTITY_FILENAME,
  endpointIdentityPath,
  loadEndpointIdentities,
  portOfBaseUrl,
  rememberEndpointIdentity,
} from '../src/standalone/endpoint-identity.ts'

/**
 * Stable endpoint addresses.
 *
 * The shim mints a fresh port and secret every start. These tests pin the
 * memory that removes the churn — and, just as importantly, that every part of
 * it degrades to the old behaviour rather than blocking a start.
 */

const previousHome = process.env['WORKBUDDY_BRIDGE_HOME']
let home: string | undefined
const servers: Server[] = []

afterEach(async () => {
  if (previousHome === undefined) delete process.env['WORKBUDDY_BRIDGE_HOME']
  else process.env['WORKBUDDY_BRIDGE_HOME'] = previousHome
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true })
    home = undefined
  }
})

async function useTempHome(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), 'wb-identity-'))
  process.env['WORKBUDDY_BRIDGE_HOME'] = home
  return home
}

/** Bind a listener on an OS-chosen port and return it, registered for cleanup. */
async function occupyPort(): Promise<{ port: number, server: Server }> {
  const server = createServer()
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { port: address.port, server }
}

describe('the identity document', () => {
  it('is absent on a first run, so every endpoint starts fresh', async () => {
    await useTempHome()
    expect(await loadEndpointIdentities()).toEqual(new Map())
  })

  it('round-trips a port and a token', async () => {
    await useTempHome()
    await rememberEndpointIdentity('workbuddy-ai-pool', { port: 51_001, token: 'secret-value' }, { persistToken: true })
    const loaded = await loadEndpointIdentities()
    expect(loaded.get('workbuddy-ai-pool')).toEqual({ port: 51_001, token: 'secret-value' })
  })

  it('is written 0600 so another user cannot read the token', async () => {
    await useTempHome()
    await rememberEndpointIdentity('pool', { port: 51_002, token: 'secret' }, { persistToken: true })
    const info = await stat(endpointIdentityPath())
    // Windows reports advisory bits; the assertion is only meaningful on POSIX.
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600)
    expect(endpointIdentityPath()).toBe(join(home!, ENDPOINT_IDENTITY_FILENAME))
  })

  it('never writes a token when tokens are not persisted, but keeps the port', async () => {
    await useTempHome()
    await rememberEndpointIdentity('pool', { port: 51_003, token: 'secret' }, { persistToken: false })
    const loaded = await loadEndpointIdentities()
    expect(loaded.get('pool')).toEqual({ port: 51_003 })
    expect(await readFile(endpointIdentityPath(), 'utf8')).not.toContain('secret')
  })

  it('does not erase a stored token when a later run opts out of persisting it', async () => {
    await useTempHome()
    await rememberEndpointIdentity('pool', { port: 51_004, token: 'kept' }, { persistToken: true })
    // `--no-descriptor` is a per-run choice; it must not destroy the record
    // an ordinary run would want back.
    await rememberEndpointIdentity('pool', { port: 51_005, token: 'discarded' }, { persistToken: false })
    expect((await loadEndpointIdentities()).get('pool')).toEqual({ port: 51_005, token: 'kept' })
  })

  it('keeps other endpoints\' records when one is updated', async () => {
    await useTempHome()
    await rememberEndpointIdentity('first', { port: 51_006, token: 'a' }, { persistToken: true })
    await rememberEndpointIdentity('second', { port: 51_007, token: 'b' }, { persistToken: true })
    await rememberEndpointIdentity('first', { port: 51_008, token: 'c' }, { persistToken: true })
    const loaded = await loadEndpointIdentities()
    expect(loaded.get('first')).toEqual({ port: 51_008, token: 'c' })
    expect(loaded.get('second')).toEqual({ port: 51_007, token: 'b' })
  })

  it('skips the write when nothing changed', async () => {
    await useTempHome()
    await rememberEndpointIdentity('pool', { port: 51_009, token: 'same' }, { persistToken: true })
    const before = await stat(endpointIdentityPath())
    await new Promise(resolve => setTimeout(resolve, 20))
    await rememberEndpointIdentity('pool', { port: 51_009, token: 'same' }, { persistToken: true })
    const after = await stat(endpointIdentityPath())
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it.each([
    ['malformed JSON', 'not json at all'],
    ['a wrong version', JSON.stringify({ version: 99, endpoints: { pool: { port: 51_010 } } })],
    ['a non-object document', JSON.stringify([1, 2, 3])],
  ])('reads %s as empty rather than failing a start', async (_label, text) => {
    await useTempHome()
    await writeFile(endpointIdentityPath(), text, 'utf8')
    expect(await loadEndpointIdentities()).toEqual(new Map())
  })

  it('drops only the damaged entries of an otherwise readable document', async () => {
    await useTempHome()
    await writeFile(endpointIdentityPath(), JSON.stringify({
      version: 1,
      endpoints: {
        good: { port: 51_011, token: 'fine' },
        badPort: { port: 0 },
        badToken: { token: '   ' },
        notAnObject: 42,
      },
    }), 'utf8')
    const loaded = await loadEndpointIdentities()
    expect([...loaded.keys()]).toEqual(['good'])
  })

  it('treats an unusable port as no preference and an empty token as none', async () => {
    await useTempHome()
    await rememberEndpointIdentity('pool', { port: 0, token: '' }, { persistToken: true })
    // Nothing usable to remember, so nothing is written at all.
    expect(await loadEndpointIdentities()).toEqual(new Map())
  })

  it('ignores an out-of-range port', async () => {
    await useTempHome()
    await rememberEndpointIdentity('pool', { port: 70_000, token: 't' }, { persistToken: true })
    expect((await loadEndpointIdentities()).get('pool')).toEqual({ token: 't' })
  })
})

describe('reading a port back out of a base URL', () => {
  it.each([
    ['http://127.0.0.1:51234/v1', 51_234],
    ['http://127.0.0.1:51234', 51_234],
    ['http://172.20.96.1:41000/v1', 41_000],
  ])('reads %s', (url, expected) => {
    expect(portOfBaseUrl(url)).toBe(expected)
  })

  it.each(['not a url', 'http://127.0.0.1/v1', ''])('reports nothing for %s', url => {
    expect(portOfBaseUrl(url)).toBeUndefined()
  })
})

describe('listening on a preferred port', () => {
  it('uses the preferred port when it is free', async () => {
    const { port: free } = await occupyPort()
    // Release it so the bind below can take it; the number is what matters.
    const server = servers.pop()!
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    const subject = createServer()
    servers.push(subject)
    await listenOnPreferredPort(subject, free, '127.0.0.1')
    const address = subject.address()
    expect(address !== null && typeof address !== 'string' ? address.port : 0).toBe(free)
  })

  it('falls back to an ephemeral port when the preferred one is taken', async () => {
    const { port: taken } = await occupyPort()
    const subject = createServer()
    servers.push(subject)
    await listenOnPreferredPort(subject, taken, '127.0.0.1')
    const address = subject.address()
    const bound = address !== null && typeof address !== 'string' ? address.port : 0
    expect(bound).not.toBe(0)
    expect(bound).not.toBe(taken)
  })

  it.each([undefined, 0, -1, 70_000, 1.5])('binds an ephemeral port for %s', async port => {
    const subject = createServer()
    servers.push(subject)
    await listenOnPreferredPort(subject, port as number | undefined, '127.0.0.1')
    const address = subject.address()
    expect(address !== null && typeof address !== 'string' ? address.port : 0).toBeGreaterThan(0)
  })

  it('still rejects a failure that is not a taken port', async () => {
    const subject = createServer()
    servers.push(subject)
    // An unbindable address: EADDRNOTAVAIL, which must not be swallowed by the
    // fallback — retrying it on a random port would hide a real problem.
    await expect(listenOnPreferredPort(subject, 51_012, '203.0.113.1')).rejects.toMatchObject({
      code: expect.stringMatching(/EADDRNOTAVAIL|EACCES/u),
    })
  })
})
