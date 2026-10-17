import { $ as ProbeAttempt, A as WorkBuddyCatalogFetch, B as WorkBuddyUpstreamModel, C as CN_VARIANT, E as WorkBuddyVariant, F as WorkBuddyModelReasoning, G as normalizeCredits, I as WorkBuddyPromotion, J as prepareCnChatBody, K as parseModelCatalog, L as WorkBuddyRefreshOutcome, M as WorkBuddyCredits, N as WorkBuddyEffort, O as variantFor, P as WorkBuddyModelBilling, Q as PROBE_EFFORT_CANDIDATES, R as WorkBuddyRegion, S as AI_VARIANT, St as validAppVersion, V as classifyUpstreamError, W as modelWithCurrentPromotion, X as regionOf, Y as prepareInternationalChatBody, _ as desktopAuthCandidatesFor, _t as WorkBuddyAppVersionSource, a as FALLBACK_WORKBUDDY_AI_MODELS, at as randomSentinel, bt as readBundleVersion, c as WorkBuddyModelInfo, ct as FALLBACK_CN_APP_VERSION, d as WorkBuddyAuthStatus, dt as fallbackChatIdentity, et as ProbeOutcome, f as WorkBuddyCredential, ft as readCliVersion, g as defaultDesktopAuthPath, gt as WORKBUDDY_APP_VERSION_FILENAME, h as defaultDesktopAuthCandidates, ht as AppVersionInfo, i as createWorkBuddyShim, it as probeModel, j as WorkBuddyChatResult, k as UpstreamErrorKind, l as WORKBUDDY_AUTH_FILENAME, lt as ResolveChatIdentityOptions, mt as validCliVersion, n as WorkBuddyShim, nt as ProbeSender, o as FALLBACK_WORKBUDDY_MODELS, ot as CN_APP_VERSION_FILENAME, p as WorkBuddyCredentialStore, pt as resolveChatIdentity, q as prepareChatBody, s as WorkBuddyCatalog, st as ChatIdentity, u as WORKBUDDY_AUTH_FILE_ENV, ut as chatUserAgent, v as parseWorkBuddyAuth, vt as appUserAgent, w as WORKBUDDY_VARIANTS, xt as resolveAppVersion, y as workbuddyOwnAuthPath, yt as installedAppVersion, z as WorkBuddyUpstreamClient } from "./shim-U171C0Zy.js";
import { a as WorkBuddyProbeStore, c as workbuddyProbePath, d as workbuddyVisibilityPath, f as WORKBUDDY_CATALOG_FILENAME, i as WorkBuddyProbeRecord, l as WORKBUDDY_VISIBILITY_FILENAME, m as workbuddyCatalogPath, n as WorkBuddyProbeStatus, o as WorkBuddyProbeValidation, p as WorkBuddyCatalogStore, r as WORKBUDDY_PROBE_FILENAME, s as fingerprintModel, t as WorkBuddyProbeService, u as WorkBuddyVisibilityStore } from "./probe-service-DkISd0qs.js";
import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import { PiAiAdapter, PiAiAdapterOptions } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/dsh/adapter.d.ts
/** Provider route this bundle owns. */
declare const WORKBUDDY_PROVIDER = "workbuddy";
/** Provider idle ceiling while one stream read is outstanding. */
declare const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Constructor dependencies. */
interface WorkBuddyAdapterOptions {
  providerId?: string;
  displayName?: string;
  /**
   * Which endpoint this adapter serves, from the variant descriptor. Decides
   * only whether the CN `onlyReasoning` veto hides `off` (#87); defaults to
   * `'cn'`, the same legacy default `providerId` carries.
   */
  region?: WorkBuddyRegion;
  shim: WorkBuddyShim;
  store: WorkBuddyCredentialStore;
  catalog: WorkBuddyCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
  /** Resolve one image's path in the current model-tool execution world. */
  resolveImageAccess?: NonNullable<PiAiAdapterOptions['resolveImageAccess']>;
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => WorkBuddyProbeRecord | undefined;
  /**
   * Model ids the current account has hidden from the picker, resolved per
   * read so an account switch is honored without rebuilding the adapter.
   *
   * Hiding is a *listing* concern only: `buildModels()` keeps serving the full
   * catalog because pi-ai's `resolveModel`/`prepareCall` resolve from the same
   * snapshot `listModels` reads — filtering the descriptors there would make a
   * hidden model unresolvable and break sessions already using it. The filter
   * therefore lives in this adapter's `listModels` override alone.
   */
  hidden?: () => readonly string[];
}
/** What {@link createWorkBuddyAdapter} hands back. */
interface WorkBuddyAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
}
/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 *
 * The profile is constructed by hand rather than through dsh-llm-pi-ai's
 * internal `resolveProfiles()`: that helper is not part of the package's
 * public export surface (root entry, `lib/` deep imports blocked by the
 * exports map, `src/` not shipped), so hand-assembly is the only supported
 * path and every newly required field must be adopted here explicitly —
 * `modelErrors` since 0.1.5-alpha.2 (#12).
 */
declare function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter;
//#endregion
//#region src/core/host-heartbeat.d.ts
/**
 * Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
 * `workbuddy` provider is registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card.
 *
 * The browser (client) bundle cannot write files; its health is reported
 * only through `console.error` on failure (see `src/client/index.tsx`).
 * This asymmetry is intentional: the host is the load-bearing half, and
 * a missing heartbeat unambiguously means the host never started.
 *
 * @module dsh-workbuddy-connect/host-heartbeat
 */
/** Basename of the host heartbeat file inside the Harness home. */
declare const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
declare const HEARTBEAT_FORMAT_VERSION = 1;
/** On-disk shape of the heartbeat. */
interface WorkBuddyHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION;
  package: 'dsh-workbuddy-connect';
  pluginVersion: string;
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number;
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number;
}
/** Absolute path of the host heartbeat file. */
declare function workbuddyHostHeartbeatPath(): string;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
declare function clearHostHeartbeat(): Promise<void>;
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
declare function readHostHeartbeat(): Promise<WorkBuddyHostHeartbeat | undefined>;
/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined (no such PID, platform lacks a readable source).
 *
 * - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
 *   `Date.parse` resolves it against the local clock, which matches how
 *   `registeredAt` (a `Date.now()` absolute value) is expressed.
 * - Windows: `wmic` prints a CIM_DATETIME `CreationDate` — local fields plus a
 *   signed minute offset (see {@link parseWmiCreationDate}); the epoch it
 *   yields is comparable to `registeredAt`.
 *
 * Failures return `undefined` so callers can fall back to plain PID liveness
 * rather than mis-report a running host as dead.
 */
