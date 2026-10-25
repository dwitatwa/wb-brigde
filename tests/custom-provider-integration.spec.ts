import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyBridge, type BridgeOptions } from '../src/standalone/bridge.ts'
import { main } from '../src/standalone/cli.ts'
import { bridgeDescriptorPath, readBridgeDescriptor, writeBridgeDescriptor } from '../src/standalone/descriptor.ts'
import { createWslForwarder } from '../src/standalone/wsl.ts'

let home: string
const cleanup: Array<() => Promise<void>> = []
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-custom-'))
  vi.stubEnv('WORKBUDDY_BRIDGE_HOME', home)
  vi.stubEnv('WORKBUDDY_AUTH_FILE', join(home, 'missing-cn'))
  vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(home, 'missing-ai'))
})
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
  await rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = 0
})

const provider = (id = 'custom') => ({ id, displayName: `Custom ${id}`, baseUrl: 'http://127.0.0.1:1/prefix', models: ['shared-model'] })
async function start(options: BridgeOptions) {
  const bridge = new WorkBuddyBridge(options)
  cleanup.push(() => bridge.close())
  const descriptor = await bridge.start()
  return { bridge, descriptor }
}
async function upstream(status = 200, sse = false) {
  const calls: { path: string, auth: string | undefined, body: string }[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    calls.push({ path: req.url!, auth: req.headers.authorization, body })
    res.writeHead(status, { 'Content-Type': sse ? 'text/event-stream' : 'application/json' })
    res.end(sse ? 'data: {"choices":[{"delta":{"reasoning_content":"a"}}]}\n\ndata: {"choices":[{"delta":{"reasoning_content":"b"}}]}\n\ndata: [DONE]\n\n' : JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const addr = server.address() as { port: number }
  return { baseUrl: `http://127.0.0.1:${addr.port}/api/prefix`, calls }
}

describe('custom provider bridge integration', () => {
  it('serves two providers through one pooled endpoint with a local token', async () => {
    const { bridge, descriptor } = await start({ variants: [], providers: [provider('one'), provider('two')], discoverAccounts: true } as BridgeOptions)
    expect(descriptor.version).toBe(1)
    // The pool is the ONLY endpoint: no per-provider listeners exist.
    expect(descriptor.endpoints.map(ep => ep.provider)).toEqual(['custom-pool'])
    const pool = descriptor.endpoints[0]!
    expect(pool.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u)
    expect(pool.token).not.toContain('http')
    expect((await fetch(`${pool.baseUrl}/models`)).status).toBe(401)
    // The pool offers the union of its members' models under its own id.
    const pooled = await fetch(`${pool.baseUrl}/models`, { headers: { Authorization: `Bearer ${pool.token}` } })
    expect(await pooled.json()).toMatchObject({ data: [{ id: 'shared-model', owned_by: 'custom-pool' }] })
    const state = await bridge.uiState()
    expect(state.endpoints.map(ep => ep.kind)).toEqual([undefined])
    expect(state.endpoints[0]!.pool!.members.map(m => m.label)).toEqual(['Custom one', 'Custom two'])
    await bridge.publishToDisk()
    expect((await readBridgeDescriptor())?.endpoints).toEqual(descriptor.endpoints)
    await bridge.close()
    expect(bridge.endpoints()).toEqual([])
    await expect(fetch(pool.baseUrl)).rejects.toThrow()
  })

  it('serves one provider through the pool alone', async () => {
    const { bridge, descriptor } = await start({ variants: [], providers: [provider('one')] } as BridgeOptions)
    expect(descriptor.endpoints.map(ep => ep.provider)).toEqual(['custom-pool'])
    const pool = descriptor.endpoints[0]!
    expect(pool.signedIn).toBe(true)
    const response = await fetch(`${pool.baseUrl}/models`, { headers: { Authorization: `Bearer ${pool.token}` } })
    expect(await response.json()).toMatchObject({ data: [{ id: 'shared-model', owned_by: 'custom-pool' }] })
    // The UI card names the one member.
    const state = await bridge.uiState()
    expect(state.endpoints[0]!.pool!.members.map(m => m.label)).toEqual(['Custom one'])
  })

  it('keeps default built-in ordering before configured providers', async () => {
    const { descriptor } = await start({ providers: [provider()] } as BridgeOptions)
    expect(descriptor.endpoints.map(ep => ep.provider)).toEqual(['workbuddy-pool', 'workbuddy-ai-pool', 'custom-pool'])
  })

  it.each([null, [], [provider('cn')], [{ ...provider(), baseUrl: 'https://user:secret@example.com' }]].map(providers => ({ providers })))('validates direct provider options before starting listeners: $providers', async ({ providers }) => {
    const bridge = new WorkBuddyBridge({ providers } as unknown as BridgeOptions)
    cleanup.push(() => bridge.close())
    await expect(bridge.start()).rejects.toThrow(/provider|baseUrl/u)
    expect(bridge.endpoints()).toEqual([])
  })

  it.each([200, 402, 429, 500])('records coarse HTTP metadata for pooled requests with status %i', async status => {
    const mock = await upstream(status)
    vi.stubEnv('CUSTOM_TEST_KEY', 'upstream-secret')
    const { bridge, descriptor } = await start({ variants: [], providers: [{ ...provider(), baseUrl: mock.baseUrl, apiKeyEnv: 'CUSTOM_TEST_KEY' }] } as BridgeOptions)
    const ep = descriptor.endpoints[0]!
    const body = '{"model":"shared-model","messages":[{"role":"developer","content":"private prompt"}],"stream":false,"tool_choice":{"type":"auto"}}'
    const response = await fetch(`${ep.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' }, body })
    expect(response.status).toBe(status)
    await response.text()
    expect(mock.calls).toEqual([{ path: '/api/prefix/chat/completions', auth: 'Bearer upstream-secret', body }])
    const state = await bridge.uiState()
    expect(state.endpoints[0]).toMatchObject({ signedIn: true, models: [{ id: 'shared-model' }], requests: [{ model: 'shared-model', status, outcome: status === 200 ? 'ok' : status >= 500 ? 'server' : status === 402 ? 'hard_credit' : status === 429 ? 'soft_rate' : 'client' }] })
    expect(state.endpoints[0]?.requests).toHaveLength(1)
    // The chain names the serving provider even when only one was tried.
    expect(state.endpoints[0]?.requests![0]?.attempts).toEqual([{ account: 'Custom custom', outcome: status === 200 ? 'ok' : status >= 500 ? 'server' : status === 402 ? 'hard_credit' : status === 429 ? 'soft_rate' : 'client', ...(status === 200 ? {} : { status }) }])
    expect(JSON.stringify(state)).not.toMatch(/private prompt|upstream-secret|api\/prefix/u)
    await expect(access(join(home, 'last-channel-failure.json'))).rejects.toThrow()
  })

  it('does not coalesce generic reasoning streams', async () => {
    const mock = await upstream(200, true)
    const { descriptor } = await start({ variants: [], providers: [{ ...provider(), baseUrl: mock.baseUrl }] } as BridgeOptions)
    const ep = descriptor.endpoints[0]!
    const response = await fetch(`${ep.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' }, body: '{"model":"shared-model","messages":[],"stream":true}' })
    const body = await response.text()
    expect(body.match(/reasoning_content/gu)).toHaveLength(2)
  })

  it('keeps the pool available locally but hides models and reports the safe reason when no key resolves', async () => {
    vi.stubEnv('CUSTOM_MISSING_KEY', '')
    const { bridge, descriptor } = await start({ variants: [], providers: [{ ...provider(), apiKeyEnv: 'CUSTOM_MISSING_KEY' }] } as BridgeOptions)
    const ep = descriptor.endpoints[0]!
    expect(ep).toMatchObject({ signedIn: false, modelCount: 0 })
    expect((await bridge.uiState()).endpoints[0]).toMatchObject({ signedIn: false, models: [], error: expect.stringContaining('no provider in the pool has a usable key') })
    const response = await fetch(`${ep.baseUrl}/models`, { headers: { Authorization: `Bearer ${ep.token}` } })
    expect(await response.json()).toMatchObject({ data: [] })
    vi.stubEnv('CUSTOM_MISSING_KEY', 'now-present')
    expect(bridge.endpoints()[0]).toMatchObject({ signedIn: true, modelCount: 1 })
  })

  it('forwards generic auth and chat over the WSL forwarding path', async () => {
    const mock = await upstream()
    const { descriptor } = await start({ variants: [], providers: [{ ...provider(), baseUrl: mock.baseUrl }] } as BridgeOptions)
    const ep = descriptor.endpoints[0]!
    const forwarder = createWslForwarder({ target: ep.baseUrl, host: '127.0.0.1' })
    cleanup.push(() => forwarder.close())
    await forwarder.ready
    expect((await fetch(`${forwarder.url()}/v1/models`)).status).toBe(401)
    const response = await fetch(`${forwarder.url()}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${ep.token}`, 'Content-Type': 'application/json' }, body: '{"model":"shared-model","messages":[]}' })
    expect(response.status).toBe(200)
    await response.text()
    expect(mock.calls[0]?.path).toBe('/api/prefix/chat/completions')
  })
})

async function configFile(text = JSON.stringify({ version: 1, providers: [provider()] })) {
  const path = join(home, 'providers.json')
  await writeFile(path, text)
  return path
}
async function runServe(argv: string[]) {
  let published: Record<string, unknown> | undefined
  let disk: Awaited<ReturnType<typeof readBridgeDescriptor>>
  const originalInt = process.listenerCount('SIGINT')
  const originalTerm = process.listenerCount('SIGTERM')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
    if (typeof text === 'string' && text.startsWith('{')) {
      published = JSON.parse(text) as Record<string, unknown>
      setTimeout(() => { void readBridgeDescriptor().then(value => { disk = value; process.emit('SIGTERM') }) }, 0)
    }
  })
  await main([...argv, '--json'])
  // Keep this harness safe on the old implementation, which leaves the unused signal listener behind.
  while (process.listenerCount('SIGINT') > originalInt) process.removeListener('SIGINT', process.listeners('SIGINT').at(-1)! as () => void)
  while (process.listenerCount('SIGTERM') > originalTerm) process.removeListener('SIGTERM', process.listeners('SIGTERM').at(-1)! as () => void)
  return { published: published as { endpoints: Array<{ provider: string, token: string }>, uiUrl?: string }, disk: disk! }
}

