import { E as WorkBuddyVariant, f as WorkBuddyCredential, j as WorkBuddyChatResult, k as UpstreamErrorKind, p as WorkBuddyCredentialStore, t as ShimLogger, z as WorkBuddyUpstreamClient } from "./shim-U171C0Zy.js";
import { t as main } from "./cli-Cr0TbRBT.js";
//#region src/standalone/descriptor.d.ts
/**
 * The endpoint descriptor the standalone runner publishes.
 *
 * The shim keeps its upstream behaviour exactly — an ephemeral loopback port
 * and a per-process in-memory secret — so nothing outside this process can
 * know where to connect until the runner tells it. This document is that
 * telling: one small 0600 file naming the base URL and bearer token for each
 * running variant, rewritten on every start.
 *
 * Security note: writing the secret to disk narrows the shim's threat model
 * from "no local process can forge a request" to "no *other user's* process
 * can". Any process running as the same user can now read the token. That is
 * the deliberate cost of letting an external agent be configured at all; use
 * `--no-descriptor` or `--redact-token` to opt out, and note that an agent
 * running as the same user could read the token out of this file either way.
 *
 * @module workbuddy-bridge/standalone/descriptor
 */
/** Basename of the descriptor inside the bridge home. */
declare const BRIDGE_DESCRIPTOR_FILENAME = ".workbuddy-bridge-endpoint.json";
/** Current descriptor format; readers reject others. */
declare const DESCRIPTOR_VERSION = 1;
/** One served variant, as an external client needs to address it. */
interface BridgeEndpoint {
  /** Provider id, `workbuddy` or `workbuddy-ai`. */
  provider: string;
  /** Human-readable group name, e.g. `WorkBuddy AI`. */
  displayName: string;
  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  baseUrl: string;
  /**
   * The same endpoint as reachable from inside WSL, including the `/v1`
   * suffix, when the bridge was started with `--wsl`. Absent otherwise.
   *
   * A second field rather than a second endpoint entry because it *is* the
   * same endpoint — same token, same models, same account — merely addressed
   * over the WSL virtual switch instead of loopback. Tooling running inside
   * WSL prefers this and falls back to `baseUrl` everywhere else.
   */
  wslBaseUrl?: string;
  /** The bearer token this endpoint accepts, or `''` when redacted. */
  token: string;
  /** How many models `/v1/models` currently lists. */
  modelCount: number;
  /** Whether a credential is currently usable for this variant. */
  signedIn: boolean;
  /**
   * Why no credential is usable, when the reason is *diagnosable* rather than
   * "nobody is signed in" — a credential belonging to the other region, or a
   * desktop auth file that exists but cannot be read or decrypted. Absent when
   * signed in, and absent in the ordinary signed-out case.
   *
   * Without this, an empty model list is indistinguishable from a broken
   * setup: both render as "signed out", and the operator has nothing to act
   * on. The reason text names the file that is wrong, which is the fix.
   */
  error?: string;
}
/** The whole published document. */
interface BridgeDescriptor {
  version: typeof DESCRIPTOR_VERSION;
  /** Owning process, so a stale descriptor can be told from a live one. */
  pid: number;
  startedAtMs: number;
  endpoints: BridgeEndpoint[];
}
/** Path of the descriptor file. */
declare function bridgeDescriptorPath(): string;
/**
 * Descriptor locations to try, most specific first.
 *
 * The extra entries exist for WSL. The bridge runs on Windows and writes under
 * the **Windows** user profile, but inside WSL `$HOME` is the *Linux* home, so
 * {@link bridgeDescriptorPath} points at a directory that has never held a
 * descriptor. Without these candidates, `status`, `env` and `models` run from
 * inside WSL would always report "no running bridge" — which is exactly the
 * case those commands are most useful in.
 *
 * Each mounted drive's `Users` directory is enumerated, so a Windows account
 * whose name differs from the Linux user is still found.
 */
declare function bridgeDescriptorCandidates(): string[];
/** Write the descriptor atomically at 0600. */
declare function writeBridgeDescriptor(descriptor: BridgeDescriptor): Promise<string>;
/**
 * Read the descriptor back, or undefined when there is none or it is
 * unreadable. Never throws: a malformed file is a "no descriptor" answer, the
 * same way a missing one is.
 *
 * Searches every candidate location, so this works when run from inside WSL as
 * well as on Windows.
 */
declare function readBridgeDescriptor(): Promise<BridgeDescriptor | undefined>;
/**
 * Remove the descriptor, but only if it is still ours.
 *
 * Two bridges can legitimately run at once — a second instance started before
 * the first was stopped, or an agent that spawned its own. There is one
 * descriptor file, so the last writer wins; without this check, an exiting
 * instance deletes the *other* instance's descriptor and makes a perfectly
 * healthy bridge look stopped. Observed for real: a second instance exiting
 * wiped the descriptor of a running one, and `status` then reported nothing.
 *
 * `pid` defaults to this process, which is what the CLI wants; pass it
 * explicitly only to reason about another instance.
 */
