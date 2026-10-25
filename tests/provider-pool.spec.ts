/**
 * The custom-provider pool: one endpoint, several providers, failover.
 *
 * These tests drive the real router and the real loopback endpoint over real
 * local upstream servers — no mocks of the thing under test. Each one names
 * the production change that would break it: a rotation that does not advance
 * after a retryable failure, a chain that retries a request-level refusal, a
 * head that moves without a failure, a model routed to a provider that does
 * not list it, or a credential captured per attempt instead of per request.
 */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CUSTOM_POOL_ID,
  CustomProviderFailoverPool,
  capturePoolMembers,
  createCustomProviderPoolShim,
  errorKindForStatus,
  poolMemberAvailable,
  poolModelList,
  type CustomPoolMember,
} from '../src/standalone/provider-pool.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
})

/** A local OpenAI-compatible provider that records what it was sent. */
async function provider(options: {
  status?: number
  body?: string
  contentType?: string
  models?: string[]
} = {}) {
  const calls: { path: string, authorization: string | undefined, body: string }[] = []
  const server: Server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    calls.push({ path: req.url!, authorization: req.headers.authorization, body })
    res.writeHead(options.status ?? 200, { 'Content-Type': options.contentType ?? 'application/json' })
    res.end(options.body ?? JSON.stringify({ choices: [{ message: { content: 'answer' } }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const port = (server.address() as { port: number }).port
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls }
}

function member(id: string, baseUrl: string, models: string[], extra: Partial<CustomPoolMember> = {}): CustomPoolMember {
  return { id, displayName: id, baseUrl, models, managed: true, ...extra }
}

/** One attempt that always succeeds, so the chain is the only variable. */
const ok = async () => ({ state: 'ok' as const, value: { marker: true } })

describe('custom provider pool: routing', () => {
  it('serves from the head and keeps it there while it keeps succeeding', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [member('a', 'https://a.test/v1', ['m']), member('b', 'https://b.test/v1', ['m'])]
    const order: string[] = []
    const capture = (id: string) => async () => {
      order.push(id)
      return await ok()
    }
    const attempt = async (candidate: { id: string }) => capture(candidate.id)()
    await pool.route(capturePoolMembers(members), 'm', attempt)
    await pool.route(capturePoolMembers(members), 'm', attempt)
    // Sticky: the second request did not move on to b.
    expect(order).toEqual(['a', 'a'])
    expect(pool.headIndex(members)).toBe(0)
  })

  it('moves the head to the next provider after a retryable failure, and the next request starts there', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [member('a', 'https://a.test/v1', ['m']), member('b', 'https://b.test/v1', ['m'])]
    const tried: string[] = []
    const first = await pool.route(capturePoolMembers(members), 'm', async candidate => {
      tried.push(candidate.id)
      if (candidate.id === 'a') {
        return {
          state: 'upstream-error' as const,
          status: 429,
          kind: 'soft_rate' as const,
          message: 'throttled',
          error: { message: 'throttled', type: 'upstream_error' },
          retryable: true,
        }
      }
      return await ok()
    })
    expect(tried).toEqual(['a', 'b'])
    expect(first.value).toBeDefined()
    expect(pool.headIndex(members)).toBe(1)
    // The following request starts at the new head, not back at a.
    const next: string[] = []
    await pool.route(capturePoolMembers(members), 'm', async candidate => {
      next.push(candidate.id)
      return await ok()
    })
    expect(next).toEqual(['b'])
  })

  it('stops the chain on a request-level refusal: every provider would answer it the same way', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [
      member('a', 'https://a.test/v1', ['m']),
      member('b', 'https://b.test/v1', ['m']),
      member('c', 'https://c.test/v1', ['m']),
    ]
    const tried: string[] = []
    const outcome = await pool.route(capturePoolMembers(members), 'm', async candidate => {
      tried.push(candidate.id)
      return {
        state: 'upstream-error' as const,
        status: 400,
        kind: 'client' as const,
        message: 'bad request',
        error: { message: 'bad request', type: 'upstream_error' },
        retryable: false,
      }
    })
    expect(tried).toEqual(['a'])
    expect(outcome.failure).toMatchObject({ status: 400, kind: 'client' })
  })

  it('only tries providers that list the requested model, and rotates within them', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [
      member('a', 'https://a.test/v1', ['only-a']),
      member('b', 'https://b.test/v1', ['shared']),
      member('c', 'https://c.test/v1', ['shared']),
    ]
    const tried: string[] = []
    const outcome = await pool.route(capturePoolMembers(members), 'shared', async candidate => {
      tried.push(candidate.id)
      return {
        state: 'upstream-error' as const,
        status: 503,
        kind: 'server' as const,
        message: 'down',
        error: { message: 'down', type: 'upstream_error' },
        retryable: true,
      }
    })
    // a does not offer the model, so it is never attempted.
    expect(tried).toEqual(['b', 'c'])
    expect(outcome.failure).toMatchObject({ status: 503 })
  })

  it('refuses a model no provider offers without attempting anyone', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [member('a', 'https://a.test/v1', ['m'])]
    let attempted = false
    await expect(pool.route(capturePoolMembers(members), 'nope', async () => {
      attempted = true
      return await ok()
    })).rejects.toMatchObject({ status: 400 })
    expect(attempted).toBe(false)
  })

  it('reports the whole chain in attempt order, for the log the page renders', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [
      member('a', 'https://a.test/v1', ['m']),
      member('b', 'https://b.test/v1', ['m']),
      member('c', 'https://c.test/v1', ['m']),
    ]
    const outcome = await pool.route(capturePoolMembers(members), 'm', async candidate => {
      if (candidate.id === 'c') return await ok()
      return {
        state: 'upstream-error' as const,
        status: 500,
        kind: 'server' as const,
        message: 'broken',
        error: { message: 'broken', type: 'upstream_error' },
        retryable: true,
      }
    })
    expect(outcome.attempts.map(attempt => attempt.index)).toEqual([0, 1, 2])
    expect(outcome.attempts.map(attempt => attempt.outcome.state)).toEqual(['upstream-error', 'upstream-error', 'ok'])
  })

  it('counts successes and failures per provider, and resets the failure streak on success', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [member('a', 'https://a.test/v1', ['m']), member('b', 'https://b.test/v1', ['m'])]
    await pool.route(capturePoolMembers(members), 'm', async candidate => {
      if (candidate.id === 'a') {
        return {
          state: 'upstream-error' as const,
          status: 502,
          kind: 'server' as const,
          message: 'bad gateway',
          error: { message: 'bad gateway', type: 'upstream_error' },
          retryable: true,
        }
      }
      return await ok()
    })
    const health = pool.memberHealth(members)
    expect(health[0]).toMatchObject({ failures: 1, consecutiveFailures: 1, successes: 0 })
    expect(health[1]).toMatchObject({ successes: 1, consecutiveFailures: 0, failures: 0 })
  })

  it('keeps the head on the surviving provider when membership changes', async () => {
    const pool = new CustomProviderFailoverPool()
    const before = [member('a', 'https://a.test/v1', ['m']), member('b', 'https://b.test/v1', ['m'])]
    await pool.route(capturePoolMembers(before), 'm', async candidate => {
      if (candidate.id === 'a') {
        return {
          state: 'upstream-error' as const,
          status: 503,
          kind: 'server' as const,
          message: 'down',
          error: { message: 'down', type: 'upstream_error' },
          retryable: true,
        }
      }
      return await ok()
    })
    expect(pool.headIndex(before)).toBe(1)
    // Remove a (the failed provider) and add c: the head is still b by id.
    const after = [member('b', 'https://b.test/v1', ['m']), member('c', 'https://c.test/v1', ['m'])]
    pool.prune(after)
    expect(pool.headIndex(after)).toBe(0)
    const tried: string[] = []
    await pool.route(capturePoolMembers(after), 'm', async candidate => {
      tried.push(candidate.id)
      return await ok()
    })
    expect(tried).toEqual(['b'])
  })

  it('drops routing records for providers that are gone, so a re-added id starts clean', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [member('a', 'https://a.test/v1', ['m']), member('b', 'https://b.test/v1', ['m'])]
    await pool.route(capturePoolMembers(members), 'm', async candidate => {
      if (candidate.id === 'a') {
        return {
          state: 'upstream-error' as const,
          status: 500,
          kind: 'server' as const,
          message: 'down',
          error: { message: 'down', type: 'upstream_error' },
          retryable: true,
        }
      }
      return await ok()
    })
    pool.prune([member('b', 'https://b.test/v1', ['m'])])
    const readded = [member('a', 'https://a.test/v1', ['m']), member('b', 'https://b.test/v1', ['m'])]
    pool.prune(readded)
    expect(pool.memberHealth(readded)[0]).toMatchObject({ successes: 0, failures: 0, consecutiveFailures: 0 })
  })

  it('stops attempting when the client has already gone away', async () => {
    const pool = new CustomProviderFailoverPool()
    const members = [member('a', 'https://a.test/v1', ['m']), member('b', 'https://b.test/v1', ['m'])]
    const controller = new AbortController()
    controller.abort()
    let attempted = false
    const outcome = await pool.route(capturePoolMembers(members), 'm', async () => {
      attempted = true
      return await ok()
    }, controller.signal)
    expect(attempted).toBe(false)
    expect(outcome.failure?.status).toBe(499)
  })
})

