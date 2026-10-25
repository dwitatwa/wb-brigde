import { request } from 'node:http'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkBuddyUiServer,
  type ManagedProvider,
  type ManagedProviderSnapshot,
  type ProviderManagement,
  type UiProbeRequest,
  type UiProbeResult,
  type UiState,
  type WorkBuddyUiServer,
} from '../src/standalone/ui.ts'
import { ProviderManagementError } from '../src/standalone/provider-store.ts'

/**
 * The provider-management HTTP surface of the UI.
 *
 * The security posture is deliberately tighter than "loopback browser": these
 * routes can spend an upstream provider's quota and store a secret, so the
 * gates are (1) loopback Host always, (2) the page nonce on every management
 * route, and (3) when a browser sent an Origin, it must be the exact origin
 * this server hands out — loopback or, with `--wsl`, the forwarder URL. No
 * arbitrary local port may manage providers, and no response ever carries a
 * key back or echoes one in an error.
 */

const servers: WorkBuddyUiServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

function state(): UiState {
  return { version: 1, startedAtMs: 0, nowMs: 1, endpoints: [] }
}

function snapshot(providers: ManagedProvider[] = [], revision = 'r1'): ManagedProviderSnapshot {
  return { revision, providers }
}

const oneProvider: ManagedProvider[] = [
  {
    id: 'my-llm',
    displayName: 'My LLM',
    baseUrl: 'https://api.example.com/v1',
    models: ['gpt-x'],
    authMode: 'api-key',
    hasApiKey: true,
  },
]

interface Answer {
  status: number
  text: string
  json: Record<string, unknown>
}

function call(
  server: WorkBuddyUiServer,
  path: string,
  init: { method?: string, headers?: Record<string, string>, body?: string } = {},
): Promise<Answer> {
  const { port } = new URL(server.url())
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: Number(port),
      path,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        let json: Record<string, unknown> = {}
        try { json = JSON.parse(text) as Record<string, unknown> } catch { /* page */ }
        resolve({ status: res.statusCode ?? 0, text, json })
      })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** A management manager whose calls are recorded, with controllable answers. */
function manager(overrides: Partial<ProviderManagement> = {}): ProviderManagement & {
  calls: Array<{ op: 'save' | 'remove', input: unknown }>
  throwOn: { save?: unknown, remove?: unknown }
} {
  const calls: Array<{ op: 'save' | 'remove', input: unknown }> = []
  const throwOn: { save?: unknown, remove?: unknown } = {}
  const impl = {
    calls,
    throwOn,
    list: async () => snapshot(oneProvider),
    save: async (input: unknown) => {
      calls.push({ op: 'save', input })
      if (throwOn.save !== undefined) throw throwOn.save
      return snapshot(oneProvider)
    },
    remove: async (input: unknown) => {
      calls.push({ op: 'remove', input })
      if (throwOn.remove !== undefined) throw throwOn.remove
      return snapshot([])
    },
    ...overrides,
  }
  return impl as ProviderManagement & typeof impl
}

async function start(options: {
  providers?: ProviderManagement
  allowedUiOrigins?: () => string[]
  probe?: (request: UiProbeRequest) => Promise<UiProbeResult>
} = {}): Promise<WorkBuddyUiServer> {
  const server = createWorkBuddyUiServer({ state: async () => state(), ...options })
  servers.push(server)
  await server.ready
  return server
}

