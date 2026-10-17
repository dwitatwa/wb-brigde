/**
 * The WSL forwarder is a frontend hop, and it has to be *transparent*.
 *
 * An agent inside WSL cannot reach a bridge bound to the Windows loopback
 * (WSL2 has its own loopback), so `--wsl` binds the host-side WSL switch
 * address and proxies back to `127.0.0.1`. Everything the agent sends must
 * arrive at the shim byte-for-byte, and the request the shim then composes for
 * the upstream must be identical to the one a Windows client produces.
 *
 * That last point is why these tests exist: the upstream validates the channel
 * on `/v2/chat/completions` via the `X-Conversation-*` header family (issues
 * #139 / #142), and a hop that silently dropped the body would surface as an
 * upstream `400 / 11128` rather than as an obvious proxy error. So the
 * assertions run all the way to the wire the upstream client builds, not just
 * to the shim's own response.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/core/auth.ts'
import { WorkBuddyCatalog } from '../src/core/catalog.ts'
import type { ChatIdentity } from '../src/core/client-identity.ts'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/core/shim.ts'
import { WorkBuddyUpstreamClient } from '../src/core/upstream.ts'
import { createWslForwarder, wslHostAddresses, type WslForwarder } from '../src/standalone/wsl.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/**
 * The WSL switch address is machine-specific, so the suite skips on a host
 * without one instead of failing. On a machine with WSL this always runs.
 */
const WSL_HOSTS = wslHostAddresses()

/** Deterministic identity: the assertion must not depend on the installed app. */
const IDENTITY: ChatIdentity = { clientVersion: '5.7.6', cliVersion: '2.137.1' }

const FAMILY = [
  'X-Conversation-ID',
  'X-Conversation-Request-ID',
  'X-Root-Request-ID',
  'X-Conversation-Message-ID',
] as const

const DASHED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const HEX32_SHAPE = /^[0-9a-f]{32}$/

interface Harness {
  shim: WorkBuddyShim
  forwarder: WslForwarder
  /** The WSL switch address the forwarder bound. */
  host: string
  /** The forwarder's ephemeral port. */
  port: number
  /** Every `(url, init)` the upstream client handed to `fetch`. */
  upstreamCalls: [string, RequestInit][]
  /** Body the stubbed upstream answers with. */
  respond: (body: string) => void
}

/**
 * Boot a real shim (real upstream client, stubbed `fetch`) behind a real
 * forwarder, so the assertions observe the composed upstream request rather
 * than a stub's echo.
 */
async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-wsl-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))

  // A global credential, because the trio is the international gateway's rule.
  const desktop = join(dir, 'workbuddy-desktop-ai.info')
  await writeFile(desktop, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'www.workbuddy.ai' },
    account: { uid: 'uid-1' },
  }))
  const store = new WorkBuddyCredentialStore({
    desktopPath: desktop,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })

  const upstreamCalls: [string, RequestInit][] = []
  let answer = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    upstreamCalls.push([String(input), init ?? {}])
    return new Response(answer, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }))

  const shim = createWorkBuddyShim({
    store,
    catalog: new WorkBuddyCatalog(),
    client: new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY }),
  })
  await shim.ready
  CLEANUP.push(() => shim.close())

  const host = WSL_HOSTS[0] as string
  const forwarder = createWslForwarder({ target: shim.baseUrl(), host })
  await forwarder.ready
  CLEANUP.push(() => forwarder.close())

  const port = Number(new URL(forwarder.url()).port)
  return {
    shim,
    forwarder,
    host,
    port,
    upstreamCalls,
    respond: (body: string) => { answer = body },
  }
}

/** Raw request with full header control, addressed to the forwarder. */
function rawRequest(options: {
  host: string
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
  /** Send the body as two chunked writes instead of one content-length'd body. */
  chunked?: boolean
}): Promise<{ status: number, headers: IncomingHttpHeaders, body: string }> {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers }
    if (options.chunked === true) headers['transfer-encoding'] = 'chunked'
    const req = request({
      host: options.host,
      port: options.port,
      method: options.method,
      path: options.path,
      headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) {
      if (options.chunked === true) {
        const half = Math.floor(options.body.length / 2)
        req.write(options.body.slice(0, half))
        req.write(options.body.slice(half))
      } else {
        req.write(options.body)
      }
    }
    req.end()
  })
}

