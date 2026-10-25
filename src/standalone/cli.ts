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
import { readFile } from 'node:fs/promises'
import { parseProviderConfig, type ProviderConfigEntry } from './provider-config.ts'
import { WORKBUDDY_CONNECT_VERSION } from '../core/version.ts'
import { WORKBUDDY_VARIANTS, variantFor, type WorkBuddyVariant } from '../core/variants.ts'
import { WorkBuddyBridge } from './bridge.ts'
import { probeChatTurn } from './account-probe.ts'
import {
  bridgeDescriptorPath,
  readBridgeDescriptor,
  removeBridgeDescriptor,
  writeBridgeDescriptor,
  type BridgeDescriptor,
  type BridgeEndpoint,
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
                                 shows each pool member and can test it
  ${PROGRAM} test [options]      send one real chat turn through the running
                                 bridge, over both the loopback and WSL routes
  ${PROGRAM} models [--json]     list the models the running bridge serves
  ${PROGRAM} status [--json]     show the running bridge, if any
  ${PROGRAM} env                 print shell exports for the running bridge
  ${PROGRAM} help                show this text

Options:
  --config <path>           explicit version-1 custom provider JSON (serve/ui);
                            no automatic config discovery
  --provider <id[,id...]>    cn, ai, both, built-in or custom provider IDs;
                            repeat or separate with commas; default: both
                            built-in products plus all configured providers
                            (both selects built-in products only)
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
  --no-coalesce-reasoning   forward reasoning deltas exactly as the upstream
                            sends them (by default tiny per-word deltas are
                            regrouped, so clients show paragraphs rather than
                            one thinking block per word)
  --home <dir>              override the bridge home directory
  --no-descriptor           do not write the endpoint descriptor file
  --redact-token            write the descriptor without the bearer token
  --no-stable-endpoints     choose a fresh port and token on every start
                            (default: the port and token an endpoint used last
                            time are reused, so a configured agent keeps
                            working across restarts)
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

By default each endpoint reuses the loopback port and bearer token it bound on
the previous start, so a client configured once keeps working. Both are
preferences: a port another process now holds falls back to a free one, and the
descriptor always records what actually bound. Pass --no-stable-endpoints for a
fresh pair each start. With --no-descriptor the token stays in memory only and
is never written to the identity file.
`

interface ParsedArgs {
  command: 'serve' | 'models' | 'status' | 'env' | 'test' | 'help'
  /** Serve the web UI alongside the bridge. */
  ui: boolean
  /** Also listen on the WSL switch address. */
  wsl: boolean
  /** Discover and serve every account in the desktop auth directory. */
  allAccounts: boolean
  /** Forward reasoning deltas exactly as received. */
  noCoalesceReasoning: boolean
  providerIds: string[]
  config: string | undefined
  /** Model for `test`; absent means "the endpoint's first". */
  model: string | undefined
  descriptor: boolean
  redactToken: boolean
  /** Reuse each endpoint's last port and token across restarts. */
  stableEndpoints: boolean
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
    noCoalesceReasoning: false,
    providerIds: [],
    config: undefined,
    model: undefined,
    descriptor: true,
    redactToken: false,
    stableEndpoints: true,
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
      case '--no-coalesce-reasoning':
        args.noCoalesceReasoning = true
        break
      case 'help':
      case '--help':
      case '-h':
        args.command = 'help'
        break
      case '--config': {
        const value = argv[index += 1]
        if (value === undefined || value.startsWith('-') || value.trim() === '') throw new Error('--config needs a value')
        args.config = value
        break
      }
      case '--provider': {
        const value = argv[index += 1]
        if (value === undefined || value.startsWith('-') || !value.split(',').some(part => part.trim() !== '')) throw new Error('--provider needs a value')
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
      case '--no-stable-endpoints':
        args.stableEndpoints = false
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

/** Expand aliases once, retaining selection order and removing duplicates. */
function selectedIds(providerIds: readonly string[]): string[] {
  return [...new Set(providerIds.flatMap(id => id === 'both'
    ? WORKBUDDY_VARIANTS.map(variant => variant.id)
    : [id === 'cn' ? 'workbuddy' : id === 'ai' ? 'workbuddy-ai' : id]))]
}

/** Explicit opt-in only. Do not echo JSON input or filesystem error details. */
async function loadProviders(path: string | undefined): Promise<ProviderConfigEntry[]> {
  if (path === undefined) return []
  let text: string
  try { text = await readFile(path, 'utf8') } catch { throw new Error('provider config file could not be read') }
  let input: unknown
  try { input = JSON.parse(text) } catch { throw new Error('provider config file must contain valid JSON') }
  const parsed = parseProviderConfig(input)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.config.providers
}

/** Validate every selection before any listener starts. */
function resolveProviders(providerIds: readonly string[], configured: readonly ProviderConfigEntry[]): {
  variants: readonly WorkBuddyVariant[]
  providers: readonly ProviderConfigEntry[]
} {
  if (providerIds.length === 0) return { variants: WORKBUDDY_VARIANTS, providers: configured }
  const wanted = selectedIds(providerIds)
  for (const id of wanted) {
    if (variantFor(id) === undefined && !configured.some(provider => provider.id === id)) {
      throw new Error(`unknown provider: ${id}`)
    }
  }
  return {
    variants: wanted.flatMap(id => {
      const variant = variantFor(id)
      return variant === undefined ? [] : [variant]
    }),
    providers: wanted.flatMap(id => {
      const provider = configured.find(candidate => candidate.id === id)
      return provider === undefined ? [] : [provider]
    }),
  }
}

/** Copy a descriptor with the bearer tokens blanked, for `--redact-token`. */
function redacted(descriptor: BridgeDescriptor): BridgeDescriptor {
  return { ...descriptor, endpoints: descriptor.endpoints.map(endpoint => ({ ...endpoint, token: '' })) }
}

/**
 * Stable addresses for listeners that are not published endpoints.
 *
 * The web UI and each WSL forwarder get a port of their own, and an agent
 * inside WSL is configured with the forwarder's address — so those have to
 * survive a restart for the same reason an endpoint's does. The bridge owns
 * the document; this is the narrow slice of it the reconciler needs.
 */
interface PortRegistry {
  preferredPortFor(key: string): number | undefined
  rememberPortFor(key: string, baseUrl: string): Promise<void>
}

/** The identity key of the WSL forwarder serving one published endpoint. */
function wslPortKey(provider: string): string {
  return `wsl:${provider}`
}

/** The identity key of the WSL forwarder serving the web UI. */
const UI_WSL_PORT_KEY = 'wsl-ui'

/**
 * The publish step after a managed-provider mutation: re-read the bridge's
 * endpoints, apply `--redact-token`, write the descriptor when the operator
 * has not disabled it, and reconcile the WSL forwarders.
 *
 * It never rejects. A failure here is not a rollback — the saved change is
 * already live in the bridge's runtime — so the operator is told exactly
 * that. Two channels: the console line (for the operator at the terminal) and
 * `providerWarning` in the state callback's mutable slot (so the page's next
 * poll renders the persistent banner the UI shows). The mutation's own
 * promise resolves only after this settles.
 */
const PROVIDER_WARNING_PUBLISH_FAILED
  = 'Provider change saved, but endpoint publication failed.'
const PROVIDER_WARNING_SAVE_PUBLISH_FAILED
  = 'Provider saved and active, but endpoint publication failed.'

async function publishAfterMutation(
  bridge: WorkBuddyBridge,
  runtime: {
    forwarders: Map<string, WslForwarder>
    wslUrls: Map<string, string>
    wslHost: string | undefined
    descriptor: boolean
    redactToken: boolean
    providerWarning: { value: string | undefined }
    /** Whether the mutation being published was a save (wording detail). */
    lastMutationWasSave: boolean
    logger: { warn: (...parts: unknown[]) => void; error: (...parts: unknown[]) => void }
  },
): Promise<void> {
  let failed = false
  try {
    const descriptor = await bridge.publish()
    // Reconcile reports partial failure through its boolean, not a throw: a
    // forwarder that failed to bind must not stop the descriptor write, since
    // the descriptor is still the truth for every non-WSL client.
    failed = !(await reconcileWslForwarders(bridge.endpoints(), runtime))
    const published: BridgeDescriptor = {
      ...descriptor,
      endpoints: descriptor.endpoints.map(endpoint => {
        const wsl = runtime.wslUrls.get(endpoint.baseUrl)
        return wsl === undefined ? endpoint : { ...endpoint, wslBaseUrl: wsl }
      }),
    }
    if (runtime.descriptor) {
      await writeBridgeDescriptor(runtime.redactToken ? redacted(published) : published)
    }
  } catch (error: unknown) {
    failed = true
    runtime.logger.error(
      'workbuddy-bridge: the saved provider change is active, but publication failed —'
      + ' the descriptor and WSL addresses may be stale',
      error,
    )
  }
  if (failed) {
    runtime.providerWarning.value = runtime.lastMutationWasSave === true
      ? PROVIDER_WARNING_SAVE_PUBLISH_FAILED
      : PROVIDER_WARNING_PUBLISH_FAILED
  } else {
    // Publication fully succeeded; any earlier warning is stale.
    runtime.providerWarning.value = undefined
  }
}

/**
 * Reconcile the WSL forwarders with the bridge's current endpoints.
 *
 * A forwarder is bound once per endpoint base URL and never rebound while its
 * endpoint survives: editing a managed provider (a model-list change, a new
 * upstream key) must not re-expose the same endpoint on a new port, because
 * every restart-like churn makes clients re-copy their settings for nothing.
 * Only genuinely new base URLs get a forwarder and only genuinely gone ones
 * are closed — the registry is keyed by the loopback base URL itself, so the
 * handle closed is exactly the one bound to that URL (ports cannot be matched
 * by target, since the forwarder's *public* port has nothing to do with the
 * target's). The registry holds **endpoint** forwarders only; the UI's own WSL
 * forwarder lives outside it, so reconciling can never close the page's own
 * access route.
 *
 * Resolves to `true` when every wanted endpoint ended up bound, `false` when
 * any bind failed (the failure is also logged and flagged for the page) — a
 * partial failure is not a throw, because the descriptor write that follows
 * should still happen for the non-WSL world.
 */
async function reconcileWslForwarders(
  endpoints: readonly BridgeEndpoint[],
  runtime: {
    forwarders: Map<string, WslForwarder>
    wslUrls: Map<string, string>
    wslHost: string | undefined
    providerWarning: { value: string | undefined }
    logger: { warn: (...parts: unknown[]) => void; error: (...parts: unknown[]) => void }
    /** Stable ports for the forwarders this reconcile binds. */
    ports?: PortRegistry | undefined
  },
): Promise<boolean> {
  if (runtime.wslHost === undefined) return true
  const byBaseUrl = new Map(endpoints.map(endpoint => [endpoint.baseUrl, endpoint]))
  const wanted = new Set(byBaseUrl.keys())
  const closed: Promise<void>[] = []
  for (const [baseUrl, forwarder] of [...runtime.forwarders]) {
    if (wanted.has(baseUrl)) continue
    runtime.forwarders.delete(baseUrl)
    runtime.wslUrls.delete(baseUrl)
    closed.push(forwarder.close().catch(error => {
      runtime.logger.error(`workbuddy-bridge: could not close the WSL forwarder for ${baseUrl}`, error)
    }))
  }
  await Promise.all(closed)
  const bindings: Promise<boolean>[] = []
  for (const [baseUrl, endpoint] of byBaseUrl) {
    if (runtime.forwarders.has(baseUrl)) continue
    const key = wslPortKey(endpoint.provider)
    const preferred = runtime.ports?.preferredPortFor(key)
    const forwarder = createWslForwarder({
      target: baseUrl,
      host: runtime.wslHost,
      logger: runtime.logger,
      ...preferred === undefined ? {} : { port: preferred },
    })
    runtime.forwarders.set(baseUrl, forwarder)
    bindings.push(forwarder.ready
      .then(() => {
        runtime.wslUrls.set(baseUrl, `${forwarder.url()}/v1`)
        // Remember what actually bound, not what was asked for: the forwarder
        // falls back to an ephemeral port when the remembered one is taken.
        void runtime.ports?.rememberPortFor(key, forwarder.url())
        return true
      })
      .catch(error => {
        // The bind failed: drop the handle so a later reconcile can retry, and
        // surface the failure as the page's publication warning.
        runtime.forwarders.delete(baseUrl)
        runtime.wslUrls.delete(baseUrl)
        runtime.providerWarning.value = PROVIDER_WARNING_PUBLISH_FAILED
        runtime.logger.error(`workbuddy-bridge: could not expose ${baseUrl} on the WSL switch`, error)
        return false
      }))
  }
  return (await Promise.all(bindings)).every(Boolean)
}

/** Render the endpoints for a human reader. */
function render(descriptor: BridgeDescriptor, showTokens: boolean): string {
  const lines = [`${PROGRAM} ${WORKBUDDY_CONNECT_VERSION} — ${descriptor.endpoints.length} endpoint(s)`]
  // Continuation lines line up under the URL column: two spaces, the padded
  // display name, one space.
  const indent = ' '.repeat(17)
  for (const endpoint of descriptor.endpoints) {
    const customPool = endpoint.provider === 'custom-pool'
    const state = endpoint.signedIn
      ? `configured · ${endpoint.modelCount} models (failover pool)`
      : customPool
        ? 'unavailable · no usable provider key'
        : 'unavailable · no signed-in account'
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
  // Every endpoint is a failover pool now, so the first usable one is the one
  // to hand an agent.
  const endpoint = descriptor.endpoints.find(candidate => candidate.signedIn)
    ?? descriptor.endpoints[0]
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
  const configured = await loadProviders(args.config)
  const { variants, providers } = resolveProviders(args.providerIds, configured)
  const authFiles = new Map<string, readonly string[]>()
  if (args.authFileCN.length > 0) authFiles.set('workbuddy', args.authFileCN)
  if (args.authFileAI.length > 0) authFiles.set('workbuddy-ai', args.authFileAI)

  const logger = {
    warn: (...parts: unknown[]): void => { console.warn(...parts) },
    error: (...parts: unknown[]): void => { console.error(...parts) },
  }
  const bridge = new WorkBuddyBridge({
    variants,
    ...providers.length === 0 ? {} : { providers },
    logger,
    ...args.allAccounts ? { discoverAccounts: true } : {},
    ...args.noCoalesceReasoning ? { coalesceReasoning: false } : {},
    ...authFiles.size === 0 ? {} : { authFiles },
    // Managed providers are always on for the UI: the store loads the saved
    // home config automatically at start, so `ui` alone is enough to bring a
    // previously added provider back. `serve` gets it too so the plain
    // command and the UI agree on what is being served. External `--config`
    // providers stay read-only as served; a saved provider with the same id
    // is an explicit collision error, not a silent overwrite.
    manageProviders: true,
    // Stable addresses by default: a client configured once keeps working
    // across restarts. `--no-descriptor` keeps its promise of an
    // in-memory-only secret, so only the ports are reused in that mode.
    persistEndpointIdentity: args.stableEndpoints,
    reuseEndpointTokens: args.stableEndpoints && args.descriptor,
  })
  const wslUrls = new Map<string, string>()
  const forwarders = new Map<string, WslForwarder>()
  let ui: WorkBuddyUiServer | undefined
  let uiWslUrl: string | undefined
  let uiWslForwarder: WslForwarder | undefined
  // Shared mutation state: the management callbacks reconcile against the same
  // forwarder registry the startup path built. `wslHost` is filled in below,
  // after the switch address is resolved. `providerWarning` is the page's
  // persistent banner slot: set on a publication failure, cleared once a later
  // publication succeeds.
  const providerWarning = { value: undefined as string | undefined }
  const runtime = {
    forwarders,
    wslUrls,
    wslHost: undefined as string | undefined,
    /** Filled in once the bridge exists, so forwarders can ask for old ports. */
    ports: undefined as PortRegistry | undefined,
    descriptor: args.descriptor,
    redactToken: args.redactToken,
    providerWarning,
    lastMutationWasSave: true,
    logger,
  }
  try {
    const descriptor = await bridge.start()
    // The UI can add the first managed provider at runtime, so an empty
    // endpoint list is only fatal when nothing can ever fill it: `serve` with
    // nothing configured must still refuse (its shape has always been
    // "start what was asked and publish it"), while `ui` stays up and lets
    // the page create a provider.
    if (descriptor.endpoints.length === 0 && !args.ui) {
      throw new Error('no provider could start a loopback endpoint')
    }

    // The UI listens on its own ephemeral loopback port rather than sharing the
    // shim's: the shim's surface is fixed by the upstream and adding a page to it
    // would be the one thing this port promised not to do.
    //
    // The wslUrls map is declared here — before the forwarders that fill it —
    // because the state closure reads it at request time, so the URLs appear on
    // the page the moment they are bound.
    if (args.ui) {
      const preferredUiPort = bridge.preferredUiPort()
      ui = createWorkBuddyUiServer({
        state: async () => {
          const state = await bridge.uiState()
          return {
            ...state,
            // A publication failure after a managed-provider mutation is not
            // a rollback — the change is live — so the page carries a
            // persistent banner until a later publication succeeds.
            ...providerWarning.value === undefined ? {} : { providerWarning: providerWarning.value },
            endpoints: state.endpoints.map(endpoint => {
              const wsl = wslUrls.get(endpoint.baseUrl)
              return wsl === undefined ? endpoint : { ...endpoint, wslBaseUrl: wsl }
            }),
          }
        },
        probe: request => bridge.probePoolMember(request),
        // Add / edit / remove managed providers straight from the page. The
        // bridge's `manageProviders` store owns validation and persistence;
        // after a successful mutation the runtime publishes the descriptor
        // (honoring --no-descriptor / --redact-token) and reconciles the WSL
        // forwarders, so no restart is needed. The snapshot's committed
        // semantics are unchanged; the publish step only records whether it
        // succeeded, for the banner.
        providers: {
          list: () => bridge.listManagedProviders(),
          save: input => bridge.saveManagedProvider(input).then(snapshot => {
            runtime.lastMutationWasSave = true
            return publishAfterMutation(bridge, runtime).then(() => snapshot)
          }),
          remove: input => bridge.removeManagedProvider(input).then(snapshot => {
            runtime.lastMutationWasSave = false
            return publishAfterMutation(bridge, runtime).then(() => snapshot)
          }),
        },
        // Exact origins the page is additionally served from — the WSL
        // forwarder's URL, known only after the forwarders bind. Evaluated
        // per request so a late-bound port is seen. Host-controlled only:
        // the request's own Host or Origin can never add itself here.
        allowedUiOrigins: () => [ui?.url(), uiWslUrl].filter((value): value is string => value !== undefined),
        ...preferredUiPort === undefined ? {} : { port: preferredUiPort },
        logger,
      })
      await ui.ready
      await bridge.rememberUiPort(ui.url())
    }

    // WSL: re-expose each loopback service on the host side of the WSL virtual
    // switch. WSL2 in NAT mode has its own loopback, so `127.0.0.1` inside WSL is
    // not this machine's `127.0.0.1`, and an agent running there cannot reach a
    // bridge bound to loopback — the failure is a bare connection refusal.
    const wslHosts = wslHostAddresses()
    if (args.wsl && wslHosts[0] === undefined) {
      console.warn('workbuddy-bridge: --wsl was given but no WSL virtual switch was found; nothing extra to expose')
    }
    const wslHost = args.wsl ? wslHosts[0] : undefined
    runtime.wslHost = wslHost
    if (wslHost !== undefined) {
      // Through the reconciler, not a private loop: startup and every later
      // provider mutation then bind forwarders the same way, with the same
      // remembered ports, instead of two code paths that can drift.
      runtime.ports = bridge
      await reconcileWslForwarders(descriptor.endpoints, runtime)
      if (ui !== undefined) {
        // Held outside the forwarder registry: the reconcile only ever closes
        // endpoint forwarders, so the page's own access route from WSL cannot
        // be severed by a provider save/remove. It lives and dies with the
        // process, like the UI itself.
        const preferred = bridge.preferredPortFor(UI_WSL_PORT_KEY)
        const forwarder = createWslForwarder({
          target: ui.url(),
          host: wslHost,
          logger,
          ...preferred === undefined ? {} : { port: preferred },
        })
        await forwarder.ready
        uiWslForwarder = forwarder
        uiWslUrl = forwarder.url()
        await bridge.rememberPortFor(UI_WSL_PORT_KEY, uiWslUrl)
      }
    }

    // Written after the forwarders exist, because the WSL addresses are only
    // known once they are bound and a reader inside WSL cannot derive them.
    const published: BridgeDescriptor = {
      ...descriptor,
      endpoints: descriptor.endpoints.map(endpoint => {
        const wsl = wslUrls.get(endpoint.baseUrl)
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
      const shutdown = (): void => {
        process.removeListener('SIGINT', shutdown)
        process.removeListener('SIGTERM', shutdown)
        resolve()
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
  } finally {
    await Promise.all([
      ...[...forwarders.values()].map(forwarder => forwarder.close()),
      ...uiWslForwarder === undefined ? [] : [uiWslForwarder.close()],
    ])
    await ui?.close()
    await bridge.close()
    if (args.descriptor) await removeBridgeDescriptor()
  }
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
 * The request itself lives in `account-probe.ts`, shared with the web UI's
 * per-account test button: the two ask the same question of the same endpoint,
 * and two copies of the SSE parse would eventually disagree about what a pass
 * looks like.
 */
async function chatProbe(route: string, baseUrl: string, token: string, model: string): Promise<ChatProbeResult> {
  const result = await probeChatTurn({ baseUrl, token, model, timeoutMs: CHAT_PROBE_TIMEOUT_MS })
  return { route, baseUrl, ok: result.ok, detail: result.detail }
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
  const selected = new Set(args.providerIds.flatMap(selection => {
    const byId = descriptor.endpoints.filter(candidate => candidate.provider === selection)
    if (byId.length > 0) return byId
    const byName = descriptor.endpoints.filter(candidate => candidate.displayName === selection)
    if (byName.length > 0) return byName
    return selectedIds([selection]).flatMap(id => {
      // Built-in aliases select the product's pool endpoint — the only one
      // the product serves.
      const byAlias = descriptor.endpoints.filter(candidate => candidate.provider === id || candidate.provider === `${id}-pool`)
      if (byAlias.length === 0) throw new Error(`unknown provider: ${selection}`)
      return byAlias
    })
  }))
  const eligible = args.providerIds.length === 0 ? descriptor.endpoints : descriptor.endpoints.filter(candidate => selected.has(candidate))
  const endpoint = eligible.find(candidate => candidate.signedIn) ?? eligible[0]
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
    if (variantFor(endpoint.provider.replace(/-pool$/u, '')) !== undefined && results.some(result => !result.ok) && existsSync(channelFailurePath())) {
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
