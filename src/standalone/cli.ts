#!/usr/bin/env node
/**
 * `workbuddy-bridge` — run the WorkBuddy loopback bridge for any
 * OpenAI-compatible agent.
 *
 * The bridge itself is agent-agnostic: it serves a standard `/v1` surface on
 * loopback and this CLI publishes where to find it. DeepSeek Harness reaches
 * the same core through its own plugin entry instead; nothing here imports a
 * DSH package.
 *
 * @module workbuddy-bridge/standalone/cli
 */

import { existsSync } from 'node:fs'
import { WORKBUDDY_CONNECT_VERSION } from '../core/version.ts'
import { WORKBUDDY_VARIANTS, variantFor, type WorkBuddyVariant } from '../core/variants.ts'
import { WorkBuddyBridge } from './bridge.ts'
import {
  bridgeDescriptorPath,
  readBridgeDescriptor,
  removeBridgeDescriptor,
  writeBridgeDescriptor,
  type BridgeDescriptor,
} from './descriptor.ts'
import { createWorkBuddyUiServer, type WorkBuddyUiServer } from './ui.ts'
import { channelFailurePath } from './failure-capture.ts'
import { createWslForwarder, isRunningInWsl, wslHostAddresses, type WslForwarder } from './wsl.ts'

const PROGRAM = 'workbuddy-bridge'

const USAGE = `${PROGRAM} ${WORKBUDDY_CONNECT_VERSION}

Serve the WorkBuddy desktop app's models over a local OpenAI-compatible
endpoint, for any agent that can be pointed at a base URL.

Usage:
  ${PROGRAM} serve [options]     start the bridge (default command)
  ${PROGRAM} ui                  start the bridge plus a local web UI, which
                                 shows each pool account and can test it
  ${PROGRAM} test [options]      send one real chat turn through the running
                                 bridge, over both the loopback and WSL routes
  ${PROGRAM} models [--json]     list the models the running bridge serves
  ${PROGRAM} status [--json]     show the running bridge, if any
  ${PROGRAM} env                 print shell exports for the running bridge
  ${PROGRAM} help                show this text

Options:
  --provider <cn|ai|both>   which product(s) to serve (default: both)
  --model <id>              model for "test" (default: the endpoint's first)
  --ui                      also serve the web UI (models + credits)
  --wsl                     also listen on the WSL switch address, so agents
                            running inside WSL can reach the bridge
  --auth-file <path>        explicit WorkBuddy (CN) desktop auth file;
                            repeat to serve several CN accounts at once
  --auth-file-ai <path>     explicit WorkBuddy AI desktop auth file;
                            repeat to serve several AI accounts at once
  --all-accounts            serve every account found in the desktop auth
                            directory (explicit --auth-file* flags win for
                            the product they name)
  --pool failover           also serve one pool endpoint per product with 2+
                            accounts; a request another account could survive
                            (out of credits, rate limit, dead session, 5xx)
                            is retried on the next account
  --no-coalesce-reasoning   forward reasoning deltas exactly as the upstream
                            sends them (by default tiny per-word deltas are
                            regrouped, so clients show paragraphs rather than
                            one thinking block per word)
  --home <dir>              override the bridge home directory
  --no-descriptor           do not write the endpoint descriptor file
  --redact-token            write the descriptor without the bearer token
  --json                    machine-readable output
  -h, --help                show this text

WSL note: WSL2 in NAT mode has its own loopback, so a bridge on 127.0.0.1 is
unreachable from inside WSL. Either pass --wsl (which binds the host side of
the WSL virtual switch as well), or set networkingMode=mirrored in .wslconfig,
which shares localhost between Windows and WSL and needs no extra listener.

Environment:
  WORKBUDDY_BRIDGE_HOME     bridge home (default: ~/.workbuddy-bridge)
  WORKBUDDY_BRIDGE_POLL_MS  credential sweep interval (default: 30000)
  WORKBUDDY_AUTH_FILE       CN desktop auth file, when --auth-file is absent
  WORKBUDDY_AI_AUTH_FILE    AI desktop auth file, when --auth-file-ai is absent

The port and bearer token are chosen per process, exactly as the upstream
shim does. Re-read the descriptor (or \`${PROGRAM} env\`) after each restart.
`