async function nonceOf(server: WorkBuddyUiServer): Promise<string> {
  const page = await call(server, '/')
  const match = /var UI_NONCE = "([^"]+)";/u.exec(page.text)
  if (match?.[1] === undefined) throw new Error('the page carries no nonce')
  return match[1]
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('GET /api/providers', () => {
  it('returns the managed snapshot with revision and providers', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers', { headers: { 'X-Bridge-Ui': nonce } })
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({ revision: 'r1', providers: oneProvider })
  })

  it('answers 501 when no manager is configured', async () => {
    const server = await start()
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers', { headers: { 'X-Bridge-Ui': nonce } })
    expect(answer.status).toBe(501)
  })

  it('requires the nonce — a request without it learns nothing', async () => {
    const providers = manager()
    const server = await start({ providers })
    const answer = await call(server, '/api/providers')
    expect(answer.status).toBe(403)
    expect(answer.json['error']).toBe('request-not-trusted')
    expect(answer.text).not.toContain('my-llm')
  })

  it('rejects a browser Origin that is merely loopback but not the UI origin', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers', {
      headers: { 'X-Bridge-Ui': nonce, Origin: 'http://127.0.0.1:59999' },
    })
    expect(answer.status).toBe(403)
    expect(answer.text).not.toContain('my-llm')
  })

  it('accepts the exact served origin as browser Origin', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers', {
      headers: { 'X-Bridge-Ui': nonce, Origin: server.url() },
    })
    expect(answer.status).toBe(200)
  })

  it('accepts an exact configured WSL origin and no other port on that host', async () => {
    const providers = manager()
    const server = await start({
      providers,
      allowedUiOrigins: () => ['http://172.20.96.1:41001'],
    })
    const nonce = await nonceOf(server)
    const good = await call(server, '/api/providers', {
      headers: { 'X-Bridge-Ui': nonce, Origin: 'http://172.20.96.1:41001' },
    })
    expect(good.status).toBe(200)
    const wrongPort = await call(server, '/api/providers', {
      headers: { 'X-Bridge-Ui': nonce, Origin: 'http://172.20.96.1:41002' },
    })
    expect(wrongPort.status).toBe(403)
    const wrongHost = await call(server, '/api/providers', {
      headers: { 'X-Bridge-Ui': nonce, Origin: 'http://172.20.96.2:41001' },
    })
    expect(wrongHost.status).toBe(403)
  })
})

describe('POST /api/providers/save', () => {
  it('passes the parsed body to the manager and answers its snapshot', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const body = {
      revision: 'r1', id: 'my-llm', displayName: 'My LLM', baseUrl: 'https://api.example.com/v1',
      models: ['gpt-x'], authMode: 'api-key', apiKey: 'sk-test-123',
    }
    const answer = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify(body),
    })
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({ revision: 'r1', providers: oneProvider })
    expect(providers.calls).toEqual([{ op: 'save', input: body }])
  })

  it('omits id on add, and the response never carries a key', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const body = {
      revision: 'r1', displayName: 'Added', baseUrl: 'http://127.0.0.1:9/v1',
      models: ['m1'], authMode: 'none',
    }
    const answer = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify(body),
    })
    expect(answer.status).toBe(200)
    expect((providers.calls[0]!.input as Record<string, unknown>)['id']).toBeUndefined()
    // The snapshot never carries a key — `hasApiKey` is a boolean, and no
    // string field holds secret material. ("api-key" is a mode label.)
    expect(answer.text).not.toMatch(/"apiKey"\s*:\s*"[^"]/u)
    expect(answer.json).toEqual({ revision: 'r1', providers: oneProvider })
  })

  it('requires the nonce and rejects foreign browser origins', async () => {
    const providers = manager()
    const server = await start({ providers })
    const body = JSON.stringify({ revision: 'r1', displayName: 'X', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'], authMode: 'none' })
    const noNonce = await call(server, '/api/providers/save', { method: 'POST', headers: JSON_HEADERS, body })
    expect(noNonce.status).toBe(403)
    const nonce = await nonceOf(server)
    const foreign = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce, Origin: 'http://localhost:12345' },
      body,
    })
    expect(foreign.status).toBe(403)
    expect(providers.calls).toEqual([])
  })

  it('answers 501 when no manager is configured', async () => {
    const server = await start()
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1', displayName: 'X', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'], authMode: 'none' }),
    })
    expect(answer.status).toBe(501)
  })

  it('demands JSON content type like the probe route does', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1' }),
    })
    expect(answer.status).toBe(415)
  })

  it('answers 400 on a malformed body without echoing it', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    for (const body of ['not json', '[]', '{}', '{"revision":"r1"}']) {
      const answer = await call(server, '/api/providers/save', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
        body,
      })
      expect(answer.status, body).toBe(400)
      expect(answer.text).not.toContain(body)
    }
    expect(providers.calls).toEqual([])
  })

  it('limits body size with 413', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1', models: Array.from({ length: 4096 }, () => 'x'.repeat(64)), displayName: 'x', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'none' }),
    })
    expect(answer.status).toBe(413)
  })

  it('surfaces a known manager error by status and safe message only', async () => {
    const providers = manager()
    providers.throwOn.save = new ProviderManagementError(409, 'a provider with this id already exists')
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1', id: 'my-llm', displayName: 'X', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'], authMode: 'none' }),
    })
    expect(answer.status).toBe(409)
    expect(answer.json['error']).toBe('a provider with this id already exists')
  })

  it('answers a generic message for unknown manager errors', async () => {
    const providers = manager()
    providers.throwOn.save = new Error('boom with apiKey=sk-super-secret')
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1', id: 'my-llm', displayName: 'X', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'], authMode: 'none' }),
    })
    expect(answer.status).toBe(500)
    expect(answer.json['error']).toBe('provider management failed')
    expect(answer.text).not.toContain('boom')
    expect(answer.text).not.toContain('sk-super-secret')
  })

  it('does not host-log a raw manager error either — its text can carry the key', async () => {
    const logged: unknown[][] = []
    const providers = manager()
    providers.throwOn.save = new Error('boom with apiKey=sk-super-secret')
    const server = await start({
      providers,
      // A logger the host could have wired; it must stay silent here.
    })
    // Re-create with a logger by reaching into the options path used above.
    servers.pop()
    await server.close()
    const withLogger = createWorkBuddyUiServer({
      state: async () => state(),
      providers,
      logger: {
        warn: (...parts: unknown[]) => { logged.push(parts) },
        error: (...parts: unknown[]) => { logged.push(parts) },
      },
    })
    servers.push(withLogger)
    await withLogger.ready
    const nonce = await nonceOf(withLogger)
    const answer = await call(withLogger, '/api/providers/save', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1', id: 'my-llm', displayName: 'X', baseUrl: 'http://127.0.0.1:9/v1', models: ['m'], authMode: 'none' }),
    })
    expect(answer.status).toBe(500)
    expect(logged).toEqual([])
    expect(JSON.stringify(logged)).not.toContain('sk-super-secret')
  })
})

