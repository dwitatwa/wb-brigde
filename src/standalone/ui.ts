/**
 * The bridge's local web UI: a single self-contained page showing each
 * endpoint's sign-in state, credit balance, and model list — plus, for a
 * failover pool, one row per member with a button that proves whether that
 * account can actually answer a turn.
 *
 * It follows the same trust model as the upstream plugin's status route
 * (`src/dsh/web-status.ts`), which is the important part:
 *
 * - it binds loopback only, and
 * - every request must name a loopback `Host` and, if a browser sent one, a
 *   loopback `Origin`. The `Host` check is what defeats DNS rebinding, because
 *   a rebinding page carries the attacker's domain in `Host`.
 *
 * Unlike the shim it does **not** require a bearer token. It cannot: a browser
 * navigating to a URL cannot attach an `Authorization` header. The loopback
 * pair above is therefore the whole boundary, which is exactly why the token
 * is never placed in this document — a page that cannot be authenticated must
 * not be able to read the secret that authenticates the other one.
 *
 * Probing is the one action this page can take, and it is the one that spends
 * money, so it is gated separately: the page carries a per-process nonce that
 * a `POST /api/pool/test` must repeat in a header. A cross-origin page cannot
 * read the nonce (this server sends no CORS headers), and a custom header
 * forces a preflight it will not pass, so "any local page can burn credits by
 * posting to the UI port" is not a thing that can happen. The nonce is not a
 * secret worth protecting — it authenticates nothing upstream — but it does
 * bind the action to a document this server handed out.
 *
 * @module workbuddy-bridge/standalone/ui
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostIsLoopback, originIsLoopback } from '../core/loopback.ts'
import type { ShimLogger } from '../core/shim.ts'

/** One credit package, as the UI shows it. */
export interface UiCreditAccount {
  packageName: string
  remain: number
  size: number
  unlimited?: true
  endTimeMs?: number
}

/** One aggregate credit answer. Mirrors `WorkBuddyCredits` without the token path. */
export interface UiCredits {
  total: number
  accounts: readonly UiCreditAccount[]
  unlimited?: true
  cycleResetTime?: string
}

/** One model row, flattened for display. */
export interface UiModel {
  id: string
  name: string
  /** Normalized rate, e.g. `x0.79`; absent when the upstream declared none. */
  credits?: string
  free?: true
  /** Upstream promo labels, verbatim. */
  badges?: readonly string[]
  /** The upstream's price cannot be vouched for; show "needs refresh". */
  rateUnknown?: true
  contextWindow?: number
  defaultContextWindow?: number
  maxContextWindow?: number
  maxTokens?: number
  supportsImages: boolean
  reasoning?: {
    supports: boolean
    efforts?: readonly string[]
    canDisableThinking?: boolean
  }
}

/** One member of a failover pool, as the UI shows it. */
export interface UiPoolMember {
  /** Position in the pool's member list, 0-based — what a test request names. */
  index: number
  /** 1-based position among the product's accounts. */
  accountIndex: number
  /** The account's nickname, or a positional label while none is known. */
  label: string
  signedIn: boolean
  /** The account's own endpoint, so a row can be matched to its card. */
  baseUrl: string
  /** Whether this member will answer the next request. */
  head: boolean
  /** Turns this member served successfully since the bridge started. */
  successes: number
  /** Attempts on this member that failed. */
  failures: number
  /** Failures since this member last succeeded. */
  consecutiveFailures: number
  lastAttemptAtMs?: number
  /** The last attempt's class, for a status pill. */
  lastOutcome?: 'ok' | 'credential-error' | 'upstream-error'
  /** One line describing the last attempt. */
  lastOutcomeDetail?: string
  credits?: UiCredits
  creditsError?: string
}

/**
 * A pool's membership, as one block on its card.
 *
 * Carried on the endpoint rather than as separate endpoint rows because a
 * pool member is not addressable the way an account is: its credits, its
 * failures and its test result only mean anything in relation to the pool
 * that routes to it.
 */
