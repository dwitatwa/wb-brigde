import { B as WorkBuddyUpstreamModel, C as CN_VARIANT, D as electronProfileFor, E as WorkBuddyVariant, G as normalizeCredits, H as extractDisplayErrorMessage, J as prepareCnChatBody, K as parseModelCatalog, L as WorkBuddyRefreshOutcome, M as WorkBuddyCredits, O as variantFor, Q as PROBE_EFFORT_CANDIDATES, R as WorkBuddyRegion, S as AI_VARIANT, T as WorkBuddyElectronProduct, U as isChannelValidationBlock, V as classifyUpstreamError, X as regionOf, Y as prepareInternationalChatBody, Z as upstreamErrorCode, _ as desktopAuthCandidatesFor, a as FALLBACK_WORKBUDDY_AI_MODELS, b as WorkBuddyAtRestKeyProvider, c as WorkBuddyModelInfo, d as WorkBuddyAuthStatus, et as ProbeOutcome, f as WorkBuddyCredential, g as defaultDesktopAuthPath, h as defaultDesktopAuthCandidates, ht as AppVersionInfo, i as createWorkBuddyShim, it as probeModel, j as WorkBuddyChatResult, k as UpstreamErrorKind, l as WORKBUDDY_AUTH_FILENAME, m as WorkBuddyStoreOptions, n as WorkBuddyShim, o as FALLBACK_WORKBUDDY_MODELS, p as WorkBuddyCredentialStore, pt as resolveChatIdentity, q as prepareChatBody, r as WorkBuddyShimOptions, s as WorkBuddyCatalog, st as ChatIdentity, t as ShimLogger, u as WORKBUDDY_AUTH_FILE_ENV, ut as chatUserAgent, v as parseWorkBuddyAuth, vt as appUserAgent, w as WORKBUDDY_VARIANTS, x as atRestKeyProviderFor, xt as resolveAppVersion, y as workbuddyOwnAuthPath, yt as installedAppVersion, z as WorkBuddyUpstreamClient } from "./shim-U171C0Zy.js";
import { a as WorkBuddyProbeStore, c as workbuddyProbePath, d as workbuddyVisibilityPath, f as WORKBUDDY_CATALOG_FILENAME, i as WorkBuddyProbeRecord, l as WORKBUDDY_VISIBILITY_FILENAME, m as workbuddyCatalogPath, n as WorkBuddyProbeStatus, p as WorkBuddyCatalogStore, r as WORKBUDDY_PROBE_FILENAME, t as WorkBuddyProbeService, u as WorkBuddyVisibilityStore } from "./probe-service-DkISd0qs.js";
//#region src/core/atomic-write.d.ts
/**
 * Atomic file writes and advisory file locks, in plain Node.
 *
 * These replace the `@deepseek-ai/dsh-atomic-write` helper the bridge used to
 * import, so the core carries no DeepSeek Harness dependency. The exported
 * names and signatures are deliberately identical to the originals, which is
 * why no call site had to change when the module was swapped in.
 *
 * @module workbuddy-bridge/core/atomic-write
 */
/** Options for {@link writeFileAtomic}. */
interface AtomicWriteOptions {
  /** Permission bits for the written file, applied to the temp file before the rename. */
  mode?: number;
  /** Permission bits for directories this call has to create. */
  dirMode?: number;
}
/**
 * Write a file so a reader never observes a partial document.
 *
 * The bytes land in a uniquely named temp file *in the same directory* as the
 * target, are flushed to disk, and are then renamed over it. Rename within one
 * directory is atomic, so the target holds either the old contents or the new
 * ones and never a truncated mix — which matters here because the credential
 * copy and the catalog cache are read by other processes.
 */
declare function writeFileAtomic(path: string, data: string, options?: AtomicWriteOptions): Promise<void>;
/**
 * Run `fn` while holding an exclusive lock named `<path>.lock`.
 *
 * The lock is an exclusively created (`wx`) marker file. That exact name is
 * part of the contract rather than an implementation detail: the credential
 * store's `logout()` deletes `<ownPath>.lock` alongside its copy, so renaming
 * the suffix would leave a stale marker behind.
 *
 * A holder that dies without releasing is recovered by stealing a lock older
 * than {@link LOCK_STALE_MS} — the same bounded-recovery idea the upstream
 * helper used, and the reason the file carries an mtime at all.
 */