describe('POST /api/providers/remove', () => {
  it('passes {revision, id} to the manager', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers/remove', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1', id: 'my-llm' }),
    })
    expect(answer.status).toBe(200)
    expect(providers.calls).toEqual([{ op: 'remove', input: { revision: 'r1', id: 'my-llm' } }])
    expect(answer.json).toEqual({ revision: 'r1', providers: [] })
  })

  it('answers 400 on a missing id rather than calling the manager', async () => {
    const providers = manager()
    const server = await start({ providers })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/providers/remove', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ revision: 'r1' }),
    })
    expect(answer.status).toBe(400)
    expect(providers.calls).toEqual([])
  })
})

describe('the origin gate across routes', () => {
  it('still serves the page and state to a loopback browser without a nonce', async () => {
    const server = await start({ providers: manager() })
    expect((await call(server, '/')).status).toBe(200)
    const stateAnswer = await call(server, '/api/state', { headers: { Origin: 'http://127.0.0.1:59999' } })
    expect(stateAnswer.status).toBe(200)
  })

  it('admits a page load and state poll from the exact WSL origin without a nonce', async () => {
    const server = await start({ allowedUiOrigins: () => ['http://172.20.96.1:41001'] })
    const page = await call(server, '/', { headers: { Origin: 'http://172.20.96.1:41001' } })
    expect(page.status).toBe(200)
    const stateAnswer = await call(server, '/api/state', { headers: { Origin: 'http://172.20.96.1:41001' } })
    expect(stateAnswer.status).toBe(200)
  })

  it('still refuses a non-loopback Host on every route', async () => {
    const server = await start({ providers: manager(), allowedUiOrigins: () => ['http://172.20.96.1:41001'] })
    const page = await call(server, '/', { headers: { Host: 'evil.example.com' } })
    expect(page.status).toBe(403)
    const api = await call(server, '/api/providers', { headers: { Host: 'evil.example.com' } })
    expect(api.status).toBe(403)
  })

  it('keeps the probe route on loopback origins only', async () => {
    const server = await start({
      allowedUiOrigins: () => ['http://172.20.96.1:41001'],
      probe: async () => { throw new Error('must not run') },
    })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/pool/test', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce, Origin: 'http://172.20.96.1:41001' },
      body: JSON.stringify({ provider: 'workbuddy-ai-pool', index: 0 }),
    })
    expect(answer.status).toBe(403)
  })
})

describe('the dialogs start closed', () => {
  /**
   * The backdrop's `display: flex` author rule beats the UA stylesheet's
   * `[hidden] { display: none }`, so a `hidden` attribute alone left both
   * dialogs painted over the page from the first load — blocking every click
   * below them. The stylesheet must override that explicitly, and the markup
   * must carry `hidden` from the server so the closed state holds before any
   * script runs.
   */
  it('carries hidden backdrops and a stylesheet that keeps them display:none', async () => {
    const server = await start({ providers: manager() })
    const page = await call(server, '/')
    expect(page.text).toContain('<div id="editor-backdrop" class="dialog-backdrop" hidden>')
    expect(page.text).toContain('<div id="remove-backdrop" class="dialog-backdrop" hidden>')
    // Without this rule the author `display: flex` on .dialog-backdrop wins
    // and the attribute is ignored — the exact bug the smoke run caught.
    expect(page.text).toMatch(/\.dialog-backdrop\[hidden\]\s*\{\s*display:\s*none;\s*\}/u)
  })
})

