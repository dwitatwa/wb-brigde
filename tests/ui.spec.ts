import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkBuddyUiServer,
  type UiProbeRequest,
  type UiProbeResult,
  type UiState,
  type WorkBuddyUiServer,
} from '../src/standalone/ui.ts'

/**
 * The UI's HTTP surface, as opposed to what it renders.
 *
 * Three things matter here and none of them are cosmetic: the loopback gate
 * still holds, the one state-changing route cannot be driven by a page this
 * server did not hand out, and a probe result crossing to the browser is
 * redacted like every other string that reaches it.
 */

const servers: WorkBuddyUiServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

/** A state document with one pool over two accounts. */
function state(): UiState {
  return {
    version: 1,
    startedAtMs: 0,
    nowMs: 1_700_000_000_000,
    endpoints: [
      {
        provider: 'workbuddy-ai-pool',
        displayName: 'WorkBuddy AI · pool (failover)',
        baseUrl: 'http://127.0.0.1:51003/v1',
        signedIn: true,
        models: [],
        requests: [
          {
            atMs: 1_700_000_000_000,
            model: 'model-x',
            status: 200,
            outcome: 'ok',
            latencyMs: 420,
            attempts: [{ account: 'alice', outcome: 'ok' }],
          },
          {
            atMs: 1_700_000_001_000,
            model: 'model-x',
            status: 402,
            outcome: 'hard_credit',
            latencyMs: 1200,
            attempts: [
              { account: 'alice', outcome: 'hard_credit', status: 402 },
              { account: 'bob', outcome: 'ok' },
            ],
          },
        ],
        pool: {
          headIndex: 0,
          members: [
            {
              index: 0,
              accountIndex: 1,
              label: 'alice',
              signedIn: true,
              baseUrl: 'http://127.0.0.1:51001/v1',
              head: true,
              successes: 2,
              failures: 0,
              consecutiveFailures: 0,
              lastAttemptAtMs: 1_700_000_000_000,
              lastOutcome: 'ok',
            },
            {
              index: 1,
              accountIndex: 2,
              label: 'bob',
              signedIn: true,
              baseUrl: 'http://127.0.0.1:51002/v1',
              head: false,
              successes: 0,
              failures: 1,
              consecutiveFailures: 1,
              lastAttemptAtMs: 1_700_000_000_000,
              lastOutcome: 'upstream-error',
              // Deliberately token-shaped: the response must scrub it.
              lastOutcomeDetail: 'HTTP 402 · hard_credit · access_token=super-secret',
            },
          ],
        },
      },
    ],
  }
}

interface Answer {
  status: number
  text: string
  json: Record<string, unknown>
}

/** One request against the UI server, with the Host header under our control. */
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
        try {
          json = JSON.parse(text) as Record<string, unknown>
        } catch {
          // A page, not JSON; the callers that need the body read `text`.
        }
        resolve({ status: res.statusCode ?? 0, text, json })
      })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** Start a server over a fixed state and probe, and track it for cleanup. */
async function start(options: {
  probe?: (request: UiProbeRequest) => Promise<UiProbeResult>
} = {}): Promise<WorkBuddyUiServer> {
  const server = createWorkBuddyUiServer({ state: async () => state(), ...options })
  servers.push(server)
  await server.ready
  return server
}

/** The nonce the page carries, which a probe request must repeat. */
async function nonceOf(server: WorkBuddyUiServer): Promise<string> {
  const page = await call(server, '/')
  const match = /var UI_NONCE = "([^"]+)";/u.exec(page.text)
  if (match?.[1] === undefined) throw new Error('the page carries no nonce')
  return match[1]
}