describe('custom provider CLI integration', () => {
  it.each([
    { selection: [], expected: ['workbuddy-pool', 'workbuddy-ai-pool', 'custom-pool'] },
    { selection: ['--provider', 'custom'], expected: ['custom-pool'] },
    { selection: ['--provider', 'cn,custom,cn', '--provider', 'ai,custom'], expected: ['workbuddy-pool', 'workbuddy-ai-pool', 'custom-pool'] },
    { selection: ['--provider', 'both'], expected: ['workbuddy-pool', 'workbuddy-ai-pool'] },
    { selection: ['--provider', 'ai,cn,custom'], expected: ['workbuddy-ai-pool', 'workbuddy-pool', 'custom-pool'] },
  ])('selects only requested providers and deduplicates $selection', async ({ selection, expected }) => {
    const result = await runServe(['serve', '--config', await configFile(), ...selection])
    expect(result.published.endpoints.map(ep => ep.provider)).toEqual(expected)
    expect(result.disk?.endpoints.map(ep => ep.provider)).toEqual(expected)
    expect(await readBridgeDescriptor()).toBeUndefined()
  })

  it('allows a custom ID that matches an Object property name', async () => {
    const path = await configFile(JSON.stringify({ version: 1, providers: [provider('constructor')] }))
    const result = await runServe(['serve', '--config', path, '--provider', 'constructor'])
    expect(result.published.endpoints.map(ep => ep.provider)).toEqual(['custom-pool'])
  })

  it('supports custom-only UI with redacted descriptor and JSON', async () => {
    const result = await runServe(['ui', '--config', await configFile(), '--provider', 'custom', '--redact-token'])
    expect(result.published.uiUrl).toMatch(/^http:\/\/127\.0\.0\.1:/u)
    expect(result.published.endpoints[0]?.token).toBe('')
    expect(result.disk?.endpoints[0]?.token).toBe('')
  })

  it('preserves --no-descriptor for custom endpoints', async () => {
    const result = await runServe(['serve', '--config', await configFile(), '--provider', 'custom', '--no-descriptor'])
    expect(result.published.endpoints[0]?.token).not.toBe('')
    expect(result.disk).toBeUndefined()
  })

  it.each(['{secret-input', '{"providers":[],"version":1}', '{"version":2,"providers":[]}'])('rejects malformed config without printing its contents: %s', async text => {
    await expect(main(['serve', '--config', await configFile(text)])).rejects.toThrow(/config/u)
    await expect(access(bridgeDescriptorPath())).rejects.toThrow()
    try { await main(['ui', '--config', await configFile(text)]) } catch (error) { expect(String(error)).not.toContain('secret-input') }
  })

  it.each([['--config'], ['--config', '--ui'], ['--provider'], ['--provider', '--ui'], ['--provider', ',']].map(flags => ({ flags })))('rejects a missing flag value: $flags', async ({ flags }) => {
    await expect(main(['serve', ...flags])).rejects.toThrow(/needs a value/u)
  })

  it('rejects an unreadable config without file contents', async () => {
    await expect(main(['serve', '--config', join(home, 'missing')])).rejects.toThrow(/config/u)
  })

  it('rejects unknown providers before startup', async () => {
    await expect(main(['serve', '--config', await configFile(), '--provider', 'unknown'])).rejects.toThrow(/unknown provider/u)
    expect(await readBridgeDescriptor()).toBeUndefined()
  })

  it('does not silently fall back when test selects an unknown provider', async () => {
    const { descriptor } = await start({ variants: [] })
    await writeBridgeDescriptor(descriptor)
    await expect(main(['test', '--provider', 'unknown'])).rejects.toThrow(/unknown provider/u)
  })

  it('uses the descriptor for custom models, status, env and test without reopening config', async () => {
    const mock = await upstream(200, true)
    const { descriptor } = await start({ variants: [], providers: [{ ...provider(), baseUrl: mock.baseUrl }] })
    await writeBridgeDescriptor(descriptor)
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation(text => { output.push(String(text)) })
    await main(['models', '--json', '--config', join(home, 'not-read')])
    expect(JSON.parse(output.pop()!)).toMatchObject([{ provider: 'custom-pool', models: ['shared-model'] }])
    await main(['status', '--json'])
    expect(JSON.parse(output.pop()!)).toMatchObject({ version: 1, alive: true, endpoints: [{ provider: 'custom-pool' }] })
    await main(['env'])
    expect(output.join('\n')).toContain(`export OPENAI_BASE_URL=${descriptor.endpoints[0]!.baseUrl}`)
    expect(output.join('\n')).toContain(`export OPENAI_API_KEY=${descriptor.endpoints[0]!.token}`)
    await main(['test', '--provider', 'custom-pool', '--json'])
    expect(JSON.parse(output.pop()!)).toMatchObject({ provider: 'custom-pool', model: 'shared-model', results: [{ ok: true }] })
  })

  it('probes only the named second account when accounts share a provider ID', async () => {
    const alice = await upstream(200, true)
    const bob = await upstream(200, true)
    await writeBridgeDescriptor({
      version: 1, pid: process.pid, startedAtMs: Date.now(),
      endpoints: [alice, bob].map((account, index) => ({
        provider: 'workbuddy-ai', displayName: `WorkBuddy AI · ${index === 0 ? 'alice' : 'bob'}`,
        baseUrl: account.baseUrl, token: `local-account-${index}`, signedIn: true, modelCount: 1,
      })),
    })
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation(text => { output.push(String(text)) })
    await main(['test', '--provider', 'WorkBuddy AI · bob', '--model', 'shared-model', '--json'])
    expect(alice.calls).toEqual([])
    expect(bob.calls).toHaveLength(1)
    expect(bob.calls[0]).toMatchObject({ path: '/api/prefix/chat/completions', auth: 'Bearer local-account-1' })
    expect(JSON.parse(output.pop()!)).toMatchObject({ results: [{ baseUrl: bob.baseUrl, ok: true }] })
    await expect(main(['test', '--provider', 'WorkBuddy AI · unknown', '--model', 'shared-model'])).rejects.toThrow(/unknown provider/u)
    expect(alice.calls).toEqual([])
    expect(bob.calls).toHaveLength(1)
  })

  it.each([
    { selection: 'target', otherName: 'target', targetId: 'target', targetName: 'Target API' },
    { selection: 'ai', otherName: 'Other API', targetId: 'target', targetName: 'ai' },
  ])('resolves exact IDs before names and names before aliases: $selection', async ({ selection, otherName, targetId, targetName }) => {
    const other = await upstream(200, true)
    const target = await upstream(200, true)
    await writeBridgeDescriptor({
      version: 1, pid: process.pid, startedAtMs: Date.now(),
      endpoints: [
        { provider: selection === 'ai' ? 'workbuddy-ai' : 'other', displayName: otherName, baseUrl: other.baseUrl, token: 'other-token', signedIn: true, modelCount: 1 },
        { provider: targetId, displayName: targetName, baseUrl: target.baseUrl, token: 'target-token', signedIn: true, modelCount: 1 },
      ],
    })
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation(text => { output.push(String(text)) })
    await main(['test', '--provider', selection, '--model', 'shared-model', '--json'])
    expect(other.calls).toEqual([])
    expect(target.calls).toHaveLength(1)
    expect(target.calls[0]).toMatchObject({ auth: 'Bearer target-token' })
    expect(JSON.parse(output.pop()!)).toMatchObject({ provider: targetId, results: [{ baseUrl: target.baseUrl, ok: true }] })
  })

  it('expands built-in aliases when testing and rejects every unknown selection', async () => {
    const { descriptor } = await start({ providers: [provider()] })
    await writeBridgeDescriptor(descriptor)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(['test', '--provider', 'ai'])
    expect(process.exitCode).toBe(1)
    await expect(main(['test', '--provider', 'custom,unknown'])).rejects.toThrow(/unknown provider/u)
  })

  it('explains config and custom selection in help', async () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation(text => { output.push(String(text)) })
    await main(['help'])
    expect(output.join('\n')).toContain('--config <path>')
    expect(output.join('\n')).toMatch(/custom.*id/iu)
  })
})