describe('custom provider pool: membership', () => {
  it('unions the available providers’ models, in order, without duplicates', () => {
    const members = [
      member('a', 'https://a.test/v1', ['m-1', 'shared']),
      member('b', 'https://b.test/v1', ['shared', 'm-2']),
    ]
    expect(poolModelList(members)).toEqual(['m-1', 'shared', 'm-2'])
  })

  it('leaves a provider with a missing key out of the model list and reports it unavailable', () => {
    const members = [
      member('a', 'https://a.test/v1', ['m-1'], { apiKeyEnv: 'WB_POOL_TEST_ABSENT_KEY' }),
      member('b', 'https://b.test/v1', ['m-2'], { apiKey: 'sk-present' }),
    ]
    expect(poolMemberAvailable(members[0]!)).toBe(false)
    expect(poolModelList(members)).toEqual(['m-2'])
  })

  it('treats a provider with no key configured as available, for local gateways', () => {
    expect(poolMemberAvailable(member('a', 'http://127.0.0.1:9/v1', ['m']))).toBe(true)
  })

  it('captures each credential once, before any attempt, and names a missing variable', () => {
    const members = [
      member('a', 'https://a.test/v1', ['m'], { apiKeyEnv: 'WB_POOL_TEST_KEY' }),
      member('b', 'https://b.test/v1', ['m'], { apiKey: 'sk-stored' }),
      member('c', 'https://c.test/v1', ['m']),
    ]
    const captured = capturePoolMembers(members, name => name === 'WB_POOL_TEST_KEY' ? 'sk-from-env' : undefined)
    expect(captured[0]).toMatchObject({ key: 'sk-from-env' })
    expect(captured[1]).toMatchObject({ key: 'sk-stored' })
    expect(captured[2]!.key).toBeUndefined()
    const missing = capturePoolMembers(members, () => undefined)
    expect(missing[0]).toMatchObject({ missingEnv: 'WB_POOL_TEST_KEY' })
  })

  it('classifies statuses by whether another provider could survive them', () => {
    expect(errorKindForStatus(401)).toBe('session_dead')
    expect(errorKindForStatus(402)).toBe('hard_credit')
    expect(errorKindForStatus(404)).toBe('not_found')
    expect(errorKindForStatus(429)).toBe('soft_rate')
    expect(errorKindForStatus(500)).toBe('server')
    expect(errorKindForStatus(400)).toBe('client')
  })
})

