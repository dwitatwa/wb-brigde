import { A as UpstreamErrorKind, B as WorkBuddyUpstreamClient, D as WorkBuddyVariant, M as WorkBuddyChatResult, m as WorkBuddyCredentialStore, n as ShimLogger, p as WorkBuddyCredential, t as LoopbackEndpoint, z as WorkBuddyRegion } from "./shim-C_F_ZwL7.js";
import { t as main } from "./cli-Cr0TbRBT.js";
import { ServerResponse } from "node:http";
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
/** One served provider or pool, as an external client needs to address it. */
interface BridgeEndpoint {
  /** Built-in product, pool, or configured custom provider id. */
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
  /** Whether credentials are usable (or not required); not a connectivity check. */
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
//#region src/standalone/account-probe.d.ts
/** How long one probe turn may take before it is abandoned. */
declare const CHAT_PROBE_TIMEOUT_MS = 60000;
/** What to probe: one endpoint plus the credential it accepts. */
interface ChatProbeOptions {
  /**
   * The OpenAI-compatible base URL — for a bridge endpoint, **including** the
   * `/v1` suffix the descriptor publishes; for a provider's own upstream, its
   * configured base URL. Getting this wrong is not a subtle failure: a shim
   * answers `/chat/completions` with its own 404, which reads exactly like an
   * upstream refusal.
   */
  baseUrl: string;
  /**
   * The bearer token an agent would be configured with. Absent (or empty)
   * sends no Authorization header — how a no-authentication provider is probed.
   */
  token?: string;
  /** The model to ask for; must be one this endpoint serves. */
  model: string;
  /** Override the default timeout, in milliseconds. */
  timeoutMs?: number;
  /** Caller cancellation, e.g. the browser hanging up mid-turn. */
  signal?: AbortSignal;
}
/** What one probe produced, in the terms a user needs to read. */
interface ChatProbeResult {
  ok: boolean;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** Wall time from request to the last byte of the answer. */
  latencyMs: number;
  /** A short factual account: status, size, termination, first text — or the error. */
  detail: string;
}
/**
 * Send one minimal streaming chat turn and classify what came back.
 *
 * Never throws: a refused connection, a timeout and a 402 are all answers to
 * "can this account serve a turn", and the caller renders them the same way.
 */
declare function probeChatTurn(options: ChatProbeOptions): Promise<ChatProbeResult>;
/** Send one prepared chat turn through an account's own upstream path. */
type AccountTurnSender = (bodyJson: string, signal?: AbortSignal) => Promise<WorkBuddyChatResult>;
/**
 * One member probe, as the bridge hands it to the probe implementation.
 *
 * An account member is probed in process: there is no per-account endpoint to
 * knock on any more, so the probe carries a turn sender that runs the same
 * upstream call a pool-served request runs. A provider member is probed over
 * HTTP at its own base URL, with its own key and nobody else's.
 */
interface MemberProbeOptions {
  /** The pool's provider id and the member's position in it, for diagnostics. */
  provider: string;
  index: number;
  /** The model the probe asks for; the bridge has already validated it. */
  model: string;
  /** A provider member's upstream base URL; present exactly for providers. */
  baseUrl?: string;
  /** The provider member's API key; absent means no authentication header. */
  apiKey?: string;
  /** Send one prepared chat turn at an account member through its own path. */
  sendTurn?: AccountTurnSender;
}
//#endregion
//#region src/standalone/provider-config.d.ts
/**
 * Pure parser for the custom-provider configuration document. No I/O, no
 * Node builtins — the loader that reads a file lives with the caller, and
 * the parser here is the only place validation rules are defined.
 *
 * The document shape is:
 *
 * ```json
 * {
 *   "version": 1,
 *   "providers": [
 *     { "id": "my-llm", "displayName": "My LLM", "baseUrl": "https://api.example.com/v1",
 *       "apiKeyEnv": "MY_API_KEY", "models": ["gpt-x", "gpt-y"] }
 *   ]
 * }
 * ```
 *
 * `baseUrl` is the **full API prefix**: the shim appends `/chat/completions`
 * itself, so a gateway that mounts OpenAI under a non-`/v1` path works as-is.
 * `apiKeyEnv` is optional; a provider without one is served without an
 * upstream credential (for local gateways that need none).
 *
 * Error messages name the offending field by path but never echo config
 * values, so a secret-bearing document can be logged safely.
 *
 * @module workbuddy-bridge/provider-config
 */
/** The only config document version this parser accepts. */
declare const PROVIDER_CONFIG_VERSION = 1;
/** One custom OpenAI-compatible provider. */
interface ProviderConfigEntry {
  /** Slug identifier, unique across the document, not a built-in id. */
  id: string;
  /** Optional display label for `status`, `models`, and the web UI. */
  displayName?: string;
  /** Full API prefix; `/chat/completions` is appended by the endpoint. */
  baseUrl: string;
  /**
   * Environment variable holding the upstream API key, resolved per request.
   * Absent means the provider is served without an upstream credential.
   */
  apiKeyEnv?: string;
  /** Model ids offered on `/v1/models`, nonempty and unique, kept verbatim. */
  models: string[];
}
/** A validated custom-provider document. */
interface ProviderConfigDocument {
  providers: ProviderConfigEntry[];
}
/** Discriminated parser result. */
type ParseResult = {
  ok: true;
  config: ProviderConfigDocument;
} | {
  ok: false;
  error: string;
};
/** Parse and validate an already-read config value (an object from JSON). */
declare function parseProviderConfig(input: unknown): ParseResult;
//#endregion
//#region src/standalone/account-store.d.ts
/** One stored account, as the UI lists it. Metadata only — never a token. */
interface StoredAccount {
  /** The account identity, which is also the file's basename. */
  uid: string;
  /** The desktop file this copy came from, for the operator's benefit. */
  origin: string;
  /** When the copy was written. */
  savedAtMs: number;
  /** Whether the stored document is a 5.6 at-rest envelope. */
  encrypted: boolean;
  /**
   * Which product's upstream this sign-in belongs to, when it can be read.
   *
   * Absent means the document carried no domain, which is not a guess the
   * store will make: such an account is offered to every variant and the
   * credential store refuses it where it does not belong.
   */
  region?: WorkBuddyRegion;
}
/**
 * What the page can do with WorkBuddy accounts.
 *
 * Deliberately narrow: **list**, **import** one desktop sign-in file, and
 * **remove** one stored account. There is no "edit" — a sign-in file is a
 * credential blob, and changing it is not a page operation. There is also no
 * way to reach the desktop app's own directory: this surface only ever touches
 * the bridge's copy, and it never scans, so the pool's membership is exactly
 * the set of files the operator uploaded.
 */
interface AccountManagement {
  /** The stored accounts, metadata only. */
  list(): Promise<readonly StoredAccount[]>;
  /**
   * Store one sign-in file and serve it from the next request. `text` is the
   * file's own bytes; the manager validates and refuses a foreign envelope.
   */
  import(input: {
    text: string;
    origin?: string;
  }): Promise<StoredAccount>;
  /** Remove one stored account; `removed: false` when it was not there. */
  remove(uid: string): Promise<{
    removed: boolean;
    total: number;
  }>;
}
//#endregion
//#region src/standalone/provider-store.d.ts
/**
 * The UI-managed provider store: file-backed CRUD for custom
 * OpenAI-compatible providers the user adds from the web UI (rather than a
 * config file the CLI reads).
 *
 * Responsibilities, in the shape the UI and the bridge agreed:
 *
 * - **Validation** — one authoritative `validateSave` for every save; unknown
 *   fields reject; the base URL re-uses the file-config parser's rules
 *   (https, or http only for loopback). Error messages name the offending
 *   field but never echo a value, because a payload can carry a key.
 * - **Ids** — generated from the display name's slug, collision-safe by
 *   suffix, and checked against the reserved set the file-config parser
 *   enforces, so a managed provider can never shadow a built-in product or a
 *   pool endpoint. The id is immutable across edits.
 * - **Revisions** — an opaque token; every mutation demands the caller's
 *   revision to match the current document's, so a stale tab (or a stale
 *   process) fails with 409 instead of overwriting.
 * - **Secrets** — the key is written only into the document; every answer,
 *   error, and log line carries `hasApiKey` instead. `authMode: 'none'`
 *   clears it; an edit that omits the key keeps the stored one.
 * - **Durability** — atomic write plus an advisory lock (the shared
 *   `core/atomic-write.ts` helpers), POSIX 0600/0700 via the write itself,
 *   and a Windows restriction pass over the credential directory through an
 *   injectable seam (`restrictCredentialDir`) so tests never spawn and the
 *   production seam never puts the key on a command line (it takes a path,
 *   nothing else).
 *
 * There is deliberately **no encryption**: the plan approved plaintext at
 * rest under the user's own home directory with restrictive permissions —
 * the same trust level as the config file this store parallels — and
 * pretending otherwise would only misstate the threat model.
 *
 * A corrupt or unrecognized document **fails safe**: reads report an error
 * and writes refuse, so a broken file can never be silently overwritten with
 * an empty roster. Recovery is human: fix or delete the file.
 *
 * @module workbuddy-bridge/standalone/provider-store
 */
/** On-disk format version this store reads and writes. */
declare const MANAGED_PROVIDERS_VERSION = 1;
/** Directory name under the bridge home holding the managed store. */
declare const MANAGED_PROVIDERS_DIRNAME = "managed-providers";
/** Document filename inside {@link MANAGED_PROVIDERS_DIRNAME}. */
declare const MANAGED_PROVIDERS_FILENAME = "providers.json";
/** One UI-managed provider, as every response carries it. Metadata only. */
interface ManagedProvider {
  id: string;
  displayName: string;
  /** The full OpenAI-compatible API prefix; `/chat/completions` is appended. */
  baseUrl: string;
  models: string[];
  authMode: 'api-key' | 'none';
  /** Whether a key is stored — never the key itself. */
  hasApiKey: boolean;
}
/** The store's answer: the current roster and its concurrency token. */
interface ManagedProviderSnapshot {
  revision: string;
  providers: ManagedProvider[];
}
/** The management surface the UI and the bridge expose. */
interface ProviderManagement {
  list(): Promise<ManagedProviderSnapshot>;
  save(input: unknown): Promise<ManagedProviderSnapshot>;
  remove(input: unknown): Promise<ManagedProviderSnapshot>;
}
/**
 * A manager rejection with an HTTP status and a message safe to show: no
 * field value, no key, no filesystem detail ever appears in one.
 */
declare class ProviderManagementError extends Error {
  readonly status: number;
  constructor(status: number, message: string);
}
/** Options for {@link WorkBuddyManagedProviderStore}. */
interface WorkBuddyManagedProviderStoreOptions {
  /** Explicit document path; defaults to the bridge home's managed directory. */
  path?: string;
  /**
   * Restrict the credential directory to the current user on platforms whose
   * mode bits cannot (Windows). Injectable so tests never spawn a process;
   * the production seam takes the path and nothing else — a key never rides
   * a command line because the store never passes one.
   */
  restrictCredentialDir?: (dir: string) => Promise<void>;
}
/**
 * The file-backed managed-provider store. Every operation serializes through
 * the document's advisory lock, so two tabs (or two processes) cannot lose
 * each other's writes, and the revision check turns a loser into a 409
 * instead of a silent overwrite.
 */
declare class WorkBuddyManagedProviderStore implements ProviderManagement {
  private readonly path;
  private readonly dir;
  private readonly restrictCredentialDir;
  constructor(options?: WorkBuddyManagedProviderStoreOptions);
  /** The document path, for diagnostics and tests. */
  filePath(): string;
  /**
   * The id a new provider with this display name would get, **without
   * persisting anything** — the staging step's dry run. `undefined` when the
   * name would generate an unusable or reserved id (the caller treats that
   * as a validation failure). Collision suffixes depend on what is already
   * stored, so a concurrent create can still change the final id; the commit
   * is authoritative.
   */
  previewId(displayName: unknown): string | undefined;
  /**
   * Create the credential directory with 0700 **before** the lock runs:
   * `withFileLock` makes its own recursive mkdir with default modes, so
   * letting it create the directory would leave a 0755 credential directory
   * behind. chmod after mkdir repairs a directory an older version created
   * wide; the Windows seam runs in the same place. A failed ACL pass fails
   * closed — the caller refuses to write a credential into a directory whose
   * protection could not be verified.
   */
  private ensurePrivateDir;
  list(): Promise<ManagedProviderSnapshot>;
  /**
   * The full committed state under one lock: the metadata snapshot AND every
   * provider's captured credential, from the **same** document at the **same**
   * revision. The runtime consumes this so a configuration and its key can
   * never be assembled from two different commits (this process's or another
   * process's). Secrets live in the return value only — never in the public
   * projection, never in a log.
   */
  loadInternal(): Promise<{
    metadata: ManagedProviderSnapshot;
    secrets: Record<string, string | undefined>;
  }>;
  /**
   * The transactional save: validates and persists exactly like {@link save},
   * then returns the committed state (metadata + captured keys) from the same
   * document the commit wrote, under the same lock.
   *
   * `blockedIds` names ids the runtime already serves under other ownership
   * (external configured providers): the FINAL allocated id — collision
   * suffix included — may not take one, so a create can never shadow an
   * external endpoint.
   */
  saveInternal(input: unknown, options?: {
    blockedIds?: readonly string[];
  }): Promise<{
    metadata: ManagedProviderSnapshot;
    secrets: Record<string, string | undefined>;
  }>;
  /** The public metadata-only save: a thin projection over the transaction. */
  save(input: unknown): Promise<ManagedProviderSnapshot>;
  /** The transactional remove: same contract as {@link remove} with the internal return. */
  removeInternal(input: unknown): Promise<{
    metadata: ManagedProviderSnapshot;
    secrets: Record<string, string | undefined>;
  }>;
  /** The public metadata-only remove: a thin projection over the transaction. */
  remove(input: unknown): Promise<ManagedProviderSnapshot>;
  /**
   * Load, mutate, and persist under one lock, checking the caller's revision
   * against the document just loaded — the cross-tab and cross-process guard.
   */
  private withDocumentInternal;
  /** Read and parse the document; a corrupt one fails safe. */
  private readUnderLock;
}
//#endregion
//#region src/standalone/pool.d.ts
/**
 * The store surface the pool needs from each member. Structural, so tests
 * can stand in stubs; the real bridge passes each account runtime's pieces.
 */
interface WorkBuddyPoolMember {
  /**
   * A stable label for this member, used to keep the head on the same account
   * when the member list changes. Absent means the member is addressed by
   * position, which is what every pre-existing caller does.
   *
   * Must be unique among the members of one pool and must not change for the
   * life of the member; the account's uid is the natural choice.
   */
  id?: string;
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
 * - `session_dead` — this credential cannot be renewed, or the gateway has
 *   restricted the account itself; another may be fine
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
 * What the pool has observed about one member's traffic.
 *
 * Exists for the UI: a pool is one endpoint over several accounts, so the
 * only way an operator can see *which* account is carrying the load — or
 * which one has started failing — is for the router to remember. Counts are
 * since process start; nothing here is persisted, because a restart genuinely
 * resets the head and the evidence that shaped it.
 */
interface WorkBuddyPoolMemberHealth {
  /** Position in the member list, 0-based — what a test request names. */
  index: number;
  /** When this member was last attempted, or 0 before any traffic. */
  lastAttemptAtMs: number;
  /** The last attempt's outcome, or undefined before any traffic. */
  lastOutcome?: WorkBuddyPoolAttempt['outcome'];
  /** Failures since this member last succeeded; what makes it look unhealthy. */
  consecutiveFailures: number;
  /** Turns this member served successfully. */
  successes: number;
  /** Attempts on this member that failed. */
  failures: number;
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
 *
 * The member list is replaceable through {@link setMembers}, which is what
 * lets an account added from the page serve from the next request without the
 * listener being rebuilt. The head survives that call: it is stored as an
 * identity when members name one, so appending an account cannot move live
 * traffic onto it.
 */
declare class WorkBuddyFailoverPool {
  /** Where the next request starts; advances past failed members. */
  private head;
  /** The identity the head belongs to, when the members name one. */
  private headId;
  private members;
  /** Per-member traffic record, parallel to `members`. */
  private observed;
  /**
   * An empty membership is allowed: accounts arrive only by upload, so a pool
   * exists before the first one does. Every request answers the shim's 401
   * until a member is added, which is the same state a pool whose every
   * account is signed out reports.
   */
  constructor(members: readonly WorkBuddyPoolMember[]);
  /** One all-zero traffic record per member. */
  private static freshRecords;
  /**
   * Replace the member list, keeping the head on the same account.
   *
   * Traffic records follow a member's identity when it has one, so an account
   * that has already served keeps its success and failure counts across an
   * edit. A member with no identity is matched by position, which is the
   * behaviour every caller had before membership could change.
   *
   * An empty list is accepted: the last account can be removed from the page,
   * and the endpoint must survive that so the URL a client was configured with
   * keeps working once an account is added again.
   */
  setMembers(members: readonly WorkBuddyPoolMember[]): void;
  /** How many accounts the pool can draw from. */
  get size(): number;
  /** The member that will answer the next request, 0-based. */
  headIndex(): number;
  /** A copy of each member's traffic record, in member order. */
  memberHealth(): readonly WorkBuddyPoolMemberHealth[];
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
   *
   * The member list is read once into a local, so a membership change mid-turn
   * cannot make one request see two different pools. The head start and the
   * traffic records are captured with it for the same reason: `setMembers`
   * replaces all three, and a turn that began before the change must finish
   * against the pool it started on.
   */
  chatStream(_credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal, onAttempt?: (attempt: WorkBuddyPoolAttempt) => void): Promise<WorkBuddyChatResult>;
}
//#endregion
//#region src/standalone/request-log.d.ts
/** How many turns one process remembers. */
declare const REQUEST_LOG_LIMIT = 200;
/** How many rows one endpoint's card shows. */
declare const REQUEST_ROWS_PER_CARD = 20;
/** One member's part in a pooled turn. */
interface WorkBuddyRequestAttempt {
  /** The account's nickname, or a positional label. */
  account: string;
  /** `ok`, a failure class, or the account's credential refusing to resolve. */
  outcome: 'ok' | 'credential-error' | UpstreamErrorKind;
  /** The upstream's status for a failed attempt. */
  status?: number;
}
/** One turn, as the log remembers it. */
interface WorkBuddyRequestRecord {
  /** Monotonic id, so two identical-looking turns stay distinguishable. */
  id: number;
  atMs: number;
  /**
   * Stable key of the endpoint the agent addressed: `<provider>#<account>` for
   * an account endpoint, `<provider>-pool` for a pool. Two accounts of one
   * product share a provider id, so the account has to be part of the key.
   */
  endpoint: string;
  /** The account that answered, for an endpoint that fronts one account. */
  account?: string;
  model: string;
  /** The upstream's status: 200 when the turn was accepted. */
  status: number;
  outcome: 'ok' | UpstreamErrorKind;
  /** Wall time until the shim had a verdict — the first byte, not the last. */
  latencyMs: number;
  /** The failover chain, in attempt order; present only when more than one was tried. */
  attempts?: readonly WorkBuddyRequestAttempt[];
}
/** Pull `model` out of a request body without assuming it parses. */
declare function modelOfBody(bodyJson: string): string;
/**
 * Flatten one pool attempt for the log.
 *
 * The attempt's message is dropped deliberately: it is upstream error text
 * that can echo request material, and `failure-capture.ts` already keeps it
 * for the failures that need it. What survives is the class and the status,
 * which is what makes a chain readable.
 */
declare function attemptRecord(attempt: WorkBuddyPoolAttempt, labelOf: (index: number) => string): WorkBuddyRequestAttempt;
/**
 * A fixed-size ring of recent turns, newest last.
 *
 * `record()` is called on the hot path of every request, so it does no I/O and
 * cannot throw: a log that fails a turn would be worse than no log.
 */
declare class WorkBuddyRequestLog {
  private readonly limit;
  private readonly entries;
  private nextId;
  constructor(limit?: number);
  /** How many turns are remembered. */
  get size(): number;
  /** Add one turn, dropping the oldest when the ring is full. */
  record(input: Omit<WorkBuddyRequestRecord, 'id' | 'atMs'>): WorkBuddyRequestRecord;
  /** One endpoint's most recent turns, newest first. */
  recent(endpoint: string, limit?: number): readonly WorkBuddyRequestRecord[];
}
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
/** One member of a failover pool, as the UI shows it. */
interface UiPoolMember {
  /** Position in the pool's member list, 0-based — what a test request names. */
  index: number;
  /** 1-based position among the product's accounts. */
  accountIndex: number;
  /** The account's nickname, or a positional label while none is known. */
  label: string;
  /** The account uid (email or user id), when known. */
  uid?: string;
  signedIn: boolean;
  /**
   * The account's own endpoint, so a row can be matched to its card. Absent
   * since per-account endpoints were removed — a member has no endpoint of
   * its own to name; the pool card is the only address an agent uses.
   */
  baseUrl?: string;
  /** Whether this member will answer the next request. */
  head: boolean;
  /** Turns this member served successfully since the bridge started. */
  successes: number;
  /** Attempts on this member that failed. */
  failures: number;
  /** Failures since this member last succeeded. */
  consecutiveFailures: number;
  lastAttemptAtMs?: number;
  /** The last attempt's class, for a status pill. */
  lastOutcome?: 'ok' | 'credential-error' | 'upstream-error';
  /** One line describing the last attempt. */
  lastOutcomeDetail?: string;
  credits?: UiCredits;
  creditsError?: string;
  /**
   * Whether the page can edit this member, and under which provider id. A
   * custom-pool member is a provider card of its own, so the pool row can
   * carry the same Edit/Remove controls that card does.
   */
  editId?: string;
}
/**
 * A pool's membership, as one block on its card.
 *
 * Carried on the endpoint rather than as separate endpoint rows because a
 * pool member is not addressable the way an account is: its credits, its
 * failures and its test result only mean anything in relation to the pool
 * that routes to it.
 */
interface UiPool {
  /** Which member answers next, 0-based. */
  headIndex: number;
  members: readonly UiPoolMember[];
  /**
   * What a member is: an account of one product, or a custom provider.
   * Absent means accounts, so an older host document renders unchanged.
   */
  kind?: 'accounts' | 'providers';
}
/**
 * One recent turn, as a card shows it.
 *
 * The record's internal `id` and `endpoint` key are dropped: the card *is* the
 * endpoint, and the id exists to keep two identical-looking turns apart in the
 * log, not to be rendered.
 */
type UiRequestRow = Omit<WorkBuddyRequestRecord, 'id' | 'endpoint'>;
/** One served endpoint, as the UI shows it. */
interface UiEndpoint {
  /** Absent means a WorkBuddy account or pool, for backward compatibility. */
  kind?: 'openai-compatible';
  provider: string;
  displayName: string;
  /** The OpenAI-compatible base URL an agent would use. */
  baseUrl: string;
  /**
   * The WSL-facing base URL, when `--wsl` re-exposes this endpoint on the
   * WSL virtual switch. Absent when the bridge runs without `--wsl`.
   */
  wslBaseUrl?: string;
  /** The bearer token for this endpoint — shown so the user can copy it. */
  token?: string;
  /** The account uid (email or user id), when known. */
  uid?: string;
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
  /** Present only on a failover pool: its members and who answers next. */
  pool?: UiPool;
  /** The most recent turns this endpoint served, newest first. Metadata only. */
  requests: readonly UiRequestRow[];
}
/** The whole document `/api/state` returns. */
interface UiState {
  version: 1;
  startedAtMs: number;
  nowMs: number;
  endpoints: readonly UiEndpoint[];
  /**
   * A persistent banner the host sets in its state callback — set by the
   * standalone runner when a provider change was saved and became active but
   * its endpoint publication (descriptor write or WSL forwarder binding)
   * failed, cleared when publication later succeeds. A fixed, safe string the
   * runner owns; never error text, so no redaction question can arise.
   */
  providerWarning?: string;
}
/** What the page asks the bridge to test: one pool member. */
interface UiProbeRequest {
  /** The pool endpoint's provider id, e.g. `workbuddy-ai-pool`. */
  provider: string;
  /** 0-based member index within that pool. */
  index: number;
  /** Model to test with; the account's first model when absent. */
  model?: string;
}
/** What one probe produced, attributed back to the member that was asked. */
interface UiProbeResult {
  provider: string;
  index: number;
  /** The account's nickname, so a result can be read without the page. */
  label: string;
  model: string;
  ok: boolean;
  /** HTTP status, or 0 when the turn never completed. */
  status: number;
  latencyMs: number;
  detail: string;
}
/**
 * A request the caller got wrong, with the status to answer it with.
 *
 * Separate from an ordinary `Error` because "there is no pool at that
 * provider" and "the upstream refused this account" are different answers: the
 * first is a 404 the page should surface as a bug, the second is a 200 with
 * `ok: false` and is the whole point of the feature.
 */
declare class UiRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string);
}
/**
 * A running UI server.
 */
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
  /**
   * Test one pool member with a real chat turn.
   *
   * Absent means the page renders without test buttons — a read-only UI, which
   * is what an embedder that cannot afford upstream calls should pass.
   */
  probe?: (request: UiProbeRequest) => Promise<UiProbeResult>;
  /**
   * Provider management (add/edit/remove custom OpenAI-compatible providers).
   *
   * Absent means the page is read-only: no editor, no management routes — an
   * embedder that hands out a fixed configuration keeps its read-only UI.
   */
  providers?: ProviderManagement;
  /**
   * WorkBuddy account management: the bridge-owned account folder.
   *
   * Absent means the page shows no account controls at all — an embedder that
   * does not manage accounts keeps the read-only UI it had.
   */
  accounts?: AccountManagement;
  /**
   * Exact extra origins the UI is served from, e.g. the WSL forwarder's URL
   * when the bridge was started with `--wsl`. Called per request so a
   * late-bound forwarder port is seen.
   *
   * Purely host-controlled: the request's own Host or Origin can never add
   * itself to this list. A browser Origin that matches an entry exactly is
   * trusted to *load* the page and poll state; management routes additionally
   * demand the nonce. A merely-loopback Origin (any local port) is trusted for
   * page/state as before, but never for management.
   */
  allowedUiOrigins?: () => string[];
  /**
   * Preferred loopback port, so the page keeps the address the operator has
   * bookmarked. A taken port falls back to an ephemeral one.
   */
  port?: number;
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
  /** Explicit custom providers, validated before any listener starts. */
  providers?: readonly ProviderConfigEntry[];
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
  manageProviders?: boolean;
  /** Where the shim logs upstream stream failures. */
  logger?: ShimLogger;
  /**
   * Explicit desktop auth-file paths per variant id, in account order.
   *
   * One path serves that account exactly as the desktop default would.
   * Several paths serve several accounts of the same product at once — each
   * becomes its own runtime with its own store, shim, port, and endpoint,
   * labelled by the account's nickname once the sweep has seen a credential.
   * Absent (or empty) means the bridge's own account folder, and nothing else.
   */
  authFiles?: ReadonlyMap<string, readonly string[]>;
  /**
   * Keep a bridge-owned account folder and expose it for management.
   *
   * The folder holds a copy of a desktop sign-in file per account, named by
   * the account's uid. It is the **only** way an account joins a pool: the
   * bridge never sweeps the desktop app's auth directory, so the pool's
   * membership is exactly the set of files the operator uploaded, and
   * removing one takes that account out of rotation.
   *
   * Default false: an embedder that never manages accounts is unchanged.
   */
  manageAccounts?: boolean;
  /**
   * Regroup the upstream's tiny reasoning deltas into larger chunks before
   * they reach the client. Default on: the upstream sends reasoning a word or
   * two at a time, and a client that starts a new thinking block per closed
   * reasoning block renders one block per word. Set false to forward the
   * stream exactly as received.
   */
  coalesceReasoning?: boolean;
  /**
   * Send one member probe turn. Defaults to the real probe: upstream HTTP for
   * a provider member, the account's own upstream path for an account.
   *
   * Injectable so a test can answer without an upstream, and so an embedder
   * can substitute a cheaper check.
   */
  probe?: (options: MemberProbeOptions) => Promise<ChatProbeResult>;
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
  persistEndpointIdentity?: boolean;
  /**
   * Whether the persisted bearer secrets may be reused and rewritten. Default
   * true. False keeps tokens memory-only for this run (the `--no-descriptor`
   * promise) while ports stay stable, and never erases a stored token.
   */
  reuseEndpointTokens?: boolean;
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
  private readonly genericRuntimes;
  /** The failover pool over custom providers; present when two or more exist. */
  private customPool;
  private readonly options;
  /** The managed-provider store; present only with `manageProviders: true`. */
  private managedStore;
  /** The bridge-owned account folder; present only with `manageAccounts: true`. */
  private accountStore;
  /**
   * The pinned active snapshot: the managed document this bridge actually
   * serves. `listManagedProviders` answers from here, so the UI can never
   * see a document this process would then fail to act on; a remote commit
   * that moved the on-disk revision surfaces as a 409 on the next operation.
   */
  private managedSnapshot;
  /**
   * The captured keys of the pinned snapshot, in memory only — same commit,
   * same revision as {@link managedSnapshot}. A runtime's snapshot embeds the
   * key from here at stage time; nothing re-reads the disk per request.
   */
  private managedSecrets;
  /**
   * Serializes management operations so a save/remove cannot interleave with
   * another on this bridge; cross-process safety stays with the file lock.
   */
  private manageQueue;
  /** Probe keys (`provider#index`) currently in flight, so a double click cannot double-spend. */
  private readonly probes;
  /** The turns agents have sent, for the UI. Metadata only, in memory, bounded. */
  private readonly requests;
  private timer;
  private stopped;
  private startedAtMs;
  /**
   * What each endpoint bound in an earlier run, so a restart can ask for the
   * same port and token instead of making every client re-copy its settings.
   * Loaded once at start; an empty map means every endpoint starts fresh.
   * Kept current as endpoints bind, so one that closes and reopens within this
   * run (the custom pool, when its last provider leaves and one arrives) asks
   * for the values it just held rather than the ones from the last run.
   */
  private identities;
  /** Whether the bearer secrets in {@link identities} may be reused. */
  private reuseTokens;
  constructor(options?: BridgeOptions);
  /**
   * The last step before a chat result reaches the shim: regroup reasoning
   * deltas unless the operator turned that off. Failures pass through
   * untouched, so error handling is unaffected.
   */
  private finishChat;
  /**
   * Record one turn against the endpoint the agent addressed.
   *
   * Metadata only: the body is parsed for its model name and then dropped, so
   * the log never holds a prompt. Called on the request path, therefore free
   * of I/O — and it cannot fail a turn, because the log is worth less than the
   * request it describes.
   */
  private noteTurn;
  /**
   * Bring up every variant's endpoint and publish the descriptor.
   *
   * A variant that fails to start is skipped rather than fatal — the same
   * containment the plugin applies, so a machine with only one of the two apps
   * installed still serves that one.
   */
  start(): Promise<BridgeDescriptor>;
  /** The store's metadata view, as the generic runtime sees it. */
  private managedToConfig;
  private startEndpoints;
  /**
   * The pool's current members: every custom provider this bridge serves,
   * each with the credential it would send.
   *
   * A managed provider's key comes from the pinned transaction, not from a
   * fresh disk read, so the pool's view and the per-provider endpoints' view
   * are the same commit. External providers keep their `apiKeyEnv` lookup.
   */
  private customPoolMembers;
  /**
   * The port a listener should ask for, when the runner keeps addresses
   * stable. Used for listeners that are not published endpoints — the web UI
   * and the WSL forwarders — so their addresses survive a restart too.
   *
   * Exposed as a method rather than by handing out the map, so the document's
   * rules stay in one place.
   */
  preferredPortFor(key: string): number | undefined;
  /** Record the port a non-endpoint listener actually bound. Never throws. */
  rememberPortFor(key: string, baseUrl: string): Promise<void>;
  /**
   * The port the web UI should ask for. The UI is not a published endpoint, so
   * it has no token — only the address the operator has open matters.
   */
  preferredUiPort(): number | undefined;
  /** Record the port the UI actually bound. Never throws. */
  rememberUiPort(baseUrl: string): Promise<void>;
  /**
   * The port and token an endpoint should ask for, from what it bound last
   * time. Both are preferences — the shim falls back on its own — so this only
   * has to answer "what did we use before".
   */
  private wantedIdentity;
  /**
   * Record what an endpoint actually bound.
   *
   * Never throws and never rejects: a failure to remember makes the *next*
   * start less convenient, which must not fail this one. The port is read back
   * from the live base URL because the shim may have fallen back from the
   * preferred one, and the remembered value has to be the truth.
   */
  private rememberBound;
  /**
   * Keep the custom-provider pool in step with the provider list.
   *
   * The pool is the only endpoint a custom provider is served on, so it
   * exists however many providers there are — one is enough — and closes only
   * when the last one goes. Between states the same listener is kept and only
   * the member list changes, so the published base URL and local token
   * survive every edit.
   */
  private syncCustomPool;
  /**
   * Bring one provider's snapshot into the served set.
   *
   * The pool reads membership live, so attaching a snapshot is all it takes:
   * the pool endpoint serves the provider from its next request, and an edit
   * swaps the snapshot in place without touching any listener.
   */
  private startGeneric;
  /**
   * The pinned active managed snapshot, for the UI's provider editor.
   *
   * Answers from what this bridge actually serves, never straight from the
   * disk: a commit another process made after this bridge started would
   * otherwise describe endpoints the UI cannot then edit (any mutation would
   * 409 against it). Off-bridge loading is a reload/restart.
   */
  listManagedProviders(): Promise<ManagedProviderSnapshot>;
  /**
   * Validate, commit, then expose one managed provider — strictly in that
   * order. The payload's revision must name the pinned state here AND the
   * store's on-disk revision at commit (a second guard under the store's
   * lock), so neither a stale tab nor a stale process can overwrite. A failed
   * save throws before the commit, so the old state keeps serving unchanged
   * and nothing is persisted.
   */
  saveManagedProvider(input: unknown): Promise<ManagedProviderSnapshot>;
  /**
   * Persist one removal, then drop the provider's snapshot — persist first,
   * so a failed remove leaves the serving state unchanged. The payload's
   * revision must name the pinned state here AND the disk's at the store's
   * commit, matching save's dual guard.
   */
  removeManagedProvider(input: unknown): Promise<ManagedProviderSnapshot>;
  /**
   * The bridge-owned account folder's contents, for the page's account list.
   *
   * Metadata only: a stored file's tokens are never read here, let alone sent
   * to a page with no authentication.
   */
  listStoredAccounts(): Promise<StoredAccount[]>;
  /**
   * Store one desktop sign-in file and serve it from the next request.
   *
   * The file is copied verbatim — this never re-seals a token — and an
   * envelope sealed by a different WorkBuddy install is refused with the
   * reason before anything is written. The account joins the pool immediately;
   * the listener is not rebuilt, so the published URL and token are unchanged.
   */
  importStoredAccount(input: {
    text: string;
    origin?: string;
  }): Promise<StoredAccount>;
  /**
   * Remove one stored account from the folder and from the pool.
   *
   * Only the bridge's own copy is deleted — the desktop app's file and its
   * snapshots are untouched, so the account can be added back by copying the
   * same file again. The pool's listener is unchanged; the member leaves the
   * member list, and the head stays on the same account by identity.
   */
  removeStoredAccount(uid: string): Promise<{
    removed: boolean;
    total: number;
  }>;
  /** The product a stored account file is assumed to belong to. */
  private accountVariant;
  /** An account-management call on a bridge that does not manage accounts. */
  private assertAccounts;
  /** Serialize management operations per bridge; cross-process stays on the file lock. */
  private enqueueManagement;
  /** A bridge not started with `manageProviders` has no management surface. */
  private assertManaged;
  /**
   * Shared management payload guard: the payload must be an object carrying
   * the pinned revision, so a stale tab cannot overwrite the active state.
   * The store re-checks the same revision against the disk under its lock —
   * the dual guard for cross-process conflicts.
   */
  private assertPinnedRevision;
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
  private attachManaged;
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
  private poolRuntimeOf;
  /**
   * The auth-file paths one variant should serve, and which of them belong to
   * the bridge's own account folder.
   *
   * Order matters, because the first account keeps the historical
   * plugin-owned credential copy.
   *
   * Two sources, in precedence order:
   *
   * 1. Explicit `authFiles` for this variant — a hand-picked list replaces
   *    everything else, so a caller that names its files is never widened by
   *    the account folder.
   * 2. The bridge's own account folder, when `manageAccounts` is on.
   *
   * **Nothing is discovered.** The desktop app's auth directory is never
   * swept, so an account joins a pool only when its sign-in file is uploaded,
   * and the pool's membership is exactly the set the operator put there.
   *
   * An empty list is a real answer: the pool starts with no members and
   * answers every request as signed out until the first upload.
   */
  private accountSourcesOf;
  /**
   * The stored account files belonging to one product, in save order.
   *
   * The store is not per-variant on disk, so a file is offered only to the
   * product whose region its sign-in names. Without this filter every uploaded
   * account became a member of **both** pools, so an AI account appeared in the
   * CN pool as a permanently signed-out row.
   *
   * A file whose region cannot be read is offered to both: the credential
   * store is the authority on usability and refuses a foreign file with a
   * reason, which is a better outcome than an uploaded account vanishing.
   */
  private storedAccountPaths;
  /**
   * Start a runtime for every stored account not already served.
   *
   * This is what makes an upload take effect without a restart: the file is
   * already in the account folder, so the next call starts its runtime and
   * hands the pool the new member list. The listener is never rebuilt, so the
   * published base URL and token are unchanged.
   *
   * A file already served is skipped by path, so a repeated call adds nothing.
   * Accounts that disappeared are **not** removed here: removing one is the
   * page's explicit Remove action, which drops the runtime directly.
   *
   * Returns how many runtimes were added.
   */
  private addStoredAccounts;
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
  private poolMembersOf;
  /**
   * One pool endpoint per product, whether or not it has accounts yet.
   *
   * Accounts arrive only by upload, so a fresh bridge has none — and the pool
   * must still exist, because the base URL and token an operator copies into
   * a client have to survive the account being added later. With no members
   * every request answers the shim's 401, which is the same state a pool whose
   * accounts are all signed out reports.
   */
  private startPools;
  /** The descriptor as of the last publish. */
  publish(): Promise<BridgeDescriptor>;
  /** Write the descriptor to disk and return it. */
  publishToDisk(): Promise<BridgeDescriptor>;
  /** Current endpoints, without touching disk. */
  endpoints(): BridgeEndpoint[];
  /**
   * Build the web UI's state document. Carries the bearer token so the user
   * can copy it from the pool card. The page itself is still unauthenticated —
   * it relies on the Host/Origin loopback gate — but the token is now part of
   * the rendered state.
   */
  uiState(): Promise<UiState>;
  /**
   * The custom-provider pool's card: its membership, who answers next, and
   * what the router has seen of each provider's real traffic.
   *
   * The same shape the account pool uses, so the page renders one component
   * for both. A provider with no key shows as unavailable rather than as a
   * routing failure; the upstream base URL stays out of the page — the pool
   * card is the only thing an agent is configured with.
   */
  private uiCustomPoolOf;
  /**
   * The pool's UI row: its membership, who answers next, and what the router
   * has seen of each member's real traffic.
   *
   * No credit figure of its own: credits belong to accounts, and each member
   * row shows its own — a pool balance would have to pick one member's number
   * and present it as the pool's, which is a lie. What the pool row adds is
   * the thing no account card can show: the routing state.
   */
  private uiPoolOf;
  /** One pool member row, assembled from the runtime, its health, and its credit read. */
  private uiPoolMemberOf;
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
  probePoolMember(request: UiProbeRequest): Promise<UiProbeResult>;
  /**
   * Test one provider inside the custom pool.
   *
   * Probed over HTTP at the provider's own base URL with its own key — the
   * claim is "this provider can answer", and a test must not move the head or
   * spend a turn on another provider. A provider with no usable key is
   * refused before any call, so a test never becomes an accidental
   * unauthenticated request.
   */
  private probeCustomProvider;
  /** One endpoint's recent turns, newest first, as the page shows them. */
  private uiRequestsOf;
  /** One account's live credit read, for its pool member row. */
  private accountCreditsOf;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
  /**
   * The custom-provider pool's descriptor row.
   *
   * Its provider id is `custom-pool`, which no provider may take (the store
   * and the external parser both reserve it), so tooling that filters by
   * provider id never confuses the pool with one of its members.
   */
  private customPoolEndpointOf;
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
//#region src/standalone/endpoint-identity.d.ts
/**
 * The stable part of a loopback endpoint: its port and its bearer secret.
 *
 * The shim mints both fresh every start — an OS-chosen port and a random
 * in-memory secret — which is safe but makes every restart a reconfiguration:
 * an agent pointed at the old port gets a connection refusal, and one holding
 * the old token gets a 401. This module is the memory that removes that
 * churn. It records what an endpoint actually bound, keyed by the endpoint's
 * published provider id, and the next start asks for those values back.
 *
 * Both are *preferences*, never requirements. A port another process now
 * holds falls back to an ephemeral one, and a missing or unreadable record
 * simply means "start as before". Stability is the common case, not a
 * precondition for starting.
 *
 * Security note: persisting the token has exactly the threat model the
 * descriptor already has — the token is written to a `0600` file under the
 * bridge home, so any process running as the same user can read it. That is
 * why token persistence is separable from port persistence: `--no-descriptor`
 * keeps its promise of an in-memory-only secret by disabling only the token
 * half, while ports (which are not secret) stay stable.
 *
 * @module workbuddy-bridge/standalone/endpoint-identity
 */
/** Basename of the identity document inside the bridge home. */
declare const ENDPOINT_IDENTITY_FILENAME = ".workbuddy-bridge-identity.json";
/**
 * Key used for the web UI's own listener.
 *
 * Not an endpoint — the UI publishes no bearer and is never in the descriptor
 * — but its URL is printed on start and opened by hand, so a stable port is
 * worth the same treatment. The leading space keeps it out of the id space
 * real providers use (ids are slugs, which cannot contain a space).
 */
declare const UI_IDENTITY_KEY = " ui";
/** What was remembered about one endpoint. */
interface EndpointIdentity {
  /** The port it last bound. Absent when nothing usable was recorded. */
  port?: number;
  /** The bearer secret it last served, when tokens are persisted at all. */
  token?: string;
}
/** Path of the identity document. */
declare function endpointIdentityPath(): string;
/**
 * Every remembered endpoint, for a caller starting several listeners at once.
 *
 * One read for the whole start: the bridge asks for each pool's values from
 * this map rather than re-reading per endpoint.
 */
declare function loadEndpointIdentities(): Promise<Map<string, EndpointIdentity>>;
/** Options for {@link rememberEndpointIdentity}. */
interface RememberEndpointIdentityOptions {
  /**
   * Whether the bearer secret may be written. False under `--no-descriptor`,
   * which promises an in-memory-only secret; the port is still recorded.
   */
  persistToken: boolean;
}
/**
 * Record what an endpoint actually bound, so the next start can ask for it.
 *
 * Runs under the document's advisory lock and re-reads first, so two bridges
 * starting at once keep each other's keys instead of the last writer wiping
 * the file. Writes nothing when the record is already current, which keeps
 * repeated starts from churning the file.
 */
declare function rememberEndpointIdentity(key: string, identity: EndpointIdentity, options: RememberEndpointIdentityOptions): Promise<void>;
/**
 * The port a published base URL names, or undefined when it cannot be read.
 *
 * Callers have the live base URL, not the bound port, so this is how a
 * just-started endpoint's port reaches the record.
 */
declare function portOfBaseUrl(baseUrl: string): number | undefined;
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
  /** Preferred port on that address; a taken port falls back to an ephemeral one. */
  port?: number;
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
//#region src/standalone/openai-provider.d.ts
/** Upper bound on upstream error body bytes read for diagnostics. */
declare const UPSTREAM_ERROR_BODY_LIMIT: number;
/** Diagnostic hooks the bridge task can wire into its request log. */
interface OpenAIProviderLogger extends ShimLogger {
  /** A chat turn reached a verdict: outcome, status, and timing metadata only. */
  request?: (entry: {
    outcome: 'ok' | 'error';
    status: number;
    model: string;
    durationMs: number;
  }) => void;
}
/**
 * One request-scoped provider configuration: everything a chat turn needs,
 * captured together before the body is read, so a concurrent edit can never
 * give a single turn a half-old configuration — old URL with a new key, old
 * models with a new URL, anything of the sort. The key lives here in memory
 * only; it never reaches a log, a descriptor, or an error message.
 */
interface GenericSnapshot {
  id: string;
  baseUrl: string;
  models: string[];
  /**
   * Where this request's upstream credential comes from. `env` names an
   * environment variable resolved when the snapshot is captured; `stored` is
   * a key captured with the snapshot (managed providers); `none` sends no
   * credential at all.
   */
  auth: {
    kind: 'env';
    envName: string;
    key?: string;
    missing?: boolean;
  } | {
    kind: 'stored';
    key: string;
  } | {
    kind: 'none';
  };
}
/** Constructor dependencies. */
interface OpenAICompatibleShimOptions {
  /**
   * The provider configuration, read per request. Either a fixed value (the
   * legacy file-config case) or a `getSnapshot` accessor — the bridge's
   * managed runtimes pass one so an edit swaps the configuration for new
   * requests while a request that already started keeps the snapshot it
   * resolved. In-flight snapshot stability is the caller's job; the shim
   * reads this once per request and uses that snapshot throughout.
   */
  provider?: Omit<GenericSnapshot, 'auth'> & {
    apiKeyEnv?: string;
    apiKey?: string;
  };
  getSnapshot?: () => Omit<GenericSnapshot, 'auth'> & {
    apiKeyEnv?: string;
    apiKey?: string;
  };
  /**
   * Resolve an environment variable name to its current value. Defaults to
   * `process.env`; injectable so tests (and the host) do not touch the real
   * environment.
   */
  resolveApiKeyEnv?: (name: string) => string | undefined;
  logger?: OpenAIProviderLogger;
  /**
   * How long the upstream may take to send response headers. Defaults to
   * {@link UPSTREAM_HEADERS_TIMEOUT_MS}; injectable so tests can compress
   * the deadline and prove bodies outlive it. Does not bound the body.
   */
  headersTimeoutMs?: number;
}
type OpenAICompatibleShim = LoopbackEndpoint;
/** The sanitized OpenAI-style error body the bridge answers with. */
interface UpstreamErrorPayload {
  message: string;
  type: string;
  code?: string;
  param?: string;
}
/**
 * One upstream turn, after the response headers arrived: the bytes are still
 * unread, so the caller decides how to forward them.
 */
interface UpstreamTurnResponse {
  kind: 'response';
  status: number;
  contentType: string;
  body: ReadableStream<Uint8Array> | null;
}
/** One upstream turn that produced no usable response. */
interface UpstreamTurnFailure {
  kind: 'failure';
  /**
   * `cancelled` — the downstream client went away; nothing should be written.
   * `timeout` — no response headers in time. `unreachable` — the connection
   * failed. `redirect` — a 3xx we refuse to follow. `upstream` — the upstream
   * answered with a non-2xx status.
   */
  reason: 'cancelled' | 'timeout' | 'unreachable' | 'redirect' | 'upstream';
  /** The status the bridge answers the downstream client with. */
  status: number;
  error: UpstreamErrorPayload;
  /**
   * Whether a *different* provider could plausibly answer the same request.
   *
   * Per-provider properties are retryable: a rate limit, a dead or unpaid
   * key, a 5xx from that gateway, a wrong path, or an unreachable host. The
   * request itself is not: a malformed body or an unsupported parameter would
   * be refused identically everywhere, so retrying only multiplies the wait.
   */
  retryable: boolean;
  /** The upstream's own status, when it answered at all. */
  upstreamStatus?: number;
}
type UpstreamTurnResult = UpstreamTurnResponse | UpstreamTurnFailure;
/**
 * Whether an upstream HTTP status is a property of *that* provider rather
 * than of the request, and so is worth retrying elsewhere.
 */
declare function upstreamStatusRetryable(status: number): boolean;
/**
 * Send one chat turn to one provider and stop at the response headers.
 *
 * This is the whole hardened transport in one place, shared by the
 * single-provider shim and the multi-provider pool: manual redirect refusal
 * (the key must never be replayed to an unvetted `Location`), a
 * headers-only deadline that never cuts a long body, downstream cancellation
 * linked through the returned stream, and a bounded, secret-redacted
 * diagnostic for a failed turn.
 *
 * `signal` is the downstream cancellation; the header deadline is internal
 * and per attempt, so a pool retrying a timed-out provider does not abort the
 * whole request.
 */
declare function startUpstreamTurn(request: {
  baseUrl: string;
  apiKey?: string;
}, rawBody: string, options?: {
  signal?: AbortSignal;
  headersTimeoutMs?: number;
}): Promise<UpstreamTurnResult>;
/**
 * Forward one upstream response to the downstream client.
 *
 * Resolves once the response is committed to the wire — for a stream that is
 * after the headers are written, not after the last byte, so the caller can
 * record the turn without waiting for the body.
 */
declare function writeUpstreamTurn(res: ServerResponse, turn: UpstreamTurnResponse, onStreamError?: (error: unknown) => void): Promise<void>;
/**
 * Start the custom-provider loopback endpoint. The bearer it requires is
 * the per-process shared secret from the neutral endpoint — the same
 * publication model as the WorkBuddy shim.
 */
declare function createOpenAICompatibleShim(options: OpenAICompatibleShimOptions): OpenAICompatibleShim;
//#endregion
//#region src/standalone/provider-pool.d.ts
/** The published provider id of the pool endpoint. */
declare const CUSTOM_POOL_ID = "custom-pool";
/** One provider the pool can route to. */
interface CustomPoolMember {
  id: string;
  displayName: string;
  /** Full API prefix; `/chat/completions` is appended per attempt. */
  baseUrl: string;
  /** Model ids this provider offers. */
  models: readonly string[];
  /** A stored key, captured with the configuration (managed providers). */
  apiKey?: string;
  /** An environment variable resolved per request (externally configured). */
  apiKeyEnv?: string;
  /**
   * Whether the page may edit this member. False for a provider that came
   * from the caller's configuration file: it is read-only there.
   */
  managed: boolean;
}
/**
 * One provider frozen for a single request, its credential resolved.
 *
 * Captured before the request body is read, so a concurrent edit can never
 * give one turn a half-old configuration — the defect the single-provider
 * shim already guards against, here applied to the whole member list.
 */
interface CapturedPoolMember extends CustomPoolMember {
  /** The key this request would send, when one is available. */
  key?: string;
  /** The environment variable that was not set, when a key was required. */
  missingEnv?: string;
}
/** A request the pool refuses before any provider is attempted. */
declare class CustomPoolRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string);
}
/** Whether this provider can authenticate right now. */
declare function poolMemberAvailable(member: CustomPoolMember): boolean;
/**
 * Freeze the member list for one request, resolving each provider's
 * credential exactly once. A stored key is copied by value; an environment
 * name is resolved here rather than at attempt time, so the credential and
 * the destination travel together.
 */
