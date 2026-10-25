import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/standalone/cli.ts'
import { readBridgeDescriptor } from '../src/standalone/descriptor.ts'

/**
 * Startup wiring for UI-managed custom providers.
 *
 * The bridge's managed-provider store and the UI's management routes are
 * owned by other slices; this file pins the CLI's side of the contract by
 * mocking those two seams and exercising the real `serve` path — the option
 * that is passed, the callbacks that are wired, and what happens to the
 * descriptor and the WSL forwarders when the page mutates a provider.
 */

interface FakeEndpoint {
  provider: string
  displayName: string
  baseUrl: string
  token: string
  modelCount: number
  signedIn: boolean
}

interface FakeBridge {
  options: Record<string, unknown>
  endpointsNow: FakeEndpoint[]
  saved: unknown[]
  removed: unknown[]
  failPublish: boolean
  closed: boolean
  onSave: (input: unknown) => unknown
  onRemove: (input: unknown) => unknown
  publish(): Promise<unknown>
  preferredPortFor(key: string): number | undefined
  rememberPortFor(key: string, baseUrl: string): Promise<void>
  preferredUiPort(): number | undefined
  rememberUiPort(baseUrl: string): Promise<void>
}

const state = vi.hoisted(() => ({
  bridges: [] as FakeBridge[],
  prototype: undefined as unknown as {
    start: (this: FakeBridge) => Promise<unknown>
  },
}))
const uiCaptures = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }))

vi.mock('../src/standalone/bridge.ts', () => {
  class FakeBridge implements FakeBridge {
    options: Record<string, unknown>
    endpointsNow: FakeEndpoint[] = []
    saved: unknown[] = []
    removed: unknown[] = []
    failPublish = false
    closed = false
    onSave: (input: unknown) => unknown = () => ({ revision: 'r1', providers: [] })
    onRemove: (input: unknown) => unknown = () => ({ revision: 'r1', providers: [] })
    constructor(options: Record<string, unknown>) {
      this.options = options
      state.bridges.push(this)
    }
    async start(): Promise<unknown> { return this.publish() }
    async publish(): Promise<unknown> {
      if (this.failPublish) throw new Error('simulated publish failure')
      return { version: 1, pid: process.pid, startedAtMs: 1, endpoints: this.endpointsNow }
    }
    endpoints(): FakeEndpoint[] { return this.endpointsNow }
    async uiState(): Promise<unknown> { return { version: 1, startedAtMs: 1, nowMs: 1, endpoints: [] } }
    async probePoolMember(): Promise<never> { throw new Error('no pool endpoint named test') }
    async close(): Promise<void> { this.closed = true }
    async listManagedProviders(): Promise<unknown> {
      return {
        revision: 'r1',
        providers: this.endpointsNow.map(ep => ({
          id: ep.provider,
          displayName: ep.displayName,
          baseUrl: 'https://upstream.example/v1',
          models: ['m1'],
          authMode: 'none',
          hasApiKey: false,
        })),
      }
    }
    async saveManagedProvider(input: unknown): Promise<unknown> {
      this.saved.push(input)
      return this.onSave(input)
    }
    async removeManagedProvider(input: unknown): Promise<unknown> {
      this.removed.push(input)
      return this.onRemove(input)
    }
    /**
     * Stable-address seams. The fake remembers nothing: what this suite pins is
     * the CLI's wiring (that the methods are called at all), not the document
     * the real bridge writes — that has its own suite.
     */
    preferredPortFor(_key: string): number | undefined { return undefined }
    async rememberPortFor(_key: string, _baseUrl: string): Promise<void> {}
    preferredUiPort(): number | undefined { return undefined }
    async rememberUiPort(_baseUrl: string): Promise<void> {}
  }
  state.prototype = FakeBridge.prototype as unknown as typeof state.prototype
  return { WorkBuddyBridge: FakeBridge }
})

vi.mock('../src/standalone/ui.ts', () => ({
  createWorkBuddyUiServer: (options: Record<string, unknown>) => {
    uiCaptures.options.push(options)
    return {
      ready: Promise.resolve(),
      url: () => 'http://127.0.0.1:41000',
      close: async () => {},
    }
  },
}))