export interface UiPool {
  /** Which member answers next, 0-based. */
  headIndex: number
  members: readonly UiPoolMember[]
}

/** One served endpoint, as the UI shows it. Never carries the bearer token. */
export interface UiEndpoint {
  provider: string
  displayName: string
  /** The OpenAI-compatible base URL an agent would use. */
  baseUrl: string
  signedIn: boolean
  nickname?: string
  domain?: string
  /** Which stored copy the credential came from. */
  source?: string
  expiresAtMs?: number
  /** Where the served models came from: live fetch, saved cache, or fallback. */
  catalogSource?: string
  catalogFetchedAtMs?: number
  /** A diagnosable credential problem, when there is one. */
  error?: string
  credits?: UiCredits
  creditsError?: string
  models: readonly UiModel[]
  /** Present only on a failover pool: its members and who answers next. */
  pool?: UiPool
}

/** The whole document `/api/state` returns. */
export interface UiState {
  version: 1
  startedAtMs: number
  nowMs: number
  endpoints: readonly UiEndpoint[]
}

/** What the page asks the bridge to test: one pool member. */
export interface UiProbeRequest {
  /** The pool endpoint's provider id, e.g. `workbuddy-ai-pool`. */
  provider: string
  /** 0-based member index within that pool. */
  index: number
  /** Model to test with; the account's first model when absent. */
  model?: string
}

/** What one probe produced, attributed back to the member that was asked. */
export interface UiProbeResult {
  provider: string
  index: number
  /** The account's nickname, so a result can be read without the page. */
  label: string
  model: string
  ok: boolean
  /** HTTP status, or 0 when the turn never completed. */
  status: number
  latencyMs: number
  detail: string
}

/**
 * A request the caller got wrong, with the status to answer it with.
 *
 * Separate from an ordinary `Error` because "there is no pool at that
 * provider" and "the upstream refused this account" are different answers: the
 * first is a 404 the page should surface as a bug, the second is a 200 with
 * `ok: false` and is the whole point of the feature.
 */
export class UiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'UiRequestError'
  }
}