/** A chat body shaped the way an agent sends one: developer role, object tool_choice. */
function agentChatBody(): string {
  return JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: false,
    messages: [
      { role: 'developer', content: 'You are a coding agent.' },
      { role: 'user', content: 'hi' },
    ],
    tool_choice: { type: 'function', function: { name: 'read_file' } },
  })
}

describe.skipIf(WSL_HOSTS.length === 0)('WSL forwarder transparency', () => {
  it('carries a chat request to the upstream with the #139 trio intact', async () => {
    const harness = await startHarness()
    const response = await rawRequest({
      host: harness.host,
      port: harness.port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        // The address WSL actually dials; the forwarder must rewrite it.
        host: `${harness.host}:${harness.port}`,
        authorization: `Bearer ${harness.shim.token()}`,
        'content-type': 'application/json',
      },
      body: agentChatBody(),
    })

    // The shim accepted it, so the hop preserved the Host rewrite and the bearer.
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.body).toContain('hi')
    expect(response.body).toContain('[DONE]')

    // The decisive assertion: what the upstream would have received.
    expect(harness.upstreamCalls.length).toBe(1)
    const [url, init] = harness.upstreamCalls[0] as [string, RequestInit]
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')

    const headers = init.headers as Record<string, string>
    for (const name of FAMILY) expect(headers[name]).toBeTruthy()
    expect(headers['X-Conversation-ID']).toMatch(DASHED_UUID)
    for (const name of ['X-Conversation-Request-ID', 'X-Root-Request-ID', 'X-Conversation-Message-ID'] as const) {
      expect(headers[name]).toMatch(HEX32_SHAPE)
    }

    const forwarded = JSON.parse(String(init.body)) as {
      stream: unknown
      messages: { role: string }[]
      tool_choice: unknown
    }
    // The wire quirks the shim exists to apply must survive the hop too.
    expect(forwarded.stream).toBe(true)
    expect(forwarded.messages[0]?.role).toBe('system')
    expect(forwarded.tool_choice).toBe('read_file')
  })

  it('relays a chunked request body without corrupting it', async () => {
    const harness = await startHarness()
    const body = agentChatBody()
    const response = await rawRequest({
      host: harness.host,
      port: harness.port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `${harness.host}:${harness.port}`,
        authorization: `Bearer ${harness.shim.token()}`,
        'content-type': 'application/json',
      },
      body,
      chunked: true,
    })

    expect(response.status).toBe(200)
    const forwarded = JSON.parse(String((harness.upstreamCalls[0] as [string, RequestInit])[1].body)) as {
      messages: { content: string }[]
    }
    expect(forwarded.messages[0]?.content).toBe('You are a coding agent.')
    expect(forwarded.messages[1]?.content).toBe('hi')
  })

  it('streams the SSE response back unaltered', async () => {
    const harness = await startHarness()
    // A body long enough to span several TCP writes, so a hop that re-encoded
    // it (or double-chunked it) would be caught rather than accidentally passing.
    const event = `data: {"choices":[{"delta":{"content":"${'x'.repeat(4096)}"}}]}\n\n`
    const expected = `${event}${event}data: [DONE]\n\n`
    harness.respond(expected)

    const response = await rawRequest({
      host: harness.host,
      port: harness.port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `${harness.host}:${harness.port}`,
        authorization: `Bearer ${harness.shim.token()}`,
        'content-type': 'application/json',
      },
      body: agentChatBody(),
    })

    expect(response.status).toBe(200)
    expect(response.body).toBe(expected)
  })

  it('refuses a Host that is neither loopback nor the address it bound', async () => {
    const harness = await startHarness()
    const response = await rawRequest({
      host: harness.host,
      port: harness.port,
      method: 'GET',
      path: '/v1/models',
      headers: { host: 'evil.example.com', authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(403)
    expect(response.body).toContain('request-not-trusted')
  })

  it('still requires the bearer token, so the hop does not loosen authentication', async () => {
    const harness = await startHarness()
    const response = await rawRequest({
      host: harness.host,
      port: harness.port,
      method: 'GET',
      path: '/v1/models',
      headers: { host: `${harness.host}:${harness.port}` },
    })
    expect(response.status).toBe(401)
  })

  it('proxies the root health route, not only /v1', async () => {
    const harness = await startHarness()
    const response = await rawRequest({
      host: harness.host,
      port: harness.port,
      method: 'GET',
      path: '/healthz',
      headers: { host: `${harness.host}:${harness.port}`, authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(200)
    expect(response.body).toContain('"ok":true')
  })
})