declare function capturePoolMembers(members: readonly CustomPoolMember[], resolveEnv?: (name: string) => string | undefined): CapturedPoolMember[];
/**
 * The models the pool can actually serve: the union of every available
 * provider's roster, in member order, deduplicated. A provider whose key is
 * missing contributes nothing, because a request routed to it could only
 * fail — the same rule the single-provider endpoint applies.
 */
declare function poolModelList(members: readonly CustomPoolMember[]): string[];
/** The failure class a provider's HTTP status belongs to. */
declare function errorKindForStatus(status: number): UpstreamErrorKind;
/** What one attempted provider produced. */
type PoolAttemptResult<T> = {
  state: 'ok';
  value: T;
} | {
  state: 'credential-error';
  message: string;
} | {
  state: 'upstream-error';
  status: number;
  kind: UpstreamErrorKind;
  message: string;
  error: UpstreamErrorPayload;
  retryable: boolean;
};
/** The verdict of one routed request: the winner, or the last failure. */
interface PoolRouteOutcome<T> {
  value?: T;
  failure?: {
    status: number;
    kind: UpstreamErrorKind;
    message: string;
    error: UpstreamErrorPayload;
  };
  /** Every provider tried, in attempt order — the chain the UI renders. */
  attempts: WorkBuddyPoolAttempt[];
}
/**
 * The router behind the pool endpoint.
 *
 * Holds no listeners and no credentials of its own: it owns only the routing
 * state — who answers next and what each provider has done — while the
 * endpoint owns the listener and the transport. Membership is passed in on
 * every call rather than stored, so a page view can never move the head or
 * describe a list the next request would not see.
 */