interface ParsedArgs {
  command: 'serve' | 'models' | 'status' | 'env' | 'test' | 'help'
  /** Serve the web UI alongside the bridge. */
  ui: boolean
  /** Also listen on the WSL switch address. */
  wsl: boolean
  /** Discover and serve every account in the desktop auth directory. */
  allAccounts: boolean
  /** Failover pool mode; absent means no pool endpoint. */
  pool: 'failover' | undefined
  /** Forward reasoning deltas exactly as received. */
  noCoalesceReasoning: boolean
  providerIds: string[]
  /** Model for `test`; absent means "the endpoint's first". */
  model: string | undefined
  descriptor: boolean
  redactToken: boolean
  json: boolean
  home: string | undefined
  /** Desktop auth files for the CN product, in account order; repeatable. */
  authFileCN: string[]
  /** Desktop auth files for the AI product, in account order; repeatable. */
  authFileAI: string[]
}

/** Parse argv into the shape the commands consume. */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'serve',
    ui: false,
    wsl: false,
    allAccounts: false,
    pool: undefined,
    noCoalesceReasoning: false,
    providerIds: [],
    model: undefined,
    descriptor: true,
    redactToken: false,
    json: false,
    home: undefined,
    authFileCN: [],
    authFileAI: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    switch (arg) {
      case 'serve':
      case 'models':
      case 'status':
      case 'env':
      case 'test':
        args.command = arg
        break
      // `ui` is not a separate mode: it is `serve --ui`, expressed as a
      // command because typing it is what a user actually wants to do.
      case 'ui':
        args.command = 'serve'
        args.ui = true
        break
      case '--ui':
        args.ui = true
        break
      case '--wsl':
        args.wsl = true
        break
      case '--all-accounts':
        args.allAccounts = true
        break
      case '--pool': {
        const value = argv[index += 1]
        if (value !== 'failover') throw new Error(`--pool must be "failover", got: ${value ?? '(missing)'}`)
        args.pool = value
        break
      }
      case '--no-coalesce-reasoning':
        args.noCoalesceReasoning = true
        break
      case 'help':
      case '--help':
      case '-h':
        args.command = 'help'
        break
      case '--provider': {
        const value = argv[index += 1]
        if (value === undefined) throw new Error('--provider needs a value')
        args.providerIds.push(...value.split(',').map(part => part.trim()).filter(part => part !== ''))
        break
      }
      case '--model': {
        const value = argv[index += 1]
        if (value === undefined) throw new Error('--model needs a value')
        args.model = value
        break
      }
      // Repeatable: each occurrence adds one account, in flag order. Two of
      // the same flag therefore serve two accounts of that product at once.
      case '--auth-file': {
        const value = argv[index += 1]
        if (value === undefined) throw new Error('--auth-file needs a value')
        args.authFileCN.push(value)
        break
      }
      case '--auth-file-ai': {
        const value = argv[index += 1]
        if (value === undefined) throw new Error('--auth-file-ai needs a value')
        args.authFileAI.push(value)
        break
      }
      case '--home':
        args.home = argv[index += 1]
        break
      case '--no-descriptor':
        args.descriptor = false
        break
      case '--redact-token':
        args.redactToken = true
        break
      case '--json':
        args.json = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

/**
 * Resolve the requested providers to variant descriptors.
 *
 * `cn` and `ai` are accepted as the friendly spellings of the two provider
 * ids, so a user does not have to know that the international one is called
 * `workbuddy-ai` on the wire.
 */
function resolveVariants(providerIds: readonly string[]): readonly WorkBuddyVariant[] {
  if (providerIds.length === 0) return WORKBUDDY_VARIANTS
  const aliases: Record<string, string> = { cn: 'workbuddy', ai: 'workbuddy-ai' }
  const wanted = providerIds.flatMap(id => {
    if (id === 'both') return WORKBUDDY_VARIANTS.map(variant => variant.id)
    return [aliases[id] ?? id]
  })
  const resolved = wanted.flatMap(id => {
    const variant = variantFor(id)
    if (variant === undefined) throw new Error(`unknown provider: ${id}`)
    return [variant]
  })
  return resolved
}

/** Copy a descriptor with the bearer tokens blanked, for `--redact-token`. */
function redacted(descriptor: BridgeDescriptor): BridgeDescriptor {
  return { ...descriptor, endpoints: descriptor.endpoints.map(endpoint => ({ ...endpoint, token: '' })) }
}

/** Render the endpoints for a human reader. */
function render(descriptor: BridgeDescriptor, showTokens: boolean): string {
  const lines = [`${PROGRAM} ${WORKBUDDY_CONNECT_VERSION} — ${descriptor.endpoints.length} endpoint(s)`]
  // Continuation lines line up under the URL column: two spaces, the padded
  // display name, one space.
  const indent = ' '.repeat(17)
  for (const endpoint of descriptor.endpoints) {
    const state = endpoint.signedIn ? `${endpoint.modelCount} models` : 'signed out'
    const token = showTokens && endpoint.token !== '' ? `  token: ${endpoint.token}` : ''
    lines.push(`  ${endpoint.displayName.padEnd(14)} ${endpoint.baseUrl}  ${state}${token}`)
    // A second way to reach the *same* endpoint, so it sits under its loopback
    // URL rather than beside it. Omitting this was a real bug: `--wsl` worked
    // and the address was in the descriptor, but nothing on screen said so.
    if (endpoint.wslBaseUrl !== undefined) lines.push(`${indent}wsl: ${endpoint.wslBaseUrl}`)
    // A diagnosable reason sits under its endpoint rather than replacing the
    // line, so the URL and token stay readable while the cause is visible.
    if (endpoint.error !== undefined) lines.push(`${indent}reason: ${endpoint.error}`)
  }
  return lines.join('\n')
}

/** Print the copy-paste block an OpenAI-compatible client needs. */
function renderClientHint(descriptor: BridgeDescriptor): string {
  const endpoint = descriptor.endpoints.find(candidate => candidate.signedIn) ?? descriptor.endpoints[0]
  if (endpoint === undefined) return ''
  return [
    '',
    'Point any OpenAI-compatible client at:',
    `  base URL : ${endpoint.baseUrl}`,
    `  api key  : ${endpoint.token === '' ? '<see console output>' : endpoint.token}`,
  ].join('\n')
}

/** `serve` — start the bridge and hold the process open. */
async function serve(args: ParsedArgs): Promise<void> {
  const variants = resolveVariants(args.providerIds)
  const authFiles = new Map<string, readonly string[]>()
  if (args.authFileCN.length > 0) authFiles.set('workbuddy', args.authFileCN)
  if (args.authFileAI.length > 0) authFiles.set('workbuddy-ai', args.authFileAI)

  const logger = {
    warn: (...parts: unknown[]): void => { console.warn(...parts) },
    error: (...parts: unknown[]): void => { console.error(...parts) },
  }
  const bridge = new WorkBuddyBridge({
    variants,
    logger,
    ...args.allAccounts ? { discoverAccounts: true } : {},
    ...args.pool === undefined ? {} : { pool: args.pool },
    ...args.noCoalesceReasoning ? { coalesceReasoning: false } : {},
    ...authFiles.size === 0 ? {} : { authFiles },
  })
  const descriptor = await bridge.start()
  if (descriptor.endpoints.length === 0) {
    throw new Error('no WorkBuddy variant could start a loopback endpoint')
  }

  // The UI listens on its own ephemeral loopback port rather than sharing the
  // shim's: the shim's surface is fixed by the upstream and adding a page to it
  // would be the one thing this port promised not to do.
  let ui: WorkBuddyUiServer | undefined
  if (args.ui) {
    ui = createWorkBuddyUiServer({
      state: () => bridge.uiState(),
      probe: request => bridge.probePoolMember(request),
      logger,
    })
    await ui.ready
  }

  // WSL: re-expose each loopback service on the host side of the WSL virtual
  // switch. WSL2 in NAT mode has its own loopback, so `127.0.0.1` inside WSL is
  // not this machine's `127.0.0.1`, and an agent running there cannot reach a
  // bridge bound to loopback — the failure is a bare connection refusal.
  const wslHosts = wslHostAddresses()
  const forwarders: WslForwarder[] = []
  const wslUrls = new Map<string, string>()
  let uiWslUrl: string | undefined
  if (args.wsl && wslHosts[0] === undefined) {
    console.warn('workbuddy-bridge: --wsl was given but no WSL virtual switch was found; nothing extra to expose')
  }
  const wslHost = args.wsl ? wslHosts[0] : undefined
  if (wslHost !== undefined) {
    for (const endpoint of descriptor.endpoints) {
      const forwarder = createWslForwarder({ target: endpoint.baseUrl, host: wslHost, logger })
      await forwarder.ready
      forwarders.push(forwarder)
      wslUrls.set(endpoint.provider, `${forwarder.url()}/v1`)
    }
    if (ui !== undefined) {
      const forwarder = createWslForwarder({ target: ui.url(), host: wslHost, logger })
      await forwarder.ready
      forwarders.push(forwarder)
      uiWslUrl = forwarder.url()
    }
  }

  // Written after the forwarders exist, because the WSL addresses are only
  // known once they are bound and a reader inside WSL cannot derive them.
  const published: BridgeDescriptor = {
    ...descriptor,
    endpoints: descriptor.endpoints.map(endpoint => {
      const wsl = wslUrls.get(endpoint.provider)
      return wsl === undefined ? endpoint : { ...endpoint, wslBaseUrl: wsl }
    }),
  }
  if (args.descriptor) {
    await writeBridgeDescriptor(args.redactToken ? redacted(published) : published)
  }

  if (args.json) {
    console.log(JSON.stringify({
      ...(args.redactToken ? redacted(published) : published),
      ...ui === undefined ? {} : { uiUrl: ui.url() },
      ...uiWslUrl === undefined ? {} : { uiWslUrl },
    }, null, 2))
  } else {
    console.log(render(published, true))
    console.log(renderClientHint(published))
    if (ui !== undefined) console.log(`\nweb UI: ${ui.url()}`)
    if (uiWslUrl !== undefined) console.log(`web UI (WSL): ${uiWslUrl}`)
    if (wslUrls.size > 0) {
      console.log('\nFrom inside WSL use the wsl: address above, or run `workbuddy-bridge env` from WSL.')
    } else if (wslHosts[0] !== undefined) {
      // Discoverable rather than automatic: binding another interface is a
      // deliberate choice, but the user should not have to guess it exists.
      console.log(`\nhint: WSL switch detected at ${wslHosts[0]} — pass --wsl to also serve agents inside WSL.`)
    }
    if (args.descriptor) console.log(`descriptor: ${bridgeDescriptorPath()}`)
  }

  await new Promise<void>(resolve => {
    const shutdown = (): void => { resolve() }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  await Promise.all(forwarders.map(forwarder => forwarder.close()))
  await ui?.close()
  await bridge.close()
  if (args.descriptor) await removeBridgeDescriptor()
}

/** Compact message text for a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One entry as `/v1/models` returns it. */
interface ModelEntry {
  id: string
  object: string
  created: number
  owned_by: string
}

/** Ask one running endpoint for its model list. */
async function fetchModels(endpoint: { baseUrl: string; token: string }): Promise<ModelEntry[]> {
  const response = await fetch(`${endpoint.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${endpoint.token}` },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json() as { data?: ModelEntry[] }
  return body.data ?? []
}

/**
 * `models` — list what the running bridge serves.
 *
 * Reads the descriptor rather than starting anything, so it reports on the
 * bridge that is actually running. An endpoint with no models is not an
 * error: it means that product has no usable credential, which the upstream
 * shim deliberately renders as an empty list rather than a roster that could
 * only fail.
 */
async function models(args: ParsedArgs): Promise<void> {
  const descriptor = await readBridgeDescriptor()
  if (descriptor === undefined) {
    console.error(`no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`)
    process.exitCode = 1
    return
  }
  const collected = await Promise.all(descriptor.endpoints.map(async endpoint => {
    try {
      return { endpoint, list: await fetchModels(endpoint), error: undefined as string | undefined }
    } catch (error: unknown) {
      return { endpoint, list: [] as ModelEntry[], error: messageOf(error) }
    }
  }))

  if (args.json) {
    console.log(JSON.stringify(collected.map(entry => ({
      provider: entry.endpoint.provider,
      displayName: entry.endpoint.displayName,
      baseUrl: entry.endpoint.baseUrl,
      signedIn: entry.endpoint.signedIn,
      models: entry.list.map(model => model.id),
      // Two distinct failures, kept distinct: `credentialError` explains an
      // empty list (the descriptor's diagnosis), while `error` means the
      // endpoint could not be reached at all.
      ...entry.endpoint.error === undefined ? {} : { credentialError: entry.endpoint.error },
      ...entry.error === undefined ? {} : { error: entry.error },
    })), null, 2))
    return
  }

  for (const { endpoint, list, error } of collected) {
    console.log(`\n${endpoint.displayName}  ${endpoint.baseUrl}`)
    if (error !== undefined) {
      console.log(`  error: ${error}`)
      continue
    }
    if (list.length === 0) {
      console.log(endpoint.error === undefined
        ? '  (no models — this product has no usable credential)'
        : `  (no models — ${endpoint.error})`)
      continue
    }
    console.log(`  ${list.length} model(s):`)
    for (const model of list) console.log(`    ${model.id}`)
  }
}

/** How long one `test` chat turn may take before it is abandoned. */
const CHAT_PROBE_TIMEOUT_MS = 60_000

/** What one probe attempt produced, in the terms a user needs to read. */
interface ChatProbeResult {
  route: string
  baseUrl: string
  ok: boolean
  detail: string
}

/**
 * Send one minimal streaming chat turn to a running endpoint.
 *
 * Deliberately end-to-end: it uses the same base URL, bearer token and
 * `/chat/completions` path an agent would, so a pass is evidence the whole
 * chain works — shim gates, credential resolution, upstream acceptance — and a
 * failure carries the upstream's own words instead of a classification of them.
 *
 * The body is minimal on purpose: the shim forces streaming and prepends the
 * system prompt itself, so anything larger would test the caller rather than
 * the bridge.
 */
async function chatProbe(route: string, baseUrl: string, token: string, model: string): Promise<ChatProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, CHAT_PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 8,
      }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      return { route, baseUrl, ok: false, detail: `HTTP ${response.status}: ${text.slice(0, 400)}` }
    }
    const delta = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
    const parts = [`HTTP ${response.status}`, `${text.length} bytes`]
    if (text.includes('[DONE]')) parts.push('terminated')
    parts.push(delta === null ? 'no text delta' : `first text: ${(delta[1] ?? '').slice(0, 60)}`)
    return { route, baseUrl, ok: true, detail: parts.join(', ') }
  } catch (error: unknown) {
    return { route, baseUrl, ok: false, detail: messageOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `test` — prove whether a real chat turn works, and over which route.
 *
 * "I cannot use it" has several causes that look identical from an agent's
 * side: a dead bridge, a stale port, a missing credential, an upstream refusal,
 * or a broken WSL hop. Probing both routes separates them, and printing the
 * upstream's own text keeps the answer factual.
 */
async function test(args: ParsedArgs): Promise<void> {
  const descriptor = await readBridgeDescriptor()
  if (descriptor === undefined) {
    console.error(`no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`)
    process.exitCode = 1
    return
  }
  const wanted = args.providerIds[0]
  const endpoint = (wanted === undefined
    ? undefined
    : descriptor.endpoints.find(candidate => candidate.provider === wanted || candidate.displayName === wanted))
    ?? descriptor.endpoints.find(candidate => candidate.signedIn)
    ?? descriptor.endpoints[0]
  if (endpoint === undefined) {
    console.error('the running bridge serves no endpoints')
    process.exitCode = 1
    return
  }

  let model = args.model
  if (model === undefined) {
    try {
      model = (await fetchModels(endpoint))[0]?.id
    } catch {
      // Falls through to the "no model to test against" report below.
    }
  }
  if (model === undefined) {
    console.error(`${endpoint.displayName} serves no model to test against`
      + (endpoint.error === undefined ? ' (no usable credential)' : ` (${endpoint.error})`))
    process.exitCode = 1
    return
  }

  // Both routes when the bridge was started with --wsl: that is exactly the
  // distinction an agent inside WSL cannot make for itself.
  const routes: { route: string, baseUrl: string }[] = [{ route: 'loopback', baseUrl: endpoint.baseUrl }]
  if (endpoint.wslBaseUrl !== undefined && endpoint.wslBaseUrl !== '') {
    routes.push({ route: 'wsl', baseUrl: endpoint.wslBaseUrl })
  }

  const results: ChatProbeResult[] = []
  for (const route of routes) {
    results.push(await chatProbe(route.route, route.baseUrl, endpoint.token, model))
  }

  if (args.json) {
    console.log(JSON.stringify({ provider: endpoint.provider, model, results }, null, 2))
  } else {
    console.log(`${endpoint.displayName}  model: ${model}`)
    for (const result of results) {
      console.log(`  ${result.route.padEnd(9)} ${result.baseUrl}`)
      console.log(`  ${' '.repeat(9)} ${result.ok ? 'OK' : 'FAILED'} — ${result.detail}`)
    }
    if (routes.length === 1) {
      console.log('\n(no WSL route to test: the bridge was started without --wsl)')
    }
    // The bridge records a channel refusal itself, so a failing run can be
    // diagnosed without the operator having enabled anything in advance.
    if (results.some(result => !result.ok) && existsSync(channelFailurePath())) {
      console.log(`\nfailing exchange captured at: ${channelFailurePath()}`)
    }
  }
  if (results.some(result => !result.ok)) process.exitCode = 1
}

/** `status` — report the running bridge from its descriptor. */
async function status(args: ParsedArgs): Promise<void> {
  const descriptor = await readBridgeDescriptor()
  if (descriptor === undefined) {
    console.log(args.json ? '{}' : `no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`)
    return
  }
  const alive = isProcessAlive(descriptor.pid)
  if (args.json) {
    console.log(JSON.stringify({ ...descriptor, alive }, null, 2))
    return
  }
  console.log(render(descriptor, true))
  console.log(`\npid ${descriptor.pid} (${alive ? 'running' : 'not running'})`)
  console.log(`descriptor: ${bridgeDescriptorPath()}`)
}

/** `env` — print shell exports for the running bridge. */
async function env(): Promise<void> {
  const descriptor = await readBridgeDescriptor()
  if (descriptor === undefined) {
    console.error(`no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`)
    process.exitCode = 1
    return
  }
  const endpoint = descriptor.endpoints.find(candidate => candidate.signedIn) ?? descriptor.endpoints[0]
  if (endpoint === undefined) {
    console.error('the running bridge serves no endpoints')
    process.exitCode = 1
    return
  }
  // Inside WSL the loopback URL cannot resolve — that is the entire reason
  // `wslBaseUrl` exists — so hand out the address that actually works rather
  // than one the caller would have to rewrite by hand.
  const inWsl = isRunningInWsl()
  const baseUrl = inWsl && endpoint.wslBaseUrl !== undefined ? endpoint.wslBaseUrl : endpoint.baseUrl
  if (inWsl && endpoint.wslBaseUrl === undefined) {
    console.error(
      `warning: running inside WSL but the bridge was started without --wsl,`
      + ` so ${endpoint.baseUrl} is unreachable from here; restart it with --wsl`,
    )
  }
  console.log(`export OPENAI_BASE_URL=${baseUrl}`)
  console.log(`export OPENAI_API_KEY=${endpoint.token}`)
}

/** Whether a pid is currently alive; used only to annotate `status`. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (args.home !== undefined && args.home !== '') {
    // Set before anything resolves the bridge home, which happens lazily.
    process.env['WORKBUDDY_BRIDGE_HOME'] = args.home
  }
  switch (args.command) {
    case 'help':
      console.log(USAGE)
      return
    case 'status':
      await status(args)
      return
    case 'models':
      await models(args)
      return
    case 'test':
      await test(args)
      return
    case 'env':
      await env()
      return
    case 'serve':
      await serve(args)
      return
  }
}
