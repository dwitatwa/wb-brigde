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
import { probeMemberTurn, type MemberProbeOptions, type ChatProbeResult } from './account-probe.ts'
import { WorkBuddyFailoverPool, type WorkBuddyPoolAttempt, type WorkBuddyPoolMember, type WorkBuddyPoolMemberHealth } from './pool.ts'
import {
  attemptRecord,
  modelOfBody,
  WorkBuddyRequestLog,
  type WorkBuddyRequestAttempt,
  type WorkBuddyRequestRecord,
} from './request-log.ts'
import { join, basename } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  loadEndpointIdentities,
  portOfBaseUrl,
  rememberEndpointIdentity,
  UI_IDENTITY_KEY,
  type EndpointIdentity,
} from './endpoint-identity.ts'
import { parseProviderConfig, type ProviderConfigEntry } from './provider-config.ts'
import {
  CUSTOM_POOL_ID,
  CustomProviderFailoverPool,
  capturePoolMembers,
  createCustomProviderPoolShim,
  errorKindForStatus,
  poolMemberAvailable,
  poolModelList,
  type CustomPoolMember,
  type CustomProviderPoolShim,
} from './provider-pool.ts'
import {
  AccountStoreError,
  WorkBuddyAccountStore,
  type StoredAccount,
} from './account-store.ts'
import {
  ProviderManagementError,
  WorkBuddyManagedProviderStore,
  type ManagedProviderSnapshot,
} from './provider-store.ts'

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

/**
 * The account identity a stored file stands for: its basename, because the
 * store names files by uid. Reading the file would need a decrypt, and the
 * name is authoritative by construction.
 */
function uidOfStoredPath(path: string): string {
  const name = basename(path)
  return name.endsWith('.info') ? name.slice(0, -'.info'.length) : name
}

/**
 * The account identity a discovered desktop file holds.
 *
 * The sweep already parsed these files to deduplicate them, but it returns
 * paths only, so this re-reads the one plaintext field it needs. A file that
 * cannot be read here contributes no identity and is therefore always added —
 * the credential store is the authority on whether it is usable.
 */
function discoveredUidOf(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const document = parsed as Record<string, unknown>
    const identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : document
    const uid = identity['uid']
    return typeof uid === 'string' && uid !== '' ? uid : undefined
  } catch {
    return undefined
  }
}

/** The static roster a variant serves before its first successful fetch. */
function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS
}

/**
 * One custom provider has no desktop credentials, catalog, billing, or pool.
 *
 * The provider is a *snapshot*: configuration plus its captured credential,
 * which the custom pool reads live per request. There is no per-provider
 * listener to hold a port — the pool is the only endpoint a provider is
 * served on, so an edit swaps the snapshot in place and requests already in
 * flight keep the snapshot they resolved.
 */
interface GenericRuntime {
  provider: ProviderConfigEntry
  /** The configuration and credential the pool sends upstream. */
  getSnapshot: () => GenericSnapshot
  /**
   * Swap the configuration the pool serves. Managed edits use this; requests
   * already in flight keep the snapshot they resolved.
   */
  setSnapshot: (provider: GenericSnapshot) => void
}

/** A provider's configuration together with the credential it serves with. */
type GenericSnapshot = ProviderConfigEntry & { apiKey?: string }

/**
 * The one endpoint that fronts every custom provider with failover.
 *
 * The listener is created once per membership lifetime and never per
 * provider: adding or editing a provider swaps the member list the shim
 * reads, so the published URL and local token stay stable. Routing state
 * (head, traffic counts) lives on the shim's own router — the one serving
 * requests — so the page reports what actually happened.
 */
interface CustomPoolRuntime {
  shim: CustomProviderPoolShim
}

/**
 * One variant's live account runtime.
 *
 * An account has no endpoint of its own: its store, client, and catalog feed
 * the variant's failover pool, which is the only endpoint the product serves.
 */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: WorkBuddyCredentialStore
  /** The raw upstream client: catalog, billing, and token refresh use it. */
  client: WorkBuddyUpstreamClient
  /**
   * The account's chat turn, wrapped exactly as the pool serves it — a
   * channel refusal is captured and the reasoning transform applied, so a
   * probe and a pooled request behave the same.
   */
  chat: (credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal) => Promise<WorkBuddyChatResult>
  catalog: WorkBuddyCatalog
  savedCatalogs: WorkBuddyCatalogStore
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
  /** How many runtimes this variant serves; pool member labels use it. */
  accountTotal: number
  /**
   * The auth file this runtime was created for, or undefined when it reads the
   * desktop app's default location.
   *
   * Kept so a rescan can tell which accounts are already served: the same file
   * must not become a second member, and a member removed from the bridge must
   * not come back merely because its file still exists.
   */
  authPath: string | undefined
  /** Whether this runtime came from the bridge's own account folder. */
  managedAccount: boolean
  /** The current credential's nickname, maintained by the sweep for labelling. */
  nickname: string | undefined
  /** The current credential's uid (email or user id), maintained by the sweep. */
  uid: string | undefined
}