declare class CustomProviderFailoverPool {
  /** Where the next request starts, by id so a membership edit cannot move it. */
  private headMemberId;
  private readonly observed;
  /** Drop routing state for providers that are no longer members. */
  prune(members: readonly CustomPoolMember[]): void;
  /** The member that will answer the next request, 0-based. */
  headIndex(members: readonly CustomPoolMember[]): number;
  /** One record per member, in member order. */
  memberHealth(members: readonly CustomPoolMember[]): readonly WorkBuddyPoolMemberHealth[];
  /**
   * Send one request through the pool.
   *
   * `members` is the request's own captured snapshot, so the routing decision
   * and the credential always come from the same instant. Returns the first
   * success, otherwise the last failure; a non-retryable failure stops the
   * chain because every other provider would answer it identically.
   */
  route<T>(members: readonly CapturedPoolMember[], model: string, attempt: (member: CapturedPoolMember, index: number) => Promise<PoolAttemptResult<T>>, signal?: AbortSignal): Promise<PoolRouteOutcome<T>>;
  /**
   * The eligible providers in attempt order: rotation starts at the head and
   * wraps, so the head's preference survives a model that only some members
   * offer.
   */
  private rotation;
  /** Fold one attempt into that provider's record. */
  private note;
}
/** One routed turn, as the host records it. Metadata only. */
interface CustomPoolTurnRecord {
  endpoint: string;
  model: string;
  status: number;
  outcome: 'ok' | 'error';
  durationMs: number;
  /** Every provider tried, in attempt order. */
  attempts: readonly WorkBuddyPoolAttempt[];
  /** The member labels the attempts' indices refer to. */
  labels: readonly string[];
}
/** Constructor dependencies of {@link createCustomProviderPoolShim}. */
interface CustomProviderPoolOptions {
  /**
   * The member list, read per request. The bridge returns its current
   * configuration snapshot here; the shim captures it before reading the
   * body, so one turn never spans two configurations.
   */
  getMembers: () => readonly CustomPoolMember[];
  resolveApiKeyEnv?: (name: string) => string | undefined;
  /** How long one provider may take to send response headers. */
  headersTimeoutMs?: number;
  /** Called once per routed turn with the failover chain. */
  onTurn?: (record: CustomPoolTurnRecord) => void;
  /** Upstream stream failures, for the host log. */
  onStreamError?: (error: unknown) => void;
  /** Preferred loopback port; a taken port falls back to an ephemeral one. */
  port?: number;
  /** Preferred bearer secret; absent means a fresh random one for this process. */
  token?: string;
}
type CustomProviderPoolShim = LoopbackEndpoint & {
  /**
   * The router actually serving this listener. The host reads routing state
   * from here — a second router instance would report a head and traffic
   * counts that no request ever produced.
   */
  router: CustomProviderFailoverPool;
};
/**
 * Start the pool endpoint: one loopback listener over every custom provider.
 *
 * The listener is permanent for the life of the bridge. Adding, editing, or
 * removing a provider swaps the member list the shim reads, so no provider
 * change ever opens or closes a port, and the published base URL and local
 * token stay stable across edits.
 */