declare function processStartTimeMs(pid: number): number | undefined;
/**
 * Whether the heartbeat's PID is still alive *and* still the same process that
 * registered it. A stale heartbeat (host crashed without clearing the file)
 * is distinguished from a live host by two checks:
 *
 * 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
 * 2. The process holding that PID started at or before `registeredAt`. A host
 *    that registered the heartbeat must have been started before writing it,
 *    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
 *    started after the host died, so `start > registeredAt` correctly reads dead.
 *
 * PID-only detection is not enough: after a crash the OS may hand the same PID
 * to an unrelated process, and the un-cleared stale heartbeat would otherwise
 * produce a false "Host running". When the process start time cannot be read
 * (e.g. unsupported platform) the check degrades to plain PID liveness.
 */
declare function isHeartbeatProcessAlive(heartbeat: WorkBuddyHostHeartbeat): boolean;
//#endregion
//#region src/dsh/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-workbuddy";
/** The model registry required before the provider can register. */
declare const inject: string[];
/**
 * Settings namespace owning the CN card's section.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'workbuddy'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
declare const WORKBUDDY_SETTINGS_NS: SettingsNamespace;
/**
 * Settings namespace owning the international section.
 *
 * One namespace per variant, not one shared: each section owns only its own
 * fields (`authFile` vs `authFileAI` and `useMaximumContextWindow`), and the
 * sections are what `settings.yaml` and the TUI `/settings` read. On DSH 0.1.5
 * they carry one more duty — the settings Plugins tab dispatches a card by
 * rendering `settings.plugin.item` with `entryKey = ns` for each namespace the
 * Host serves, so each variant's card needs a served section whose namespace
 * equals its id. DSH 0.1.6+ ignores that pairing (its Plugins page renders the
 * bundle's single `plugins.bundle.config` entry, keyed by package name), which
 * costs nothing: a section that names no card renders no duplicate.
 */
