import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/core/auth.ts'
import { isChannelValidationBlock, upstreamErrorCode, WorkBuddyUpstreamClient } from '../src/core/upstream.ts'
import type { ChatIdentity } from '../src/core/client-identity.ts'

/**
 * Wire pin for the international gateway's channel check (issues #139 / #142,
 * `workbuddy2api-hub#380`).
 *
 * The history matters, because it explains why the assertions look the way
 * they do. Since 2026-10-16 `www.workbuddy.ai` answers a `/v2/chat/completions`
 * request whose outbound identity omits the conversation family with `400` /
 * `code 11128` / `msg: "conversation id missing"` — the `displayMsg.zh` users
 * see is 「请求被拦截，请重新发送」. The first fix (v0.7.6) sent the trio
 * `X-Conversation-ID` / `-Request-ID` / `-Message-ID`.
 *
 * That was necessary but not sufficient. A 5.8.4 client capture
 * (`workbuddy2api-hub#381`) shows the official client sends a *four*-header
 * family — `X-Root-Request-ID` rides with the trio — plus the trace family and
 * the `X-Agent-*` trio, and that the ids are related rather than independent:
 * `X-Conversation-Message-ID` equals `X-Request-ID`, and `X-Root-Request-ID`
 * equals `X-Conversation-Request-ID`. The check is also **sampled** rather than
 * deterministic — a few requests in tens of thousands, clustered in bursts — so
 * completing the identity removes the systematic failure while leaving a
 * residual that only a retry can absorb.
 *
 * The CN gateway accepts the same family, so both regions carry it and the two
 * paths cannot drift.
 */

const CN: WorkBuddyCredential = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 0,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
}
const GLOBAL: WorkBuddyCredential = { ...CN, domain: 'www.workbuddy.ai' }

/** Deterministic identity so assertions never depend on the machine's Apps. */
const IDENTITY: ChatIdentity = { clientVersion: '5.8.4', cliVersion: '2.161.0' }

/** The four headers the capture shows on an official chat request. */
const FAMILY = [
  'X-Conversation-ID',
  'X-Conversation-Request-ID',
  'X-Root-Request-ID',
  'X-Conversation-Message-ID',
] as const

/** The family members whose shape is 32 lowercase hex with no dashes. */
const HEX32 = [
  'X-Request-ID',
  'X-Conversation-Request-ID',
  'X-Root-Request-ID',
  'X-Conversation-Message-ID',
] as const

const DASHED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX32_SHAPE = /^[0-9a-f]{32}$/

/** The body the gateway answers with when the channel check fails. */
const CHANNEL_BLOCK_BODY = JSON.stringify({
  code: 11128,
  msg: 'conversation id missing',
  requestId: 'deadbeef',
  displayMsg: { en: 'Request blocked. Please send it again', zh: '请求被拦截，请重新发送' },
  displayTips: {
    en: 'This call failed channel verification, possibly because it was not sent from an official client. Please resend from the official client.',
    zh: '这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。',
  },
})

function client(): WorkBuddyUpstreamClient {
  return new WorkBuddyUpstreamClient({ resolveChatIdentity: async () => IDENTITY })
}

function fakeResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: () => Promise.resolve(body) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Stub fetch and expose every `(url, init)` pair it received. */
function captureFetch(...responses: (Response | (() => Response))[]) {
  let index = 0
  const fetchMock = vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return typeof next === 'function' ? next() : next as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  const all = () => fetchMock.mock.calls as unknown as [string, RequestInit][]
  return {
    all,
    last: () => {
      expect(fetchMock).toHaveBeenCalled()
      const calls = all()
      return calls[calls.length - 1]!
    },
  }
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>
}

/** A minimal but realistic chat body. */
const CHAT_BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
})