/** Options for {@link WorkBuddyBridge}. */
export interface BridgeOptions {
  /** Variants to serve; defaults to both products. */
  variants?: readonly WorkBuddyVariant[]
  /** Explicit custom providers, validated before any listener starts. */
  providers?: readonly ProviderConfigEntry[]
  /**
   * Load the UI-managed provider store from the bridge home and expose
   * management through {@link listManagedProviders},
   * {@link saveManagedProvider}, and {@link removeManagedProvider}.
   *
   * Default false: embedders and tests that never touch management are
   * unchanged. When true, saved providers start as ordinary
   * openai-compatible endpoints — independent of `variants`, and an empty
   * managed list is permitted. `providers` stays external and read-only;
   * a managed id equal to an external id is a startup error.
   */
  manageProviders?: boolean
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
   * Keep a bridge-owned account folder and expose it for management.
   *
   * The folder holds a copy of a desktop sign-in file per account, named by
   * the account's uid. It exists so the operator can **remove** an account
   * from the pool and keep an account **out** of rotation, neither of which is
   * possible while the only source is the desktop app's own directory — the
   * app owns those files, and `--all-accounts` sweeps everything it finds.
   *
   * Default false: an embedder that never manages accounts is unchanged.
   */
  manageAccounts?: boolean
  /**
   * Regroup the upstream's tiny reasoning deltas into larger chunks before
   * they reach the client. Default on: the upstream sends reasoning a word or
   * two at a time, and a client that starts a new thinking block per closed
   * reasoning block renders one block per word. Set false to forward the
   * stream exactly as received.
   */
  coalesceReasoning?: boolean
  /**
   * Send one member probe turn. Defaults to the real probe: upstream HTTP for
   * a provider member, the account's own upstream path for an account.
   *
   * Injectable so a test can answer without an upstream, and so an embedder
   * can substitute a cheaper check.
   */
  probe?: (options: MemberProbeOptions) => Promise<ChatProbeResult>
  /**
   * Keep each endpoint's port and bearer token across restarts, so a client
   * configured once keeps working. Default true: this is the standalone
   * runner's whole point, and the values are remembered per published
   * provider id.
   *
   * Both are preferences. A port another process now holds falls back to an
   * ephemeral one, and the descriptor republishes whatever actually bound.
   *
   * Set false to keep the historical per-process behaviour — an embedder that
   * starts several short-lived bridges in one home would otherwise have them
   * fight over the same remembered ports.
   */
  persistEndpointIdentity?: boolean
  /**
   * Whether the persisted bearer secrets may be reused and rewritten. Default
   * true. False keeps tokens memory-only for this run (the `--no-descriptor`
   * promise) while ports stay stable, and never erases a stored token.
   */
  reuseEndpointTokens?: boolean
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
 * One variant's pool endpoint display name: the product's name plus the pool
 * marker, so the page and the CLI can tell the pool endpoint apart at a
 * glance from any other row.
 */
function poolDisplayName(variant: WorkBuddyVariant): string {
  return `${variant.displayName} · pool (failover)`
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
  private readonly genericRuntimes: GenericRuntime[] = []
  /** The failover pool over custom providers; present when two or more exist. */
  private customPool: CustomPoolRuntime | undefined
  private readonly options: BridgeOptions
  /** The managed-provider store; present only with `manageProviders: true`. */
  private managedStore: WorkBuddyManagedProviderStore | undefined
  /** The bridge-owned account folder; present only with `manageAccounts: true`. */
  private accountStore: WorkBuddyAccountStore | undefined
  /**
   * The pinned active snapshot: the managed document this bridge actually
   * serves. `listManagedProviders` answers from here, so the UI can never
   * see a document this process would then fail to act on; a remote commit
   * that moved the on-disk revision surfaces as a 409 on the next operation.
   */
  private managedSnapshot: ManagedProviderSnapshot | undefined
  /**
   * The captured keys of the pinned snapshot, in memory only — same commit,
   * same revision as {@link managedSnapshot}. A runtime's snapshot embeds the
   * key from here at stage time; nothing re-reads the disk per request.
   */
  private managedSecrets: Record<string, string | undefined> = {}
  /**
   * Serializes management operations so a save/remove cannot interleave with
   * another on this bridge; cross-process safety stays with the file lock.
   */
  private manageQueue: Promise<unknown> = Promise.resolve()
  /** Probe keys (`provider#index`) currently in flight, so a double click cannot double-spend. */
  private readonly probes = new Set<string>()
  /** The turns agents have sent, for the UI. Metadata only, in memory, bounded. */
  private readonly requests = new WorkBuddyRequestLog()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private startedAtMs = 0
  /**
   * What each endpoint bound in an earlier run, so a restart can ask for the
   * same port and token instead of making every client re-copy its settings.
   * Loaded once at start; an empty map means every endpoint starts fresh.
   * Kept current as endpoints bind, so one that closes and reopens within this
   * run (the custom pool, when its last provider leaves and one arrives) asks
   * for the values it just held rather than the ones from the last run.
   */
  private identities: Map<string, EndpointIdentity> = new Map()
  /** Whether the bearer secrets in {@link identities} may be reused. */
  private reuseTokens = true

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
    bodyJson: string
    result: WorkBuddyChatResult
    latencyMs: number
    attempts?: readonly WorkBuddyRequestAttempt[]
  }): void {
    this.requests.record({
      endpoint: input.endpoint,
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
    // Use the same strict parser as file configuration, including for JS callers.
    // An omitted list means no custom providers; an explicitly invalid list is an error.
    let providers: ProviderConfigEntry[] = []
    if (this.options.providers !== undefined) {
      const parsed = parseProviderConfig({ version: 1, providers: this.options.providers })
      if (!parsed.ok) throw new Error(parsed.error)
      providers = parsed.config.providers
    }
    // The bridge-owned account folder, when management is on. It is created
    // lazily by the store itself, so an empty or absent folder is the normal
    // first-run state rather than an error.
    if (this.options.manageAccounts === true) {
      this.accountStore = new WorkBuddyAccountStore()
    }
    // Managed providers load before any listener starts, so a corrupt saved
    // document fails startup cleanly instead of half-serving. The loaded
    // transaction (metadata + captured keys, one revision) is pinned: the
    // bridge serves *this* state and answers management from it.
    if (this.options.manageProviders === true) {
      this.managedStore = new WorkBuddyManagedProviderStore()
      const loaded = await this.managedStore.loadInternal()
      this.managedSnapshot = loaded.metadata
      this.managedSecrets = loaded.secrets
      const external = new Set(providers.map(provider => provider.id))
      for (const managed of loaded.metadata.providers) {
        if (external.has(managed.id)) {
          throw new Error(`workbuddy-bridge: managed provider ${managed.id} collides with an external configured provider of the same id; remove one`)
        }
      }
      providers = [
        ...providers,
        ...loaded.metadata.providers.map(managed => this.managedToConfig(managed)),
      ]
    }
    try {
      return await this.startEndpoints(providers)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  /** The store's metadata view, as the generic runtime sees it. */
  private managedToConfig(managed: {
    id: string
    displayName: string
    baseUrl: string
    models: string[]
    authMode: 'api-key' | 'none'
    hasApiKey: boolean
  }): ProviderConfigEntry {
    return {
      id: managed.id,
      displayName: managed.displayName,
      baseUrl: managed.baseUrl,
      // The key resolves through the managed store, not an env var: the
      // generic shim asks this bridge for the snapshot, and the snapshot's
      // key provider reads the store directly. No process.env is touched.
      models: managed.models,
    }
  }

  private async startEndpoints(providers: readonly ProviderConfigEntry[]): Promise<BridgeDescriptor> {
    this.startedAtMs = Date.now()
    // One read for every listener this start will open. A failure here is not
    // fatal: stability is a convenience, so an unreadable record just means
    // each endpoint starts the way it always did.
    this.reuseTokens = this.options.reuseEndpointTokens !== false
    this.identities = this.options.persistEndpointIdentity === false
      ? new Map()
      : await loadEndpointIdentities()
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
      const { paths, managed } = await this.accountSourcesOf(variant)
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
          managedAccount: path !== undefined && managed.has(path),
        })
        if (runtime !== undefined) this.runtimes.push(runtime)
      }
    }
    await this.startPools(variants)
    for (const provider of providers) {
      const key = this.managedStore === undefined ? undefined : this.managedSecrets[provider.id]
      this.startGeneric(provider, key)
    }    await this.syncCustomPool()
    // Reconcile once up front so the published descriptor carries real model
    // counts, then keep sweeping.
    await this.syncAll()
    const descriptor = await this.publish()
    this.timer = setInterval(() => { void this.syncAll().then(() => this.publish()) }, credentialPollMs())
    this.timer.unref?.()
    return descriptor
  }

  /**
   * The pool's current members: every custom provider this bridge serves,
   * each with the credential it would send.
   *
   * A managed provider's key comes from the pinned transaction, not from a
   * fresh disk read, so the pool's view and the per-provider endpoints' view
   * are the same commit. External providers keep their `apiKeyEnv` lookup.
   */
  private customPoolMembers(): CustomPoolMember[] {
    return this.genericRuntimes.map(runtime => {
      const provider = runtime.getSnapshot()
      return {
        id: provider.id,
        displayName: provider.displayName ?? provider.id,
        baseUrl: provider.baseUrl,
        models: provider.models,
        ...provider.apiKey === undefined ? {} : { apiKey: provider.apiKey },
        ...provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: provider.apiKeyEnv },
        managed: this.managedSnapshot?.providers.some(entry => entry.id === provider.id) === true,
      }
    })
  }

  /**
   * The port a listener should ask for, when the runner keeps addresses
   * stable. Used for listeners that are not published endpoints — the web UI
   * and the WSL forwarders — so their addresses survive a restart too.
   *
   * Exposed as a method rather than by handing out the map, so the document's
   * rules stay in one place.
   */
  preferredPortFor(key: string): number | undefined {
    if (this.options.persistEndpointIdentity === false) return undefined
    return this.identities.get(key)?.port
  }

  /** Record the port a non-endpoint listener actually bound. Never throws. */
  async rememberPortFor(key: string, baseUrl: string): Promise<void> {
    await this.rememberBound(key, baseUrl, '')
  }

  /**
   * The port the web UI should ask for. The UI is not a published endpoint, so
   * it has no token — only the address the operator has open matters.
   */
  preferredUiPort(): number | undefined {
    return this.preferredPortFor(UI_IDENTITY_KEY)
  }

  /** Record the port the UI actually bound. Never throws. */
  async rememberUiPort(baseUrl: string): Promise<void> {
    await this.rememberPortFor(UI_IDENTITY_KEY, baseUrl)
  }

  /**
   * The port and token an endpoint should ask for, from what it bound last
   * time. Both are preferences — the shim falls back on its own — so this only
   * has to answer "what did we use before".
   */
  private wantedIdentity(key: string): EndpointIdentity {
    const remembered = this.identities.get(key)
    if (remembered === undefined) return {}
    return {
      ...remembered.port === undefined ? {} : { port: remembered.port },
      ...this.reuseTokens && remembered.token !== undefined ? { token: remembered.token } : {},
    }
  }

  /**
   * Record what an endpoint actually bound.
   *
   * Never throws and never rejects: a failure to remember makes the *next*
   * start less convenient, which must not fail this one. The port is read back
   * from the live base URL because the shim may have fallen back from the
   * preferred one, and the remembered value has to be the truth.
   */
  private async rememberBound(key: string, baseUrl: string, token: string): Promise<void> {
    if (this.options.persistEndpointIdentity === false) return
    const port = portOfBaseUrl(baseUrl)
    const identity: EndpointIdentity = {
      ...port === undefined ? {} : { port },
      // A listener with no bearer (the UI) has nothing to record here; an
      // empty string would otherwise read as "the secret is blank".
      ...this.reuseTokens && token !== '' ? { token } : {},
    }
    this.identities.set(key, identity)
    try {
      await rememberEndpointIdentity(key, identity, { persistToken: this.reuseTokens })
    } catch (error: unknown) {
      this.options.logger?.warn(`workbuddy-bridge: could not remember the endpoint address for ${key}`, error)
    }
  }

  /**
   * Keep the custom-provider pool in step with the provider list.
   *
   * The pool is the only endpoint a custom provider is served on, so it
   * exists however many providers there are — one is enough — and closes only
   * when the last one goes. Between states the same listener is kept and only
   * the member list changes, so the published base URL and local token
   * survive every edit.
   */
  private async syncCustomPool(): Promise<void> {
    const members = this.customPoolMembers()
    if (members.length === 0) {
      const existing = this.customPool
      this.customPool = undefined
      await existing?.shim.close().catch(() => {})
      return
    }
    if (this.customPool !== undefined) {
      this.customPool.shim.router.prune(members)
      return
    }
    const shim = createCustomProviderPoolShim({
      getMembers: () => this.customPoolMembers(),
      onTurn: record => {
        // Metadata only, and recorded directly rather than through
        // `noteTurn`: a routed turn is a chain of HTTP attempts, not one
        // WorkBuddy chat result, so it has no `kind` to classify.
        this.requests.record({
          endpoint: CUSTOM_POOL_ID,
          model: record.model,
          status: record.status,
          outcome: record.outcome === 'ok' ? 'ok' : errorKindForStatus(record.status),
          latencyMs: record.durationMs,
          ...record.attempts.length === 0 ? {} : {
            attempts: record.attempts.map(attempt => attemptRecord(
              attempt,
              index => record.labels[index] ?? `provider ${index + 1}`,
            )),
          },
        })
      },
      onStreamError: error => { this.options.logger?.warn('workbuddy-bridge: custom provider stream failed mid-flight', error) },
      ...this.wantedIdentity(CUSTOM_POOL_ID),
    })
    this.customPool = { shim }
    await shim.ready
    await this.rememberBound(CUSTOM_POOL_ID, shim.baseUrl(), shim.token())
  }

  /**
   * Bring one provider's snapshot into the served set.
   *
   * The pool reads membership live, so attaching a snapshot is all it takes:
   * the pool endpoint serves the provider from its next request, and an edit
   * swaps the snapshot in place without touching any listener.
   */
  private startGeneric(provider: ProviderConfigEntry, apiKey: string | undefined): void {
    let snapshot: GenericSnapshot = {
      ...provider,
      // `apiKey` (a value) rather than `apiKeyEnv` (a lookup): the snapshot
      // carries its credential. No process.env is ever touched. A provider
      // with no stored key (authMode none) sends no header.
      ...(apiKey === undefined ? {} : { apiKey }),
    }
    this.genericRuntimes.push({
      provider,
      getSnapshot: () => snapshot,
      setSnapshot: next => { snapshot = next },
    })
  }

  /**
   * The pinned active managed snapshot, for the UI's provider editor.
   *
   * Answers from what this bridge actually serves, never straight from the
   * disk: a commit another process made after this bridge started would
   * otherwise describe endpoints the UI cannot then edit (any mutation would
   * 409 against it). Off-bridge loading is a reload/restart.
   */
  async listManagedProviders(): Promise<ManagedProviderSnapshot> {
    this.assertManaged()
    return this.managedSnapshot!
  }

  /**
   * Validate, commit, then expose one managed provider — strictly in that
   * order. The payload's revision must name the pinned state here AND the
   * store's on-disk revision at commit (a second guard under the store's
   * lock), so neither a stale tab nor a stale process can overwrite. A failed
   * save throws before the commit, so the old state keeps serving unchanged
   * and nothing is persisted.
   */
  async saveManagedProvider(input: unknown): Promise<ManagedProviderSnapshot> {
    this.assertManaged()
    return await this.enqueueManagement(async () => {
      const store = this.managedStore!
      const active = this.managedSnapshot!
      // Guard 1: the caller must be editing the pinned state.
      const record = this.assertPinnedRevision(input, active)
      // Guard 2 (live add): the id the new provider would generate must not
      // collide with an external configured provider of that id. The store
      // re-checks the FINAL allocated id (suffix included) against this same
      // registry under its lock at commit.
      const externalIds = (this.options.providers ?? []).map(provider => provider.id)
      if (record['id'] === undefined) {
        const preview = store.previewId(record['displayName'])
        if (preview !== undefined && externalIds.includes(preview)) {
          throw new ProviderManagementError(400, 'the new provider would collide with an external configured provider; choose another name')
        }
      }
      // Commit: the store re-validates everything, checks the caller's
      // revision against the on-disk document under its lock, and returns
      // metadata AND captured keys from the same committed document.
      const committed = await store.saveInternal(input, { blockedIds: externalIds })
      // Attach: swap the edited runtime's snapshot in place, or attach the
      // new provider with the commit's captured key. Only now does the pinned
      // snapshot and its secrets move — same transaction.
      await this.attachManaged(active, committed.metadata, committed.secrets)
      this.managedSnapshot = committed.metadata
      this.managedSecrets = committed.secrets
      // The pool reads membership live, so this only creates or retires the
      // pool listener when the first provider arrives or the last leaves —
      // never per edit.
      await this.syncCustomPool()
      return committed.metadata
    })
  }

  /**
   * Persist one removal, then drop the provider's snapshot — persist first,
   * so a failed remove leaves the serving state unchanged. The payload's
   * revision must name the pinned state here AND the disk's at the store's
   * commit, matching save's dual guard.
   */
  async removeManagedProvider(input: unknown): Promise<ManagedProviderSnapshot> {
    this.assertManaged()
    return await this.enqueueManagement(async () => {
      const active = this.managedSnapshot!
      this.assertPinnedRevision(input, active)
      const committed = await this.managedStore!.removeInternal(input)
      await this.attachManaged(active, committed.metadata, committed.secrets)
      this.managedSnapshot = committed.metadata
      this.managedSecrets = committed.secrets
      await this.syncCustomPool()
      return committed.metadata
    })
  }

  /**
   * The bridge-owned account folder's contents, for the page's account list.
   *
   * Metadata only: a stored file's tokens are never read here, let alone sent
   * to a page with no authentication.
   */
  async listStoredAccounts(): Promise<StoredAccount[]> {
    this.assertAccounts()
    return await this.accountStore!.list()
  }

  /**
   * Store one desktop sign-in file and serve it from the next request.
   *
   * The file is copied verbatim — this never re-seals a token — and an
   * envelope sealed by a different WorkBuddy install is refused with the
   * reason before anything is written. The account joins the pool immediately;
   * the listener is not rebuilt, so the published URL and token are unchanged.
   */
  async importStoredAccount(input: { text: string; origin?: string }): Promise<StoredAccount> {
    this.assertAccounts()
    return await this.enqueueManagement(async () => {
      const variant = this.accountVariant()
      const account = await this.accountStore!.save({
        text: input.text,
        origin: input.origin ?? 'uploaded file',
        // The key provider for the product the file will serve. A file for the
        // other product is refused by the credential store later; the key
        // check here is about this install, not about the region.
        keyProvider: atRestKeyProviderFor(variant),
      })
      await this.rescanAccounts()
      return account
    })
  }

  /**
   * Remove one stored account from the folder and from the pool.
   *
   * Only the bridge's own copy is deleted — the desktop app's file and its
   * snapshots are untouched, so the account can be added back by copying the
   * same file again. The pool's listener is unchanged; the member leaves the
   * member list, and the head stays on the same account by identity.
   */
  async removeStoredAccount(uid: string): Promise<{ removed: boolean; total: number }> {
    this.assertAccounts()
    return await this.enqueueManagement(async () => {
      const removed = await this.accountStore!.remove(uid)
      if (!removed) return { removed: false, total: this.runtimes.length }
      // Drop the runtime that was serving it, so the account stops answering
      // at once rather than on the next restart.
      for (const pool of this.pools) {
        const index = pool.members.findIndex(runtime => runtime.managedAccount
          && runtime.authPath !== undefined
          && uidOfStoredPath(runtime.authPath) === uid)
        if (index < 0) continue
        const [runtime] = pool.members.splice(index, 1)
        const runtimeIndex = this.runtimes.indexOf(runtime!)
        if (runtimeIndex >= 0) this.runtimes.splice(runtimeIndex, 1)
        // A pool needs at least one member; an empty one keeps the listener so
        // the URL stays valid, and reports every member signed out.
        if (pool.members.length > 0) pool.pool.setMembers(this.poolMembersOf(pool.members))
      }
      await this.syncAll()
      await this.publishToDisk()
      return { removed: true, total: this.runtimes.length }
    })
  }

  /** The product a stored account file is assumed to belong to. */
  private accountVariant(): WorkBuddyVariant {
    const served = this.pools.map(pool => pool.variant)
    return served.find(variant => variant.id !== CN_VARIANT.id) ?? served[0] ?? WORKBUDDY_VARIANTS[1]!
  }

  /** An account-management call on a bridge that does not manage accounts. */
  private assertAccounts(): void {
    if (this.stopped) throw new AccountStoreError(409, 'the bridge has stopped; account management is no longer available')
    if (this.options.manageAccounts !== true || this.accountStore === undefined) {
      throw new AccountStoreError(409, 'account management is not enabled on this bridge')
    }
  }

  /** Serialize management operations per bridge; cross-process stays on the file lock. */
  private enqueueManagement<T>(operation: () => Promise<T>): Promise<T> {    const run = this.manageQueue.then(operation, operation)
    this.manageQueue = run.catch(() => {})
    return run
  }

  /** A bridge not started with `manageProviders` has no management surface. */
  private assertManaged(): void {
    if (this.stopped) {
      throw new ProviderManagementError(409, 'the bridge has stopped; management is no longer available')
    }
    if (this.options.manageProviders !== true || this.managedStore === undefined) {
      throw new ProviderManagementError(409, 'provider management is not enabled on this bridge; start it with manageProviders enabled')
    }
  }

  /**
   * Shared management payload guard: the payload must be an object carrying
   * the pinned revision, so a stale tab cannot overwrite the active state.
   * The store re-checks the same revision against the disk under its lock —
   * the dual guard for cross-process conflicts.
   */
  private assertPinnedRevision(input: unknown, active: ManagedProviderSnapshot): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ProviderManagementError(400, 'management payload must be a JSON object')
    }
    const record = input as Record<string, unknown>
    if (record['revision'] !== active.revision) {
      throw new ProviderManagementError(409, 'the provider list changed elsewhere; reload and retry')
    }
    return record
  }

  /**
   * Make the live provider snapshots match a freshly committed managed
   * transaction.
   *
   * A create attaches a snapshot built from the commit's metadata and
   * captured key. An edit swaps the existing runtime's snapshot in place
   * (in-flight turns preserved) with the commit's captured key. A removal
   * drops the runtime after the persist. The managed/external split is by
   * the `managedIds` set built from the pinned snapshot — never by matching
   * against external ids.
   */
  private async attachManaged(
    previous: ManagedProviderSnapshot,
    snapshot: ManagedProviderSnapshot,
    secrets: Record<string, string | undefined>,
  ): Promise<void> {
    const previousIds = new Set(
      previous.providers.map(managed => managed.id),
    )
    const nextIds = new Set(snapshot.providers.map(managed => managed.id))
    const keep: GenericRuntime[] = []
    for (const runtime of this.genericRuntimes) {
      const isManagedRuntime = previousIds.has(runtime.provider.id)
      if (isManagedRuntime && nextIds.has(runtime.provider.id)) {
        keep.push(runtime)
      } else if (isManagedRuntime) {
        // Removed: dropped with the persist already done. No listener to
        // close — the pool stops routing to the provider from here on.
      } else {
        keep.push(runtime)
      }
    }
    this.genericRuntimes.length = 0
    this.genericRuntimes.push(...keep)
    for (const managed of snapshot.providers) {
      const existing = keep.find(runtime => runtime.provider.id === managed.id)
      if (existing !== undefined) {
        // Edit: swap the live snapshot; in-flight turns keep the snapshot
        // they resolved. The commit's captured key rides with the swapped
        // snapshot, so the next request's configuration and credential move
        // together.
        const key = secrets[managed.id]
        existing.setSnapshot({
          ...this.managedToConfig(managed),
          ...(key === undefined ? {} : { apiKey: key }),
        })
        continue
      }
      this.startGeneric(this.managedToConfig(managed), secrets[managed.id])
    }
  }

  /**
   * One pool endpoint per product, serving every account of that product.
   *
   * The pool rides on the same shim the accounts used to — same gates, same
   * per-process secret — but its store and client are the failover router,
   * so the shim never learns the difference. The pool is the only endpoint
   * the product serves, and it exists however many accounts are signed in:
   * the URL an agent is configured with survives accounts being added,
   * removed, or signed out, and failover appears the moment a second account
   * can answer.
   */
  /** The live pool runtime for one product, when its endpoint is up. */
  private poolRuntimeOf(variant: WorkBuddyVariant): PoolRuntime | undefined {
    return this.pools.find(candidate => candidate.variant.id === variant.id)
  }

  /**
   * The auth-file paths one variant should serve, and which of them belong to
   * the bridge's own account folder.
   *
   * Order matters, because the first account keeps the historical
   * plugin-owned credential copy. Bridge-owned accounts come first: they are
   * the operator's explicit choices, and a stored copy of an account is more
   * authoritative than a snapshot the desktop app happened to leave behind.
   *
   * Three sources, in precedence order:
   *
   * 1. Explicit `authFiles` for this variant — a hand-picked list replaces
   *    everything else, exactly as before, so a caller that names its files is
   *    never silently widened by a folder or a sweep.
   * 2. The bridge's own account folder, when `manageAccounts` is on.
   * 3. Desktop discovery, when `discoverAccounts` is on.
   *
   * Sources 2 and 3 are merged by account identity: a stored account and the
   * desktop snapshot of the same sign-in are one member, not two, and the
   * stored copy wins because the operator put it there.
   *
   * No paths at all means the variant's ordinary single-account mode — one
   * runtime reading whatever the desktop app has signed in. `[undefined]` is
   * that one entry; an empty array would start nothing, which is how the
   * default invocation once regressed to "no variant could start an
   * endpoint".
   */
  private async accountSourcesOf(variant: WorkBuddyVariant): Promise<{
    paths: ReadonlyArray<string | undefined>
    managed: ReadonlySet<string>
  }> {
    const explicit = this.options.authFiles?.get(variant.id) ?? []
    if (explicit.length > 0) return { paths: explicit, managed: new Set() }

    const stored = this.accountStore === undefined ? [] : await this.storedAccountPaths(variant)
    const discovered = this.options.discoverAccounts === true
      ? discoverDesktopAuthFiles(variant).map(account => account.path)
      : []
    if (stored.length === 0 && discovered.length === 0) return { paths: [undefined], managed: new Set() }

    // Deduplicate by the identity the sweep itself uses. A stored file's
    // identity is its basename (the store names files by uid); a discovered
    // file's is the uid the sweep parsed. Reading the stored file again would
    // cost a decrypt, so the basename is taken as the identity.
    const seen = new Set(stored.map(uidOfStoredPath))
    const merged = [...stored]
    for (const path of discovered) {
      const uid = discoveredUidOf(path)
      if (uid !== undefined && seen.has(uid)) continue
      if (uid !== undefined) seen.add(uid)
      merged.push(path)
    }
    return { paths: merged, managed: new Set(stored) }
  }

  /**
   * The stored account files for one product, in save order.
   *
   * The store is not per-variant on disk, so a file is offered to the variant
   * whose region it belongs to. The store's own listing is metadata-only, and
   * a region mismatch is caught later by the credential store — which is where
   * it belongs, because only the parsed credential knows its domain.
   */
  private async storedAccountPaths(_variant: WorkBuddyVariant): Promise<string[]> {
    if (this.accountStore === undefined) return []
    try {
      return await this.accountStore.paths()
    } catch {
      // An unreadable account folder must not stop the bridge: discovery and
      // the desktop app's own file still serve.
      return []
    }
  }

  /**
   * Add every account that appeared since the last scan, without a restart.
   *
   * This is the page's **Rescan** action. It repeats the source list — the
   * bridge's own folder and the desktop sweep — and starts one runtime for
   * each account not already served, then hands the pool the new member list.
   * The listener is never rebuilt, so the published base URL and token are
   * unchanged.
   *
   * A file already served is skipped by identity, so pressing the button twice
   * adds nothing. Accounts that disappeared are **not** removed: a member whose
   * file is gone keeps its runtime and simply reports as signed out, which is
   * the same state a sign-out produces and keeps the head meaningful. Removing
   * an account is an explicit action on the account folder.
   *
   * Returns what changed, for the caller to report.
   */
  async rescanAccounts(): Promise<{ added: string[]; total: number }> {
    if (this.stopped) throw new UiRequestError(409, 'the bridge has stopped')
    const added: string[] = []
    for (const pool of this.pools) {
      const variant = pool.variant
      const { paths, managed } = await this.accountSourcesOf(variant)
      const known = new Set(pool.members.map(runtime => runtime.authPath).filter((path): path is string => path !== undefined))
      const savedCatalogs = new WorkBuddyCatalogStore(workbuddyCatalogPath(variant.catalogFilename))
      for (const path of paths) {
        if (path === undefined || known.has(path)) continue
        const runtime = await this.startVariant(variant, {
          ownPath: join(resolveBridgeHome(), `.workbuddy-auth-${this.runtimes.length + 1}.json`),
          desktopPath: path,
          accountIndex: pool.members.length + 1,
          accountTotal: pool.members.length + 1,
          savedCatalogs,
          managedAccount: managed.has(path),
        })
        if (runtime === undefined) continue
        this.runtimes.push(runtime)
        pool.members.push(runtime)
        known.add(path)
        added.push(path)
      }
      if (added.length > 0) {
        // One membership update per pool: the router re-anchors the head by
        // identity, so live traffic stays on the account that was serving it.
        pool.pool.setMembers(this.poolMembersOf(pool.members))
      }
    }
    if (added.length > 0) {
      await this.syncAll()
      await this.publishToDisk()
    }
    return {
      added: added.map(path => basename(path)),
      total: this.runtimes.length,
    }
  }

  /** The live pool runtime for one product, when its endpoint is up. */

  /**
   * The pool members one variant's runtimes produce, in runtime order.
   *
   * `id` is the runtime's stable identity so the router can keep the head on
   * the same account when the member list changes. A runtime that has not
   * resolved a credential yet has no uid, so it is identified by its auth path
   * — still stable, still unique — and falls back to its position only when it
   * has neither.
   */
  private poolMembersOf(members: readonly VariantRuntime[]): WorkBuddyPoolMember[] {
    return members.map((runtime, index) => ({
      id: runtime.uid ?? runtime.authPath ?? `#${index}`,
      // The wrapped chat turn — capture and reasoning transform included — so
      // a pool-served refusal is diagnosable the same way a direct one was,
      // and a probe exercises the same path.
      store: runtime.store,
      client: {
        chatStream: (credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal) =>
          runtime.chat(credential, bodyJson, signal),
      },
    }))
  }

  private async startPools(variants: readonly WorkBuddyVariant[]): Promise<void> {
    const logger = this.options.logger
    for (const variant of variants) {
      const members = this.runtimes.filter(runtime => runtime.variant.id === variant.id)
      if (members.length === 0) continue
      const catalog = new WorkBuddyCatalog(fallbackFor(variant))
      if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(true)
      catalog.setVisible(false)
      const pool = new WorkBuddyFailoverPool(this.poolMembersOf(members))
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
            // The attempt indices refer to the pool's current member list, so
            // the labels are read from it rather than from the list captured
            // when this listener started: an account added since then is a
            // real member and must be named, not shown as a bare index.
            const current = this.poolRuntimeOf(variant)
            const result = await pool.chatStream(credential, bodyJson, signal, attempt => {
              attempts.push(attemptRecord(attempt, index => {
                const member = current?.members[index]
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
        ...this.wantedIdentity(`${variant.id}-pool`),
      })
      try {
        await shim.ready
      } catch (error: unknown) {
        logger?.error(`workbuddy-bridge: ${variant.displayName} pool endpoint failed to start`, error)
        continue
      }
      await this.rememberBound(`${variant.id}-pool`, shim.baseUrl(), shim.token())
      this.pools.push({ variant, members, pool, catalog, shim })
    }
  }

  /** The descriptor as of the last publish. */
  async publish(): Promise<BridgeDescriptor> {
    const descriptor: BridgeDescriptor = {
      version: 1,
      pid: process.pid,
      startedAtMs: this.startedAtMs,
      endpoints: this.endpoints(),
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
      ...this.pools.map(pool => this.poolEndpointOf(pool)),
      ...this.customPool === undefined ? [] : [this.customPoolEndpointOf(this.customPool)],
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
    // One credit read per signed-in account, computed once: the pool card
    // reuses those figures for each member's credits, so a page load still
    // costs one billing call per account.
    const credits = new Map<VariantRuntime, { credits?: UiCredits; creditsError?: string }>()
    for (const runtime of this.runtimes) credits.set(runtime, await this.accountCreditsOf(runtime))
    for (const pool of this.pools) endpoints.push(await this.uiPoolOf(pool, credits))
    if (this.customPool !== undefined) endpoints.push(this.uiCustomPoolOf(this.customPool))
    return { version: 1, startedAtMs: this.startedAtMs, nowMs: Date.now(), endpoints }
  }

  /**
   * The custom-provider pool's card: its membership, who answers next, and
   * what the router has seen of each provider's real traffic.
   *
   * The same shape the account pool uses, so the page renders one component
   * for both. A provider with no key shows as unavailable rather than as a
   * routing failure; the upstream base URL stays out of the page — the pool
   * card is the only thing an agent is configured with.
   */
  private uiCustomPoolOf(pool: CustomPoolRuntime): UiEndpoint {
    const members = this.customPoolMembers()
    const health = pool.shim.router.memberHealth(members)
    const headIndex = pool.shim.router.headIndex(members)
    const models = poolModelList(members)
    return {
      provider: CUSTOM_POOL_ID,
      displayName: 'Custom providers · pool (failover)',
      baseUrl: `${pool.shim.baseUrl()}/v1`,
      token: pool.shim.token(),
      signedIn: models.length > 0,
      models: models.map(id => ({ id, name: id, supportsImages: false })),
      requests: this.uiRequestsOf(CUSTOM_POOL_ID),
      pool: {
        kind: 'providers',
        headIndex,
        members: members.map((member, index) => {
          const record = health[index]
          return {
            index,
            accountIndex: index + 1,
            label: member.displayName,
            signedIn: poolMemberAvailable(member),
            head: index === headIndex,
            successes: record?.successes ?? 0,
            failures: record?.failures ?? 0,
            consecutiveFailures: record?.consecutiveFailures ?? 0,
            ...record === undefined || record.lastAttemptAtMs <= 0 ? {} : { lastAttemptAtMs: record.lastAttemptAtMs },
            ...attemptText(record?.lastOutcome),
            ...member.managed ? { editId: member.id } : {},
          }
        }),
      },
      ...models.length === 0 ? { error: 'no provider in the pool has a usable key' } : {},
    }
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
  private async uiPoolOf(
    pool: PoolRuntime,
    credits: ReadonlyMap<VariantRuntime, { credits?: UiCredits; creditsError?: string }>,
  ): Promise<UiEndpoint> {
    const health = pool.pool.memberHealth()
    const headIndex = pool.pool.headIndex()
    return {
      provider: `${pool.variant.id}-pool`,
      displayName: poolDisplayName(pool.variant),
      baseUrl: `${pool.shim.baseUrl()}/v1`,
      token: pool.shim.token(),
      signedIn: pool.members.some(runtime => runtime.identity !== undefined),
      models: pool.catalog.current().map(uiModelOf),
      requests: this.uiRequestsOf(`${pool.variant.id}-pool`),
      pool: {
        headIndex,
        members: pool.members.map((runtime, index) => this.uiPoolMemberOf(runtime, index, headIndex, health[index], credits.get(runtime))),
      },
      ...pool.members.every(runtime => runtime.identity === undefined)
        ? { error: 'no account in the pool is signed in' }
        : {},
    }
  }

  /** One pool member row, assembled from the runtime, its health, and its credit read. */
  private uiPoolMemberOf(
    runtime: VariantRuntime,
    index: number,
    headIndex: number,
    health: WorkBuddyPoolMemberHealth | undefined,
    billing: { credits?: UiCredits; creditsError?: string } | undefined,
  ): UiPoolMember {
    return {
      index,
      accountIndex: runtime.accountIndex,
      label: runtime.nickname ?? runtime.uid ?? `account ${runtime.accountIndex}`,
      ...runtime.uid === undefined ? {} : { uid: runtime.uid },
      signedIn: runtime.identity !== undefined,
      head: index === headIndex,
      successes: health?.successes ?? 0,
      failures: health?.failures ?? 0,
      consecutiveFailures: health?.consecutiveFailures ?? 0,
      ...health === undefined || health.lastAttemptAtMs <= 0 ? {} : { lastAttemptAtMs: health.lastAttemptAtMs },
      ...attemptText(health?.lastOutcome),
      ...billing?.credits === undefined ? {} : { credits: billing.credits },
      ...billing?.creditsError === undefined ? {} : { creditsError: billing.creditsError },
    }
  }

  /**
   * Send one real chat turn through one pool member, for the page's test
   * button.
   *
   * An account member is probed in process, through the same wrapped client a
   * pool-served request runs — same gates, same credential resolution, same
   * upstream call — so the claim being tested is "this account can answer",
   * without a per-account endpoint to knock on. A provider member is probed
   * over HTTP at its own base URL with its own key. Either way the pool is
   * deliberately untouched — a manual test must not move the head, or
   * checking a spare member would silently redirect live traffic onto it.
   */
  async probePoolMember(request: UiProbeRequest): Promise<UiProbeResult> {
    if (request.provider === CUSTOM_POOL_ID) return await this.probeCustomProvider(request)
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
      const result = await (this.options.probe ?? probeMemberTurn)({
        provider: request.provider,
        index: request.index,
        model,
        sendTurn: async (bodyJson, signal) => member.chat(
          // The probe resolves the credential itself, the way a pool-served
          // request would, so an expired token is renewed rather than failed.
          // A refusal to resolve is the result the report needs.
          await member.store.resolve(),
          bodyJson,
          signal,
        ),
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

  /**
   * Test one provider inside the custom pool.
   *
   * Probed over HTTP at the provider's own base URL with its own key — the
   * claim is "this provider can answer", and a test must not move the head or
   * spend a turn on another provider. A provider with no usable key is
   * refused before any call, so a test never becomes an accidental
   * unauthenticated request.
   */
  private async probeCustomProvider(request: UiProbeRequest): Promise<UiProbeResult> {
    const members = this.customPoolMembers()
    const member = members[request.index]
    if (member === undefined) throw new UiRequestError(404, `no provider at index ${request.index} in the pool`)
    if (!poolMemberAvailable(member)) {
      throw new UiRequestError(409, `provider ${member.displayName} has no usable API key`)
    }
    if (request.model !== undefined && !member.models.includes(request.model)) {
      throw new UiRequestError(400, `this provider does not serve ${request.model}`)
    }
    const model = request.model ?? member.models[0]
    if (model === undefined) throw new UiRequestError(409, 'this provider serves no model to test against')

    const key = `${request.provider}#${request.index}`
    if (this.probes.has(key)) throw new UiRequestError(409, 'a test is already running for this provider')
    this.probes.add(key)
    try {
      const result = await (this.options.probe ?? probeMemberTurn)({
        provider: request.provider,
        index: request.index,
        model,
        baseUrl: member.baseUrl,
        ...(member.apiKey === undefined ? {} : { apiKey: member.apiKey }),
      })
      return {
        provider: request.provider,
        index: request.index,
        label: member.displayName,
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

  /** One account's live credit read, for its pool member row. */
  private async accountCreditsOf(runtime: VariantRuntime): Promise<{ credits?: UiCredits; creditsError?: string }> {
    // `current()`, not `resolve()`: looking at the page must not trigger a
    // token refresh as a side effect of being observed. If the credential is
    // inside the refresh margin the sweep will renew it on its own schedule.
    let credential: WorkBuddyCredential | undefined
    try {
      credential = await runtime.store.current()
    } catch {
      return {}
    }
    if (credential === undefined) return {}
    // Billing is a separate upstream call that can fail on its own. Degrading
    // to `creditsError` rather than failing the document is the upstream
    // status route's behaviour, and it matters here for the same reason: a
    // billing outage must not blank the member rows.
    try {
      return { credits: uiCreditsOf(await runtime.client.fetchCredits(credential)) }
    } catch (error: unknown) {
      return { creditsError: messageOf(error) }
    }
  }

  /** Stop serving and destroy open connections. */
  async close(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    // Drain any management operation still running (a save mid-commit is
    // allowed to finish persisting and attaching before the state goes
    // away), and refuse new ones afterwards.
    const drained = this.manageQueue.catch(() => {})
    await drained
    await Promise.all([
      ...this.pools.map(pool => pool.shim.close()),
      ...this.customPool === undefined ? [] : [this.customPool.shim.close()],
    ])
    this.runtimes.length = 0
    this.pools.length = 0
    this.genericRuntimes.length = 0
    this.customPool = undefined
  }

  /**
   * The custom-provider pool's descriptor row.
   *
   * Its provider id is `custom-pool`, which no provider may take (the store
   * and the external parser both reserve it), so tooling that filters by
   * provider id never confuses the pool with one of its members.
   */
  private customPoolEndpointOf(pool: CustomPoolRuntime): BridgeEndpoint {
    const members = this.customPoolMembers()
    const models = poolModelList(members)
    return {
      provider: CUSTOM_POOL_ID,
      displayName: 'Custom providers · pool (failover)',
      baseUrl: `${pool.shim.baseUrl()}/v1`,
      token: pool.shim.token(),
      signedIn: models.length > 0,
      modelCount: models.length,
    }
  }

  /** The pool's descriptor row. Provider id gets a `-pool` suffix so tooling that filters by product id does not match it. */
  private poolEndpointOf(pool: PoolRuntime): BridgeEndpoint {
    return {
      provider: `${pool.variant.id}-pool`,
      displayName: poolDisplayName(pool.variant),
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
      managedAccount?: boolean
    },
  ): Promise<VariantRuntime | undefined> {
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

    // Every chat turn an account serves goes through one wrapper — pool
    // requests, member probes — so a channel refusal records the exchange
    // that caused it exactly once, and the reasoning transform applies the
    // same way whichever path brought the turn here. Catalog, billing and
    // token refresh keep using the real client, so capture cannot affect
    // them.
    const runtime: VariantRuntime = {
      variant,
      store,
      client,
      chat: async (credential, bodyJson, signal) => {
        const result = await client.chatStream(credential, bodyJson, signal)
        void captureChannelFailure(variant.id, bodyJson, result)
        return this.finishChat(result)
      },
      catalog,
      savedCatalogs,
      identity: undefined,
      source: 'fallback',
      error: undefined,
      lastFetchAtMs: 0,
      inflight: undefined,
      accountIndex: account.accountIndex,
      accountTotal: account.accountTotal,
      authPath: account.desktopPath,
      managedAccount: account.managedAccount === true,
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
