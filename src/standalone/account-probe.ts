/**
 * One real chat turn against one loopback endpoint, as evidence.
 *
 * "This account is signed in and has credits" is not the same claim as "this
 * account can answer a turn": the credential can be present while the
 * upstream refuses it, the model can be listed while the account's channel is
 * rejected, and the shim's gates can fail for reasons none of the read-only
 * checks see. The only honest test is the one an agent performs, so this
 * sends exactly that — same base URL, same bearer token, same
 * `/chat/completions` path — and reports the upstream's own words when it
 * fails.
 *
 * The body is minimal on purpose: the shim forces streaming and prepends the
 * system prompt itself, so anything larger would test the caller rather than
 * the account.
 *
 * @module workbuddy-bridge/standalone/account-probe
 */

/** How long one probe turn may take before it is abandoned. */
export const CHAT_PROBE_TIMEOUT_MS = 60_000

/** What to probe: one endpoint plus the credential it accepts. */
export interface ChatProbeOptions {
  /**
   * The OpenAI-compatible base URL, **including** the `/v1` suffix — the same
   * string the descriptor publishes and an agent is configured with. Getting
   * this wrong is not a subtle failure: the shim answers `/chat/completions`
   * with its own 404, which reads exactly like an upstream refusal.
   */
  baseUrl: string
  /** That shim's bearer token — the one an agent would be configured with. */
  token: string
  /** The model to ask for; must be one this endpoint serves. */
  model: string
  /** Override the default timeout, in milliseconds. */
  timeoutMs?: number
  /** Caller cancellation, e.g. the browser hanging up mid-turn. */
  signal?: AbortSignal
}

/** What one probe produced, in the terms a user needs to read. */
export interface ChatProbeResult {
  ok: boolean
  /** HTTP status, or 0 when the request never completed. */
  status: number
  /** Wall time from request to the last byte of the answer. */
  latencyMs: number
  /** A short factual account: status, size, termination, first text — or the error. */
  detail: string
}

/** Compact message text for a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Send one minimal streaming chat turn and classify what came back.
 *
 * Never throws: a refused connection, a timeout and a 402 are all answers to
 * "can this account serve a turn", and the caller renders them the same way.
 */
export async function probeChatTurn(options: ChatProbeOptions): Promise<ChatProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, options.timeoutMs ?? CHAT_PROBE_TIMEOUT_MS)
  const cancel = (): void => { controller.abort() }
  options.signal?.addEventListener('abort', cancel, { once: true })
  const startedAtMs = Date.now()
  try {
    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({
        model: options.model,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    const latencyMs = Date.now() - startedAtMs
    if (!response.ok) {
      return { ok: false, status: response.status, latencyMs, detail: `HTTP ${response.status}: ${text.slice(0, 400)}` }
    }
    const delta = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
    const parts = [`HTTP ${response.status}`, `${text.length} bytes`]
    if (text.includes('[DONE]')) parts.push('terminated')
    parts.push(delta === null ? 'no text delta' : `first text: ${(delta[1] ?? '').slice(0, 60)}`)
    return { ok: true, status: response.status, latencyMs, detail: parts.join(', ') }
  } catch (error: unknown) {
    return { ok: false, status: 0, latencyMs: Date.now() - startedAtMs, detail: messageOf(error) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}