describe('chat carries the full conversation channel family', () => {
  it('sends the four-header family with the captured shapes and equalities', async () => {
    const wire = captureFetch(fakeResponse('{}'))
    const result = await client().chatStream(GLOBAL, CHAT_BODY)
    expect(result.ok).toBe(true)

    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = headersOf(init)

    for (const name of FAMILY) expect(headers[name]).toBeTruthy()
    expect(headers['X-Conversation-ID']).toMatch(DASHED_UUID)
    for (const name of HEX32) expect(headers[name]).toMatch(HEX32_SHAPE)

    // The relations the capture shows. They are not cosmetic: the gateway is
    // checking for the family's shape, and independent random ids for these
    // pairs are the one way to get that shape wrong while looking complete.
    expect(headers['X-Conversation-Message-ID']).toBe(headers['X-Request-ID'])
    expect(headers['X-Root-Request-ID']).toBe(headers['X-Conversation-Request-ID'])
    // The conversation id is its own value, never an alias of the others.
    expect(new Set([headers['X-Conversation-ID'], headers['X-Request-ID'], headers['X-Conversation-Request-ID']]).size).toBe(3)
  })

  it('carries the desktop fingerprint headers the capture shows', async () => {
    const wire = captureFetch(fakeResponse('{}'))
    await client().chatStream(GLOBAL, CHAT_BODY)
    const headers = headersOf(wire.last()[1])

    expect(headers['X-Agent-Type']).toBe('main')
    expect(headers['X-Agent-Purpose']).toBe('conversation')
    expect(headers['X-Agent-Intent']).toBe('craft')
    expect(headers['X-Private-Data']).toBe('true')
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')

    // The trace family, with the W3C shape the capture shows.
    const trace = headers['X-Trace-ID']
    expect(trace).toMatch(HEX32_SHAPE)
    expect(headers['traceparent']).toBe(`00-${trace}-${headers['X-B3-SpanId']}-01`)
    expect(headers['b3']).toBe(`${trace}-${headers['X-B3-SpanId']}-1`)
    expect(headers['X-B3-TraceId']).toBe(trace)
    expect(headers['X-B3-SpanId']).toMatch(/^[0-9a-f]{16}$/)
    expect(headers['X-B3-Sampled']).toBe('1')

    // The capture shows the official client does NOT send these on chat: they
    // belong to the feedback path, and they are account-linkable besides.
    expect(headers['X-Machine-ID']).toBeUndefined()
    expect(headers['X-Session-ID']).toBeUndefined()
  })

  it('sends the same family on the CN chat — measured as accepted, so the paths cannot drift', async () => {
    const wire = captureFetch(fakeResponse('{}'))
    await client().chatStream(CN, CHAT_BODY)
    const [url, init] = wire.last()
    expect(url).toBe('https://copilot.tencent.com/v2/chat/completions')
    const headers = headersOf(init)
    for (const name of FAMILY) expect(headers[name]).toBeTruthy()
  })

  it('mints a fresh family per request, so parallel agents never share one conversation', async () => {
    const wire = captureFetch(fakeResponse('{}'), fakeResponse('{}'))
    const upstream = client()
    await upstream.chatStream(GLOBAL, CHAT_BODY)
    const first = headersOf(wire.last()[1])
    await upstream.chatStream(GLOBAL, CHAT_BODY)
    const second = headersOf(wire.last()[1])
    for (const name of [...FAMILY, 'X-Request-ID', 'X-Trace-ID'] as const) {
      expect(second[name]).not.toBe(first[name])
    }
  })

  it('the effort probe shares the chat rule', async () => {
    const wire = captureFetch(fakeResponse(JSON.stringify({ code: 11150, msg: 'no' }), false, 400))
    const result = await client().probeEffort(GLOBAL, 'model-x', 'low', new AbortController().signal)
    expect(result.status).toBe(400)
    const [url, init] = wire.last()
    expect(url).toBe('https://www.workbuddy.ai/v2/chat/completions')
    const headers = headersOf(init)
    for (const name of FAMILY) expect(headers[name]).toBeTruthy()
  })
})

describe('the sampled channel block is retried, and only it', () => {
  it('retries the block with a fresh family and returns the retry', async () => {
    const wire = captureFetch(
      fakeResponse(CHANNEL_BLOCK_BODY, false, 400),
      fakeResponse('data: [DONE]\n\n'),
    )
    const result = await client().chatStream(GLOBAL, CHAT_BODY)
    expect(result.ok).toBe(true)
    expect(wire.all().length).toBe(2)

    // A retry that replayed the blocked ids would be re-judged by the same
    // sample, so the ids must differ between attempts.
    const first = headersOf(wire.all()[0]![1])
    const second = headersOf(wire.all()[1]![1])
    expect(second['X-Conversation-ID']).not.toBe(first['X-Conversation-ID'])
    expect(second['X-Request-ID']).not.toBe(first['X-Request-ID'])
    // The body is prepared once and reused, so it must be byte-identical.
    expect(wire.all()[1]![1].body).toBe(wire.all()[0]![1].body)
  })

  it('gives up after the attempt budget and reports the block', async () => {
    const wire = captureFetch(fakeResponse(CHANNEL_BLOCK_BODY, false, 400))
    const result = await client().chatStream(GLOBAL, CHAT_BODY)
    if (result.ok) throw new Error('expected the channel block to surface as a failure')
    expect(result.status).toBe(400)
    expect(result.kind).toBe('client')
    expect(wire.all().length).toBe(3)
  })

  it('does not retry a 400 that is not the channel block', async () => {
    const wire = captureFetch(fakeResponse(JSON.stringify({ code: 11133, msg: 'integer_below_min_value' }), false, 400))
    const result = await client().chatStream(GLOBAL, CHAT_BODY)
    if (result.ok) throw new Error('expected the business 400 to surface as a failure')
    expect(result.kind).toBe('client')
    expect(wire.all().length).toBe(1)
  })

  it('does not retry a failure that is not a 400', async () => {
    const wire = captureFetch(fakeResponse(CHANNEL_BLOCK_BODY, false, 429))
    const result = await client().chatStream(GLOBAL, CHAT_BODY)
    if (result.ok) throw new Error('expected the 429 to surface as a failure')
    expect(result.kind).toBe('soft_rate')
    expect(wire.all().length).toBe(1)
  })

  it('recognises the block by code, msg, or either language of the display text', () => {
    expect(isChannelValidationBlock(400, CHANNEL_BLOCK_BODY)).toBe(true)
    expect(isChannelValidationBlock(400, JSON.stringify({ code: 11128 }))).toBe(true)
    expect(isChannelValidationBlock(400, JSON.stringify({ msg: 'conversation id missing' }))).toBe(true)
    expect(isChannelValidationBlock(400, JSON.stringify({ displayTips: { en: 'failed channel verification' } }))).toBe(true)
    // A different business error must stay untouched.
    expect(isChannelValidationBlock(400, JSON.stringify({ code: 11133, msg: 'integer_below_min_value' }))).toBe(false)
    expect(isChannelValidationBlock(402, CHANNEL_BLOCK_BODY)).toBe(false)
  })
})