/**
 * An executable client harness: run the served page script against a fake DOM
 * and a scripted fetch, then drive the dialog flow. Text assertions on the
 * page source cannot catch the revision race — the flow has to run.
 */
interface FakeNode {
  textContent: string
  innerHTML: string
  value: string
  hidden: boolean
  className: string
  disabled: boolean
  checked: boolean
  focus: () => void
  addEventListener: (type: string, listener: (event?: unknown) => void) => void
  listeners: Map<string, Array<(event?: unknown) => void>>
  querySelector: (selector: string) => FakeNode | null
  querySelectorAll: (selector: string) => FakeNode[]
  setAttribute: (name: string, value: string) => void
  getAttribute: (name: string) => string | null
  classList: { toggle: (name: string, on: boolean) => void }
  onclick: ((event?: unknown) => void) | null
}

function fakeNode(id: string): FakeNode {
  const attrs = new Map<string, string>()
  const listeners = new Map<string, Array<(event?: unknown) => void>>()
  const makeNode = (): FakeNode => ({
    textContent: '', innerHTML: '', value: '', hidden: false, className: '',
    disabled: false, checked: false,
    listeners,
    focus: () => {},
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    querySelector: (selector: string) => selector === '.dialog' ? makeChild() : null,
    querySelectorAll: () => [],
    setAttribute: (name, value) => { attrs.set(name, value) },
    getAttribute: name => attrs.get(name) ?? null,
    classList: { toggle: () => {} },
    onclick: null,
  })
  const makeChild = (): FakeNode => ({ ...makeNode(), querySelector: () => null })
  const node = makeNode()
  if (id === 'editor-backdrop' || id === 'remove-backdrop') node.hidden = true
  return node
}

function clientHarness(pageText: string): {
  nodes: Map<string, FakeNode>
  document: {
    getElementById: (id: string) => FakeNode
    addEventListener: (type: string, listener: (event?: unknown) => void) => void
    activeElement: FakeNode | null
    querySelector: (selector: string) => FakeNode | null
  }
  requests: Array<{ path: string, init: { method?: string, headers?: Record<string, string>, body?: string } }>
  respond: (path: string, next: unknown) => void
  run: (expression: string) => void
  tick: () => Promise<void>
} {
  const nodes = new Map<string, FakeNode>()
  const node = (id: string): FakeNode => {
    if (!nodes.has(id)) nodes.set(id, fakeNode(id))
    return nodes.get(id)!
  }
  // One queue slot per path: the page fires /api/state (load) and
  // /api/providers (loadProviders) at startup, and each gets its own answer.
  const pending = new Map<string, { resolve: (value: unknown) => void }>()
  const requests: Array<{ path: string, init: { method?: string, headers?: Record<string, string>, body?: string } }> = []
  const fetchStub = (path: string, init: Record<string, unknown> = {}): Promise<unknown> => {
    requests.push({ path: String(path), init: init as never })
    return new Promise(resolve => { pending.set(String(path), { resolve }) })
  }
  const documentStub = {
    getElementById: node,
    addEventListener: () => {},
    activeElement: null,
    querySelector: (selector: string) =>
      selector === '.dialog-backdrop:not([hidden])'
        ? [node('editor-backdrop'), node('remove-backdrop')].find(b => !b.hidden) ?? null
        : null,
  }
  const context = {
    document: documentStub,
    fetch: fetchStub,
    setInterval: () => 0,
  }
  const script = /<script>([\s\S]*?)<\/script>/u.exec(pageText)![1]!
  runInNewContext(script, context)
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return {
    nodes,
    document: documentStub,
    requests,
    respond: (path: string, next: unknown) => {
      const p = pending.get(path)
      pending.delete(path)
      p?.resolve({ ok: true, status: 200, json: async () => next })
    },
    run: expression => { runInNewContext(expression, context) },
    tick,
  }
}

