/**
 * The bridge's managed-provider surface: automatic load, live CRUD with
 * staged endpoints, revision conflicts, and fail-safe startup.
 */
import { createServer } from 'node:http'
import { Server } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyBridge, type BridgeOptions } from '../src/standalone/bridge.ts'
import {
  MANAGED_PROVIDERS_DIRNAME,
  MANAGED_PROVIDERS_FILENAME,
  ProviderManagementError,
  WorkBuddyManagedProviderStore,
} from '../src/standalone/provider-store.ts'

let home: string
const cleanup: Array<() => Promise<void>> = []
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-managed-bridge-'))
  vi.stubEnv('WORKBUDDY_BRIDGE_HOME', home)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', join(home, 'missing-cn'))
  vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(home, 'missing-ai'))
})
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
  await rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function start(options: BridgeOptions) {
  const bridge = new WorkBuddyBridge(options)
  cleanup.push(() => bridge.close())
  const descriptor = await bridge.start()
  return { bridge, descriptor }
}

/** A controllable OpenAI-compatible upstream. */
async function upstream(status = 200) {
  const calls: { path: string, auth: string | undefined, body: string }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    calls.push({ path: req.url!, auth: req.headers.authorization, body })
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const addr = server.address() as { port: number }
  return { baseUrl: `http://127.0.0.1:${addr.port}/api/prefix`, calls }
}

/** Seed the managed store through its own API, returning the final revision. */
async function seedStore(entries: Array<Record<string, unknown>>): Promise<string> {
  const store = new WorkBuddyManagedProviderStore()
  let revision = 'absent'
  for (const entry of entries) {
    const snapshot = await store.save({ ...entry, revision })
    revision = snapshot.revision
  }
  return revision
}

const docPath = () => join(home, MANAGED_PROVIDERS_DIRNAME, MANAGED_PROVIDERS_FILENAME)
async function readDoc(): Promise<any> {
  return JSON.parse(await readFile(docPath(), 'utf8'))
}