/** A running UI server. */
export interface WorkBuddyUiServer {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The UI origin, e.g. `http://127.0.0.1:41000`; valid after ready. */
  url(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyUiOptions {
  /** Build the current state document. Called per request. */
  state: () => Promise<UiState>
  /**
   * Test one pool member with a real chat turn.
   *
   * Absent means the page renders without test buttons — a read-only UI, which
   * is what an embedder that cannot afford upstream calls should pass.
   */
  probe?: (request: UiProbeRequest) => Promise<UiProbeResult>
  logger?: ShimLogger
}

/**
 * Strip anything token-shaped before it crosses to the browser.
 *
 * Ported from the upstream status route. Every error string that reaches the
 * page goes through this: an upstream failure can echo back request material,
 * and a page with no authentication must not become a way to read a credential
 * out of a diagnostic.
 */
export function redactForBrowser(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

/**
 * Apply {@link redactForBrowser} to every string field that can carry an error.
 *
 * Done as one pass over the finished document rather than at each throw site,
 * so a future field cannot forget it: the choke point is the response, not the
 * producer.
 */
function redactState(state: UiState): UiState {
  return {
    ...state,
    endpoints: state.endpoints.map(endpoint => ({
      ...endpoint,
      ...endpoint.error === undefined ? {} : { error: redactForBrowser(endpoint.error) },
      ...endpoint.creditsError === undefined ? {} : { creditsError: redactForBrowser(endpoint.creditsError) },
      ...endpoint.pool === undefined ? {} : {
        pool: {
          ...endpoint.pool,
          members: endpoint.pool.members.map(member => ({
            ...member,
            ...member.creditsError === undefined ? {} : { creditsError: redactForBrowser(member.creditsError) },
            ...member.lastOutcomeDetail === undefined
              ? {}
              : { lastOutcomeDetail: redactForBrowser(member.lastOutcomeDetail) },
          })),
        },
      },
    })),
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** The Host/Origin loopback pair, identical to the upstream status route's gate. */
function loopbackRequest(req: IncomingMessage): boolean {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin)
}

/** Largest probe body accepted; the page sends a provider name and an index. */
const PROBE_BODY_LIMIT = 8 * 1024

/** Header the page repeats the nonce in. Custom, so it forces a preflight. */
const PROBE_HEADER = 'x-bridge-ui'

/** Read a request body with a size cap. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > PROBE_BODY_LIMIT) throw new UiRequestError(413, 'request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Validate a probe body into a request, or answer with what is wrong. */
function parseProbeRequest(raw: string): UiProbeRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UiRequestError(400, 'body must be JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UiRequestError(400, 'body must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const provider = record['provider']
  const index = record['index']
  const model = record['model']
  if (typeof provider !== 'string' || provider === '') {
    throw new UiRequestError(400, 'provider must be a non-empty string')
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new UiRequestError(400, 'index must be a non-negative integer')
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new UiRequestError(400, 'model must be a string when present')
  }
  return { provider, index, ...model === undefined || model === '' ? {} : { model } }
}

/**
 * Start the UI server.
 *
 * Returns `ready` rather than awaiting the listen, so a caller can hold the
 * handle before the port is known — the same shape the shim exposes.
 */
export function createWorkBuddyUiServer(options: WorkBuddyUiOptions): WorkBuddyUiServer {
  const { state, probe, logger } = options
  // Minted per process, not per page: the page is re-served on every load, and
  // a token that changed under a reload would make an open tab's test buttons
  // fail for no reason the user could see.
  const nonce = randomUUID()
  const page = PAGE.replace('"__UI_NONCE__"', JSON.stringify(nonce))
  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => { resolve() })
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  const url = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('workbuddy UI has no listening address')
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!loopbackRequest(req)) {
        writeJson(res, 403, { error: 'request-not-trusted' })
        return
      }
      const path = (req.url ?? '/').split('?')[0]
      if (req.method === 'GET') {
        if (path === '/' || path === '/index.html') {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(page),
            'Cache-Control': 'no-store',
          })
          res.end(page)
          return
        }
        if (path === '/api/state') {
          writeJson(res, 200, redactState(await state()))
          return
        }
        writeJson(res, 404, { error: `no such route: ${req.method} ${path}` })
        return
      }
      if (req.method === 'POST' && path === '/api/pool/test') {
        // The nonce check comes first and answers like the host gate: a
        // request that cannot prove it came from this page learns nothing
        // about which routes exist.
        if (req.headers[PROBE_HEADER] !== nonce) {
          writeJson(res, 403, { error: 'request-not-trusted' })
          return
        }
        if (probe === undefined) {
          writeJson(res, 501, { error: 'probing is not available' })
          return
        }
        // JSON only: a cross-origin HTML form can send `text/plain` without a
        // preflight, and this is the second gate behind the nonce.
        const type = req.headers['content-type']
        if (typeof type !== 'string' || !type.trim().toLowerCase().startsWith('application/json')) {
          writeJson(res, 415, { error: 'Content-Type must be application/json' })
          return
        }
        const request = parseProbeRequest(await readBody(req))
        const result = await probe(request)
        writeJson(res, 200, { ...result, detail: redactForBrowser(result.detail) })
        return
      }
      writeJson(res, 405, { error: 'method not allowed' })
    } catch (error: unknown) {
      if (error instanceof UiRequestError) {
        writeJson(res, error.status, { error: error.message })
        return
      }
      logger?.warn('workbuddy-bridge: UI request failed', error)
      if (!res.headersSent) writeJson(res, 500, { error: 'internal' })
      else res.end()
    }
  }

  return {
    ready,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}