vi.mock('../src/standalone/wsl.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/standalone/wsl.ts')>()
  return {
    ...actual,
    wslHostAddresses: () => ['127.0.0.1'],
    // A bind failure for one endpoint must surface as the page's publication
    // warning (and leave the rest published), so this seam can fail on demand.
    createWslForwarder: (options: import('../src/standalone/wsl.ts').WslForwarderOptions) =>
      Object.prototype.hasOwnProperty.call(bindFailures.targets, options.target)
        ? { ...actual.createWslForwarder(options), ready: Promise.reject(new Error('simulated bind failure')) }
        : actual.createWslForwarder(options),
  }
})

const bindFailures = vi.hoisted(() => ({ targets: {} as Record<string, true> }))

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-managed-'))
  vi.stubEnv('WORKBUDDY_BRIDGE_HOME', home)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', join(home, 'missing-cn'))
  vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(home, 'missing-ai'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  bindFailures.targets = {}
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
})

/**
 * Run one ui invocation, capturing its JSON document.
 *
 * `whileServing`, when given, runs while `main` is still alive — the forwarders
 * and bridge are only usable inside that window, because `serve`'s shutdown
 * cleanup closes them before `main` resolves. Tests that only inspect the
 * printed document or the (post-mutation) republished descriptor omit it.
 */
async function runServe(
  argv: string[],
  whileServing?: (bridge: FakeBridge, published: Record<string, unknown> & { endpoints: Array<Record<string, any>>, uiUrl?: string, uiWslUrl?: string }) => Promise<void>,
): Promise<{
  published: Record<string, unknown> & { endpoints: Array<Record<string, any>>, uiUrl?: string, uiWslUrl?: string }
  bridge: FakeBridge
  errors: string[]
}> {
  const logs: string[] = []
  const errors: string[] = []
  const originalInt = process.listenerCount('SIGINT')
  const originalTerm = process.listenerCount('SIGTERM')
  const logSpy = vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
    logs.push(String(text))
  })
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((text: unknown) => { errors.push(String(text)) })
  let serveError: unknown
  try {
    const running = main(argv).catch(error => { serveError = error })
    // Wait for the JSON document (printed after every listener is up), then
    // keep `main` alive while the caller exercises the live runtime.
    await vi.waitFor(() => {
      if (!logs.some(text => text.startsWith('{'))) throw new Error('serve did not print its JSON document yet')
    })
  if (whileServing !== undefined) {
    const json = logs.find(text => text.startsWith('{'))
    expect(json, 'serve did not print its JSON document').toBeDefined()
    await whileServing(
      state.bridges.at(-1)!,
      JSON.parse(json!) as Record<string, unknown> & { endpoints: Array<Record<string, any>>, uiUrl?: string, uiWslUrl?: string },
    )
  }
    process.emit('SIGTERM')
    await running
  } finally {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    // Keep this harness safe: remove the signal listeners `serve` registered.
    while (process.listenerCount('SIGINT') > originalInt) {
      process.removeListener('SIGINT', process.listeners('SIGINT').at(-1)! as () => void)
    }
    while (process.listenerCount('SIGTERM') > originalTerm) {
      process.removeListener('SIGTERM', process.listeners('SIGTERM').at(-1)! as () => void)
    }
  }
  if (serveError !== undefined) throw serveError
  const json = logs.find(text => text.startsWith('{'))
  expect(json, 'serve did not print its JSON document').toBeDefined()
  return {
    published: JSON.parse(json!) as Record<string, unknown> & { endpoints: Array<Record<string, any>>, uiUrl?: string, uiWslUrl?: string },
    bridge: state.bridges.at(-1)!,
    errors,
  }
}

const savedProvider = {
  revision: 'r1',
  displayName: 'My API',
  baseUrl: 'http://127.0.0.1:9/v1',
  models: ['m1'],
  authMode: 'none' as const,
}

const managedEndpoint: FakeEndpoint = {
  provider: 'managed',
  displayName: 'My API',
  baseUrl: 'http://127.0.0.1:9/v1',
  token: 'local-token',
  modelCount: 1,
  signedIn: true,
}

const managedSnapshot = {
  revision: 'r2',
  providers: [{ id: 'managed', displayName: 'My API', baseUrl: 'http://127.0.0.1:9/v1', models: ['m1'], authMode: 'none', hasApiKey: false }],
}