declare function createCustomProviderPoolShim(options: CustomProviderPoolOptions): CustomProviderPoolShim;
//#endregion
export { BRIDGE_DESCRIPTOR_FILENAME, type BridgeDescriptor, type BridgeEndpoint, type BridgeOptions, CHAT_PROBE_TIMEOUT_MS, CUSTOM_POOL_ID, type CapturedPoolMember, type ChatProbeOptions, type ChatProbeResult, type CustomPoolMember, CustomPoolRequestError, type CustomPoolTurnRecord, CustomProviderFailoverPool, type CustomProviderPoolOptions, type CustomProviderPoolShim, ENDPOINT_IDENTITY_FILENAME, type EndpointIdentity, MANAGED_PROVIDERS_DIRNAME, MANAGED_PROVIDERS_FILENAME, MANAGED_PROVIDERS_VERSION, type ManagedProvider, type ManagedProviderSnapshot, type OpenAICompatibleShim, type OpenAICompatibleShimOptions, type OpenAIProviderLogger, POOL_FAILOVER_KINDS, PROVIDER_CONFIG_VERSION, type ParseResult, type PoolAttemptResult, type PoolRouteOutcome, type ProviderConfigDocument, type ProviderConfigEntry, type ProviderManagement, ProviderManagementError, REQUEST_LOG_LIMIT, REQUEST_ROWS_PER_CARD, type RememberEndpointIdentityOptions, UI_IDENTITY_KEY, UPSTREAM_ERROR_BODY_LIMIT, type UiCreditAccount, type UiCredits, type UiEndpoint, type UiModel, type UiPool, type UiPoolMember, type UiProbeRequest, type UiProbeResult, UiRequestError, type UiRequestRow, type UiState, type UpstreamErrorPayload, type UpstreamTurnFailure, type UpstreamTurnResponse, type UpstreamTurnResult, WorkBuddyBridge, WorkBuddyFailoverPool, WorkBuddyManagedProviderStore, type WorkBuddyManagedProviderStoreOptions, type WorkBuddyPoolAttempt, type WorkBuddyPoolMember, type WorkBuddyPoolMemberHealth, type WorkBuddyRequestAttempt, WorkBuddyRequestLog, type WorkBuddyRequestRecord, type WorkBuddyUiOptions, type WorkBuddyUiServer, type WslForwarder, type WslForwarderOptions, attemptRecord, bridgeDescriptorCandidates, bridgeDescriptorPath, capturePoolMembers, coalesceReasoning, createCustomProviderPoolShim, createOpenAICompatibleShim, createWorkBuddyUiServer, createWslForwarder, endpointIdentityPath, errorKindForStatus, isRunningInWsl, loadEndpointIdentities, main, modelOfBody, parseProviderConfig, poolMemberAvailable, poolModelList, portOfBaseUrl, probeChatTurn, readBridgeDescriptor, redactForBrowser, rememberEndpointIdentity, removeBridgeDescriptor, startUpstreamTurn, upstreamStatusRetryable, writeBridgeDescriptor, writeUpstreamTurn, wslHostAddresses };