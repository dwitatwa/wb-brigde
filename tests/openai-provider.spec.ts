import { createServer, request, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAICompatibleShim, type OpenAICompatibleShim } from '../src/standalone/openai-provider.ts'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  CLEANUP.length = 0
})

interface UpstreamRequest {
  url: string
  method: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

type UpstreamResponder = (req: { url: string, headers: Record<string, string | string[] | undefined>, body: string }, res: import('node:http').ServerResponse) => void

interface Upstream {
  server: Server
  url: string
  requests: UpstreamRequest[]
  respond: (fn: UpstreamResponder) => void
}

/** A controllable fake upstream the shim forwards to. */
async function startUpstream(): Promise<Upstream> {
  const requests: UpstreamRequest[] = []
  const responders: UpstreamResponder[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const info: UpstreamRequest = { url: req.url ?? '/', method: req.method ?? 'GET', headers: req.headers, body }
      requests.push(info)
      const respond = responders[responders.length - 1]
      if (respond) respond({ url: info.url, headers: info.headers, body }, res)
      else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end('data: [DONE]\n\n')
      }
    })
  })
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`)
    })
  })
  CLEANUP.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return {
    server,
    url,
    requests,
    respond: (fn) => responders.push(fn),
  }
}

const SHIM_ENV = 'CUSTOM_OPENAI_PROVIDER_TEST_KEY'

async function startShim(options: { apiKeyEnv?: string, models?: string[], baseUrl?: string } = {}): Promise<{ shim: OpenAICompatibleShim, upstream: Upstream }> {
  const upstream = await startUpstream()
  const shim = createOpenAICompatibleShim({
    provider: {
      id: 'test-provider',
      baseUrl: options.baseUrl ?? upstream.url,
      ...(options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }),
      models: options.models ?? ['model-a', 'model-b'],
    },
    resolveApiKeyEnv: (name: string) => (name === SHIM_ENV ? 'sekret-value-123' : undefined),
    logger: { warn() {}, error() {} },
  })
  CLEANUP.push(() => shim.close())
  await shim.ready
  return { shim, upstream }
}

function shimPort(shim: OpenAICompatibleShim): number {
  return Number(new URL(shim.baseUrl()).port)
}

function post(shim: OpenAICompatibleShim, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number, body: string, headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: shimPort(shim),
      method: 'POST',
      path,
      headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const JSON_HEADERS = (token: string): Record<string, string> => ({
  host: `127.0.0.1:${shimPort(currentShim)}`,
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
})

// The raw request helper forbids per-request host in a closure-free way; this
// module-level handle is set by each test right before posting.
let currentShim: OpenAICompatibleShim

describe('OpenAI-compatible custom provider shim', () => {
  it('lists only the configured models on /v1/models', async () => {
    const { shim } = await startShim({ models: ['model-a', 'model-b'] })
    currentShim = shim
    const res = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { id: string, object: string, owned_by: string }[] }
    expect(body.data.map(m => m.id)).toEqual(['model-a', 'model-b'])
    expect(body.data[0]?.object).toBe('model')
    expect(body.data[0]?.owned_by).toBe('test-provider')
  })

  it('serves /healthz', async () => {
    const { shim } = await startShim()
    currentShim = shim
    const res = await fetch(`${shim.baseUrl()}/healthz`, {
      headers: { authorization: `Bearer ${shim.token()}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a non-loopback Host header', async () => {
    const { shim } = await startShim()
    currentShim = shim
    const res = await raw(shim, 'GET', '/healthz', { host: 'evil.com' })
    expect(res.status).toBe(403)
    expect(res.body).toContain('host_not_allowed')
  })

  it('rejects a non-loopback browser Origin', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const res = await raw(shim, 'POST', '/v1/chat/completions', {
      host: `127.0.0.1:${shimPort(shim)}`,
      origin: 'https://evil.com',
      'content-type': 'application/json',
      authorization: `Bearer ${shim.token()}`,
    }, JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(403)
    expect(upstream.requests).toHaveLength(0)
  })

  it('requires the per-process bearer on chat', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const res = await raw(shim, 'POST', '/v1/chat/completions', {
      host: `127.0.0.1:${shimPort(shim)}`,
      'content-type': 'application/json',
    }, JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(401)
    expect(upstream.requests).toHaveLength(0)
  })

  it('rejects non-JSON content type on chat', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const res = await raw(shim, 'POST', '/v1/chat/completions', {
      host: `127.0.0.1:${shimPort(shim)}`,
      'content-type': 'text/plain',
      authorization: `Bearer ${shim.token()}`,
    }, JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(415)
    expect(upstream.requests).toHaveLength(0)
  })

  it('enforces the request body limit', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], pad: 'x'.repeat(65 * 1024 * 1024) }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(upstream.requests).toHaveLength(0)
  }, 30_000)

  it('forwards the body unchanged to baseUrl + /chat/completions with only its own headers', async () => {
    const { shim, upstream } = await startShim({ apiKeyEnv: SHIM_ENV })
    currentShim = shim
    const rawBody = JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }], stream: false })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), rawBody)
    expect(res.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    const sent = upstream.requests[0]
    expect(sent?.url).toBe('/chat/completions')
    expect(sent?.body).toBe(rawBody)
    // The shim sets only Content-Type/Accept/Authorization upstream; the rest
    // is undici's own standard envelope. Downstream/WorkBuddy headers must
    // never appear.
    const headerNames = Object.keys(sent?.headers ?? {}).map(h => h.toLowerCase()).sort()
    expect(headerNames).toContain('authorization')
    expect(headerNames).toContain('content-type')
    expect(sent?.headers['authorization']).toBe('Bearer sekret-value-123')
    expect(sent?.headers['content-type']).toBe('application/json')
    const joined = headerNames.join(',')
    for (const forbidden of ['x-conversation', 'x-agent', 'x-root-request', 'x-machine', 'x-session', 'x-bridge']) {
      expect(joined).not.toContain(forbidden)
    }
  })

  it('resolves the key per request; a missing key refuses with the env var named and no secret echoed', async () => {
    const { shim, upstream } = await startShim({ apiKeyEnv: SHIM_ENV })
    currentShim = shim
    // The env resolver returns undefined on this second call — simulate by
    // pointing the shim at an env var that is never set.
    const shimNoKey = createOpenAICompatibleShim({
      provider: { id: 'test-provider', baseUrl: upstream.url, apiKeyEnv: 'NEVER_SET_ENV_VAR', models: ['model-a'] },
      resolveApiKeyEnv: () => undefined,
      logger: { warn() {}, error() {} },
    })
    CLEANUP.push(() => shimNoKey.close())
    await shimNoKey.ready
    currentShim = shimNoKey
    const res = await post(shimNoKey, '/v1/chat/completions', JSON_HEADERS(shimNoKey.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(503)
    const body = JSON.parse(res.body) as { error: { code: string, message: string } }
    expect(body.error.code).toBe('api_key_missing')
    expect(body.error.message).toContain('NEVER_SET_ENV_VAR')
    expect(res.body).not.toContain('sekret-value-123')
    expect(upstream.requests).toHaveLength(0)
    void shim
  })

  it('a provider without apiKeyEnv forwards without an Authorization header', async () => {
    const { shim, upstream } = await startShim({ models: ['model-a'] })
    currentShim = shim
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(200)
    const sent = upstream.requests[0]
    expect(sent?.headers['authorization']).toBeUndefined()
  })

  it('captures the configuration and key together before the body: a mid-upload edit cannot change this turn', async () => {
    const { upstream } = await startShim()
    let current: { id: string, baseUrl: string, models: string[], apiKeyEnv?: string, apiKey?: string } = {
      id: 'test-provider', baseUrl: upstream.url, apiKeyEnv: SHIM_ENV, models: ['model-a'],
    }
    const swapShim = createOpenAICompatibleShim({
      getSnapshot: () => current,
      resolveApiKeyEnv: name => (name === SHIM_ENV ? 'sekret-value-123' : undefined),
      logger: { warn() {}, error() {} },
    })
    CLEANUP.push(() => swapShim.close())
    await swapShim.ready
    currentShim = swapShim
    // Start the turn with a slowly delivered body: the shim must resolve its
    // snapshot (URL, model list, key) at entry, before the body arrives. The
    // swap below then changes everything for the NEXT turn only.
    const slow = new Promise<{ status: number, body: string }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: shimPort(swapShim),
        method: 'POST',
        path: '/v1/chat/completions',
        headers: JSON_HEADERS(swapShim.token()),
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.write('{"model":"model-a"')
      setTimeout(() => {
        current = { id: 'other', baseUrl: 'http://127.0.0.1:1/elsewhere', models: ['model-a'] }
        req.write(',"messages":[]}')
        req.end()
      }, 120)
    })
    const result = await slow
    expect(result.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]!.url).toBe('/chat/completions')
    expect(upstream.requests[0]!.headers['authorization']).toBe('Bearer sekret-value-123')
  })

  it('rejects a model that is not configured, without reaching upstream', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'unknown-model', messages: [] }))
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.code).toBe('model_not_configured')
    expect(upstream.requests).toHaveLength(0)
  })

  it('rejects a body that is not a JSON object', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    for (const raw of ['not json', '[]', '42']) {
      const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), raw)
      expect(res.status).toBe(400)
    }
    expect(upstream.requests).toHaveLength(0)
  })

  it('preserves upstream HTTP error statuses with a structured error subset', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit' } }))
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(429)
    const parsed = JSON.parse(res.body) as { error: { message: string, type: string, code: string } }
    expect(parsed.error.message).toBe('rate limited')
    expect(parsed.error.type).toBe('rate_limit_error')
    expect(parsed.error.code).toBe('rate_limit')
  })

  it('refuses a redirect from upstream instead of following it', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(302, { Location: 'https://evil.example.com/steal' })
      res.end()
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error.code).toBe('upstream_redirect')
    expect(res.body).not.toContain('evil.example.com')
  })

  it('streams an SSE response through and passes [DONE] untouched', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], stream: true }))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.body).toContain('hi')
    expect(res.body).toContain('[DONE]')
    // No synthetic [DONE] concern on success: exactly one present.
    expect(res.body.split('[DONE]').length - 1).toBe(1)
  })

  it('does not append a synthetic [DONE] when the upstream stream fails mid-flight', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
      // destroy without [DONE]
      setTimeout(() => res.destroy(), 20)
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], stream: true }))
    expect(res.body).toContain('partial')
    expect(res.body).not.toContain('[DONE]')
  })

  it('supports a non-stream JSON response passthrough', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'hello' } }] }))
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], stream: false }))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).toContain('hello')
  })

  it('preserves successful non-200 upstream statuses on JSON responses', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'created' }))
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], stream: false }))
    expect(res.status).toBe(201)
    expect(res.body).toContain('created')
  })

  it('serves a bodyless upstream 204 without converting it to 200', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], stream: false }))
    expect(res.status).toBe(204)
    expect(res.body).toBe('')
  })

  it('forwards a structured upstream error as a bounded sanitized subset, not a JSON-string wrapper', async () => {
    const { shim, upstream } = await startShim({ apiKeyEnv: SHIM_ENV })
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: `Invalid key sekret-value-123 for the conversation about confidential plans`,
          type: 'invalid_request_error',
          code: 'invalid_api_key',
          param: 'Authorization',
          extra_arbitrary: { nested: 'material' },
        },
        other_top_level: 'dropped',
      }))
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'confidential plans' }] }))
    expect(res.status).toBe(401)
    const parsed = JSON.parse(res.body) as Record<string, unknown> & { error: Record<string, unknown> }
    // Structured subset survives with its shape.
    expect(parsed.error.type).toBe('invalid_request_error')
    expect(parsed.error.code).toBe('invalid_api_key')
    expect(parsed.error.param).toBe('Authorization')
    // The resolved key is redacted...
    expect(res.body).not.toContain('sekret-value-123')
    // ...and the message is bounded and key-safe.
    expect(String(parsed.error.message)).not.toContain('sekret-value-123')
    expect(String(parsed.error.message).length).toBeLessThanOrEqual(900)
    // Arbitrary extra fields and top-level material are dropped.
    expect(parsed.error['extra_arbitrary']).toBeUndefined()
    expect(parsed['other_top_level']).toBeUndefined()
  })

  it('redacts the resolved key and caps every retained error string field (message, type, code, param)', async () => {
    const { shim, upstream } = await startShim({ apiKeyEnv: SHIM_ENV })
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: `denied sekret-value-123`,
          type: `sekret-value-123 in type`,
          code: `code sekret-value-123`,
          param: `param sekret-value-123`,
        },
      }))
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(401)
    const parsed = JSON.parse(res.body) as { error: { message: string, type: string, code: string, param: string } }
    expect(parsed.error.message).toContain('[redacted]')
    expect(parsed.error.type).toContain('[redacted]')
    expect(parsed.error.code).toContain('[redacted]')
    expect(parsed.error.param).toContain('[redacted]')
    expect(res.body).not.toContain('sekret-value-123')
  })

  it('bounds overlong error field values and preserves non-string scalar fields safely', async () => {
    const { shim, upstream } = await startShim({ apiKeyEnv: SHIM_ENV })
    currentShim = shim
    const long = 'q'.repeat(2000)
    upstream.respond((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: {
          message: long,
          type: long,
          code: long,
          param: long,
        },
      }))
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(400)
    const parsed = JSON.parse(res.body) as { error: { message: string, type: string, code: string, param: string } }
    for (const field of [parsed.error.message, parsed.error.type, parsed.error.code, parsed.error.param]) {
      expect(field.length).toBeLessThanOrEqual(800)
    }
  })

  it('collapses an unstructured upstream error body to a fixed safe message', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const leak = 'SSRF-marker-prompt-content-should-not-surface'
    upstream.respond((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`gateway exploded while handling ${leak}`)
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: leak }] }))
    expect(res.status).toBe(502)
    const parsed = JSON.parse(res.body) as { error: { message: string } }
    expect(parsed.error.message).toBe('upstream returned http 502')
    expect(res.body).not.toContain(leak)
  })

  it('reads error bodies bounded: an endless upstream error body still answers', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const ended = new Promise<void>((resolve) => {
      upstream.respond((_req, res) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        const drip = setInterval(() => { res.write('x'.repeat(4096)) }, 5)
        res.on('close', () => { clearInterval(drip); resolve() })
      })
    })
    const started = Date.now()
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(500)
    expect(res.body).toContain('upstream returned http 500')
    // The bounded read must cut the upstream off long before an unbounded
    // stream would take; a whole-body read would also never see it end.
    expect(Date.now() - started).toBeLessThan(10_000)
    await ended
  }, 20_000)

  it('does not read the redirect body and releases the connection', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(302, { Location: 'https://evil.example.com/steal' })
      res.write('some body that must not be consumed fully')
      res.end()
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error.code).toBe('upstream_redirect')
    expect(res.body).not.toContain('evil.example.com')
    expect(res.body).not.toContain('some body')
  })

  it('does not kill a body that outlives the headers deadline', async () => {
    // Compressed deadline: headers arrive immediately, then the body keeps
    // streaming well past the deadline. The old design (AbortSignal.timeout
    // wired into the fetch signal) truncated such a body at the deadline; the
    // clearable-timer design completes it.
    const upstream = await startUpstream()
    const shim = createOpenAICompatibleShim({
      provider: { id: 'test-provider', baseUrl: upstream.url, models: ['model-a'] },
      logger: { warn() {}, error() {} },
      headersTimeoutMs: 150,
    })
    CLEANUP.push(() => shim.close())
    await shim.ready
    currentShim = shim
    upstream.respond((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')
      // Keep ticking past the 150 ms deadline, then finish.
      let ticks = 0
      const drip = setInterval(() => {
        res.write('data: {"choices":[{"delta":{"content":"b"}}]}\n\n')
        ticks += 1
        if (ticks >= 3) {
          clearInterval(drip)
          res.end('data: [DONE]\n\n')
        }
      }, 200)
      res.on('close', () => clearInterval(drip))
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], stream: true }))
    expect(res.status).toBe(200)
    expect(res.body).toContain('[DONE]')
    // The body must have run past the deadline, not been cut by it: all
    // three late ticks arrived.
    expect(res.body.split('"b"').length - 1).toBe(3)
  })

  it('serves an empty model list while the configured key is missing, then restores without a restart', async () => {
    let envValue: string | undefined = undefined
    const upstream = await startUpstream()
    const shim = createOpenAICompatibleShim({
      provider: { id: 'test-provider', baseUrl: upstream.url, apiKeyEnv: 'TOGGLE_ENV', models: ['model-a'] },
      resolveApiKeyEnv: () => envValue,
      logger: { warn() {}, error() {} },
    })
    CLEANUP.push(() => shim.close())
    await shim.ready
    currentShim = shim

    const empty = await fetch(`${shim.baseUrl()}/v1/models`, { headers: { authorization: `Bearer ${shim.token()}` } })
    expect(empty.status).toBe(200)
    expect((await empty.json() as { data: unknown[] }).data).toEqual([])

    // Chat is refused while the key is missing.
    const refused = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(refused.status).toBe(503)

    // Key appears: models come back with no restart.
    envValue = 'fresh-key'
    const restored = await fetch(`${shim.baseUrl()}/v1/models`, { headers: { authorization: `Bearer ${shim.token()}` } })
    expect((await restored.json() as { data: { id: string }[] }).data.map(m => m.id)).toEqual(['model-a'])
    const chat = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    expect(chat.status).toBe(200)
  })

  it('logs a fixed marker for an unconfigured model, never its text', async () => {
    const logged: { outcome: string, status: number, model: string }[] = []
    const upstream = await startUpstream()
    const shim = createOpenAICompatibleShim({
      provider: { id: 'test-provider', baseUrl: upstream.url, models: ['model-a'] },
      logger: {
        warn() {}, error() {},
        request: (entry) => logged.push({ outcome: entry.outcome, status: entry.status, model: entry.model }),
      },
    })
    CLEANUP.push(() => shim.close())
    await shim.ready
    currentShim = shim
    const secret = 'sk-sensitive-in-model-field'
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: `${secret} plus padding ${'x'.repeat(2000)}`, messages: [] }))
    expect(res.status).toBe(400)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.model).toBe('<unconfigured>')
  })

  it('answers unknown routes with 404 and lists the /models alias', async () => {
    const { shim } = await startShim()
    currentShim = shim
    const missing = await fetch(`${shim.baseUrl()}/v1/nothing`, { headers: { authorization: `Bearer ${shim.token()}` } })
    expect(missing.status).toBe(404)
    const alias = await fetch(`${shim.baseUrl()}/models`, { headers: { authorization: `Bearer ${shim.token()}` } })
    expect(alias.status).toBe(200)
  })

  it('never sends the downstream bearer upstream', async () => {
    const { shim, upstream } = await startShim({ apiKeyEnv: SHIM_ENV })
    currentShim = shim
    await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [] }))
    const sent = upstream.requests[0]
    expect(sent?.headers['authorization']).toBe('Bearer sekret-value-123')
    expect(sent?.headers['authorization']).not.toBe(`Bearer ${shim.token()}`)
  })

  it('masks the resolved API key in downstream error text', async () => {
    const { shim } = await startShim({ apiKeyEnv: SHIM_ENV })
    currentShim = shim
    // A body limit failure or a model error must not echo the key; simulate by
    // sending an oversized body on a shim whose key is resolved.
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], pad: 'x'.repeat(65 * 1024 * 1024) }))
    expect(res.body).not.toContain('sekret-value-123')
  }, 30_000)

  it('aborts the upstream request when the client disconnects mid-stream (late cancellation)', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    const closed = new Promise<void>((resolve) => {
      upstream.respond((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
        res.on('close', () => resolve())
      })
    })
    // Raw POST whose socket we destroy mid-stream.
    const req = request({
      host: '127.0.0.1',
      port: shimPort(shim),
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${shimPort(shim)}`,
        'content-type': 'application/json',
        authorization: `Bearer ${shim.token()}`,
      },
    }, (res) => {
      res.once('data', () => {
        // Got the first byte; now cancel late, mid-stream.
        req.destroy()
      })
    })
    req.end(JSON.stringify({ model: 'model-a', messages: [], stream: true }))
    await closed
    // The upstream response must have been torn down too.
    expect(upstream.requests.length).toBe(1)
  })

  it('does not abort the upstream before headers are committed when the client is merely slow', async () => {
    const { shim, upstream } = await startShim()
    currentShim = shim
    // The upstream waits a moment before responding; the shim must still
    // forward and not treat the wait as a client cancellation.
    upstream.respond((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end('data: [DONE]\n\n')
      }, 80)
    })
    const res = await post(shim, '/v1/chat/completions', JSON_HEADERS(shim.token()), JSON.stringify({ model: 'model-a', messages: [], stream: true }))
    expect(res.status).toBe(200)
    expect(res.body).toContain('[DONE]')
  })
})

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function raw(shim: OpenAICompatibleShim, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: shimPort(shim),
      method,
      path,
      headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