describe('the UI server', () => {
  it('serves the page with a nonce, and never a bearer token', async () => {
    const server = await start()
    const page = await call(server, '/')
    expect(page.status).toBe(200)
    expect(page.text).toContain('WorkBuddy Bridge')
    expect(page.text).not.toContain('__UI_NONCE__')
    expect(page.text).not.toMatch(/token\s*:\s*["'][A-Za-z0-9_-]{20,}/u)
  })

  /**
   * The page is a template literal holding a whole script, which makes it easy
   * to write an escape the template literal eats — `\'` collapses to `'` and
   * silently breaks the entire client. Compiling the served script catches
   * that class of mistake; nothing here executes it.
   */
  it('serves a page whose client script parses', async () => {
    const server = await start()
    const page = await call(server, '/')
    const script = /<script>([\s\S]*?)<\/script>/u.exec(page.text)?.[1]
    expect(script).toBeTypeOf('string')
    expect(() => new Function(script as string)).not.toThrow()
  })

  it('serves the pool membership, with token-shaped detail redacted', async () => {
    const server = await start()
    const answer = await call(server, '/api/state')
    expect(answer.status).toBe(200)
    const endpoint = (answer.json['endpoints'] as Array<Record<string, unknown>>)[0]!
    const pool = endpoint['pool'] as { headIndex: number, members: Array<Record<string, unknown>> }
    expect(pool.headIndex).toBe(0)
    expect(pool.members.map(member => member['label'])).toEqual(['alice', 'bob'])
    expect(pool.members[1]!['lastOutcomeDetail']).toBe('HTTP 402 · hard_credit · access_token=[redacted]')
    // The request log crosses as metadata, chain included.
    const requests = endpoint['requests'] as Array<Record<string, unknown>>
    expect(requests.map(row => row['outcome'])).toEqual(['ok', 'hard_credit'])
    expect(requests[1]!['attempts']).toEqual([
      { account: 'alice', outcome: 'hard_credit', status: 402 },
      { account: 'bob', outcome: 'ok' },
    ])
  })

  it('refuses a request that does not name a loopback Host', async () => {
    const server = await start()
    const answer = await call(server, '/api/state', { headers: { Host: 'evil.example.com' } })
    expect(answer.status).toBe(403)
    expect(answer.json['error']).toBe('request-not-trusted')
  })

  it('refuses a probe that cannot repeat the page\'s nonce', async () => {
    let called = false
    const server = await start({
      probe: async () => {
        called = true
        return { provider: 'workbuddy-ai-pool', index: 0, label: 'alice', model: 'm', ok: true, status: 200, latencyMs: 1, detail: 'ok' }
      },
    })
    const answer = await call(server, '/api/pool/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'workbuddy-ai-pool', index: 0 }),
    })
    expect(answer.status).toBe(403)
    expect(answer.json['error']).toBe('request-not-trusted')
    expect(called).toBe(false)
  })

  it('refuses a probe body that is not JSON, even with the nonce', async () => {
    const server = await start({ probe: async () => { throw new Error('must not run') } })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/pool/test', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ provider: 'workbuddy-ai-pool', index: 0 }),
    })
    expect(answer.status).toBe(415)
  })

  it('rejects a malformed body with 400 rather than guessing', async () => {
    const server = await start({ probe: async () => { throw new Error('must not run') } })
    const nonce = await nonceOf(server)
    for (const body of ['not json', '[]', '{"provider":"workbuddy-ai-pool"}', '{"provider":"workbuddy-ai-pool","index":-1}']) {
      const answer = await call(server, '/api/pool/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': nonce },
        body,
      })
      expect(answer.status, body).toBe(400)
    }
  })

  it('runs a probe for the named member and redacts what it says', async () => {
    const seen: UiProbeRequest[] = []
    const server = await start({
      probe: async request => {
        seen.push(request)
        return {
          provider: request.provider,
          index: request.index,
          label: 'bob',
          model: 'model-x',
          ok: false,
          status: 402,
          latencyMs: 41,
          detail: 'HTTP 402: quota gone (refresh_token=abc123)',
        }
      },
    })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/pool/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ provider: 'workbuddy-ai-pool', index: 1 }),
    })
    expect(answer.status).toBe(200)
    expect(seen).toEqual([{ provider: 'workbuddy-ai-pool', index: 1 }])
    expect(answer.json).toMatchObject({ index: 1, label: 'bob', ok: false, status: 402, latencyMs: 41 })
    // The filter's `[^&\s]+` run swallows the trailing paren, which is the
    // existing behaviour and the safe direction to be wrong in.
    expect(answer.json['detail']).toContain('refresh_token=[redacted]')
    expect(answer.json['detail']).not.toContain('abc123')
  })

  it('answers 501 when no probe is configured', async () => {
    const server = await start()
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/pool/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ provider: 'workbuddy-ai-pool', index: 0 }),
    })
    expect(answer.status).toBe(501)
  })

  it('surfaces a request error with its own status, not a 500', async () => {
    const server = await start({
      probe: async () => { throw new Error('unexpected') },
    })
    const nonce = await nonceOf(server)
    const answer = await call(server, '/api/pool/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': nonce },
      body: JSON.stringify({ provider: 'workbuddy-ai-pool', index: 0 }),
    })
    // A thrown error that is not a UiRequestError is a bug, and says so.
    expect(answer.status).toBe(500)
    expect(answer.json['error']).toBe('internal')
  })
})