declare const WORKBUDDY_AI_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
interface Config {
  /** Explicit WorkBuddy (CN) desktop auth-file path, overriding env and platform defaults. */
  authFile?: string;
  /** Explicit WorkBuddy AI (international) desktop auth-file path, overriding env and platform defaults. */
  authFileAI?: string;
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees.
   */
  probeConsent?: boolean;
  /** Use the largest context window the international catalog explicitly offers. */
  useMaximumContextWindow?: boolean;
}
declare const Config: z<Config>;
/**
 * The account key model-visibility preferences are stored under: the stable
 * identity, but only when it carries a uid.
 *
 * A credential whose desktop document carried no `account.uid` normalizes to
 * an empty string; keying preferences on the resulting `":enterpriseId"` would
 * silently share one bucket between every such account. Those accounts get no
 * per-account preferences at all — everything stays visible and the control
 * route explains the refusal — which is the only honest degradation: it never
 * applies one account's hidden list to another.
 */
declare function visibilityAccountOf(credential: Pick<WorkBuddyCredential, 'uid' | 'enterpriseId'>): string | undefined;
/**
 * Start both variants: their loopback endpoints, the `workbuddy` and
 * `workbuddy-ai` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { AI_VARIANT, type AppVersionInfo, CN_APP_VERSION_FILENAME, CN_VARIANT, type ChatIdentity, Config, FALLBACK_CN_APP_VERSION, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, PROBE_EFFORT_CANDIDATES, type ProbeAttempt, type ProbeOutcome, type ProbeSender, type ResolveChatIdentityOptions, type UpstreamErrorKind, WORKBUDDY_AI_SETTINGS_NS, WORKBUDDY_APP_VERSION_FILENAME, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_CATALOG_FILENAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROBE_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WORKBUDDY_VARIANTS, WORKBUDDY_VISIBILITY_FILENAME, type WorkBuddyAdapter, type WorkBuddyAppVersionSource, type WorkBuddyAuthStatus, WorkBuddyCatalog, type WorkBuddyCatalogFetch, WorkBuddyCatalogStore, type WorkBuddyChatResult, type WorkBuddyCredential, WorkBuddyCredentialStore, type WorkBuddyCredits, type WorkBuddyEffort, type WorkBuddyHostHeartbeat, type WorkBuddyModelBilling, type WorkBuddyModelInfo, type WorkBuddyModelReasoning, type WorkBuddyProbeRecord, WorkBuddyProbeService, type WorkBuddyProbeStatus, WorkBuddyProbeStore, type WorkBuddyProbeValidation, type WorkBuddyPromotion, type WorkBuddyRefreshOutcome, type WorkBuddyShim, WorkBuddyUpstreamClient, type WorkBuddyUpstreamModel, type WorkBuddyVariant, WorkBuddyVisibilityStore, appUserAgent, apply, chatUserAgent, classifyUpstreamError, clearHostHeartbeat, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthPath, desktopAuthCandidatesFor, fallbackChatIdentity, fingerprintModel, inject, installedAppVersion, isHeartbeatProcessAlive, modelWithCurrentPromotion, name, normalizeCredits, parseModelCatalog, parseWorkBuddyAuth, prepareChatBody, prepareCnChatBody, prepareInternationalChatBody, probeModel, processStartTimeMs, randomSentinel, readBundleVersion, readCliVersion, readHostHeartbeat, regionOf, resolveAppVersion, resolveChatIdentity, validAppVersion, validCliVersion, variantFor, visibilityAccountOf, workbuddyCatalogPath, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath, workbuddyProbePath, workbuddyVisibilityPath };