/** Make the fake bridge act like the backend: save adds the managed runtime. */
function serveAddsManaged(bridge: FakeBridge): void {
  bridge.onSave = () => {
    bridge.endpointsNow = [...bridge.endpointsNow.filter(ep => ep.provider !== 'managed'), managedEndpoint]
    return managedSnapshot
  }
}

describe('managed-provider startup wiring', () => {
  it('always enables managed providers on ui startup and wires the management callbacks', async () => {
    const { bridge } = await runServe(['ui', '--json'])
    expect(bridge.options['manageProviders']).toBe(true)
    const options = uiCaptures.options.at(-1)!
    expect(typeof options['probe']).toBe('function')
    const providers = options['providers'] as Record<string, unknown>
    expect(typeof providers['list']).toBe('function')
    expect(typeof providers['save']).toBe('function')
    expect(typeof providers['remove']).toBe('function')
  })

  it('loads saved providers on plain serve too, with no flags', async () => {
    // Plain `serve` with nothing saved and nothing configured refuses before
    // the option could matter; the flag is read at construction, so capture it
    // from the failure path.
    let options: Record<string, unknown> | undefined
    try {
      await runServe(['serve', '--json'])
    } catch {
      options = state.bridges.at(-1)?.options
    }
    expect(options?.['manageProviders']).toBe(true)
  })

  it('list reaches the bridge and returns its snapshot', async () => {
    await runServe(['ui', '--json'])
    const options = uiCaptures.options.at(-1)!
    const snapshot = await (options['providers'] as { list: () => Promise<unknown> }).list()
    expect(snapshot).toMatchObject({ revision: 'r1', providers: [] })
  })

  it('save reaches the bridge and republishes the descriptor', async () => {
    const { bridge } = await runServe(['ui', '--json'], live => {
      serveAddsManaged(live)
      return Promise.resolve()
    })
    const options = uiCaptures.options.at(-1)!
    const returned = await (options['providers'] as { save: (input: unknown) => Promise<unknown> }).save(savedProvider)
    expect(bridge.saved).toEqual([savedProvider])
    expect(returned).toEqual(managedSnapshot)
    const disk = await readBridgeDescriptor()
    expect(disk?.endpoints.map(ep => ep.provider)).toEqual(['managed'])
    expect(disk?.endpoints[0]?.token).toBe('local-token')
  })

  it('republished descriptor honors --redact-token', async () => {
    const { bridge } = await runServe(['ui', '--json', '--redact-token'], live => {
      serveAddsManaged(live)
      return Promise.resolve()
    })
    const options = uiCaptures.options.at(-1)!
    await (options['providers'] as { save: (input: unknown) => Promise<unknown> }).save(savedProvider)
    expect((await readBridgeDescriptor())?.endpoints[0]?.token).toBe('')
  })

  it('save still works under --no-descriptor and writes nothing', async () => {
    const { bridge } = await runServe(['ui', '--json', '--no-descriptor'], live => {
      serveAddsManaged(live)
      return Promise.resolve()
    })
    const options = uiCaptures.options.at(-1)!
    const returned = await (options['providers'] as { save: (input: unknown) => Promise<unknown> }).save(savedProvider)
    expect(returned).toEqual(managedSnapshot)
    expect(await readBridgeDescriptor()).toBeUndefined()
  })

  it('reconciles WSL forwarders on save and remove without replacing unchanged mappings', async () => {
    const base: FakeEndpoint = { provider: 'base', displayName: 'Base', baseUrl: 'http://127.0.0.1:8/v1', token: 't', modelCount: 1, signedIn: true }
    // The base endpoint must exist at startup so the initial descriptor (and
    // its initial WSL mapping) is published before any mutation happens.
    vi.spyOn(state.prototype, 'start').mockImplementation(async function (this: FakeBridge) {
      this.endpointsNow = [base]
      return this.publish()
    })
    const { published } = await runServe(['ui', '--wsl', '--json'], async (live, published0) => {
      // The startup JSON document already carries the WSL mapping.
      const baseWsl = published0.endpoints[0]?.wslBaseUrl as string | undefined
      expect(baseWsl).toBeDefined()
      const basePort = new URL(baseWsl!).port
      expect(published0.uiWslUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
      expect(live.endpointsNow.map(ep => ep.provider)).toEqual(['base'])

      // Add: a new forwarder appears for the managed provider, base untouched.
      serveAddsManaged(live)
      const options = uiCaptures.options.at(-1)!
      const providers = options['providers'] as { save: (input: unknown) => Promise<unknown>, remove: (input: unknown) => Promise<unknown> }
      await providers.save(savedProvider)
      const disk1 = await readBridgeDescriptor()
      const byProvider = new Map(disk1?.endpoints.map(ep => [ep.provider, ep]))
      expect(byProvider.get('managed')?.wslBaseUrl).toBeDefined()
      expect(new URL(byProvider.get('managed')!.wslBaseUrl!).port).not.toBe(basePort)
      expect(byProvider.get('base')?.wslBaseUrl).toBe(baseWsl)
      const managedPort = new URL(byProvider.get('managed')!.wslBaseUrl!).port

      // Edit (same id): the mapping must survive untouched, not be rebound.
      live.onSave = () => {
        live.endpointsNow = [base, { ...managedEndpoint, modelCount: 2 }]
        return managedSnapshot
      }
      await providers.save({ ...savedProvider, revision: 'r2', models: ['m1', 'm2'] })
      const disk2 = await readBridgeDescriptor()
      expect(new URL(disk2?.endpoints.find(ep => ep.provider === 'managed')?.wslBaseUrl!).port).toBe(managedPort)
      expect(new URL(disk2?.endpoints.find(ep => ep.provider === 'base')?.wslBaseUrl!).port).toBe(basePort)

      // Remove: exactly the removed endpoint's forwarder handle is closed —
      // its public port refuses connections afterward — while the surviving
      // endpoint's forwarder keeps answering. Both targets are dead ports, so
      // the survivor answers with the forwarder's own 502; the point is that
      // its listener is alive and untouched, not what it relays.
      live.onRemove = () => {
        live.endpointsNow = [base]
        return { revision: 'r3', providers: [] }
      }
      await providers.remove({ revision: 'r2', id: 'managed' })
      expect(live.removed).toEqual([{ revision: 'r2', id: 'managed' }])
      const disk3 = await readBridgeDescriptor()
      expect(disk3?.endpoints.map(ep => ep.provider)).toEqual(['base'])
      await expect(fetch(`http://127.0.0.1:${managedPort}/healthz`)).rejects.toThrow()
      const still = await fetch(`http://127.0.0.1:${basePort}/v1/models`)
      expect(still.status).toBe(502)

      // The UI's own WSL forwarder is never in the reconciled registry, so
      // every mutation above left it listening: the page's access route from
      // WSL is intact. The mocked UI has no real HTTP server behind it, so the
      // live forwarder answers with its own 502; a severed one would refuse.
      const uiPage = await fetch(`${published0.uiWslUrl}/`)
      expect(uiPage.status).toBe(502)
    })
    vi.mocked(state.prototype.start).mockRestore()
  })

  it('a publication failure after a save is explicit and does not roll the change back', async () => {
    const { bridge } = await runServe(['ui', '--json'])
    serveAddsManaged(bridge)
    bridge.failPublish = true
    const options = uiCaptures.options.at(-1)!
    const errors: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((text: unknown) => { errors.push(String(text)) })
    let returned: unknown
    try {
      returned = await (options['providers'] as { save: (input: unknown) => Promise<unknown> }).save(savedProvider)
    } finally {
      errorSpy.mockRestore()
    }
    expect(returned).toEqual(managedSnapshot)
    expect(bridge.endpointsNow.map(ep => ep.provider)).toEqual(['managed'])
    expect(errors.join('\n')).toMatch(/saved/u)
    expect(errors.join('\n')).toMatch(/publication failed/u)
    expect(await readBridgeDescriptor()).toBeUndefined()
  })

  it('a publication failure sets a persistent save-worded banner and success clears it', async () => {
    const { bridge } = await runServe(['ui', '--json'], live => {
      serveAddsManaged(live)
      return Promise.resolve()
    })
    const options = uiCaptures.options.at(-1)!
    const providers = options['providers'] as { save: (input: unknown) => Promise<unknown> }
    const state = options['state'] as () => Promise<{ providerWarning?: string }>
    // No banner before anything fails.
    expect((await state()).providerWarning).toBeUndefined()

    bridge.failPublish = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await providers.save(savedProvider)
    } finally {
      errorSpy.mockRestore()
    }
    expect((await state()).providerWarning).toBe('Provider saved and active, but endpoint publication failed.')

    // A later successful publication clears the banner.
    bridge.failPublish = false
    await providers.save({ ...savedProvider, revision: 'r2' })
    expect((await state()).providerWarning).toBeUndefined()
  })

  it('a publication failure after a remove uses the neutral wording', async () => {
    const { bridge } = await runServe(['ui', '--json'], live => {
      serveAddsManaged(live)
      return Promise.resolve()
    })
    const options = uiCaptures.options.at(-1)!
    const providers = options['providers'] as { remove: (input: unknown) => Promise<unknown> }
    const state = options['state'] as () => Promise<{ providerWarning?: string }>
    bridge.failPublish = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await providers.remove({ revision: 'r1', id: 'managed' })
    } finally {
      errorSpy.mockRestore()
    }
    expect((await state()).providerWarning).toBe('Provider change saved, but endpoint publication failed.')
  })

  it('a WSL bind failure keeps the warning while the rest of publication succeeds', async () => {
    const base: FakeEndpoint = { provider: 'base', displayName: 'Base', baseUrl: 'http://127.0.0.1:8/v1', token: 't', modelCount: 1, signedIn: true }
    vi.spyOn(state.prototype, 'start').mockImplementation(async function (this: FakeBridge) {
      this.endpointsNow = [base]
      return this.publish()
    })
    const { bridge } = await runServe(['ui', '--wsl', '--json'], async live => {
      serveAddsManaged(live)
      // The new managed endpoint's WSL forwarder cannot bind.
      bindFailures.targets[managedEndpoint.baseUrl] = true
      const options = uiCaptures.options.at(-1)!
      const providers = options['providers'] as { save: (input: unknown) => Promise<unknown> }
      const state = options['state'] as () => Promise<{ providerWarning?: string }>
      const errors: string[] = []
      const errorSpy = vi.spyOn(console, 'error').mockImplementation((text: unknown) => { errors.push(String(text)) })
      try {
        await providers.save(savedProvider)
      } finally {
        errorSpy.mockRestore()
      }
      // The save still committed, and everything else published: the
      // descriptor lists the new endpoint (without a WSL address for it).
      expect(live.saved).toEqual([savedProvider])
      const disk = await readBridgeDescriptor()
      const byProvider = new Map(disk?.endpoints.map(ep => [ep.provider, ep]))
      expect(byProvider.get('managed')?.wslBaseUrl).toBeUndefined()
      expect(byProvider.get('base')?.wslBaseUrl).toBeDefined()
      expect(errors.join('\n')).toMatch(/could not expose/u)
      // The bind failure surfaces as the persistent banner (save wording —
      // this mutation was a save; the neutral string is only for removes).
      expect((await state()).providerWarning).toBe('Provider saved and active, but endpoint publication failed.')
      // ...and only a fully successful publication clears it.
      delete bindFailures.targets[managedEndpoint.baseUrl]
      live.onSave = () => {
        live.endpointsNow = [base, managedEndpoint]
        return managedSnapshot
      }
      await providers.save({ ...savedProvider, revision: 'r2', models: ['m1', 'm2'] })
      expect((await state()).providerWarning).toBeUndefined()
      expect((await readBridgeDescriptor())?.endpoints.find(ep => ep.provider === 'managed')?.wslBaseUrl).toBeDefined()
    })
    vi.mocked(state.prototype.start).mockRestore()
  })

  it('the UI comes up with zero endpoints so the first provider can be added', async () => {
    const { published } = await runServe(['ui', '--json'])
    expect(published.endpoints).toEqual([])
    expect(published.uiUrl).toBe('http://127.0.0.1:41000')
  })

  it('plain serve still refuses to start with zero endpoints', async () => {
    await expect(main(['serve', '--json'])).rejects.toThrow(/no provider could start/u)
  })

  it('allowedUiOrigins reports exactly the UI origin, plus the WSL UI origin with --wsl', async () => {
    const plain = await runServe(['ui', '--json'])
    const plainOptions = uiCaptures.options.at(-1)!
    expect((plainOptions['allowedUiOrigins'] as () => string[])()).toEqual(['http://127.0.0.1:41000'])

    const { published } = await runServe(['ui', '--wsl', '--json'])
    const wslOptions = uiCaptures.options.at(-1)!
    const origins = (wslOptions['allowedUiOrigins'] as () => string[])()
    expect(origins).toEqual(['http://127.0.0.1:41000', published.uiWslUrl])
  })
})
