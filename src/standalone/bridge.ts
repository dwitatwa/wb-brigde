/**
 * The standalone bridge: the agent-agnostic frontend.
 *
 * This is the same wiring the DeepSeek Harness plugin performs in its
 * `startVariant` / `syncVariant` / `fetchCatalog` triple, with the DSH seam
 * removed. Each WorkBuddy product variant gets its own credential store,
 * upstream client, catalog, and loopback shim; a sweep reconciles each variant
 * with its credentials and keeps the catalog fresh.
 *
 * What it deliberately does NOT do is register a provider with any agent. That
 * was the only DSH-specific job, and it is exactly what an external agent does
 * for itself by pointing at the published base URL. The shim is unchanged.
 *
 * @module workbuddy-bridge/standalone/bridge
 */

import { WorkBuddyCredentialStore, discoverDesktopAuthFiles, type WorkBuddyCredential } from '../core/auth.ts'
import {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from '../core/catalog.ts'
import { WorkBuddyCatalogStore, workbuddyCatalogPath } from '../core/catalog-store.ts'
import { resolveBridgeHome } from '../core/bridge-home.ts'
import { atRestKeyProviderFor } from '../core/desktop-credential-protection.ts'
import { createWorkBuddyShim, type ShimLogger, type WorkBuddyShim } from '../core/shim.ts'
import { WorkBuddyUpstreamClient, normalizeCredits, type WorkBuddyChatResult, type WorkBuddyCredits } from '../core/upstream.ts'
import { CN_VARIANT, WORKBUDDY_VARIANTS, type WorkBuddyVariant } from '../core/variants.ts'
import { writeBridgeDescriptor, type BridgeDescriptor, type BridgeEndpoint } from './descriptor.ts'
import { captureChannelFailure } from './failure-capture.ts'
import { coalesceReasoning } from './coalesce.ts'
import { probeChatTurn, type ChatProbeOptions, type ChatProbeResult } from './account-probe.ts'
import { WorkBuddyFailoverPool, type WorkBuddyPoolAttempt, type WorkBuddyPoolMemberHealth } from './pool.ts'
import {
  attemptRecord,
  modelOfBody,
  WorkBuddyRequestLog,
  type WorkBuddyRequestAttempt,
  type WorkBuddyRequestRecord,
} from './request-log.ts'
import { join } from 'node:path'
import {
  UiRequestError,
  type UiCredits,
  type UiEndpoint,
  type UiModel,
  type UiPoolMember,
  type UiProbeRequest,
  type UiProbeResult,
  type UiRequestRow,
  type UiState,
} from './ui.ts'

/**
 * How often the credential files are re-checked, in milliseconds.
 *
 * Same value and same rationale as the plugin's `CREDENTIAL_POLL_MS`: a
 * startup-only catalog fetch cannot notice a sign-in that happens while the
 * bridge is already running, so the model list would not appear until a
 * restart. The read is a cheap existence/parse check of a few local files — no
 * network, no probe.
 *
 * `WORKBUDDY_BRIDGE_POLL_MS` overrides it, clamped so a mistaken value cannot
 * turn the sweep into a busy loop.
 */
const CREDENTIAL_POLL_MS = 30_000
const MIN_POLL_MS = 100
const MAX_POLL_MS = 24 * 60 * 60 * 1000

/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs(): number {
  const override = Number(process.env['WORKBUDDY_BRIDGE_POLL_MS'])
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * How many sweeps to wait before retrying a catalog fetch that failed.
 *
 * Same reasoning as the plugin's `CATALOG_RETRY_SWEEPS`: a transient network
 * blip at startup must not leave the bridge on the built-in roster until
 * somebody notices, but a persistent outage must not become a request loop.
 */
const CATALOG_RETRY_SWEEPS = 10

/** Stable identity key used by credentials and saved catalogs. */
function credentialIdentity(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string {
  return `${credential.uid}:${credential.enterpriseId ?? ''}`
}

/** The static roster a variant serves before its first successful fetch. */
function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS
}

/** One variant's live runtime. */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: WorkBuddyCredentialStore
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  savedCatalogs: WorkBuddyCatalogStore
  shim: WorkBuddyShim
  /** The account identity currently adopted, or undefined when signed out. */
  identity: string | undefined
  /** Where the served models came from, in degradation order. */
  source: 'live' | 'saved' | 'fallback'
  /** Why the last catalog attempt failed, when it did. */
  error: string | undefined
  /** When the last catalog attempt started, for the retry backoff. */
  lastFetchAtMs: number
  /** The in-flight fetch, scoped to the identity it began under. */
  inflight: { identity: string; promise: Promise<void> } | undefined
  /** 1-based position among this variant's runtimes; always 1 when single. */
  accountIndex: number
  /** How many runtimes this variant is serving; endpoints are labelled when > 1. */
  accountTotal: number
  /** The current credential's nickname, maintained by the sweep for labelling. */
  nickname: string | undefined
  /** The current credential's uid (email or user id), maintained by the sweep. */
  uid: string | undefined
}

/** Options for {@link WorkBuddyBridge}. */
export interface BridgeOptions {
  /** Variants to serve; defaults to both products. */
  variants?: readonly WorkBuddyVariant[]
  /** Where the shim logs upstream stream failures. */
  logger?: ShimLogger
  /**
   * Explicit desktop auth-file paths per variant id, in account order.
   *
   * One path serves that account exactly as the desktop default would.
   * Several paths serve several accounts of the same product at once — each
   * becomes its own runtime with its own store, shim, port, and endpoint,
   * labelled by the account's nickname once the sweep has seen a credential.
   * Absent (or empty) means the variant's usual desktop discovery.
   */
  authFiles?: ReadonlyMap<string, readonly string[]>
  /**
   * Serve every account the desktop auth directory holds, per variant.
   *
   * The app's atomic writes leave one snapshot per sign-in behind, so a
   * machine that has used several accounts already has a file for each.
   * Discovery collects them, keeps the newest per account uid, and starts one
   * endpoint per account — no flags to repeat. Explicit `authFiles` for a
   * variant win over discovery for that variant, so a hand-picked list is
   * never silently widened.
   */
  discoverAccounts?: boolean
  /**
   * Expose one extra pool endpoint per product that serves its accounts with
   * failover: a request whose failure another account could survive (out of
   * credits, rate-limited, dead session, upstream 5xx) is retried on the
   * next account, so one account's quota is no longer a single point of
   * failure. Only created for products serving two or more accounts — a
   * one-member pool would just duplicate the account's own endpoint.
   */
  pool?: 'failover'
  /**
   * Regroup the upstream's tiny reasoning deltas into larger chunks before
   * they reach the client. Default on: the upstream sends reasoning a word or
   * two at a time, and a client that starts a new thinking block per closed
   * reasoning block renders one block per word. Set false to forward the
   * stream exactly as received.
   */
  coalesceReasoning?: boolean
  /**
   * Send one probe turn. Defaults to the real loopback chat probe.
   *
   * Injectable so a test can answer without an upstream, and so an embedder
   * can substitute a cheaper check.
   */
  probe?: (options: ChatProbeOptions) => Promise<ChatProbeResult>
}

/** Compact message text for a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error)
}

/**
 * Render one pool attempt for a human, in the two fields the row needs.
 *
 * The attempt's `kind` is kept rather than folded into prose because it is the
 * distinction the pool itself acts on: `hard_credit` means that account is
 * done for the cycle, while `client` means the request was wrong and every
 * account would refuse it.
 */
function attemptText(outcome: WorkBuddyPoolAttempt['outcome'] | undefined): Pick<
  UiPoolMember,
  'lastOutcome' | 'lastOutcomeDetail'
> {
  if (outcome === undefined) return {}
  switch (outcome.state) {
    case 'ok':
      return { lastOutcome: 'ok' }
    case 'credential-error':
      return { lastOutcome: 'credential-error', lastOutcomeDetail: outcome.message }
    case 'upstream-error':
      return {
        lastOutcome: 'upstream-error',
        lastOutcomeDetail: `HTTP ${outcome.status} · ${outcome.kind} · ${outcome.message}`,
      }
  }
}

/**
 * Flatten one catalog row into the display shape.
 *
 * Mirrors the mapping the upstream status route performs, so the standalone UI
 * and the plugin card agree on what a rate, a badge, and a context window
 * mean — including the two cases that are easy to get wrong: a rate that must
 * be withheld (`rateUnknown`) rather than shown stale, and a maximum window
 * that only appears when it actually exceeds the default.
 */
function uiModelOf(model: WorkBuddyModelInfo): UiModel {
  const rate = normalizeCredits(model.billing?.credits)
  const supported = model.supportedContextWindows ?? []
  const maxContextWindow = supported.length > 0 ? Math.max(...supported) : undefined
  const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow
  const reasoning = model.reasoning
  return {
    id: model.id,
    name: model.name,
    supportsImages: model.supportsImages === true,
    ...rate === undefined ? {} : { credits: rate },
    ...model.billing?.free === true ? { free: true as const } : {},
    ...model.billing?.badges !== undefined && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
    ...model.billing?.rateUnknown === true ? { rateUnknown: true as const } : {},
    ...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
    ...defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
    ...maxContextWindow === undefined || maxContextWindow <= defaultContextWindow ? {} : { maxContextWindow },
    ...model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {},
    ...reasoning === undefined || reasoning.supports !== true ? {} : {
      reasoning: {
        supports: true,
        ...reasoning.supportedEfforts === undefined ? {} : { efforts: reasoning.supportedEfforts },
        ...reasoning.canDisableThinking === undefined ? {} : { canDisableThinking: reasoning.canDisableThinking },
      },
    },
  }
}

/** Copy the credit fields the UI renders, leaving the rest behind. */
function uiCreditsOf(credits: WorkBuddyCredits): UiCredits {
  return {
    total: credits.total,
    accounts: credits.accounts.map(account => ({
      packageName: account.packageName,
      remain: account.remain,
      size: account.size,
      ...account.unlimited === undefined ? {} : { unlimited: account.unlimited },
      ...account.endTimeMs === undefined ? {} : { endTimeMs: account.endTimeMs },
    })),
    ...credits.unlimited === undefined ? {} : { unlimited: credits.unlimited },
    ...credits.cycleResetTime === undefined ? {} : { cycleResetTime: credits.cycleResetTime },
  }
}

/**
 * One variant's endpoint display name, including its account when the variant
 * serves several. A single-account runtime keeps the bare product name, so
 * nothing changes for the common case; with multiple accounts each endpoint
 * must say whose credentials it speaks for, preferring the account's own
 * nickname and falling back to its position while the sweep has not yet seen
 * a credential.
 */
function endpointDisplayName(runtime: VariantRuntime): string {
  if (runtime.accountTotal <= 1) return runtime.variant.displayName
  const who = runtime.nickname ?? runtime.uid ?? `account ${runtime.accountIndex}`
  return `${runtime.variant.displayName} · ${who}`
}

/** One pool endpoint's live runtime: a router over several account runtimes. */
interface PoolRuntime {
  variant: WorkBuddyVariant
  members: VariantRuntime[]
  pool: WorkBuddyFailoverPool
  catalog: WorkBuddyCatalog
  shim: WorkBuddyShim
}

/**
 * Both variants' loopback endpoints, running for the life of the process.
 *
 * Start order is load-bearing: every variant's shim must hold a port before
 * the bridge publishes anything, because the published base URL *is* the
 * shim's origin and it is only known once the listener is up.
 */
export class WorkBuddyBridge {
  private readonly runtimes: VariantRuntime[] = []
  private readonly pools: PoolRuntime[] = []
  private readonly options: BridgeOptions
  /** Probe keys (`provider#index`) currently in flight, so a double click cannot double-spend. */
  private readonly probes = new Set<string>()
  /** The turns agents have sent, for the UI. Metadata only, in memory, bounded. */
  private readonly requests = new WorkBuddyRequestLog()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private startedAtMs = 0

  constructor(options: BridgeOptions = {}) {
    this.options = options
  }

  /**
   * The last step before a chat result reaches the shim: regroup reasoning
   * deltas unless the operator turned that off. Failures pass through
   * untouched, so error handling is unaffected.
   */
  private finishChat(result: WorkBuddyChatResult): WorkBuddyChatResult {
    if (this.options.coalesceReasoning === false) return result
    return coalesceReasoning(result)
  }

  /**
   * Record one turn against the endpoint the agent addressed.
   *
   * Metadata only: the body is parsed for its model name and then dropped, so
   * the log never holds a prompt. Called on the request path, therefore free
   * of I/O — and it cannot fail a turn, because the log is worth less than the
   * request it describes.
   */
  private noteTurn(input: {
    endpoint: string
    account?: string
    bodyJson: string
    result: WorkBuddyChatResult
    latencyMs: number
    attempts?: readonly WorkBuddyRequestAttempt[]
  }): void {
    this.requests.record({
      endpoint: input.endpoint,
      ...input.account === undefined ? {} : { account: input.account },
      model: modelOfBody(input.bodyJson),
      status: input.result.ok ? 200 : input.result.status,
      outcome: input.result.ok ? 'ok' : input.result.kind,
      latencyMs: input.latencyMs,
      ...input.attempts === undefined || input.attempts.length === 0 ? {} : { attempts: input.attempts },
    })
  }

  /**
   * Bring up every variant's endpoint and publish the descriptor.
   *
   * A variant that fails to start is skipped rather than fatal — the same
   * containment the plugin applies, so a machine with only one of the two apps
   * installed still serves that one.
   */
  async start(): Promise<BridgeDescriptor> {
    this.startedAtMs = Date.now()
    const variants = this.options.variants ?? WORKBUDDY_VARIANTS
    for (const variant of variants) {
      // One runtime per account. No explicit paths and no discovery means the
      // variant's usual single-account desktop read, exactly as before;
      // several paths — listed or discovered — means several simultaneous
      // accounts, each with its own credential store and shim. The catalog
      // store is deliberately shared across a variant's accounts: its entries
      // are keyed by account identity, so one file (and one in-memory map)
      // holds every account's saved roster without them clobbering each
      // other on write.
      const explicit = this.options.authFiles?.get(variant.id) ?? []
      const discovered = explicit.length > 0
        ? explicit
        : this.options.discoverAccounts === true
          ? discoverDesktopAuthFiles(variant).map(account => account.path)
          : []
      // No paths means the variant's ordinary single-account mode: one runtime
      // that reads whatever the desktop app has signed in. `[undefined]` is
      // that one entry — an empty array would start nothing at all, which is
      // how the default (no flags) invocation once regressed to "no variant
      // could start an endpoint".
      const paths: ReadonlyArray<string | undefined> = discovered.length > 0 ? discovered : [undefined]
      const savedCatalogs = new WorkBuddyCatalogStore(workbuddyCatalogPath(variant.catalogFilename))
      const total = paths.length
      for (const [index, path] of paths.entries()) {
        const runtime = await this.startVariant(variant, {
          // The plugin-owned credential copy is keyed by variant, so two
          // accounts of one product must not share it: each store would
          // overwrite the other's refreshed tokens. The first account keeps
          // the historical default so an existing copy is not orphaned.
          ...(index === 0 ? {} : { ownPath: join(resolveBridgeHome(), `.workbuddy-auth-${index + 1}.json`) }),
          ...path === undefined ? {} : { desktopPath: path },
          accountIndex: index + 1,
          accountTotal: total,
          savedCatalogs,
        })
        if (runtime !== undefined) this.runtimes.push(runtime)
      }
    }
    if (this.options.pool === 'failover') await this.startPools(variants)
    // Reconcile once up front so the published descriptor carries real model
    // counts, then keep sweeping.
    await this.syncAll()
    const descriptor = await this.publish()
    this.timer = setInterval(() => { void this.syncAll().then(() => this.publish()) }, credentialPollMs())
    this.timer.unref?.()
    return descriptor
  }

  /**
   * One pool endpoint per product that serves two or more accounts.
   *
   * The pool rides on the same shim the accounts use — same gates, same
   * per-process secret — but its store and client are the failover router,
   * so the shim never learns the difference. Only products with several
   * accounts get one: a single-member pool would just duplicate that
   * account's own endpoint with a second port to configure.
   */
  private async startPools(variants: readonly WorkBuddyVariant[]): Promise<void> {
    const logger = this.options.logger
    for (const variant of variants) {
      const members = this.runtimes.filter(runtime => runtime.variant.id === variant.id)
      if (members.length < 2) continue
      const catalog = new WorkBuddyCatalog(fallbackFor(variant))
      if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(true)
      catalog.setVisible(false)
      const pool = new WorkBuddyFailoverPool(members.map(runtime => ({
        // Capture wraps each member's chat turn exactly as the account's own
        // shim does, so a pool-served refusal is diagnosable the same way.
        store: runtime.store,
        client: {
          // Arrow, not a method: `this` must stay the bridge so the reasoning
          // transform sees the current option.
          chatStream: async (credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal) => {
            const result = await runtime.client.chatStream(credential, bodyJson, signal)
            void captureChannelFailure(variant.id, bodyJson, result)
            return this.finishChat(result)
          },
        },
      })))
      // The shim's option types name the concrete store class, but it only
      // ever calls `store.resolve()`; the pool implements that contract.
      //
      // Its client is a wrapper rather than the router itself for one reason:
      // the router already reports every member it tried through `onAttempt`,
      // and a pool's log entry is only useful with that chain attached.
      const shim = createWorkBuddyShim({
        store: pool as unknown as WorkBuddyCredentialStore,
        client: {
          chatStream: async (credential, bodyJson, signal) => {
            const startedAtMs = Date.now()
            const attempts: WorkBuddyRequestAttempt[] = []
            const result = await pool.chatStream(credential, bodyJson, signal, attempt => {
              attempts.push(attemptRecord(attempt, index => {
                const member = members[index]
                return member?.nickname ?? `account ${member?.accountIndex ?? index + 1}`
              }))
            })
            this.noteTurn({
              endpoint: `${variant.id}-pool`,
              bodyJson,
              result,
              latencyMs: Date.now() - startedAtMs,
              attempts,
            })
            return result
          },
        },
        catalog,
        ...logger === undefined ? {} : { logger },
      })
      try {
        await shim.ready
      } catch (error: unknown) {
        logger?.error(`workbuddy-bridge: ${variant.displayName} pool endpoint failed to start`, error)
        continue
      }
      this.pools.push({ variant, members, pool, catalog, shim })
    }
  }

  /** The descriptor as of the last publish. */
  async publish(): Promise<BridgeDescriptor> {
    const descriptor: BridgeDescriptor = {
      version: 1,
      pid: process.pid,
      startedAtMs: this.startedAtMs,
      endpoints: [
        ...this.runtimes.map(runtime => this.endpointOf(runtime)),
        ...this.pools.map(pool => this.poolEndpointOf(pool)),
      ],
    }
    return descriptor
  }

  /** Write the descriptor to disk and return it. */
  async publishToDisk(): Promise<BridgeDescriptor> {
    const descriptor = await this.publish()
    await writeBridgeDescriptor(descriptor)
    return descriptor
  }

  /** Current endpoints, without touching disk. */
  endpoints(): BridgeEndpoint[] {
    return [
      ...this.runtimes.map(runtime => this.endpointOf(runtime)),
      ...this.pools.map(pool => this.poolEndpointOf(pool)),
    ]
  }

  /**
   * Build the web UI's state document. Carries the bearer token so the user
   * can copy it from the pool card. The page itself is still unauthenticated —
   * it relies on the Host/Origin loopback gate — but the token is now part of
   * the rendered state.
   */
  async uiState(): Promise<UiState> {
    const endpoints: UiEndpoint[] = []
    // One row per account, computed once: the pool card reuses those rows for
    // each member's credits, so a page load still costs one billing call per
    // account rather than one per account plus one per pool membership.
    const rows = new Map<VariantRuntime, UiEndpoint>()
    for (const runtime of this.runtimes) {
      const row = await this.uiEndpointOf(runtime)
      rows.set(runtime, row)
      endpoints.push(row)
    }
    for (const pool of this.pools) endpoints.push(this.uiPoolOf(pool, rows))
    return { version: 1, startedAtMs: this.startedAtMs, nowMs: Date.now(), endpoints }
  }

  /**
   * The pool's UI row: its membership, who answers next, and what the router
   * has seen of each member's real traffic.
   *
   * No credit figure of its own: credits belong to accounts, and each member
   * row shows its own — a pool balance would have to pick one member's number
   * and present it as the pool's, which is a lie. What the pool row adds is
   * the thing no account card can show: the routing state.
   */
  private uiPoolOf(pool: PoolRuntime, rows: ReadonlyMap<VariantRuntime, UiEndpoint>): UiEndpoint {
    const health = pool.pool.memberHealth()
    const headIndex = pool.pool.headIndex()
    return {
      provider: `${pool.variant.id}-pool`,
      displayName: `${pool.variant.displayName} · pool (failover)`,
      baseUrl: `${pool.shim.baseUrl()}/v1`,
      token: pool.shim.token(),
      signedIn: pool.members.some(runtime => runtime.identity !== undefined),
      models: pool.catalog.current().map(uiModelOf),
      requests: this.uiRequestsOf(`${pool.variant.id}-pool`),
      pool: {
        headIndex,
        members: pool.members.map((runtime, index) => this.uiPoolMemberOf(runtime, index, headIndex, health[index], rows.get(runtime))),
      },
      ...pool.members.every(runtime => runtime.identity === undefined)
        ? { error: 'no account in the pool is signed in' }
        : {},
    }
  }

  /** One pool member row, assembled from the runtime, its health, and its account card. */
  private uiPoolMemberOf(
    runtime: VariantRuntime,
    index: number,
    headIndex: number,
    health: WorkBuddyPoolMemberHealth | undefined,
    row: UiEndpoint | undefined,
  ): UiPoolMember {
    return {
      index,
      accountIndex: runtime.accountIndex,
      label: runtime.nickname ?? runtime.uid ?? `account ${runtime.accountIndex}`,
      ...runtime.uid === undefined ? {} : { uid: runtime.uid },
      signedIn: runtime.identity !== undefined,
      baseUrl: `${runtime.shim.baseUrl()}/v1`,
      head: index === headIndex,
      successes: health?.successes ?? 0,
      failures: health?.failures ?? 0,
      consecutiveFailures: health?.consecutiveFailures ?? 0,
      ...health === undefined || health.lastAttemptAtMs <= 0 ? {} : { lastAttemptAtMs: health.lastAttemptAtMs },
      ...attemptText(health?.lastOutcome),
      ...row?.credits === undefined ? {} : { credits: row.credits },
      ...row?.creditsError === undefined ? {} : { creditsError: row.creditsError },
    }
  }

  /**
   * Send one real chat turn through one pool member, for the page's test button.
   *
   * Routed through the account's **own** shim, not the pool: the claim being
   * tested is "this account can answer", which means the same gates, the same
   * credential resolution and the same upstream call an agent pointed at that
   * account would get. The pool is deliberately untouched — a manual test must
   * not move the head, or checking a spare account would silently redirect
   * live traffic onto it.
   */
  async probePoolMember(request: UiProbeRequest): Promise<UiProbeResult> {
    const pool = this.pools.find(candidate => `${candidate.variant.id}-pool` === request.provider)
    if (pool === undefined) throw new UiRequestError(404, `no pool endpoint named ${request.provider}`)
    const member = pool.members[request.index]
    if (member === undefined) throw new UiRequestError(404, `no pool account at index ${request.index}`)

    const served = member.catalog.current()
    if (request.model !== undefined && served.every(model => model.id !== request.model)) {
      throw new UiRequestError(400, `this account does not serve ${request.model}`)
    }
    const model = request.model
      ?? served[0]?.id
      ?? pool.catalog.current()[0]?.id
      ?? fallbackFor(pool.variant)[0]?.id
    if (model === undefined) throw new UiRequestError(409, 'this account serves no model to test against')

    const key = `${request.provider}#${request.index}`
    if (this.probes.has(key)) throw new UiRequestError(409, 'a test is already running for this account')
    this.probes.add(key)
    try {
      const result = await (this.options.probe ?? probeChatTurn)({
        // The published shape, `/v1` included: the probe is an agent, so it
        // must be given the URL an agent would be given.
        baseUrl: `${member.shim.baseUrl()}/v1`,
        token: member.shim.token(),
        model,
      })
      return {
        provider: request.provider,
        index: request.index,
        label: member.nickname ?? `account ${member.accountIndex}`,
        model,
        ...result,
      }
    } finally {
      this.probes.delete(key)
    }
  }

  /** One endpoint's recent turns, newest first, as the page shows them. */
  private uiRequestsOf(endpoint: string): readonly UiRequestRow[] {
    return this.requests.recent(endpoint).map((record: WorkBuddyRequestRecord) => ({
      atMs: record.atMs,
      ...record.account === undefined ? {} : { account: record.account },
      model: record.model,
      status: record.status,
      outcome: record.outcome,
      latencyMs: record.latencyMs,
      ...record.attempts === undefined ? {} : { attempts: record.attempts },
    }))
  }

  /** One endpoint's UI row, including a live credit read. */
  private async uiEndpointOf(runtime: VariantRuntime): Promise<UiEndpoint> {
    const base: UiEndpoint = {
      provider: runtime.variant.id,
      displayName: endpointDisplayName(runtime),
      baseUrl: `${runtime.shim.baseUrl()}/v1`,
      token: runtime.shim.token(),
      signedIn: runtime.identity !== undefined,
      models: runtime.catalog.current().map(uiModelOf),
      requests: this.uiRequestsOf(`${runtime.variant.id}#${runtime.accountIndex}`),
      ...runtime.error === undefined ? {} : { error: runtime.error },
      ...runtime.uid === undefined ? {} : { uid: runtime.uid },
    }
    // `current()`, not `resolve()`: looking at the page must not trigger a
    // token refresh as a side effect of being observed. If the credential is
    // inside the refresh margin the sweep will renew it on its own schedule.
    let credential: WorkBuddyCredential | undefined
    try {
      credential = await runtime.store.current()
    } catch {
      return base
    }
    if (credential === undefined) return base

    const last = runtime.client.lastCatalog
    const withIdentity: UiEndpoint = {
      ...base,
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
      ...credential.domain === '' ? {} : { domain: credential.domain },
      ...credential.expiresAtMs <= 0 ? {} : { expiresAtMs: credential.expiresAtMs },
      source: credential.source,
      ...last === undefined ? {} : { catalogSource: last.source, catalogFetchedAtMs: last.fetchedAtMs },
    }
    // Billing is a separate upstream call that can fail on its own. Degrading
    // to `creditsError` rather than failing the document is the upstream
    // status route's behaviour, and it matters here for the same reason: a
    // billing outage must not blank the model list.
    try {
      return { ...withIdentity, credits: uiCreditsOf(await runtime.client.fetchCredits(credential)) }
    } catch (error: unknown) {
      return { ...withIdentity, creditsError: messageOf(error) }
    }
  }

  /** Stop serving and destroy open connections. */
  async close(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await Promise.all([
      ...this.runtimes.map(runtime => runtime.shim.close()),
      ...this.pools.map(pool => pool.shim.close()),
    ])
    this.runtimes.length = 0
    this.pools.length = 0
  }

  private endpointOf(runtime: VariantRuntime): BridgeEndpoint {
    return {
      provider: runtime.variant.id,
      displayName: endpointDisplayName(runtime),
      baseUrl: `${runtime.shim.baseUrl()}/v1`,
      token: runtime.shim.token(),
      modelCount: runtime.catalog.current().length,
      signedIn: runtime.identity !== undefined,
      // Carried into the descriptor so `status` and `models` can explain an
      // empty list instead of reporting the same "signed out" for a broken
      // credential file as for an unconfigured machine.
      ...runtime.error === undefined ? {} : { error: runtime.error },
    }
  }

  /** The pool's descriptor row. Provider id gets a `-pool` suffix so tooling that filters by product id does not match it. */
  private poolEndpointOf(pool: PoolRuntime): BridgeEndpoint {
    return {
      provider: `${pool.variant.id}-pool`,
      displayName: `${pool.variant.displayName} · pool (failover)`,
      baseUrl: `${pool.shim.baseUrl()}/v1`,
      token: pool.shim.token(),
      modelCount: pool.catalog.current().length,
      signedIn: pool.members.some(runtime => runtime.identity !== undefined),
    }
  }

  private async startVariant(
    variant: WorkBuddyVariant,
    account: {
      ownPath?: string
      desktopPath?: string
      accountIndex: number
      accountTotal: number
      savedCatalogs: WorkBuddyCatalogStore
    },
  ): Promise<VariantRuntime | undefined> {
    const logger = this.options.logger
    const client = new WorkBuddyUpstreamClient()
    const store = new WorkBuddyCredentialStore({
      variant,
      ...account.desktopPath === undefined ? {} : { desktopPath: account.desktopPath },
      ...account.ownPath === undefined ? {} : { ownPath: account.ownPath },
      keyProvider: atRestKeyProviderFor(variant),
      refresh: credential => client.refreshToken(credential),
    })
    const catalog = new WorkBuddyCatalog(fallbackFor(variant))
    if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(true)
    // Start hidden: a variant must expose no models until an account has
    // actually been adopted, so a signed-out variant answers an empty list
    // rather than a roster whose models could only fail.
    catalog.setVisible(false)
    const savedCatalogs = account.savedCatalogs

    // The shim gets a thin wrapper rather than the raw client, so a channel
    // refusal records the exchange that caused it. Catalog, billing and token
    // refresh keep using the real client, so capture cannot affect them.
    //
    // `runtime` is assigned below, before this endpoint can serve anything —
    // the shim only answers once it is listening, and the assignment happens
    // first. It is read here rather than captured because the account's
    // nickname is discovered by the sweep after the shim is built.
    let runtime: VariantRuntime | undefined
    const shim = createWorkBuddyShim({
      store,
      client: {
        chatStream: async (credential, bodyJson, signal) => {
          const startedAtMs = Date.now()
          const result = await client.chatStream(credential, bodyJson, signal)
          if (runtime !== undefined) {
            this.noteTurn({
              endpoint: `${variant.id}#${runtime.accountIndex}`,
              account: runtime.nickname ?? `account ${runtime.accountIndex}`,
              bodyJson,
              result,
              latencyMs: Date.now() - startedAtMs,
            })
          }
          void captureChannelFailure(variant.id, bodyJson, result)
          return this.finishChat(result)
        },
      },
      catalog,
      ...logger === undefined ? {} : { logger },
    })
    try {
      await shim.ready
    } catch (error: unknown) {
      logger?.error(`workbuddy-bridge: ${variant.displayName} loopback endpoint failed to start`, error)
      return undefined
    }
    runtime = {
      variant,
      store,
      client,
      catalog,
      savedCatalogs,
      shim,
      identity: undefined,
      source: 'fallback',
      error: undefined,
      lastFetchAtMs: 0,
      inflight: undefined,
      accountIndex: account.accountIndex,
      accountTotal: account.accountTotal,
      nickname: undefined,
      uid: undefined,
    }
    return runtime
  }

  private async syncAll(): Promise<void> {
    for (const runtime of this.runtimes) await this.syncVariant(runtime)
    for (const pool of this.pools) this.syncPool(pool)
  }

  /**
   * The pool's model list is the union of its members' lists, first account
   * wins per model id. The accounts all belong to one product, so their
   * rosters are near-identical and the union is mostly a deduplication — but
   * it is the honest answer to "what can this endpoint serve": any model any
   * member can serve, since failover means the answering account is not
   * known until the request fails or succeeds.
   */
  private syncPool(pool: PoolRuntime): void {
    const seen = new Set<string>()
    const merged: WorkBuddyModelInfo[] = []
    let visible = false
    for (const runtime of pool.members) {
      if (runtime.catalog.isVisible() === false) continue
      visible = true
      for (const model of runtime.catalog.current()) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        merged.push(model)
      }
    }
    pool.catalog.set(merged.length > 0 ? merged : fallbackFor(pool.variant))
    pool.catalog.setVisible(visible)
  }

  /**
   * Reconcile one variant with its credentials.
   *
   * Three transitions matter, mirroring the plugin's sweep: signed-out hides
   * the list, a first sighting or an identity change re-seeds from the saved
   * catalog and fetches, and an unchanged identity only retries a fetch that
   * previously failed and is now due.
   */
  private async syncVariant(runtime: VariantRuntime): Promise<void> {
    if (this.stopped) return
    let credential: WorkBuddyCredential | undefined
    try {
      credential = await runtime.store.current()
    } catch (error: unknown) {
      // A region mismatch or an unreadable file is a diagnosis, not a crash:
      // record it and leave whatever is being served in place.
      runtime.error = messageOf(error)
      return
    }
    if (this.stopped) return

    if (credential === undefined) {
      if (runtime.identity !== undefined) {
        runtime.savedCatalogs.delete(runtime.identity)
        runtime.identity = undefined
      }
      runtime.nickname = undefined
      runtime.uid = undefined
      runtime.catalog.set(fallbackFor(runtime.variant))
      runtime.source = 'fallback'
      runtime.error = undefined
      runtime.catalog.setVisible(false)
      return
    }

    const identity = credentialIdentity(credential)
    if (runtime.identity === identity) {
      // Same account, already showing something. Only a previously failed or
      // non-live catalog still needs a fetch, on the slow backoff.
      const stale = runtime.source !== 'live'
      const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS
      if (stale && due) await this.fetchCatalog(runtime, identity)
      return
    }

    // First sighting or an account switch: serve this account's best-known
    // catalog until a fetch lands, preferring the saved list over the roster
    // because the saved one is what this account was actually shown.
    runtime.identity = identity
    runtime.nickname = credential.nickname
    runtime.uid = credential.uid
    const saved = runtime.savedCatalogs.get(identity)
    if (saved !== undefined) {
      runtime.catalog.set([...saved.models])
      runtime.source = 'saved'
    } else {
      runtime.catalog.set(fallbackFor(runtime.variant))
      runtime.source = 'fallback'
    }
    runtime.error = undefined
    runtime.catalog.setVisible(true)
    await this.fetchCatalog(runtime, identity)
  }

  /**
   * Fetch one variant's catalog for the current credential.
   *
   * Single-flight per identity: a second caller joins the in-flight fetch, and
   * a response whose identity has since been superseded writes nothing — which
   * is what stops a slow answer from resurrecting a departed account's roster.
   * Uses `resolve()`, not `current()`, so an expired token is renewed rather
   * than failing every request until something else refreshes it.
   */
  private async fetchCatalog(runtime: VariantRuntime, identity: string): Promise<void> {
    const inflight = runtime.inflight
    if (inflight !== undefined && inflight.identity === identity) return inflight.promise
    let run: Promise<void>
    run = (async (): Promise<void> => {
      try {
        const credential = await runtime.store.resolve()
        // The account can change between the sweep's read and this one; never
        // persist B's directory as A's.
        if (credentialIdentity(credential) !== identity) {
          await this.syncVariant(runtime)
          return
        }
        const models = await runtime.client.fetchModels(credential)
        if (this.stopped || runtime.identity !== identity) return
        runtime.lastFetchAtMs = Date.now()
        runtime.catalog.set([...models])
        runtime.source = 'live'
        runtime.error = undefined
        // Remember it for this account so a restart — or a later fetch that
        // fails — serves what this account was actually shown.
        const last = runtime.client.lastCatalog
        runtime.savedCatalogs.set(identity, {
          source: last?.source ?? 'unknown',
          fetchedAtMs: last?.fetchedAtMs ?? Date.now(),
          models: [...models],
          ...last?.appVersion === undefined ? {} : { appVersion: last.appVersion.version },
        })
      } catch (error: unknown) {
        if (this.stopped || runtime.identity !== identity) return
        runtime.lastFetchAtMs = Date.now()
        runtime.error = messageOf(error)
      }
    })().finally(() => {
      if (runtime.inflight?.promise === run) runtime.inflight = undefined
    })
    runtime.inflight = { identity, promise: run }
    return run
  }
}
