/**
 * Reasoning coalescing.
 *
 * The upstream streams `reasoning_content` in tiny pieces — often a word or
 * two per SSE event (measured: 19 events for a 1,138-character turn). ZCode
 * renders **one thinking block per reasoning event**, so those pieces show up
 * as a column of word-sized blocks instead of one block of thinking.
 *
 * There is no SSE field that says "this delta continues the previous block",
 * so the only way to get one block is to send one event. This transform
 * therefore buffers the whole reasoning run and emits it as a single event
 * when the run ends — on the first content/tool event, on `[DONE]`, or at EOF.
 *
 * No size limit, no paragraph split, no sentence split: every mid-stream
 * flush would become another block, which is the problem being fixed.
 *
 * Trade-off, stated plainly: thinking text appears when the reasoning phase
 * finishes rather than streaming word by word. That is unavoidable while the
 * client groups by event; `--no-coalesce-reasoning` restores the raw stream
 * for anyone who prefers incremental text over a single block.
 *
 * Only `reasoning_content` is touched. Text deltas, tool-call deltas, usage
 * events, heartbeats and `[DONE]` pass through untouched and in order, and the
 * concatenated reasoning is byte-identical to what the upstream sent. The shim
 * is not involved: it pipes the upstream body through unchanged, so this runs
 * in the standalone layer, on the `Response` the client wrapper hands back.
 *
 * @module workbuddy-bridge/standalone/coalesce
 */

import type { WorkBuddyChatResult } from '../core/upstream.ts'

interface SseDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  [key: string]: unknown
}

interface SseEvent {
  choices?: Array<{ delta?: SseDelta; [key: string]: unknown }>
  [key: string]: unknown
}

/** Pull the first choice's delta out of a parsed SSE payload. */
function deltaOf(event: SseEvent): SseDelta | undefined {
  const delta = event.choices?.[0]?.delta
  return typeof delta === 'object' && delta !== null ? delta : undefined
}

/**
 * Rebuild one SSE event carrying `reasoning` as its reasoning delta.
 *
 * Cloned from the last real reasoning event so every field the upstream
 * sends — id, model, created, object, the empty `content`/`tool_calls`
 * placeholders — stays exactly as the client expects. Only
 * `reasoning_content` is replaced.
 */
function reasoningEvent(template: SseEvent, reasoning: string): string {
  const event = structuredClone(template)
  const delta = deltaOf(event)
  if (delta !== undefined) delta.reasoning_content = reasoning
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * Wrap a successful chat result so its stream carries one reasoning event per
 * thinking phase.
 *
 * Returns the result untouched when it is a failure or has no body, so callers
 * can apply this unconditionally.
 */
export function coalesceReasoning(result: WorkBuddyChatResult): WorkBuddyChatResult {
  if (!result.ok || result.response.body === null) return result
  const upstream = result.response.body

  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let lineBuffer = ''
  let reasoning = ''
  let template: SseEvent | undefined
  // True while the event we just suppressed still owes its terminating blank
  // line: SSE needs one between events, and emitting it after a suppressed
  // data line would produce stray separators.
  let suppressed = false

  /** Send everything buffered — the reasoning run has ended. */
  const flushAll = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (reasoning === '' || template === undefined) return
    controller.enqueue(encoder.encode(reasoningEvent(template, reasoning)))
    reasoning = ''
  }

  const handleLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
    if (line === '') {
      // Event separator. Drop it when its data line was suppressed, pass it
      // through otherwise.
      if (suppressed) {
        suppressed = false
        return
      }
      controller.enqueue(encoder.encode('\n'))
      return
    }
    if (!line.startsWith('data:')) {
      // Comments (`: heartbeat`) carry no text and must not split the block:
      // pass them through without flushing, so a heartbeat mid-thinking does
      // not turn one thought into two.
      controller.enqueue(encoder.encode(`${line}\n`))
      return
    }
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      flushAll(controller)
      controller.enqueue(encoder.encode(`${line}\n`))
      return
    }
    let event: SseEvent | undefined
    try {
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed === 'object' && parsed !== null) event = parsed as SseEvent
    } catch {
      event = undefined
    }
    const delta = event === undefined ? undefined : deltaOf(event)
    const piece = delta?.reasoning_content
    if (event !== undefined && delta !== undefined && typeof piece === 'string' && piece !== '') {
      // A delta that also carries the role marker is the stream's opening
      // event; emit it at once with empty reasoning so the client learns the
      // role before the buffered text arrives.
      if (delta.role !== undefined && reasoning === '') {
        controller.enqueue(encoder.encode(reasoningEvent(event, '')))
      }
      template = event
      reasoning += piece
      suppressed = true
      return
    }
    // Any non-reasoning event ends the current reasoning run: whatever was
    // buffered must precede it, or the client would see text out of order.
    flushAll(controller)
    controller.enqueue(encoder.encode(`${line}\n`))
  }

  const stream = upstream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      lineBuffer += decoder.decode(chunk, { stream: true })
      let newline = lineBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = lineBuffer.slice(0, newline)
        lineBuffer = lineBuffer.slice(newline + 1)
        handleLine(line, controller)
        newline = lineBuffer.indexOf('\n')
      }
    },
    flush(controller) {
      lineBuffer += decoder.decode()
      if (lineBuffer !== '') {
        handleLine(lineBuffer, controller)
        lineBuffer = ''
      }
      flushAll(controller)
    },
  }))

  // The body changed, so a copied Content-Length or Content-Encoding would be
  // wrong; everything else (content-type, cache hints) still applies.
  const headers = new Headers(result.response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return { ok: true, response: new Response(stream, { status: result.response.status, headers }) }
}