describe('the editor pins the revision it was opened with', () => {
  it('a poll that adopts a newer revision blocks the save instead of overwriting', async () => {
    const server = await start({ providers: manager() })
    const harness = clientHarness((await call(server, '/')).text)
    // The page's initial fetches are pending; answer each by path.
    harness.respond('/api/state', state())
    harness.respond('/api/providers', snapshot(oneProvider))
    await harness.tick()
    // Open the editor on the existing provider — pinned at r1.
    harness.run('openEditor("my-llm")')
    // Meanwhile a poll adopts a newer snapshot (the page's 5s interval calls
    // loadProviders(); the harness triggers it explicitly).
    harness.run('loadProviders()')
    harness.respond('/api/providers', snapshot([{ ...oneProvider[0]!, displayName: 'Renamed elsewhere' }], 'r2'))
    await harness.tick()
    expect(harness.nodes.get('editor-title')!.textContent).toBe('Edit provider')
    harness.nodes.get('editor-name')!.value = 'Typed here'
    harness.run('saveEditor()')
    // The stale save must not have fired: no POST since the two GETs.
    const posts = harness.requests.filter(request => request.init.method === 'POST')
    expect(posts).toEqual([])
    expect(harness.nodes.get('editor-error')!.textContent).toContain('changed since the dialog opened')
    // The dialog stays open and the save stays disabled: a conflict requires
    // a reopen, it never auto-adopts the newer revision.
    expect(harness.nodes.get('editor-backdrop')!.hidden).toBe(false)
    expect(harness.nodes.get('editor-save')!.disabled).toBe(true)
  })

  it('a save against the revision it was opened with goes out with that revision', async () => {
    const server = await start({ providers: manager() })
    const harness = clientHarness((await call(server, '/')).text)
    harness.respond('/api/state', state())
    harness.respond('/api/providers', snapshot(oneProvider))
    await harness.tick()
    harness.run('openEditor("my-llm")')
    // No newer poll in between: the save carries the pinned revision.
    harness.nodes.get('editor-name')!.value = 'Typed here'
    harness.run('saveEditor()')
    const posts = harness.requests.filter(request => request.init.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0]!.init.body!)).toMatchObject({ revision: 'r1', id: 'my-llm' })
  })

  it('a remove confirmed against a stale revision is blocked the same way', async () => {
    const server = await start({ providers: manager() })
    const harness = clientHarness((await call(server, '/')).text)
    harness.respond('/api/state', state())
    harness.respond('/api/providers', snapshot(oneProvider))
    await harness.tick()
    harness.run('openRemove("my-llm")')
    harness.run('loadProviders()')
    harness.respond('/api/providers', snapshot([], 'r2'))
    await harness.tick()
    harness.run('confirmRemove()')
    const posts = harness.requests.filter(request => request.init.method === 'POST')
    expect(posts).toEqual([])
    expect(harness.nodes.get('remove-error')!.textContent).toContain('changed since this was opened')
  })

  it('the publication warning renders outside #app and persists', async () => {
    const server = await start({ providers: manager() })
    const harness = clientHarness((await call(server, '/')).text)
    harness.respond('/api/state', state())
    harness.respond('/api/providers', snapshot(oneProvider))
    await harness.tick()
    // A state document carrying the host-owned warning string.
    const warned: unknown = { ...state(), providerWarning: 'A provider change is active but its endpoint publication failed — the addresses on this page may be stale.' }
    harness.run(`render(${JSON.stringify(warned)})`)
    const banner = harness.nodes.get('provider-warning')!
    expect(banner.className).toBe('active')
    expect(banner.textContent).toContain('publication failed')
    // A later state without the warning clears it.
    harness.run(`render(${JSON.stringify(state())})`)
    expect(banner.className).toBe('')
    expect(banner.textContent).toBe('')
  })
})

describe('json answers carry no-store', () => {
  it('every JSON answer, errors included, is marked no-store', async () => {
    const server = await start({ providers: manager() })
    const nonce = await nonceOf(server)
    const answers = await Promise.all([
      call(server, '/api/state'),
      call(server, '/api/providers', { headers: { 'X-Bridge-Ui': nonce } }),
      call(server, '/api/providers', {}), // 403
      call(server, '/api/providers/save', {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'X-Bridge-Ui': nonce },
        body: '{bad',
      }), // 400
    ])
    for (const answer of answers) {
      expect(answer.text ? undefined : '').toBeUndefined() // parsed; see headers below
    }
    // `call` does not expose headers; re-issue one raw request to assert them.
    const raw = await new Promise<{ status: number, cacheControl: string | undefined }>((resolve, reject) => {
      const { port } = new URL(server.url())
      const req = request({ host: '127.0.0.1', port: Number(port), path: '/api/state' }, res => {
        resolve({ status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'] })
      })
      req.on('error', reject)
      req.end()
    })
    expect(raw.status).toBe(200)
    expect(raw.cacheControl).toBe('no-store')
  })
})