declare function removeBridgeDescriptor(pid?: number): Promise<void>;
//#endregion
//#region src/standalone/ui.d.ts
/** One credit package, as the UI shows it. */
interface UiCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  unlimited?: true;
  endTimeMs?: number;
}
/** One aggregate credit answer. Mirrors `WorkBuddyCredits` without the token path. */
interface UiCredits {
  total: number;
  accounts: readonly UiCreditAccount[];
  unlimited?: true;
  cycleResetTime?: string;
}
/** One model row, flattened for display. */
interface UiModel {
  id: string;
  name: string;
  /** Normalized rate, e.g. `x0.79`; absent when the upstream declared none. */
  credits?: string;
  free?: true;
  /** Upstream promo labels, verbatim. */
  badges?: readonly string[];
  /** The upstream's price cannot be vouched for; show "needs refresh". */
  rateUnknown?: true;
  contextWindow?: number;
  defaultContextWindow?: number;
  maxContextWindow?: number;
  maxTokens?: number;
  supportsImages: boolean;
  reasoning?: {
    supports: boolean;
    efforts?: readonly string[];
    canDisableThinking?: boolean;
  };
}
/** One served endpoint, as the UI shows it. Never carries the bearer token. */
interface UiEndpoint {
  provider: string;
  displayName: string;
  /** The OpenAI-compatible base URL an agent would use. */
  baseUrl: string;
  signedIn: boolean;
  nickname?: string;
  domain?: string;
  /** Which stored copy the credential came from. */
  source?: string;
  expiresAtMs?: number;
  /** Where the served models came from: live fetch, saved cache, or fallback. */
  catalogSource?: string;
  catalogFetchedAtMs?: number;
  /** A diagnosable credential problem, when there is one. */
  error?: string;
  credits?: UiCredits;
  creditsError?: string;
  models: readonly UiModel[];
}
/** The whole document `/api/state` returns. */
interface UiState {
  version: 1;
  startedAtMs: number;
  nowMs: number;
  endpoints: readonly UiEndpoint[];
}
/** A running UI server. */
interface WorkBuddyUiServer {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The UI origin, e.g. `http://127.0.0.1:41000`; valid after ready. */
  url(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WorkBuddyUiOptions {
  /** Build the current state document. Called per request. */
  state: () => Promise<UiState>;
  logger?: ShimLogger;
}
/**
 * Strip anything token-shaped before it crosses to the browser.
 *
 * Ported from the upstream status route. Every error string that reaches the
 * page goes through this: an upstream failure can echo back request material,
 * and a page with no authentication must not become a way to read a credential
 * out of a diagnostic.
 */
declare function redactForBrowser(text: string): string;
/**
 * Start the UI server.
 *
 * Returns `ready` rather than awaiting the listen, so a caller can hold the
 * handle before the port is known — the same shape the shim exposes.
 */
declare function createWorkBuddyUiServer(options: WorkBuddyUiOptions): WorkBuddyUiServer;
//#endregion
//#region src/standalone/bridge.d.ts
/** Options for {@link WorkBuddyBridge}. */
interface BridgeOptions {
  /** Variants to serve; defaults to both products. */
  variants?: readonly WorkBuddyVariant[];
  /** Where the shim logs upstream stream failures. */
  logger?: ShimLogger;
  /**
   * Explicit desktop auth-file paths per variant id, in account order.
   *
   * One path serves that account exactly as the desktop default would.
   * Several paths serve several accounts of the same product at once — each
   * becomes its own runtime with its own store, shim, port, and endpoint,
   * labelled by the account's nickname once the sweep has seen a credential.
   * Absent (or empty) means the variant's usual desktop discovery.
   */
  authFiles?: ReadonlyMap<string, readonly string[]>;
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
  discoverAccounts?: boolean;
  /**
   * Expose one extra pool endpoint per product that serves its accounts with
   * failover: a request whose failure another account could survive (out of
   * credits, rate-limited, dead session, upstream 5xx) is retried on the
   * next account, so one account's quota is no longer a single point of
   * failure. Only created for products serving two or more accounts — a
   * one-member pool would just duplicate the account's own endpoint.
   */
  pool?: 'failover';
  /**
   * Regroup the upstream's tiny reasoning deltas into larger chunks before
   * they reach the client. Default on: the upstream sends reasoning a word or
   * two at a time, and a client that starts a new thinking block per closed
   * reasoning block renders one block per word. Set false to forward the
   * stream exactly as received.
   */
  coalesceReasoning?: boolean;
}
/**
 * Both variants' loopback endpoints, running for the life of the process.
 *
 * Start order is load-bearing: every variant's shim must hold a port before
 * the bridge publishes anything, because the published base URL *is* the
 * shim's origin and it is only known once the listener is up.
 */
declare class WorkBuddyBridge {
  private readonly runtimes;
  private readonly pools;
  private readonly options;
  private timer;
  private stopped;
  private startedAtMs;
  constructor(options?: BridgeOptions);
  /**
   * The last step before a chat result reaches the shim: regroup reasoning
   * deltas unless the operator turned that off. Failures pass through
   * untouched, so error handling is unaffected.
   */
  private finishChat;
  /**
   * Bring up every variant's endpoint and publish the descriptor.
   *
   * A variant that fails to start is skipped rather than fatal — the same
   * containment the plugin applies, so a machine with only one of the two apps
   * installed still serves that one.
   */
  start(): Promise<BridgeDescriptor>;
  /**
   * One pool endpoint per product that serves two or more accounts.
   *
   * The pool rides on the same shim the accounts use — same gates, same
   * per-process secret — but its store and client are the failover router,
   * so the shim never learns the difference. Only products with several
   * accounts get one: a single-member pool would just duplicate that
   * account's own endpoint with a second port to configure.
   */
  private startPools;
  /** The descriptor as of the last publish. */
  publish(): Promise<BridgeDescriptor>;
  /** Write the descriptor to disk and return it. */
  publishToDisk(): Promise<BridgeDescriptor>;
  /** Current endpoints, without touching disk. */
  endpoints(): BridgeEndpoint[];
  /**
   * Build the web UI's state document.
   *
   * Deliberately carries **no bearer token**. The UI page cannot be
   * authenticated — a browser navigation cannot attach an `Authorization`
   * header — so it must not be able to read the secret that authenticates the
   * shim. Only the model list, credit balance, and sign-in identity cross here.
   */
  uiState(): Promise<UiState>;
  /**
   * The pool's UI row. No credit read of its own: credits belong to accounts,
   * and each member's row already shows them — a pool balance would have to
   * pick one member's number and present it as the pool's, which is a lie.
   */
  private uiPoolOf;
  /** One endpoint's UI row, including a live credit read. */
  private uiEndpointOf;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
  private endpointOf;
  /** The pool's descriptor row. Provider id gets a `-pool` suffix so tooling that filters by product id does not match it. */
  private poolEndpointOf;
  private startVariant;
  private syncAll;
  /**
   * The pool's model list is the union of its members' lists, first account
   * wins per model id. The accounts all belong to one product, so their
   * rosters are near-identical and the union is mostly a deduplication — but
   * it is the honest answer to "what can this endpoint serve": any model any
   * member can serve, since failover means the answering account is not
   * known until the request fails or succeeds.
   */
  private syncPool;
  /**
   * Reconcile one variant with its credentials.
   *
   * Three transitions matter, mirroring the plugin's sweep: signed-out hides
   * the list, a first sighting or an identity change re-seeds from the saved
   * catalog and fetches, and an unchanged identity only retries a fetch that
   * previously failed and is now due.
   */
  private syncVariant;
  /**
   * Fetch one variant's catalog for the current credential.
   *
   * Single-flight per identity: a second caller joins the in-flight fetch, and
   * a response whose identity has since been superseded writes nothing — which
   * is what stops a slow answer from resurrecting a departed account's roster.
   * Uses `resolve()`, not `current()`, so an expired token is renewed rather
   * than failing every request until something else refreshes it.
   */
  private fetchCatalog;
}
//#endregion
//#region src/standalone/coalesce.d.ts
/**
 * Wrap a successful chat result so its stream carries one reasoning event per
 * thinking phase.
 *
 * Returns the result untouched when it is a failure or has no body, so callers
 * can apply this unconditionally.
 */
declare function coalesceReasoning(result: WorkBuddyChatResult): WorkBuddyChatResult;
//#endregion
//#region src/standalone/pool.d.ts
/**
 * The store surface the pool needs from each member. Structural, so tests
 * can stand in stubs; the real bridge passes each account runtime's pieces.
 */
interface WorkBuddyPoolMember {
  /** Resolves this member's credential, refreshing it when due. */
  store: Pick<WorkBuddyCredentialStore, 'resolve'>;
  /** Sends this member's chat turn upstream. */
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>;
}
/**
 * Upstream failure classes where a different account could plausibly
 * succeed, and are therefore worth failing over on:
 *
 * - `hard_credit` — this account's quota is gone; another account's is not
 * - `soft_rate` — this account is throttled; another is not
 * - `session_dead` — this credential cannot be renewed; another may be fine
 * - `server` — a 5xx may be account-scoped (per-account channel state), and
 *   retrying the identical request on another account is what the upstream's
 *   own 「请重新发送」 advice asks for
 *
 * Everything else stays on the failing member: a `client` (400) failure is a
 * property of the *request*, so every account would answer it identically,
 * and a transport error is a property of the *network*, which is shared.
 */
declare const POOL_FAILOVER_KINDS: ReadonlySet<UpstreamErrorKind>;
/** Why a pool member could not be attempted, surfaced for diagnosis. */
interface WorkBuddyPoolAttempt {
  /** Position in the member list, 0-based. */
  index: number;
  /** What this member's attempt produced, or why it was skipped. */
  outcome: {
    state: 'ok';
  } | {
    state: 'credential-error';
    message: string;
  } | {
    state: 'upstream-error';
    status: number;
    kind: UpstreamErrorKind;
    message: string;
  };
}
/**
 * One pool endpoint's request router.
 *
 * Implements the two pieces the shim consumes — `store.resolve()` and
 * `client.chatStream()` — over the member list. `resolve()` exists only as
 * the shim's signed-in existence check: it answers with the head member's
 * credential when any member has one, so a pool where every account is
 * signed out still produces the shim's 401 rather than a confused 500. The
 * real per-attempt credential resolution happens inside {@link chatStream}.
 */
declare class WorkBuddyFailoverPool {
  private readonly members;
  /** Where the next request starts; advances past failed members. */
  private head;
  constructor(members: readonly WorkBuddyPoolMember[]);
  /** How many accounts the pool can draw from. */
  get size(): number;
  /** The shim's signed-in existence check: any member's credential will do. */
  resolve(): Promise<WorkBuddyCredential>;
  /**
   * Send one chat turn through the pool.
   *
   * The `credential` argument is the shim's resolved head credential and is
   * deliberately ignored: each attempt resolves its own member's credential,
   * because the whole point is that the answering account is chosen by the
   * failure pattern, not by whoever happened to be head when the request
   * arrived. Returns the first success; otherwise the last failure seen.
   */
  chatStream(_credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal, onAttempt?: (attempt: WorkBuddyPoolAttempt) => void): Promise<WorkBuddyChatResult>;
}
//#endregion
//#region src/standalone/wsl.d.ts
/**
 * Are we running *inside* WSL, rather than on the Windows host?
 *
 * This decides which address to hand an agent: inside WSL the loopback URL is
 * useless and `wslBaseUrl` is the only one that resolves. Detection is two
 * cheap checks — the env var WSL sets, and the kernel banner, which every WSL
 * kernel carries "microsoft" in. Both are needed because `WSL_DISTRO_NAME` is
 * absent in some login paths (a bare `sh -c` from Windows, for instance).
 */
declare function isRunningInWsl(): boolean;
/**
 * IPv4 addresses of the Windows-side WSL virtual switch, if any.
 *
 * Empty on a machine without WSL, which is not an error — it is how the caller
 * knows there is nothing to expose.
 */
declare function wslHostAddresses(): string[];
/** A running forwarder. */
interface WslForwarder {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The address WSL should use, e.g. `http://172.20.96.1:41000`. */
  url(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WslForwarderOptions {
  /** Loopback origin of the service to re-expose, e.g. `http://127.0.0.1:53801`. */
  target: string;
  /** Which host address to bind; one of {@link wslHostAddresses}. */
  host: string;
  logger?: ShimLogger;
}
/**
 * Start a forwarder from `host` to the loopback `target`.
 *
 * The Host header is rewritten to the target's before forwarding, because the
 * shim's own gate requires a loopback Host and would otherwise reject every
 * request that arrived through here. Everything else — method, path, body,
 * `Authorization` — passes through unchanged, and the response is piped rather
 * than buffered so the shim's `text/event-stream` chat responses keep
 * streaming.
 */
declare function createWslForwarder(options: WslForwarderOptions): WslForwarder;
//#endregion
export { BRIDGE_DESCRIPTOR_FILENAME, type BridgeDescriptor, type BridgeEndpoint, type BridgeOptions, POOL_FAILOVER_KINDS, type UiCreditAccount, type UiCredits, type UiEndpoint, type UiModel, type UiState, WorkBuddyBridge, WorkBuddyFailoverPool, type WorkBuddyPoolAttempt, type WorkBuddyPoolMember, type WorkBuddyUiOptions, type WorkBuddyUiServer, type WslForwarder, type WslForwarderOptions, bridgeDescriptorCandidates, bridgeDescriptorPath, coalesceReasoning, createWorkBuddyUiServer, createWslForwarder, isRunningInWsl, main, readBridgeDescriptor, redactForBrowser, removeBridgeDescriptor, writeBridgeDescriptor, wslHostAddresses };