declare function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
//#endregion
//#region src/core/bridge-home.d.ts
/**
 * The bridge's own home directory.
 *
 * This replaces `@deepseek-ai/dsh-home-paths`, the second of the two DeepSeek
 * Harness helpers the core used to import. Every path the bridge owns — the
 * refreshed credential copy, the saved catalogs, the probe records, the model
 * visibility lists, the app-version cache, the host heartbeat — hangs off this
 * one directory, so the whole on-disk footprint moves together.
 *
 * @module workbuddy-bridge/core/bridge-home
 */
/** Env var naming an explicit bridge home. Takes precedence over everything. */
declare const WORKBUDDY_BRIDGE_HOME_ENV = "WORKBUDDY_BRIDGE_HOME";
/** Directory name used under the user's home when nothing else is configured. */
declare const WORKBUDDY_BRIDGE_HOME_DIRNAME = ".workbuddy-bridge";
/**
 * Resolve the bridge home, in precedence order:
 *
 * 1. `$WORKBUDDY_BRIDGE_HOME` — the bridge's own override.
 * 2. `$DSH_HOME` — compatibility. A machine already running the DeepSeek
 *    Harness plugin keeps one home directory, so pointing the standalone
 *    runner at the same place makes the two frontends share a single refreshed
 *    credential copy, catalog cache, and probe-record set instead of each
 *    re-fetching and re-refreshing independently. Leaving `DSH_HOME` unset
 *    (the usual case for a standalone install) skips this step entirely.
 * 3. `~/.workbuddy-bridge` — the standalone default.
 */
declare function resolveBridgeHome(): string;
//#endregion
//#region src/core/loopback.d.ts
/**
 * Shared loopback gates for the plugin's local HTTP surfaces: the loopback
 * shim and the same-origin web-status route. Both are only ever meant to be
 * addressed through the machine's loopback interface.
 *
 * @module dsh-workbuddy-connect/loopback
 */
/** Loopback hostnames a local plugin surface may be addressed by. */
declare const LOOPBACK_HOSTS: Set<string>;
/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
declare function hostIsLoopback(host: string | undefined): boolean;
/**
 * A browser-sent Origin (present header) must be loopback. Non-browser
 * clients (the plugin's own fetch calls) send no Origin at all and pass.
 */
declare function originIsLoopback(origin: string | undefined): boolean;
//#endregion
//#region src/core/version.d.ts
declare const WORKBUDDY_CONNECT_VERSION: string;
//#endregion
export { AI_VARIANT, type AppVersionInfo, type AtomicWriteOptions, CN_VARIANT, type ChatIdentity, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, LOOPBACK_HOSTS, PROBE_EFFORT_CANDIDATES, type ProbeOutcome, type ShimLogger, type UpstreamErrorKind, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_BRIDGE_HOME_DIRNAME, WORKBUDDY_BRIDGE_HOME_ENV, WORKBUDDY_CATALOG_FILENAME, WORKBUDDY_CONNECT_VERSION, WORKBUDDY_PROBE_FILENAME, WORKBUDDY_VARIANTS, WORKBUDDY_VISIBILITY_FILENAME, WorkBuddyAtRestKeyProvider, type WorkBuddyAuthStatus, WorkBuddyCatalog, WorkBuddyCatalogStore, type WorkBuddyChatResult, type WorkBuddyCredential, WorkBuddyCredentialStore, type WorkBuddyCredits, type WorkBuddyElectronProduct, type WorkBuddyModelInfo, type WorkBuddyProbeRecord, WorkBuddyProbeService, type WorkBuddyProbeStatus, WorkBuddyProbeStore, type WorkBuddyRefreshOutcome, type WorkBuddyRegion, type WorkBuddyShim, type WorkBuddyShimOptions, type WorkBuddyStoreOptions, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, type WorkBuddyVariant, WorkBuddyVisibilityStore, appUserAgent, atRestKeyProviderFor, chatUserAgent, classifyUpstreamError, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthPath, desktopAuthCandidatesFor, electronProfileFor, extractDisplayErrorMessage, hostIsLoopback, installedAppVersion, isChannelValidationBlock, normalizeCredits, originIsLoopback, parseModelCatalog, parseWorkBuddyAuth, prepareChatBody, prepareCnChatBody, prepareInternationalChatBody, probeModel, regionOf, resolveAppVersion, resolveBridgeHome, resolveChatIdentity, upstreamErrorCode, variantFor, withFileLock, workbuddyCatalogPath, workbuddyOwnAuthPath, workbuddyProbePath, workbuddyVisibilityPath, writeFileAtomic };