/**
 * The page itself.
 *
 * Deliberately self-contained: no CDN, no fonts, no build step. A page whose
 * whole job is to report on a local bridge must work with the network down,
 * and the host's CSP allowlist would not survive a redesign anyway.
 *
 * The client script uses string concatenation rather than template literals so
 * this file needs no escaping gymnastics, and every value is passed through
 * `esc()` — model names come from the upstream and are rendered as text.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkBuddy Bridge</title>
<style>
  :root {
    --bg: #16161a; --panel: #1e1e24; --panel-2: #26262e; --line: #33333d;
    --fg: #e8e8ee; --muted: #9a9aa8; --dim: #6f6f7d;
    --accent: #a89cf0; --ok: #5dcaa5; --warn: #ef9f27; --bad: #f09595;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f6f8; --panel: #ffffff; --panel-2: #f0f0f4; --line: #dcdce4;
      --fg: #1c1c22; --muted: #5c5c6a; --dim: #8a8a98;
      --accent: #534ab7; --ok: #0f6e56; --warn: #854f0b; --bad: #a32d2d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 18px 24px; border-bottom: 1px solid var(--line);
  }
  h1 { font-size: 15px; font-weight: 500; margin: 0; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 12px; }
  .dim { color: var(--dim); font-size: 12px; }
  button {
    font: inherit; font-size: 12px; color: var(--fg); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; padding: 5px 12px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  main { padding: 24px; display: flex; flex-direction: column; gap: 20px; max-width: 1100px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .card-head { padding: 16px 20px; border-bottom: 1px solid var(--line); }
  .card-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .card-title h2 { font-size: 14px; font-weight: 500; margin: 0; }
  .pill {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
  }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .notice { margin: 14px 20px 0; padding: 10px 12px; border-radius: 8px; font-size: 12px;
            background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); }
  .notice.bad { color: var(--bad); }
  .credits { display: flex; gap: 28px; flex-wrap: wrap; padding: 14px 20px; }
  .credit-num { font-size: 22px; font-weight: 500; }
  .credit-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 20px; border-top: 1px solid var(--line); font-size: 13px; }
  th { font-weight: 500; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--panel-2);
         border: 1px solid var(--line); color: var(--muted); margin-right: 4px; }
  .tag.free { color: var(--ok); border-color: var(--ok); }
  .yes { color: var(--ok); } .no { color: var(--dim); }
  button:disabled { opacity: .45; cursor: default; }
  button:disabled:hover { border-color: var(--line); }
  .pill.head { color: var(--accent); border-color: var(--accent); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .members td { vertical-align: top; }
  .members tr.head td { background: var(--panel-2); }
  .who { display: flex; flex-direction: column; gap: 1px; }
  .who .name { font-size: 13px; }
  .sub { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dim); }
  .result { font-size: 12px; }
  .result.ok { color: var(--ok); }
  .result.bad { color: var(--bad); }
  .result .detail { color: var(--muted); font-size: 11px; display: block; margin-top: 2px; word-break: break-word; }
  footer { padding: 0 24px 32px; }
</style>
</head>
<body>
<header>
  <h1>WorkBuddy Bridge</h1>
  <span class="muted" id="version"></span>
  <span class="spacer"></span>
  <span class="dim" id="updated"></span>
  <button id="refresh">Refresh</button>
</header>
<main id="app"></main>
<footer><p class="dim">No bearer token is ever sent to this page. A test sends one real chat turn
through that account's own endpoint — it spends a few credits and does not move the pool's head.</p></footer>
<script>
var UI_NONCE = "__UI_NONCE__";
function esc(v) {
  return String(v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}
function fmtTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '';
  var d = new Date(ms);
  return d.toLocaleString();
}
function creditsBlock(ep) {
  var html = '';
  if (ep.creditsError) {
    return '<div class="notice bad">Could not read credits: ' + esc(ep.creditsError) + '</div>';
  }
  if (!ep.credits) return '';
  var c = ep.credits;
  html += '<div class="credits">';
  html += '<div><div class="credit-num">' + (c.unlimited ? 'Unlimited' : fmtNum(c.total)) + '</div>'
        + '<div class="credit-label">' + (c.unlimited ? 'quota' : 'credits remaining') + '</div></div>';
  if (c.cycleResetTime) {
    html += '<div><div class="credit-num">' + esc(c.cycleResetTime) + '</div>'
          + '<div class="credit-label">cycle reset</div></div>';
  }
  html += '</div>';
  if (c.accounts && c.accounts.length) {
    html += '<table><thead><tr><th>Package</th><th class="num">Remaining</th><th class="num">Size</th><th>Ends</th></tr></thead><tbody>';
    for (var i = 0; i < c.accounts.length; i++) {
      var a = c.accounts[i];
      html += '<tr><td>' + esc(a.packageName) + '</td>'
            + '<td class="num">' + (a.unlimited ? 'Unlimited' : fmtNum(a.remain)) + '</td>'
            + '<td class="num">' + (a.unlimited ? '' : fmtNum(a.size)) + '</td>'
            + '<td class="dim">' + esc(fmtTime(a.endTimeMs)) + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  return html;
}
function modelsTable(models) {
  if (!models.length) {
    return '<div class="notice">No models. This product has no usable credential, so the list is empty by design rather than broken.</div>';
  }
  var html = '<table><thead><tr><th>Model</th><th>Id</th><th class="num">Rate</th>'
           + '<th class="num">Context</th><th class="num">Max out</th><th>Images</th><th>Notes</th></tr></thead><tbody>';
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var tags = '';
    if (m.free) tags += '<span class="tag free">free</span>';
    if (m.rateUnknown) tags += '<span class="tag">price needs refresh</span>';
    if (m.badges) for (var b = 0; b < m.badges.length; b++) tags += '<span class="tag">' + esc(m.badges[b]) + '</span>';
    if (m.reasoning && m.reasoning.supports) {
      var eff = m.reasoning.efforts && m.reasoning.efforts.length ? m.reasoning.efforts.join('/') : 'default';
      tags += '<span class="tag">reasoning: ' + esc(eff) + '</span>';
    }
    var ctx = m.contextWindow ? fmtNum(m.contextWindow) : '';
    if (m.maxContextWindow && m.maxContextWindow > (m.contextWindow || 0)) {
      ctx = fmtNum(m.contextWindow) + ' <span class="dim">(max ' + fmtNum(m.maxContextWindow) + ')</span>';
    }
    html += '<tr>'
          + '<td>' + esc(m.name) + '</td>'
          + '<td class="mono">' + esc(m.id) + '</td>'
          + '<td class="num">' + esc(m.credits || '') + '</td>'
          + '<td class="num">' + ctx + '</td>'
          + '<td class="num">' + (m.maxTokens ? fmtNum(m.maxTokens) : '') + '</td>'
          + '<td class="' + (m.supportsImages ? 'yes' : 'no') + '">' + (m.supportsImages ? 'yes' : 'no') + '</td>'
          + '<td>' + tags + '</td>'
          + '</tr>';
  }
  return html + '</tbody></table>';
}
/* Per-member test results, keyed provider#index. Kept outside the rendered
   DOM so the 5s poll cannot wipe a result the user is still reading. */