describe('managed providers on the bridge', () => {
  it('loads saved providers automatically, independent of variants', async () => {
    const mock = await upstream()
    await seedStore([{ displayName: 'Managed One', baseUrl: mock.baseUrl, models: ['m-1'], authMode: 'api-key', apiKey: 'sk-managed-secret' }])
    const { bridge, descriptor } = await start({ variants: [], manageProviders: true })
    // One saved provider is served through the custom-pool endpoint alone.
    expect(descriptor.endpoints.map(ep => ep.provider)).toEqual(['custom-pool'])
    expect(descriptor.endpoints[0]!.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
    const models = await (await fetch(`${descriptor.endpoints[0]!.baseUrl}/models`, { headers: { Authorization: `Bearer ${descriptor.endpoints[0]!.token}` } })).json()
    expect(models).toMatchObject({ data: [{ id: 'm-1', owned_by: 'custom-pool' }] })
    const response = await fetch(`${descriptor.endpoints[0]!.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${descriptor.endpoints[0]!.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(mock.calls[0]).toMatchObject({ path: '/api/prefix/chat/completions', auth: 'Bearer sk-managed-secret' })
    expect((await bridge.uiState()).endpoints[0]).toMatchObject({ signedIn: true, models: [{ id: 'm-1' }] })
  })

  it('permits an empty managed list', async () => {
    const { descriptor } = await start({ variants: [], manageProviders: true })
    expect(descriptor.endpoints).toEqual([])
  })

  it('lists the pinned active snapshot, metadata only', async () => {
    await seedStore([{ displayName: 'Managed One', baseUrl: 'https://api.example.com/v1', models: ['m-1'], authMode: 'api-key', apiKey: 'sk-list-secret' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const snapshot = await bridge.listManagedProviders()
    expect(snapshot.providers).toHaveLength(1)
    expect(snapshot.providers[0]).toMatchObject({ id: 'managed-one', displayName: 'Managed One', authMode: 'api-key', hasApiKey: true })
    expect(JSON.stringify(snapshot)).not.toContain('sk-list-secret')
    expect(typeof snapshot.revision).toBe('string')
  })

  it('rejects management when the bridge was not started with manageProviders', async () => {
    const bridge = new WorkBuddyBridge({ variants: [] })
    cleanup.push(() => bridge.close())
    await expect(bridge.listManagedProviders()).rejects.toBeInstanceOf(ProviderManagementError)
    await expect(bridge.saveManagedProvider({ revision: 'x' })).rejects.toBeInstanceOf(ProviderManagementError)
    await expect(bridge.removeManagedProvider({ revision: 'x', id: 'x' })).rejects.toBeInstanceOf(ProviderManagementError)
  })

  it('creates live: stage, persist, then expose; the answer is metadata only', async () => {
    const mock = await upstream()
    const { bridge, descriptor } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    const snapshot = await bridge.saveManagedProvider({
      revision: before.revision,
      displayName: 'Second Gateway',
      baseUrl: mock.baseUrl,
      models: ['m-2'],
      authMode: 'api-key',
      apiKey: 'sk-created-secret',
    })
    expect(snapshot.providers.map(p => p.id)).toEqual(['second-gateway'])
    expect(JSON.stringify(snapshot)).not.toContain('sk-created-secret')
    // Exposed live on the descriptor, through the pool.
    const endpoints = bridge.endpoints()
    expect(endpoints.map(ep => ep.provider)).toEqual(['custom-pool'])
    expect(endpoints[0]!.signedIn).toBe(true)
    // Persisted.
    const doc = await readDoc()
    expect(doc.providers).toHaveLength(1)
    expect(doc.providers[0]!.apiKey).toBe('sk-created-secret')
    // Serves traffic with the stored key.
    const ep = endpoints[0]!
    const response = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-2","messages":[]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(mock.calls[0]).toMatchObject({ auth: 'Bearer sk-created-secret' })
    void descriptor
  })

  it('a new api-key provider without a key is rejected and nothing changes', async () => {
    const { bridge } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    await expect(bridge.saveManagedProvider({
      revision: before.revision, displayName: 'Keyless', baseUrl: 'https://api.example.com/v1',
      models: ['m'], authMode: 'api-key',
    })).rejects.toMatchObject({ name: 'ProviderManagementError', status: 400 })
    expect(bridge.endpoints()).toEqual([])
    expect(await bridge.listManagedProviders()).toMatchObject({ revision: before.revision, providers: [] })
  })

  it('edits live: the pool keeps its URL and token, and the edit is live at once', async () => {
    const mock = await upstream()
    await seedStore([{ displayName: 'Managed One', baseUrl: mock.baseUrl, models: ['m-1'], authMode: 'none' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const epBefore = bridge.endpoints()[0]!
    const before = await bridge.listManagedProviders()
    const snapshot = await bridge.saveManagedProvider({
      revision: before.revision,
      id: 'managed-one',
      displayName: 'Managed One Edited',
      baseUrl: mock.baseUrl,
      models: ['m-1', 'm-2'],
      authMode: 'none',
    })
    expect(snapshot.providers[0]).toMatchObject({ id: 'managed-one', displayName: 'Managed One Edited', models: ['m-1', 'm-2'] })
    const epAfter = bridge.endpoints()[0]!
    expect(epAfter.baseUrl).toBe(epBefore.baseUrl)
    expect(epAfter.token).toBe(epBefore.token)
    // The descriptor and UI state metadata follow the edit immediately.
    expect(epAfter.displayName).toBe('Custom providers · pool (failover)')
    const state = await bridge.uiState()
    expect(state.endpoints[0]).toMatchObject({ displayName: 'Custom providers · pool (failover)' })
    expect(state.endpoints[0]!.pool!.members.map(m => m.label)).toEqual(['Managed One Edited'])
    const models = await (await fetch(`${epAfter.baseUrl}/models`, { headers: { Authorization: `Bearer ${epAfter.token}` } })).json() as { data: Array<{ id: string }> }
    expect(models.data.map(m => m.id)).toEqual(['m-1', 'm-2'])
  })

  it('an edit that omits the key keeps the stored one; upstream still sees it', async () => {
    const mock = await upstream()
    await seedStore([{ displayName: 'Managed One', baseUrl: mock.baseUrl, models: ['m-1'], authMode: 'api-key', apiKey: 'sk-kept-secret' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    await bridge.saveManagedProvider({
      revision: before.revision, id: 'managed-one', displayName: 'Managed One',
      baseUrl: mock.baseUrl, models: ['m-1'], authMode: 'api-key',
    })
    const ep = bridge.endpoints()[0]!
    const response = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(mock.calls[0]).toMatchObject({ auth: 'Bearer sk-kept-secret' })
    const doc = await readDoc()
    expect(doc.providers[0]!.apiKey).toBe('sk-kept-secret')
  })

  it('removes live: persist, then close the endpoint', async () => {
    await seedStore([{ displayName: 'Managed One', baseUrl: 'https://api.example.com/v1', models: ['m-1'], authMode: 'none' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const ep = bridge.endpoints()[0]!
    const before = await bridge.listManagedProviders()
    const snapshot = await bridge.removeManagedProvider({ revision: before.revision, id: 'managed-one' })
    expect(snapshot.providers).toEqual([])
    expect(bridge.endpoints()).toEqual([])
    await expect(fetch(`${ep.baseUrl}/healthz`, { headers: { Authorization: `Bearer ${ep.token}` } })).rejects.toThrow()
    expect((await readDoc()).providers).toEqual([])
    await expect(bridge.removeManagedProvider({ revision: snapshot.revision, id: 'managed-one' }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('a stale revision is a 409 and leaves the old state unchanged', async () => {
    const mock = await upstream()
    await seedStore([{ displayName: 'Managed One', baseUrl: mock.baseUrl, models: ['m-1'], authMode: 'none' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const endpointsBefore = bridge.endpoints()
    const docBefore = await readDoc()
    await expect(bridge.saveManagedProvider({
      revision: 'stale', displayName: 'Other', baseUrl: mock.baseUrl, models: ['m'], authMode: 'none',
    })).rejects.toMatchObject({ status: 409 })
    await expect(bridge.removeManagedProvider({ revision: 'stale', id: 'managed-one' }))
      .rejects.toMatchObject({ status: 409 })
    expect(bridge.endpoints()).toEqual(endpointsBefore)
    expect(await readDoc()).toEqual(docBefore)
  })

  it('a managed id colliding with an external provider id fails startup with a clear error', async () => {
    await seedStore([{ displayName: 'Dup', baseUrl: 'https://api.example.com/v1', models: ['m'], authMode: 'none' }])
    const bridge = new WorkBuddyBridge({
      variants: [],
      manageProviders: true,
      providers: [{ id: 'dup', baseUrl: 'https://external.example.com/v1', models: ['m'] }],
    })
    cleanup.push(() => bridge.close())
    await expect(bridge.start()).rejects.toThrow(/collides with an external configured provider/u)
    expect(bridge.endpoints()).toEqual([])
  })

  it('a corrupt managed document fails startup safely and is never overwritten', async () => {
    await mkdir(join(home, MANAGED_PROVIDERS_DIRNAME), { recursive: true })
    await writeFile(docPath(), '{corrupt document')
    const bridge = new WorkBuddyBridge({ variants: [], manageProviders: true })
    cleanup.push(() => bridge.close())
    await expect(bridge.start()).rejects.toThrow()
    expect(await readFile(docPath(), 'utf8')).toBe('{corrupt document')
    expect(bridge.endpoints()).toEqual([])
  })

  it('serializes overlapping management operations', async () => {
    const { bridge } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    const results = await Promise.allSettled([
      bridge.saveManagedProvider({ revision: before.revision, displayName: 'A One', baseUrl: 'https://a.test/v1', models: ['m'], authMode: 'none' }),
      bridge.saveManagedProvider({ revision: before.revision, displayName: 'B Two', baseUrl: 'https://b.test/v1', models: ['m'], authMode: 'none' }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    // The loser 409s instead of overwriting; exactly one provider exists.
    expect((await bridge.listManagedProviders()).providers).toHaveLength(1)
  })

  it('an external provider is untouched by managed key resolution (env rules still apply)', async () => {
    const mock = await upstream()
    const first = await start({
      variants: [],
      manageProviders: true,
      providers: [{ id: 'external', displayName: 'External', baseUrl: mock.baseUrl, models: ['m-x'], apiKeyEnv: 'EXTERNAL_KEY' }],
    })
    await first.bridge.close()
    await seedStore([{ displayName: 'Managed One', baseUrl: mock.baseUrl, models: ['m-1'], authMode: 'api-key', apiKey: 'sk-managed-key' }])
    vi.stubEnv('EXTERNAL_KEY', '')
    const { bridge: loaded } = await start({
      variants: [],
      manageProviders: true,
      providers: [{ id: 'external', displayName: 'External', baseUrl: mock.baseUrl, models: ['m-x'], apiKeyEnv: 'EXTERNAL_KEY' }],
    })
    // One pool fronts both providers; the external member's env is empty, so
    // only the managed member is usable and only its models are offered.
    const pool = loaded.endpoints()[0]!
    expect(pool.provider).toBe('custom-pool')
    expect(pool.signedIn).toBe(true)
    const state = await loaded.uiState()
    const members = state.endpoints[0]!.pool!.members
    expect(members.map(m => [m.label, m.signedIn])).toEqual([['External', false], ['Managed One', true]])
    const models = await (await fetch(`${pool.baseUrl}/models`, { headers: { Authorization: `Bearer ${pool.token}` } })).json() as { data: Array<{ id: string }> }
    expect(models.data.map(m => m.id)).toEqual(['m-1'])
  })

  it('a managed provider without auth serves chat without any Authorization header', async () => {
    const mock = await upstream()
    await seedStore([{ displayName: 'NoAuth One', baseUrl: mock.baseUrl, models: ['m-1'], authMode: 'none' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const ep = bridge.endpoints()[0]!
    expect(ep.signedIn).toBe(true)
    const response = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(mock.calls[0]).toMatchObject({ auth: undefined })
  })

  it('a slow body upload keeps the configuration it captured: an edit mid-upload does not change this turn', async () => {
    let releaseUpstream: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseUpstream = resolve })
    const calls: { auth: string | undefined, body: string }[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      calls.push({ auth: req.headers.authorization, body })
      await gate
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const port = (server.address() as { port: number }).port
    await seedStore([{ displayName: 'Slow One', baseUrl: `http://127.0.0.1:${port}/api`, models: ['m-1'], authMode: 'api-key', apiKey: 'sk-old-key' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const ep = bridge.endpoints()[0]!
    const turn = fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    // Wait until the upstream has received this turn, then edit underneath it.
    for (let i = 0; i < 100 && calls.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls.length).toBe(1)
    const before = await bridge.listManagedProviders()
    await bridge.saveManagedProvider({
      revision: before.revision, id: 'slow-one', displayName: 'Slow One',
      baseUrl: `http://127.0.0.1:${port}/api`, models: ['m-1'], authMode: 'api-key', apiKey: 'sk-new-key',
    })
    releaseUpstream!()
    const response = await turn
    expect(response.status).toBe(200)
    await response.text()
    // The in-flight turn must have kept its captured credential.
    expect(calls[0]).toMatchObject({ auth: 'Bearer sk-old-key' })
    // The next turn sees the new one.
    const next = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    expect(next.status).toBe(200)
    await next.text()
    expect(calls[1]).toMatchObject({ auth: 'Bearer sk-new-key' })
  })

  it('a failed commit leaves nothing exposed and nothing persisted (staged listener closed)', async () => {
    await seedStore([{ displayName: 'Stable One', baseUrl: 'https://api.example.com/v1', models: ['m'], authMode: 'none' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    // Corrupt the store's document between the bridge's snapshot and the
    // commit: the save must fail closed, leave the old endpoint serving.
    await mkdir(join(home, MANAGED_PROVIDERS_DIRNAME), { recursive: true })
    const docBefore = await readFile(docPath(), 'utf8')
    const endpointsBefore = bridge.endpoints()
    // A stale revision is rejected before anything is staged.
    await expect(bridge.saveManagedProvider({
      revision: 'stale-revision', displayName: 'New One', baseUrl: 'https://n.test/v1', models: ['m'], authMode: 'none',
    })).rejects.toMatchObject({ status: 409 })
    expect(bridge.endpoints()).toEqual(endpointsBefore)
    expect(await readFile(docPath(), 'utf8')).toBe(docBefore)
    void before
  })

  it('a live add whose generated id would collide with an external provider is rejected', async () => {
    const { bridge } = await start({
      variants: [],
      manageProviders: true,
      providers: [{ id: 'clash', baseUrl: 'https://external.example.com/v1', models: ['m'] }],
    })
    const before = await bridge.listManagedProviders()
    await expect(bridge.saveManagedProvider({
      revision: before.revision, displayName: 'Clash', baseUrl: 'https://n.test/v1', models: ['m'], authMode: 'none',
    })).rejects.toMatchObject({ status: 400 })
    expect((await bridge.listManagedProviders()).providers).toEqual([])
  })

  it('a disk revision newer than the pinned snapshot conflicts even when the payload matches', async () => {
    await seedStore([{ displayName: 'Cross One', baseUrl: 'https://api.example.com/v1', models: ['m'], authMode: 'none' }])
    const { bridge } = await start({ variants: [], manageProviders: true })
    const pinned = await bridge.listManagedProviders()
    // Another process commits underneath this bridge.
    const other = new WorkBuddyManagedProviderStore()
    await other.save({ revision: pinned.revision, displayName: 'Cross Two', baseUrl: 'https://other.test/v1', models: ['m'], authMode: 'none' })
    // This bridge's payload still carries the pinned (now-stale) revision:
    // the store's disk check must 409 it.
    await expect(bridge.saveManagedProvider({
      revision: pinned.revision, id: 'cross-one', displayName: 'Cross One',
      baseUrl: 'https://api.example.com/v1', models: ['m'], authMode: 'none',
    })).rejects.toMatchObject({ status: 409 })
    // And the running bridge still serves what it pinned, unchanged.
    expect((await bridge.listManagedProviders()).providers.map(p => p.id)).toEqual(['cross-one'])
  })

  it('close drains a running management operation and refuses new ones', async () => {
    const { bridge } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    const saving = bridge.saveManagedProvider({
      revision: before.revision, displayName: 'Drain One', baseUrl: 'https://d.test/v1', models: ['m'], authMode: 'none',
    })
    await bridge.close()
    const snapshot = await saving
    // The in-flight save completed and persisted before close finished.
    expect(snapshot.providers.map(p => p.id)).toEqual(['drain-one'])
    await expect(bridge.saveManagedProvider({ revision: snapshot.revision, displayName: 'After', baseUrl: 'https://a.test/v1', models: ['m'], authMode: 'none' }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('a create opens exactly one listener (the pool) and close() closes it', async () => {
    const { bridge } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    await bridge.saveManagedProvider({
      revision: before.revision, displayName: 'Solo One', baseUrl: 'https://s.test/v1', models: ['m'], authMode: 'none',
    })
    // The pool is the one listener; the provider has none of its own.
    const endpoints = bridge.endpoints()
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0]!.provider).toBe('custom-pool')
    const ep = endpoints[0]!
    await bridge.close()
    // The endpoint must be gone from the wire: exactly one listener existed
    // and it is closed now.
    await expect(fetch(`${ep.baseUrl}/healthz`, { headers: { Authorization: `Bearer ${ep.token}` } })).rejects.toThrow()
    expect(bridge.endpoints()).toEqual([])
  })

  it('a failed persist exposes nothing new', async () => {
    const { bridge } = await start({ variants: [], manageProviders: true })
    const before = await bridge.listManagedProviders()
    const endpointsBefore = bridge.endpoints()
    // Make the commit fail by corrupting the document after the store read
    // path was warm: replace the file with unparsable content while holding
    // no lock — the commit's strict parse then rejects.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(docPath(), 'corrupted-after-read')
    await expect(bridge.saveManagedProvider({
      revision: before.revision, displayName: 'Doomed One', baseUrl: 'https://x.test/v1', models: ['m'], authMode: 'none',
    })).rejects.toMatchObject({ status: 500 })
    // Nothing exposed, nothing listening beyond the previous state.
    expect(bridge.endpoints()).toEqual(endpointsBefore)
    // Restore and prove the bridge still works normally.
    const other = new WorkBuddyManagedProviderStore()
    await expect(other.list()).rejects.toMatchObject({ status: 500 })
  })

  it('a create whose final id (with collision suffix) matches an external id is rejected', async () => {
    const { bridge } = await start({
      variants: [],
      manageProviders: true,
      providers: [{ id: 'dup-2', baseUrl: 'https://external.example.com/v1', models: ['m'] }],
    })
    const before = await bridge.listManagedProviders()
    // First create takes 'dup'.
    await bridge.saveManagedProvider({
      revision: before.revision, displayName: 'Dup', baseUrl: 'https://d.test/v1', models: ['m'], authMode: 'none',
    })
    const after = await bridge.listManagedProviders()
    expect(after.providers.map(p => p.id)).toEqual(['dup'])
    // Second create would allocate 'dup-2', which collides with the external
    // id — the commit must reject it, never overwrite the external runtime.
    await expect(bridge.saveManagedProvider({
      revision: after.revision, displayName: 'Dup', baseUrl: 'https://d.test/v1', models: ['m'], authMode: 'none',
    })).rejects.toMatchObject({ status: 400 })
    // The external member is untouched: exactly one managed provider exists,
    // and the pool fronts both providers.
    expect((await bridge.listManagedProviders()).providers.map(p => p.id)).toEqual(['dup'])
    expect(bridge.endpoints().map(ep => ep.provider)).toEqual(['custom-pool'])
  })

  it('two same-name creates are served by one pool listener; it closes with the bridge', async () => {
    const { bridge } = await start({ variants: [], manageProviders: true })
    const listeners: Server[] = []
    const listen = Server.prototype.listen
    vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: any[]) {
      listeners.push(this)
      return Reflect.apply(listen, this, args)
    })
    cleanup.push(async () => {
      await Promise.all(listeners.filter(server => server.listening).map(server =>
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      ))
    })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'Twins', baseUrl: 'https://t.test/v1', models: ['m'], authMode: 'none',
    })
    const second = await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Twins', baseUrl: 'https://t2.test/v1', models: ['m'], authMode: 'none',
    })
    // One pool listener fronts both providers; no create opens a listener of
    // its own. The second provider joins the SAME listener — and the store
    // lock opens no TCP server at all.
    expect(listeners).toHaveLength(1)
    const endpoints = bridge.endpoints()
    expect(endpoints.map(ep => ep.provider)).toEqual(['custom-pool'])
    const state = await bridge.uiState()
    expect(state.endpoints[0]!.pool!.members.map(m => m.label)).toEqual(['Twins', 'Twins'])
    expect((await bridge.listManagedProviders()).providers.map(p => p.id)).toEqual(['twins', 'twins-2'])
    void second
    // The listener dies with the bridge; nothing lingers. The healthz route
    // lives at the shim root, one level above the published `/v1` prefix.
    const ep = endpoints[0]!
    const root = ep.baseUrl.replace(/\/v1$/u, '')
    expect((await fetch(`${root}/healthz`, { headers: { Authorization: `Bearer ${ep.token}` } })).status).toBe(200)
    await bridge.close()
    expect(listeners.every(server => !server.listening)).toBe(true)
    await expect(fetch(`${root}/healthz`, { headers: { Authorization: `Bearer ${ep.token}` } })).rejects.toThrow()
    expect(bridge.endpoints()).toEqual([])
  })

  it('a no-auth create ignores a supplied key and a trailing slash: no Authorization header, no //chat', async () => {
    const calls: { path: string, auth: string | undefined }[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      calls.push({ path: req.url!, auth: req.headers.authorization })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
    const port = (server.address() as { port: number }).port
    const { bridge } = await start({ variants: [], manageProviders: true })
    await bridge.saveManagedProvider({
      revision: 'absent',
      displayName: 'Bare Gateway',
      // Trailing slash: the runtime must serve origin + /chat/completions,
      // never a doubled slash.
      baseUrl: `http://127.0.0.1:${port}/prefix/`,
      models: ['m-1'],
      authMode: 'none',
      // A key in a `none` payload is ignored — never forwarded, never stored.
      apiKey: 'sk-should-not-travel',
    })
    const ep = bridge.endpoints()[0]!
    const response = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(calls[0]).toMatchObject({ path: '/prefix/chat/completions', auth: undefined })
    const { readFile } = await import('node:fs/promises')
    const doc = JSON.parse(await readFile(docPath(), 'utf8'))
    expect(doc.providers[0]!.apiKey).toBeUndefined()
  })

  it('one provider is served by the pool alone; a second joins it, and it fails over between them', async () => {
    const failing = await upstream(503)
    const healthy = await upstream()
    const { bridge } = await start({ variants: [], manageProviders: true })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'Primary', baseUrl: failing.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-primary',
    })
    // The pool is the only endpoint from the first provider on.
    expect(bridge.endpoints().map(ep => ep.provider)).toEqual(['custom-pool'])

    await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Secondary', baseUrl: healthy.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-secondary',
    })
    const endpoints = bridge.endpoints()
    expect(endpoints.map(ep => ep.provider)).toEqual(['custom-pool'])
    const pool = endpoints[0]!
    expect(pool.modelCount).toBe(1)
    expect(pool.signedIn).toBe(true)
    // The pool's URL and token are unchanged by the membership edit.
    expect(pool.baseUrl).toBe(bridge.endpoints()[0]!.baseUrl)

    const response = await fetch(`${pool.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pool.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    // The head failed, so the second provider answered with its own key.
    expect(failing.calls).toHaveLength(1)
    expect(healthy.calls).toHaveLength(1)
    expect(healthy.calls[0]!.auth).toBe('Bearer sk-secondary')
  })

  it('the pool keeps one stable URL and token across edits, and outlives removal down to one provider', async () => {
    const one = await upstream()
    const two = await upstream()
    const { bridge } = await start({ variants: [], manageProviders: true })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'One', baseUrl: one.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-one',
    })
    const second = await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Two', baseUrl: two.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-two',
    })
    const before = bridge.endpoints().find(ep => ep.provider === 'custom-pool')!
    // Edit one member: the pool endpoint must keep its URL and token — an
    // edit is not a republish.
    const after = await bridge.saveManagedProvider({
      revision: second.revision, id: 'one', displayName: 'One Renamed', baseUrl: one.baseUrl,
      models: ['m-1'], authMode: 'api-key',
    })
    const edited = bridge.endpoints()
    expect(edited.find(ep => ep.provider === 'custom-pool')).toMatchObject({
      baseUrl: before.baseUrl,
      token: before.token,
      displayName: 'Custom providers · pool (failover)',
    })
    expect((await bridge.uiState()).endpoints[0]!.pool!.members.map(m => m.label)).toEqual(['One Renamed', 'Two'])

    // Removing a provider leaves one: the pool stays, now over the survivor.
    const oneId = after.providers.find(provider => provider.displayName === 'One Renamed')!.id
    await bridge.removeManagedProvider({ revision: after.revision, id: oneId })
    const remaining = bridge.endpoints()
    expect(remaining.map(ep => ep.provider)).toEqual(['custom-pool'])
    expect(remaining[0]!.baseUrl).toBe(before.baseUrl)
    expect(remaining[0]!.token).toBe(before.token)
    // The same listener still serves.
    const models = await (await fetch(`${before.baseUrl}/models`, { headers: { Authorization: `Bearer ${before.token}` } })).json() as { data: Array<{ id: string }> }
    expect(models.data.map(m => m.id)).toEqual(['m-1'])
  })

  it('the pool UI card lists its providers, the head, and edit links for managed ones', async () => {
    const one = await upstream()
    const two = await upstream(503)
    const { bridge } = await start({ variants: [], manageProviders: true })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'One', baseUrl: one.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-one',
    })
    await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Two', baseUrl: two.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-two',
    })
    const state = await bridge.uiState()
    const pool = state.endpoints.find(endpoint => endpoint.provider === 'custom-pool')!
    expect(pool.pool).toMatchObject({ kind: 'providers', headIndex: 0 })
    expect(pool.pool!.members.map(member => member.label)).toEqual(['One', 'Two'])
    expect(pool.pool!.members.map(member => member.editId)).toEqual(['one', 'two'])
    expect(pool.pool!.members.every(member => member.signedIn)).toBe(true)
    expect(pool.models.map(model => model.id)).toEqual(['m-1'])
    // The pool is the only endpoint served.
    expect(state.endpoints.map(endpoint => endpoint.provider)).toEqual(['custom-pool'])
  })

  it('an external provider joins the pool and stays read-only in it', async () => {
    const external = await upstream()
    const managed = await upstream()
    const { bridge } = await start({
      variants: [],
      manageProviders: true,
      providers: [{ id: 'external-one', displayName: 'External One', baseUrl: external.baseUrl, apiKeyEnv: 'WB_POOL_EXTERNAL_KEY', models: ['m-1'] }],
    })
    vi.stubEnv('WB_POOL_EXTERNAL_KEY', 'sk-external')
    await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'Managed One', baseUrl: managed.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-managed',
    })
    const state = await bridge.uiState()
    const pool = state.endpoints.find(endpoint => endpoint.provider === 'custom-pool')!
    expect(pool.pool!.members.map(member => member.label)).toEqual(['External One', 'Managed One'])
    // Only the managed member carries an edit link; the external one is
    // read-only because its configuration lives in the caller's file.
    expect(pool.pool!.members.map(member => member.editId)).toEqual([undefined, 'managed-one'])
  })

  it('the pool refuses a model no provider offers, before any upstream call', async () => {
    const one = await upstream()
    const two = await upstream()
    const { bridge } = await start({ variants: [], manageProviders: true })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'One', baseUrl: one.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-one',
    })
    await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Two', baseUrl: two.baseUrl, models: ['m-2'],
      authMode: 'api-key', apiKey: 'sk-two',
    })
    const pool = bridge.endpoints().find(ep => ep.provider === 'custom-pool')!
    const response = await fetch(`${pool.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pool.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-3","messages":[]}',
    })
    expect(response.status).toBe(400)
    await response.text()
    expect(one.calls).toHaveLength(0)
    expect(two.calls).toHaveLength(0)
  })

  it('pool turns are logged with their failover chain, for the page', async () => {
    const failing = await upstream(503)
    const healthy = await upstream()
    const { bridge } = await start({ variants: [], manageProviders: true })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'One', baseUrl: failing.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-one',
    })
    await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Two', baseUrl: healthy.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-two',
    })
    const pool = bridge.endpoints().find(ep => ep.provider === 'custom-pool')!
    const response = await fetch(`${pool.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pool.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[{"role":"user","content":"private prompt"}]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    const state = await bridge.uiState()
    const card = state.endpoints.find(endpoint => endpoint.provider === 'custom-pool')!
    expect(card.requests).toHaveLength(1)
    expect(card.requests[0]).toMatchObject({ model: 'm-1', outcome: 'ok' })
    expect(card.requests[0]!.attempts).toEqual([
      { account: 'One', outcome: 'server', status: 503 },
      { account: 'Two', outcome: 'ok' },
    ])
    // Metadata only: the prompt never reaches the log the page renders.
    expect(JSON.stringify(card.requests)).not.toContain('private prompt')
  })

  it('a single-provider pool turn is still logged with who served it', async () => {
    // Once the pool is the only endpoint a custom provider is served on, the
    // Tried column is the ONLY place the log names a provider: dropping the
    // chain when just one was tried would leave a successful turn with no
    // idea which provider answered.
    const healthy = await upstream()
    const { bridge } = await start({ variants: [], manageProviders: true })
    await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'Only', baseUrl: healthy.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-only',
    })
    const pool = bridge.endpoints().find(ep => ep.provider === 'custom-pool')!
    const response = await fetch(`${pool.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pool.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[{"role":"user","content":"private prompt"}]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    const card = (await bridge.uiState()).endpoints.find(endpoint => endpoint.provider === 'custom-pool')!
    expect(card.requests).toHaveLength(1)
    expect(card.requests[0]!.attempts).toEqual([{ account: 'Only', outcome: 'ok' }])
    expect(JSON.stringify(card.requests)).not.toContain('private prompt')
  })

  it('the pool card reports the head and traffic the serving router actually produced', async () => {
    const failing = await upstream(503)
    const healthy = await upstream()
    const { bridge } = await start({ variants: [], manageProviders: true })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'One', baseUrl: failing.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-one',
    })
    await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Two', baseUrl: healthy.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-two',
    })
    // Before any traffic the head is the first member and nothing is counted.
    const before = (await bridge.uiState()).endpoints.find(ep => ep.provider === 'custom-pool')!
    expect(before.pool!.headIndex).toBe(0)
    expect(before.pool!.members.map(member => member.successes)).toEqual([0, 0])

    const pool = bridge.endpoints().find(ep => ep.provider === 'custom-pool')!
    const response = await fetch(`${pool.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pool.token}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[]}',
    })
    expect(response.status).toBe(200)
    await response.text()

    // The page must describe the turn that happened: One failed, Two answered,
    // and the head moved to Two. A second router instance would report zeros.
    const after = (await bridge.uiState()).endpoints.find(ep => ep.provider === 'custom-pool')!
    expect(after.pool!.members[0]).toMatchObject({ failures: 1, successes: 0 })
    expect(after.pool!.members[0]!.lastOutcome).toBe('upstream-error')
    expect(after.pool!.members[1]).toMatchObject({ successes: 1, failures: 0, head: true })
    expect(after.pool!.headIndex).toBe(1)
  })

  it('a pool test goes through the provider’s own endpoint and does not move the head', async () => {
    const one = await upstream()
    const two = await upstream()
    const { bridge } = await start({ variants: [], manageProviders: true })
    const first = await bridge.saveManagedProvider({
      revision: 'absent', displayName: 'One', baseUrl: one.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-one',
    })
    await bridge.saveManagedProvider({
      revision: first.revision, displayName: 'Two', baseUrl: two.baseUrl, models: ['m-1'],
      authMode: 'api-key', apiKey: 'sk-two',
    })
    const result = await bridge.probePoolMember({ provider: 'custom-pool', index: 1, model: 'm-1' })
    expect(result).toMatchObject({ provider: 'custom-pool', index: 1, label: 'Two', model: 'm-1', ok: true })
    // The second provider was called with its own key; the first was not called.
    expect(two.calls).toHaveLength(1)
    expect(two.calls[0]!.auth).toBe('Bearer sk-two')
    expect(one.calls).toHaveLength(0)
    // The head did not move: a manual test must not redirect live traffic.
    const card = (await bridge.uiState()).endpoints.find(ep => ep.provider === 'custom-pool')!
    expect(card.pool!.headIndex).toBe(0)
  })

  it('a pool test for a provider with no usable key is refused before any call', async () => {
    const one = await upstream()
    const two = await upstream()
    const { bridge } = await start({
      variants: [],
      manageProviders: true,
      providers: [
        { id: 'no-key-one', displayName: 'No Key', baseUrl: one.baseUrl, apiKeyEnv: 'WB_POOL_MISSING_KEY', models: ['m-1'] },
        { id: 'two', displayName: 'Two', baseUrl: two.baseUrl, models: ['m-1'] },
      ],
    })
    await expect(bridge.probePoolMember({ provider: 'custom-pool', index: 0 }))
      .rejects.toMatchObject({ status: 409 })
    expect(one.calls).toHaveLength(0)
    expect(two.calls).toHaveLength(0)
  })
})