describe('custom provider pool: the endpoint', () => {
  it('forwards a chat turn to the head provider with its own key and the body unchanged', async () => {
    const upstream = await provider()
    const shim = createCustomProviderPoolShim({
      getMembers: () => [member('a', upstream.baseUrl, ['m-1'], { apiKey: 'sk-a' })],
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-1","messages":[{"role":"user","content":"hi"}]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(upstream.calls).toHaveLength(1)
    expect(upstream.calls[0]!.authorization).toBe('Bearer sk-a')
    expect(upstream.calls[0]!.path).toBe('/v1/chat/completions')
    // The body reaches the provider byte-for-byte, never re-serialized.
    expect(upstream.calls[0]!.body).toBe('{"model":"m-1","messages":[{"role":"user","content":"hi"}]}')
  })

  it('fails over to the next provider and answers the client from it', async () => {
    const broken = await provider({ status: 503, body: '{"error":{"message":"overloaded"}}' })
    const healthy = await provider()
    const shim = createCustomProviderPoolShim({
      getMembers: () => [
        member('broken', broken.baseUrl, ['m'], { apiKey: 'sk-broken' }),
        member('healthy', healthy.baseUrl, ['m'], { apiKey: 'sk-healthy' }),
      ],
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'answer' } }] })
    expect(broken.calls).toHaveLength(1)
    expect(healthy.calls).toHaveLength(1)
    // The healthy provider was sent its own key, never the broken one's.
    expect(healthy.calls[0]!.authorization).toBe('Bearer sk-healthy')
  })

  it('answers with the upstream status when every provider fails, and never leaks a key', async () => {
    const first = await provider({ status: 429, body: '{"error":{"message":"slow down sk-first"}}' })
    const second = await provider({ status: 500, body: 'not json at all' })
    const shim = createCustomProviderPoolShim({
      getMembers: () => [
        member('first', first.baseUrl, ['m'], { apiKey: 'sk-first' }),
        member('second', second.baseUrl, ['m'], { apiKey: 'sk-second' }),
      ],
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    })
    // The last failure's status is what the client sees.
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain('sk-second')
    expect(text).not.toContain('not json at all')
    expect(JSON.parse(text)).toMatchObject({ error: { type: 'upstream_error' } })
  })

  it('does not retry a request-level refusal on the next provider', async () => {
    const rejecting = await provider({ status: 400, body: '{"error":{"message":"bad parameter"}}' })
    const healthy = await provider()
    const shim = createCustomProviderPoolShim({
      getMembers: () => [
        member('rejecting', rejecting.baseUrl, ['m'], { apiKey: 'sk-r' }),
        member('healthy', healthy.baseUrl, ['m'], { apiKey: 'sk-h' }),
      ],
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    })
    expect(response.status).toBe(400)
    await response.text()
    expect(healthy.calls).toHaveLength(0)
  })

  it('lists the union of the members’ models and refuses one nobody offers', async () => {
    const shim = createCustomProviderPoolShim({
      getMembers: () => [
        member('a', 'https://a.test/v1', ['m-1'], { apiKey: 'sk-a' }),
        member('b', 'https://b.test/v1', ['m-2'], { apiKey: 'sk-b' }),
      ],
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const listed = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    })
    expect(await listed.json()).toMatchObject({
      data: [{ id: 'm-1', owned_by: CUSTOM_POOL_ID }, { id: 'm-2', owned_by: CUSTOM_POOL_ID }],
    })
    const refused = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m-3","messages":[]}',
    })
    expect(refused.status).toBe(400)
    await refused.text()
  })

  it('reads membership per request, so a provider added later serves without a restart', async () => {
    const first = await provider()
    const second = await provider()
    let members: CustomPoolMember[] = [member('first', first.baseUrl, ['m'], { apiKey: 'sk-1' })]
    const shim = createCustomProviderPoolShim({ getMembers: () => members })
    cleanup.push(() => shim.close())
    await shim.ready
    const send = async () => await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    })
    expect((await send()).status).toBe(200)
    expect(first.calls).toHaveLength(1)
    // The listener, URL, and token are unchanged; only the list moved.
    const urlBefore = shim.baseUrl()
    const tokenBefore = shim.token()
    members = [
      member('first', first.baseUrl, ['m'], { apiKey: 'sk-1' }),
      member('second', second.baseUrl, ['m'], { apiKey: 'sk-2' }),
    ]
    const listed = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    })
    expect(await listed.json()).toMatchObject({ data: [{ id: 'm', owned_by: CUSTOM_POOL_ID }] })
    expect(shim.baseUrl()).toBe(urlBefore)
    expect(shim.token()).toBe(tokenBefore)
    expect(second.calls).toHaveLength(0)
  })

  it('records one turn per request with the failover chain, and no prompt text', async () => {
    const broken = await provider({ status: 503 })
    const healthy = await provider()
    const turns: Array<{ status: number, outcome: string, attempts: readonly { index: number }[], labels: readonly string[] }> = []
    const shim = createCustomProviderPoolShim({
      getMembers: () => [
        member('broken', broken.baseUrl, ['m'], { apiKey: 'sk-b' }),
        member('healthy', healthy.baseUrl, ['m'], { apiKey: 'sk-h' }),
      ],
      onTurn: record => { turns.push(record) },
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m","messages":[{"role":"user","content":"a secret prompt"}]}',
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ status: 200, outcome: 'ok' })
    expect(turns[0]!.attempts.map(attempt => attempt.index)).toEqual([0, 1])
    expect(turns[0]!.labels).toEqual(['broken', 'healthy'])
    // The record carries no request material.
    expect(JSON.stringify(turns[0])).not.toContain('a secret prompt')
  })

  it('passes a streamed response through unchanged', async () => {
    const chunk = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
    const streaming = await provider({ contentType: 'text/event-stream', body: chunk })
    const shim = createCustomProviderPoolShim({
      getMembers: () => [member('s', streaming.baseUrl, ['m'], { apiKey: 'sk-s' })],
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: '{"model":"m","messages":[],"stream":true}',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(await response.text()).toBe(chunk)
  })

  it('requires the local bridge token, so the pool is not an open proxy', async () => {
    const shim = createCustomProviderPoolShim({
      getMembers: () => [member('a', 'https://a.test/v1', ['m'], { apiKey: 'sk-a' })],
    })
    cleanup.push(() => shim.close())
    await shim.ready
    const unauthorized = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"model":"m","messages":[]}',
    })
    expect(unauthorized.status).toBe(401)
    await unauthorized.text()
  })
})
