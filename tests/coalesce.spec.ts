import { describe, expect, it } from 'vitest'
import { coalesceReasoning } from '../src/standalone/coalesce.ts'

/**
 * The reasoning coalescer turns a whole reasoning run into **one** SSE event,
 * because ZCode renders one thinking block per reasoning event — so any
 * mid-stream flush, whether at a character count, a paragraph or a sentence,
 * just moves the split rather than removing it.
 *
 * These tests pin the invariant that must never change (the concatenated
 * reasoning text and the order of every other event) and the one thing that
 * must: exactly one reasoning event per thinking phase.
 */

interface Event {
  id?: string
  choices?: Array<{ delta?: Record<string, unknown> }>
  usage?: unknown
}

function sse(events: Array<Event | '[DONE]' | ':heartbeat'>): Response {
  const lines = events.map(event => {
    if (event === '[DONE]') return 'data: [DONE]\n\n'
    if (event === ':heartbeat') return ': heartbeat\n\n'
    return `data: ${JSON.stringify(event)}\n\n`
  })
  return new Response(lines.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Content-Length': String(lines.join('').length) } })
}

function reasoning(text: string, extra: Record<string, unknown> = {}): Event {
  return {
    id: 'c1',
    choices: [{ delta: { content: '', reasoning_content: text, function_call: null, refusal: '', tool_calls: [], ...extra } }],
    usage: null,
  }
}

function content(text: string): Event {
  return { id: 'c1', choices: [{ delta: { content: text, reasoning_content: '' } }], usage: null }
}

/** Feed text in one-character deltas, the way the upstream actually streams. */
function charDeltas(text: string): Event[] {
  return [...text].map(character => reasoning(character))
}

async function run(events: Array<Event | '[DONE]' | ':heartbeat'>): Promise<{ reasoning: string[]; events: string[]; raw: string }> {
  const result = coalesceReasoning({ ok: true, response: sse(events) })
  if (!result.ok || result.response.body === null) throw new Error('expected a stream')
  const raw = await new Response(result.response.body).text()
  const out = raw.split('\n\n').filter(part => part.trim() !== '')
  const chunks: string[] = []
  for (const event of out) {
    if (!event.startsWith('data: ')) continue
    const payload = event.slice(6)
    if (payload === '[DONE]') continue
    const parsed = JSON.parse(payload) as Event
    const value = parsed.choices?.[0]?.delta?.['reasoning_content']
    if (typeof value === 'string' && value !== '') chunks.push(value)
  }
  return { reasoning: chunks, events: out, raw }
}

describe('reasoning coalescing', () => {
  it('emits the whole thinking phase as ONE event, however many paragraphs it has', async () => {
    const text = 'First paragraph, with a sentence.\n\nSecond paragraph here.\n\nThird and last.'
    const { reasoning: chunks } = await run([...charDeltas(text), content('done'), '[DONE]'])

    // One block, not one per paragraph and not one per sentence: the client
    // renders a block per event, so a single event is the only way to get a
    // single block.
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe(text)
  })

  it('does not split on list newlines or paragraph breaks', async () => {
    const text = 'Steps:\n1. Define the route.\n2. Implement the handler.\n\n3. Mount it.'
    const { reasoning: chunks } = await run([...charDeltas(text), '[DONE]'])
    expect(chunks).toEqual([text])
  })

  it('does not split at a heartbeat that arrives mid-thinking', async () => {
    const { reasoning: chunks, raw } = await run([
      reasoning('first half. '),
      ':heartbeat',
      reasoning('second half.'),
      '[DONE]',
    ])
    expect(chunks).toEqual(['first half. second half.'])
    expect(raw).toContain(': heartbeat')
  })

  it('keeps the reasoning before the content that follows it', async () => {
    const { events } = await run([reasoning('thinking'), content('Hello'), content(' world'), '[DONE]'])
    const order = events
      .filter(event => event.startsWith('data: ') && event.slice(6) !== '[DONE]')
      .map(event => {
        const delta = (JSON.parse(event.slice(6)) as Event).choices?.[0]?.delta
        if (delta?.['reasoning_content']) return 'reasoning'
        return delta?.['content'] ? 'content' : 'other'
      })
    expect(order).toEqual(['reasoning', 'content', 'content'])
  })

  it('passes content deltas through untouched', async () => {
    const { events } = await run([reasoning('a'), content('Hello'), content(' world'), '[DONE]'])
    const contents = events
      .filter(event => event.startsWith('data: ') && event.slice(6) !== '[DONE]')
      .map(event => (JSON.parse(event.slice(6)) as Event).choices?.[0]?.delta?.['content'])
      .filter(value => typeof value === 'string' && value !== '')
    expect(contents).toEqual(['Hello', ' world'])
  })

  it('preserves the opening role event so clients learn the role first', async () => {
    const { events } = await run([reasoning('', { role: 'assistant' }), reasoning('hello'), '[DONE]'])
    const first = JSON.parse(events[0]!.slice(6)) as Event
    expect(first.choices?.[0]?.delta?.['role']).toBe('assistant')
    expect(first.choices?.[0]?.delta?.['reasoning_content']).toBe('')
    // ...and the buffered text still arrives as its own single event.
    const second = JSON.parse(events[1]!.slice(6)) as Event
    expect(second.choices?.[0]?.delta?.['reasoning_content']).toBe('hello')
  })

  it('drops stale length/encoding headers since the body changed', async () => {
    const result = coalesceReasoning({ ok: true, response: sse([reasoning('a'), '[DONE]']) })
    if (!result.ok) throw new Error('expected success')
    expect(result.response.headers.get('content-length')).toBe(null)
    expect(result.response.headers.get('content-type')).toBe('text/event-stream')
  })

  it('returns failures untouched', async () => {
    const failure = { ok: false as const, status: 402, kind: 'hard_credit' as const, message: 'no credits' }
    expect(coalesceReasoning(failure)).toBe(failure)
  })
})