describe('the upstream error code is surfaced for diagnosis', () => {
  it('reads a numeric code', () => {
    expect(upstreamErrorCode(CHANNEL_BLOCK_BODY)).toBe('11128')
  })

  it('reads a string code, as the gateway also spells it', () => {
    expect(upstreamErrorCode(JSON.stringify({ code: '11-128' }))).toBe('11-128')
  })

  it('returns undefined when there is no code to report', () => {
    expect(upstreamErrorCode('not json')).toBeUndefined()
    expect(upstreamErrorCode(JSON.stringify({ msg: 'no code here' }))).toBeUndefined()
  })
})

describe('the degraded identity is never sent if a second resolve completes it', () => {
  /**
   * The resolver degrades to the built-in fallback on a transient reader
   * failure — built-in version, and **no `CLI/…` segment**. That shape is what
   * the gateway refuses as an unapproved client (`400 / 11128 / "Illegal API
   * invocation from an unapproved channel"`), and it is not cached, so a
   * second ask can produce the complete identity. Sending the degraded one is
   * therefore a bug even though the resolver "succeeded".
   */

  it('asks again and sends the complete identity when the first resolve degrades', async () => {
    const wire = captureFetch(fakeResponse('{}'))
    let calls = 0
    const upstream = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => {
        calls += 1
        // First answer is the fallback shape: no CLI version.
        return calls === 1 ? { clientVersion: '5.5.2' } : IDENTITY
      },
    })
    const result = await upstream.chatStream(GLOBAL, CHAT_BODY)
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
    // One request only: the retry of the *resolve* is not a retry of the turn.
    expect(wire.all().length).toBe(1)
    const headers = headersOf(wire.all()[0]![1])
    expect(headers['User-Agent']).toContain('CLI/')
    expect(headers['X-IDE-Version']).toBe('5.8.4')
  })

  it('re-resolves on every attempt instead of freezing a degraded identity', async () => {
    const wire = captureFetch(fakeResponse(CHANNEL_BLOCK_BODY, false, 400))
    let calls = 0
    const upstream = new WorkBuddyUpstreamClient({
      resolveChatIdentity: async () => {
        calls += 1
        return { clientVersion: '5.5.2' }
      },
    })
    const result = await upstream.chatStream(GLOBAL, CHAT_BODY)
    if (result.ok) throw new Error('expected the channel block to surface as a failure')
    // More resolves than attempts: each attempt asks again rather than
    // replaying the identity resolved before the first one.
    expect(calls).toBeGreaterThan(wire.all().length)
    for (const [, init] of wire.all()) {
      expect(headersOf(init)['User-Agent']).not.toContain('CLI/')
    }
  })
})

describe('the channel family stays off every other endpoint (blast-radius pin)', () => {
  it('refresh never carries it', async () => {
    const wire = captureFetch(fakeResponse(JSON.stringify({ code: 0, msg: 'ok', data: { accessToken: 'next' } })))
    await client().refreshToken(CN)
    for (const [url, init] of wire.all()) {
      expect(url).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh')
      for (const name of FAMILY) expect(headersOf(init)[name]).toBeUndefined()
    }
  })

  it('catalog never carries it, on either request it issues', async () => {
    const wire = captureFetch(fakeResponse(JSON.stringify({
      code: 0, msg: 'ok',
      data: {
        models: [{ id: 'm', name: 'M', maxInputTokens: 100, maxOutputTokens: 10 }],
        agents: [{ name: 'cli', models: ['m'] }],
      },
    })))
    await client().fetchModels(CN)
    expect(wire.all().length).toBeGreaterThanOrEqual(2)
    for (const [, init] of wire.all()) {
      for (const name of FAMILY) expect(headersOf(init)[name]).toBeUndefined()
    }
  })

  it('billing never carries it', async () => {
    const wire = captureFetch(fakeResponse(JSON.stringify({
      code: 0, msg: 'ok',
      data: { Response: { Data: { Accounts: [] } } },
    })))
    await client().fetchCredits(CN)
    for (const [, init] of wire.all()) {
      for (const name of FAMILY) expect(headersOf(init)[name]).toBeUndefined()
    }
  })
})