var tests = {};
var lastState = null;
function testKey(provider, index) { return provider + '#' + index; }
function testOf(provider, index) { return tests[testKey(provider, index)]; }
function memberLabel(pool, index) {
  var m = pool.members[index];
  return m ? m.label : 'account ' + (index + 1);
}
function creditsCell(m) {
  if (m.credits) return m.credits.unlimited ? 'Unlimited' : fmtNum(m.credits.total);
  if (m.creditsError) return '<span class="no">error</span>';
  return '<span class="no">—</span>';
}
function attemptCell(m) {
  if (m.lastOutcome === undefined) return '<span class="no">no traffic yet</span>';
  var when = m.lastAttemptAtMs ? fmtTime(m.lastAttemptAtMs) : '';
  var pill = m.lastOutcome === 'ok'
    ? '<span class="pill ok">ok</span>'
    : '<span class="pill bad">' + esc(m.lastOutcome === 'credential-error' ? 'credential' : 'upstream') + '</span>';
  var detail = m.lastOutcomeDetail ? '<span class="sub">' + esc(m.lastOutcomeDetail) + '</span>' : '';
  return '<div class="who">' + pill + '<span class="sub">' + esc(when) + '</span>' + detail + '</div>';
}
function resultCell(provider, index) {
  var t = testOf(provider, index);
  if (t === undefined) return '';
  if (t.running) return '<span class="result">testing…</span>';
  var cls = t.ok ? 'ok' : 'bad';
  var head = t.ok
    ? 'pass · ' + (typeof t.latencyMs === 'number' ? (t.latencyMs / 1000).toFixed(1) + 's' : '')
    : 'fail';
  return '<span class="result ' + cls + '">' + head + '<span class="detail">' + esc(t.detail || '') + '</span></span>';
}
function poolBlock(ep) {
  var p = ep.pool;
  if (!p || !p.members || !p.members.length) return '';
  var html = '<div class="notice">One endpoint over ' + p.members.length + ' accounts. The next request is answered by '
    + '<strong>' + esc(memberLabel(p, p.headIndex)) + '</strong>. A test runs against that account only — '
    + 'it does not move the head.</div>';
  html += '<table class="members"><thead><tr><th>Account</th><th>State</th>'
        + '<th class="num">Credits</th><th>Last attempt</th><th>Test</th></tr></thead><tbody>';
  for (var i = 0; i < p.members.length; i++) {
    var m = p.members[i];
    var t = testOf(ep.provider, m.index);
    var busy = t !== undefined && t.running;
    var state = '<div class="who">'
      + '<span class="pill ' + (m.signedIn ? 'ok' : 'bad') + '">' + (m.signedIn ? 'signed in' : 'signed out') + '</span>';
    if (m.head) {
      state += m.signedIn
        ? '<span class="pill head">next</span>'
        : '<span class="pill warn">next · signed out</span>';
    }
    if (m.consecutiveFailures > 0) {
      state += '<span class="pill bad">' + m.consecutiveFailures + ' fail in a row</span>';
    }
    state += '<span class="sub">' + fmtNum(m.successes) + ' ok / ' + fmtNum(m.failures) + ' failed</span></div>';
    html += '<tr' + (m.head ? ' class="head"' : '') + '>'
          + '<td><div class="who"><span class="name">' + esc(m.label) + '</span>'
          + '<span class="sub">' + esc(m.baseUrl) + '</span></div></td>'
          + '<td>' + state + '</td>'
          + '<td class="num">' + creditsCell(m) + '</td>'
          + '<td>' + attemptCell(m) + '</td>'
          + '<td><button class="test" data-test-provider="' + esc(ep.provider) + '" data-test-index="' + m.index + '"'
          + (busy ? ' disabled' : '') + '>' + (busy ? 'testing…' : 'Test') + '</button>'
          + resultCell(ep.provider, m.index) + '</td></tr>';
  }
  return html + '</tbody></table>';
}
function renderCard(ep) {
  var html = '<section class="card"><div class="card-head"><div class="card-title">';
  html += '<h2>' + esc(ep.displayName) + '</h2>';
  html += '<span class="pill ' + (ep.signedIn ? 'ok' : 'bad') + '">' + (ep.signedIn ? 'signed in' : 'signed out') + '</span>';
  if (ep.nickname) html += '<span class="pill">' + esc(ep.nickname) + '</span>';
  if (ep.domain) html += '<span class="pill">' + esc(ep.domain) + '</span>';
  html += '<span class="spacer"></span>';
  if (ep.pool) {
    html += '<button class="test-all" data-test-all="' + esc(ep.provider) + '">Test all</button> ';
  }
  html += '<span class="url">' + esc(ep.baseUrl) + '</span>';
  html += '</div>';
  var meta = [];
  if (ep.catalogSource) meta.push('catalog: ' + ep.catalogSource);
  if (ep.catalogFetchedAtMs) meta.push('fetched ' + fmtTime(ep.catalogFetchedAtMs));
  if (ep.source) meta.push('credential: ' + ep.source);
  if (ep.expiresAtMs) meta.push('expires ' + fmtTime(ep.expiresAtMs));
  if (meta.length) html += '<div class="dim" style="margin-top:6px">' + esc(meta.join('  ·  ')) + '</div>';
  html += '</div>';
  if (ep.error) html += '<div class="notice bad">' + esc(ep.error) + '</div>';
  html += creditsBlock(ep);
  html += poolBlock(ep);
  html += modelsTable(ep.models || []);
  html += '</section>';
  return html;
}
function render(state) {
  lastState = state;
  document.getElementById('version').textContent = 'v' + (state.version === 1 ? '1' : '?');
  document.getElementById('updated').textContent = 'updated ' + new Date(state.nowMs).toLocaleTimeString();
  var app = document.getElementById('app');
  if (!state.endpoints || !state.endpoints.length) {
    app.innerHTML = '<div class="notice">No endpoints are being served.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < state.endpoints.length; i++) html += renderCard(state.endpoints[i]);
  app.innerHTML = html;
}

/*
 * Run one probe. The "done" callback lets "Test all" chain the accounts one at
 * a time — serial on purpose: firing every account at once would spend several
 * turns of quota to answer a question one turn at a time answers better, and a
 * burst from one machine across several identities is exactly the pattern the
 * pool's own notes warn about.
 */
function runTest(provider, index, done) {
  var key = testKey(provider, index);
  tests[key] = { running: true };
  if (lastState) render(lastState);
  fetch('/api/pool/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': UI_NONCE },
    body: JSON.stringify({ provider: provider, index: index })
  })
    .then(function (r) {
      return r.json().then(function (body) { return { status: r.status, body: body }; });
    })
    .then(function (res) {
      tests[key] = res.status === 200
        ? res.body
        : { ok: false, detail: (res.body && res.body.error) || ('HTTP ' + res.status) };
    })
    .catch(function (e) {
      tests[key] = { ok: false, detail: e.message };
    })
    .then(function () {
      tests[key].running = false;
      if (lastState) render(lastState);
      // A passing test just spent a credit: re-read the state so the row's
      // balance is not stale for up to five seconds.
      load();
      if (done) done();
    });
}
function runAll(provider) {
  var ep = null;
  if (lastState && lastState.endpoints) {
    for (var i = 0; i < lastState.endpoints.length; i++) {
      if (lastState.endpoints[i].provider === provider) ep = lastState.endpoints[i];
    }
  }
  if (!ep || !ep.pool) return;
  var queue = ep.pool.members.map(function (m) { return m.index; });
  function step() {
    if (!queue.length) return;
    runTest(provider, queue.shift(), step);
  }
  step();
}
document.getElementById('app').addEventListener('click', function (event) {
  var target = event.target;
  if (!target || target.tagName !== 'BUTTON') return;
  if (target.dataset.testProvider !== undefined) {
    runTest(target.dataset.testProvider, Number(target.dataset.testIndex));
    return;
  }
  if (target.dataset.testAll !== undefined) runAll(target.dataset.testAll);
});
var timer = null;
function load() {
  fetch('/api/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function (e) {
      document.getElementById('app').innerHTML =
        '<div class="notice bad">Could not reach the bridge: ' + esc(e.message) + '</div>';
    });
}
document.getElementById('refresh').addEventListener('click', load);
load();
timer = setInterval(load, 5000);
</script>
</body>
</html>
`
