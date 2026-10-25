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

import { extractDisplayErrorMessage, type WorkBuddyChatResult } from '../core/upstream.ts'

/** How long one probe turn may take before it is abandoned. */
export const CHAT_PROBE_TIMEOUT_MS = 60_000

/** What to probe: one endpoint plus the credential it accepts. */
export interface ChatProbeOptions {
  /**
   * The OpenAI-compatible base URL — for a bridge endpoint, **including** the
   * `/v1` suffix the descriptor publishes; for a provider's own upstream, its
   * configured base URL. Getting this wrong is not a subtle failure: a shim
   * answers `/chat/completions` with its own 404, which reads exactly like an
   * upstream refusal.
   */
  baseUrl: string
  /**
   * The bearer token an agent would be configured with. Absent (or empty)
   * sends no Authorization header — how a no-authentication provider is probed.
   */
  token?: string
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

/** The minimal turn a probe sends; the account prepends its own system prompt. */
export function probeBody(model: string): string {
  return JSON.stringify({
    model,
    stream: true,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_tokens: 8,
  })
}

/**
 * Classify a finished probe response into the shape the page renders.
 *
 * Shared by the HTTP probe and the direct upstream probe, so a member test
 * reads the same way whichever path it traveled.
 */
export function probeDetail(status: number, text: string, startedAtMs: number): ChatProbeResult {
  const latencyMs = Date.now() - startedAtMs
  if (status < 200 || status >= 300) {
    return { ok: false, status, latencyMs, detail: `HTTP ${status}: ${text.slice(0, 400)}` }
  }
  const delta = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  const parts = [`HTTP ${status}`, `${text.length} bytes`]
  if (text.includes('[DONE]')) parts.push('terminated')
  parts.push(delta === null ? 'no text delta' : `first text: ${(delta[1] ?? '').slice(0, 60)}`)
  return { ok: true, status, latencyMs, detail: parts.join(', ') }
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
      headers: {
        'Content-Type': 'application/json',
        ...(options.token === undefined || options.token === '' ? {} : { Authorization: `Bearer ${options.token}` }),
      },
      body: probeBody(options.model),
      signal: controller.signal,
    })
    return probeDetail(response.status, await response.text(), startedAtMs)
  } catch (error: unknown) {
    return { ok: false, status: 0, latencyMs: Date.now() - startedAtMs, detail: messageOf(error) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}

/** Send one prepared chat turn through an account's own upstream path. */
export type AccountTurnSender = (
  bodyJson: string,
  signal?: AbortSignal,
) => Promise<WorkBuddyChatResult>

/**
 * One member probe, as the bridge hands it to the probe implementation.
 *
 * An account member is probed in process: there is no per-account endpoint to
 * knock on any more, so the probe carries a turn sender that runs the same
 * upstream call a pool-served request runs. A provider member is probed over
 * HTTP at its own base URL, with its own key and nobody else's.
 */
export interface MemberProbeOptions {
  /** The pool's provider id and the member's position in it, for diagnostics. */
  provider: string
  index: number
  /** The model the probe asks for; the bridge has already validated it. */
  model: string
  /** A provider member's upstream base URL; present exactly for providers. */
  baseUrl?: string
  /** The provider member's API key; absent means no authentication header. */
  apiKey?: string
  /** Send one prepared chat turn at an account member through its own path. */
  sendTurn?: AccountTurnSender
}

/**
 * The default member probe: upstream HTTP for a provider, the account's own
 * client path for an account. The same turn shape {@link probeChatTurn} sends.
 */
export async function probeMemberTurn(options: MemberProbeOptions): Promise<ChatProbeResult> {
  if (options.sendTurn === undefined) {
    return await probeChatTurn({
      baseUrl: options.baseUrl!,
      ...(options.apiKey === undefined ? {} : { token: options.apiKey }),
      model: options.model,
    })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, CHAT_PROBE_TIMEOUT_MS)
  const startedAtMs = Date.now()
  try {
    const result = await options.sendTurn(probeBody(options.model), controller.signal)
    if (!result.ok) {
      const detail = extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400)
      const statusNote = (result.status === 401 || result.status === 403) && result.kind !== 'session_dead'
        ? ''
        : ` (upstream http ${result.status})`
      const status = result.kind === 'hard_credit' ? 402
        : result.kind === 'soft_rate' ? 429
        : result.kind === 'session_dead' ? 401
        : result.kind === 'not_found' || result.kind === 'server' ? 502
        : 400
      return {
        ok: false,
        status,
        latencyMs: Date.now() - startedAtMs,
        detail: `HTTP ${status}${statusNote}: ${detail}`,
      }
    }
    const text = await result.response.text()
    return probeDetail(200, text, startedAtMs)
  } catch (error: unknown) {
    return { ok: false, status: 0, latencyMs: Date.now() - startedAtMs, detail: messageOf(error) }
  } finally {
    clearTimeout(timer)
  }
}
