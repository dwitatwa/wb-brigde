import { ServerResponse } from "node:http";
//#region src/core/status-paths.d.ts
/**
 * Why no credential is usable, as a closed enum the browser half switches on.
 *
 * Deliberately separate from `reason`: `reason` is free text meant for a human
 * to read, so matching on it would break the moment the wording changes. This
 * is the machine-readable half, and the card uses it — never a substring of
 * `reason` — to decide whether the Agent assist block applies.
 */
type WorkBuddySignedOutReasonCode =
/** Nobody is signed in; nothing diagnosable beyond that. */
'no-credential' |
/** A credential for the *other* product was found in this variant's file. */
'credential-region-mismatch' |
/** An encrypted credential exists but could not be opened (wrong key, GCM failure, helper crash). */
'encrypted-credential-unreadable' |
/** A product on a supported platform: discovery ran to completion and found no usable candidate. */
'electron-binary-not-found' |
/** A product on a supported platform: discovery found more than one distinct usable app. */
'electron-binary-ambiguous' |
/** No auto-discovery for this product/platform and no explicit path configured. */
'electron-binary-unavailable' |
/** An explicit path (option or env) is set but missing or not executable. */
'electron-path-invalid' |
/** Discovery could not finish: tool missing, timeout, output overflow, unreadable plist. */
'electron-discovery-incomplete';
//#endregion
//#region src/core/app-version.d.ts
/** Basename of the saved version under `$DSH_HOME`. */
declare const WORKBUDDY_APP_VERSION_FILENAME = ".workbuddy-ai-version.json";
/** Where the version came from, for `doctor` output. */
type WorkBuddyAppVersionSource = 'installed' | 'saved' | 'fallback';
/** Resolved version plus provenance. */
interface AppVersionInfo {
  version: string;
  source: WorkBuddyAppVersionSource;
  /** Basename of the App bundle the version was read from, when installed. */
  bundle?: string;
}
/**
 * Whether a string is safe to interpolate into an HTTP header.
 *
 * Strict on purpose: the value reaches a header, so anything that could split
 * the request (CR, LF, spaces beyond the separator) or inject a second UA
 * token must never pass. The App's own version is always `N.N.N` or `N.N.N.N`.
 */
declare function validAppVersion(value: unknown): value is string;
/**
 * Read `CFBundleShortVersionString` out of an `Info.plist`.
 *
 * Parsed as XML rather than grepped, because the plist contains several
 * `<string>` values and a regex would be one unrelated key away from
 * returning the wrong one. A binary plist has no `<dict>` in its bytes and is
 * reported as unreadable (the saved value then applies) rather than guessed at.
 */
declare function readBundleVersion(plistPath: string): Promise<string | undefined>;
/**
 * The installed international App's version, or `undefined` when it is not
 * installed (or not readable).
 *
 * Windows and Linux have no verified bundle-metadata location yet, so this
 * returns `undefined` there and the saved/fallback value is used instead of
 * guessing a path — the same discipline the credential discovery follows.
 */
declare function installedAppVersion(): Promise<{
  version: string;
  bundle: string;
} | undefined>;
/** Constructor dependencies; all injectable so tests never touch the real FS. */
interface ResolveAppVersionOptions {
  /** Installed-version reader; defaults to {@link installedAppVersion}. */
  installed?: () => Promise<{
    version: string;
    bundle: string;
  } | undefined>;
  /** Saved-version path; defaults to {@link appVersionPath}. */
  path?: string;
}
/**
 * Resolve the UA version: installed App first, then the last saved value, then
 * the compiled-in fallback.
 *
 * A value read from the App is written back immediately, so an uninstalled App
 * or an unreadable plist later still has the last real version to fall back
 * on. The write is best-effort: failing to cache a version must never fail the
 * catalog request that asked for it.
 */
declare function resolveAppVersion(options?: ResolveAppVersionOptions): Promise<AppVersionInfo>;
/**
 * Build the App-shaped User-Agent for catalog requests.
 *
 * `WorkBuddyAI/<version>` with no space is the form measured to reach the App
 * document; the space form is rejected with 400/12403. Throws on an invalid
 * version rather than sending a malformed header.
 */
declare function appUserAgent(version: string): string;
//#endregion
//#region src/core/client-identity.d.ts
/**
 * Compiled-in CN fallback for the `WorkBuddy/<v>` tokens.
 *
 * Observed on the CN desktop app installed here (research §3.1, verified
 * 2026-09-11); like the international fallback it is a shape requirement,
 * not a currency claim — the gateway has not been observed to branch on it.
 */
declare const FALLBACK_CN_APP_VERSION = "5.5.6";
/**
 * Basename of the CN saved-version cache under `$DSH_HOME`.
 *
 * Deliberately not the international `.workbuddy-ai-version.json`: that file
 * feeds the international catalog's User-Agent, and a CN App writing its
 * version into it would relabel that request. The two caches stay isolated
 * the way the per-variant catalog files are.
 */
declare const CN_APP_VERSION_FILENAME = ".workbuddy-app-version.json";
/** The resolved identity a chat request presents as. */
interface ChatIdentity {
  /** Desktop App version; drives the desktop UA and `X-IDE-Version`. */
  clientVersion: string;
  /** Bundled agent-CLI version; absent drops the `CLI/…` UA token. */
  cliVersion?: string;
}
/**
 * Whether a value is a CLI version that may reach a header.
 *
 * Tolerates a prerelease suffix (`2.137.1-rc.1`) because the bundled CLI's
 * own metadata uses that spelling; anything with whitespace, CR or LF never
 * passes — the value is interpolated into an HTTP header.
 */
declare function validCliVersion(value: unknown): value is string;
/**
 * The bundled agent CLI's real version, or `undefined` when it does not resolve.
 *
 * `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
 * version in `publishConfig.customPackage.version`; a valid non-placeholder
 * `version` wins, otherwise the custom-package value applies, and unreadable
 * or invalid metadata yields `undefined` (the caller drops the `CLI/…` UA
 * token rather than guessing).
 */
declare function readCliVersion(bundle: string): Promise<string | undefined>;
/**
 * Build the chat User-Agent for one region.
 *
 * Throws on an invalid version rather than interpolating one into a header;
 * `resolveChatIdentity` never produces such an identity, so the throw is a
 * last gate against future call-site mistakes, not an expected path.
 */
declare function chatUserAgent(identity: ChatIdentity, region: WorkBuddyRegion): string;
/** Constructor dependencies; every reader is injectable so tests never touch a real App or home. */
interface ResolveChatIdentityOptions {
  /** Installed CN desktop-bundle reader; defaults to the macOS probe. */
  installedCn?: () => Promise<{
    version: string;
    bundle: string;
  } | undefined>;
  /** International version resolver; defaults to `app-version.ts`'s chain. */
  resolveIntl?: () => Promise<AppVersionInfo>;
  /** CLI-version reader; defaults to reading the bundle's `cli/package.json`. */
  cliVersion?: (bundle: string) => Promise<string | undefined>;
  /** CN saved-cache path; defaults to `$DSH_HOME/.workbuddy-app-version.json`. */
  cnSavedPath?: string;
}
/**
 * Resolve the chat identity for one region: installed App → region's saved
 * value → compiled-in fallback. Never throws — a missing App, an unreadable
 * plist, a failed cache write, or a reader that throws outright all degrade
 * to {@link fallbackChatIdentity}; resolution never blocks a message.
 *
 * The production path caches per region (a message must not re-read the
 * install tree); any injected option bypasses the cache entirely so tests
 * with different readers cannot observe each other's resolutions.
 */
declare function resolveChatIdentity(region: WorkBuddyRegion, options?: ResolveChatIdentityOptions): Promise<ChatIdentity>;
/**
 * The region's compiled-in fallback identity: the desktop form with the
 * built-in version and no `CLI/…` segment. This is the single degraded
 * shape every failure path converges on — a thrown reader, an unreadable
 * bundle, or a missing cache all present this, never the legacy CLI UA.
 */
declare function fallbackChatIdentity(region: WorkBuddyRegion): ChatIdentity;
//#endregion
//#region src/core/probe.d.ts
/**
 * The canonical values a probe tests, in a fixed order.
 *
 * `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
 * by policy — disabling thinking is a separate capability the upstream must
 * declare through `canDisableThinking`, never something probing may infer.
 */
declare const PROBE_EFFORT_CANDIDATES: readonly WorkBuddyEffort[];
/** Sentinel generator; injectable so tests get deterministic values. */
type SentinelFactory = () => string;
/** Default sentinel: unmistakably non-canonical, different on every call. */
declare function randomSentinel(): string;
/**
 * One response as the probe sees it, split into the only distinctions the
 * attribution rule needs.
 */
interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  /** True when a parseable SSE event arrived. */
  streamed: boolean;
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string;
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string;
}
/** How one attempt is performed; the caller owns credentials and HTTP. */
type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>;
/** The outcome of probing one model. */
type ProbeOutcome = {
  validation: 'validating';
  efforts: readonly WorkBuddyEffort[];
  requests: number;
} | {
  validation: 'non-validating';
  efforts: readonly [];
  requests: number;
} | {
  validation: 'unknown';
  efforts: readonly [];
  requests: number;
  reason: string;
};
/** Which endpoint's rejection vocabulary a probe interprets. */
type ProbeRegion = 'cn' | 'global';
/**
 * Probe one model.
 *
 * `options.candidates` exists so tests can shorten the sweep; production always
 * uses {@link PROBE_EFFORT_CANDIDATES}. `options.region` selects which
 * endpoint's rejection vocabulary is read; it defaults to `cn`, which is also
 * the production default for the China app.
 */
declare function probeModel(options: {
  send: ProbeSender;
  sentinel?: SentinelFactory;
  candidates?: readonly WorkBuddyEffort[];
  timeoutMs?: number;
  region?: ProbeRegion;
}): Promise<ProbeOutcome>;
//#endregion
//#region src/core/upstream.d.ts
/** WorkBuddy region selected by the credential's login domain. */
type WorkBuddyRegion = 'cn' | 'global';
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/** One CLI-usable model as the upstream catalog describes it. */
interface WorkBuddyUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  /** The upstream's preferred window before an optional maximum is selected. */
  defaultContextWindow?: number;
  maxInputTokens?: number;
  supportedContextWindows?: readonly number[];
  promotions?: readonly WorkBuddyPromotion[];
  maxTokens: number;
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean;
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire
   * effort values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto
   * pi-ai's thinking levels, and the supported set decides which levels the
   * DSH model selector offers.
   */
  reasoning?: WorkBuddyModelReasoning;
  /**
   * Billing convenience metadata: the credits multiplier string the upstream
   * reports (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000` or `badge:夜间折扣:#1E90FF`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a
   * language-neutral display form (`x0.79`) that reads the same in every UI
   * language. The raw upstream string (which may spell `x0.79 credits`) stays
   * on {@link WorkBuddyModelBilling.credits} for diagnostics.
   */
  billing?: WorkBuddyModelBilling;
}
/** Reasoning metadata the upstream catalog declares for one model. */
interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean;
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean;
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[];
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort;
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean;
}
/** The concrete effort spellings WorkBuddy exposes on the wire. */
type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Billing convenience metadata reported for one model. */
interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string;
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[];
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean;
  /**
   * The rate cannot be stated for this model right now.
   *
   * Set when a row that arrived with promotions attached has no promotion in
   * force: the upstream bakes the discounted value into `credits`, so the
   * cached rate describes a discount that has ended. The original price is not
   * recoverable from the row, so the plugin reports "unknown, refresh needed"
   * rather than repeating a figure it can no longer stand behind — in
   * particular it never keeps claiming the model is free.
   */
  rateUnknown?: boolean;
}
/** One billing package and its remaining credit. */
interface WorkBuddyCreditAccount {
  packageName: string;
  remain: number;
  size: number;
  unlimited?: true;
  /**
   * When the package's own cycle ends, in epoch milliseconds.
   *
   * The upstream has always sent this (`CycleEndTime`, a zone-less
   * `YYYY-MM-DD HH:mm:ss` string) and the query itself already filters on
   * `PackageEndTimeRange`, but the field used to be dropped here — so a card
   * could show "500 credit" for a package expiring in an hour with nothing to
   * distinguish it from one expiring next month. Absent when the upstream omits
   * or malforms it, which must never read as "no expiry".
   *
   * The zone the upstream means is **not established**: reading the string as
   * the running machine's local time follows the official desktop client (see
   * {@link parseCycleEndTime}), and is not a claim about the account's zone.
   */
  endTimeMs?: number;
}
/** Credit whose package expires within a horizon the user should act on. */
interface WorkBuddyExpiringCredits {
  /** Sum of {@link WorkBuddyCreditAccount.remain} over the window. */
  total: number;
  /** How many packages contribute to {@link total}. */
  packages: number;
  /** The soonest `endTimeMs` among them. */
  earliestEndTimeMs?: number;
}
/**
 * Credit at risk, bucketed by how soon it lapses.
 *
 * Thresholds are calendar-ish (24h / 3d / 7d) rather than "this month": a package
 * expiring at 08:00 tomorrow is not helped by a monthly average, and the upstream
 * genuinely staggers expiries per package.
 *
 * Only *future* horizons are reported. An already-lapsed package is deliberately
 * **not** summarised here: the personal billing query this feeds filters
 * `Status: [0, 3]` (`valid` + `usedUp`) from the current time forward, while the
 * upstream marks a lapsed package `Status: 2` (`expired`) — a status this query
 * never returns. Historical expiry would need its own query, which is out of
 * scope.
 */
interface WorkBuddyCreditExpiry {
  within24h: WorkBuddyExpiringCredits;
  within3d: WorkBuddyExpiringCredits;
  within7d: WorkBuddyExpiringCredits;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyCredits {
  total: number;
  accounts: readonly WorkBuddyCreditAccount[];
  /**
   * The account's cycle quota is uncapped (`limitNum === -1` on the CN
   * enterprise endpoint).
   *
   * A separate flag rather than a `-1`/`0` sentinel in {@link total}: the two
   * mean opposite things to a reader ("no limit" vs "nothing left"), and the
   * existing negative-clamp in the personal branch would turn a sentinel into
   * a plausible-looking zero. Every renderer must therefore test this flag
   * first and not fall back to `total` when it is set.
   */
  unlimited?: true;
  cycleResetTime?: string;
  /**
   * Credit lapsing soon, so a card can warn instead of only reporting a total.
   *
   * Absent when no account carried a usable end time — the plugin must not
   * claim "nothing expires soon" on the strength of data it never received.
   */
  expiry?: WorkBuddyCreditExpiry;
}
/** Token refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** Chat answer: either a live SSE response or a classified failure. */
type WorkBuddyChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
  /**
   * The channel-relevant headers the final attempt actually sent.
   *
   * Present only on a failure, and never a secret: it is the identity the
   * gateway judges, so a refusal can be told apart from a refusal caused by
   * the identity never being sent. `Authorization` is excluded by
   * construction — the subset is chosen by name, not filtered out.
   */
  channelHeaders?: Record<string, string>;
};
/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some catalog
 * rows report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 * Dropping a trailing `credits` (case-insensitive, singular or plural) yields
 * the one spelling that reads identically in every language.
 *
 * @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
 * @returns the bare multiplier, or undefined when nothing displayable remains.
 */
declare function normalizeCredits(credits: string | undefined): string | undefined;
/** Classify an upstream failure from its HTTP status and body excerpt. */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Extract a user-facing error message from an upstream JSON response body.
 * Prefers WorkBuddy's localized `displayMsg.zh` / `displayMsg.en`, falling back to `msg`.
 */
declare function extractDisplayErrorMessage(body: string): string | undefined;
/**
 * The upstream's own error code, when its body carries one.
 *
 * The display text alone is not actionable. `11128` means "conversation id
 * missing" on the international chat but "Illegal API invocation from an
 * unapproved channel" for a rejected `developer` role, and several unrelated
 * codes share the generic 「请求被拦截」 wording — so a report that quotes only
 * the display text cannot be diagnosed. The number is the stable part.
 */
declare function upstreamErrorCode(body: string): string | undefined;
/**
 * Does this upstream answer look like the sampled channel-validation block?
 *
 * Deliberately narrow — a `400` carrying the conversation-channel signature,
 * and nothing else. The code is the stable part (`11128`); the `msg` and the
 * localized display text are the spellings seen on the wire, and `displayTips`
 * names the channel check outright in both languages. A genuine bad request is
 * left alone, because retrying it only burns a round trip.
 */
declare function isChannelValidationBlock(status: number, body: string): boolean;
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
declare function regionOf(domain: string): WorkBuddyRegion;
/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), flatten
 * `tool_choice` (the upstream's field is a string; object forms return 400),
 * and rewrite `developer` messages as `system`.
 *
 * The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
 * `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
 * upstream rejects that role with HTTP 400 code 11128 ("Illegal API
 * invocation from an unapproved channel"). Rewriting to `system` is the
 * compatible spelling the upstream accepts.
 */
declare function prepareChatBody(source: string): string;
/** Provenance of one successful catalog fetch, surfaced by the status card. */
interface WorkBuddyCatalogFetch {
  fetchedAtMs: number;
  /** Which document answered, e.g. `workbuddy-ai:app`. */
  source: string;
  /** UA version used, when the request needed one. */
  appVersion?: AppVersionInfo;
}
/** Constructor dependencies. */
interface WorkBuddyUpstreamClientOptions {
  /** App-version resolver for international catalog requests; injectable for tests. */
  resolveAppVersion?: () => Promise<AppVersionInfo>;
  /**
   * Chat-identity resolver for chat and probe requests; injectable for tests.
   * Defaults to `client-identity.ts`'s per-region chain. Refresh, catalog, and
   * billing never consult it — those requests keep their long-standing headers.
   */
  resolveChatIdentity?: (region: WorkBuddyRegion) => Promise<ChatIdentity>;
}
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 *
 * One instance is *per variant*: the international provider needs its own
 * catalog source, UA version, and probe differences, and keeping them on the
 * instance avoids passing a variant through every call signature.
 */
declare class WorkBuddyUpstreamClient {
  /**
   * Resolves the App-shaped UA version for international catalog requests.
   * Injectable so tests never read the real filesystem.
   */
  private readonly resolveAppVersion;
  /** Chat-identity resolver; see {@link WorkBuddyUpstreamClientOptions.resolveChatIdentity}. */
  private readonly resolveChatIdentity;
  /** Provenance of the most recent successful catalog fetch, for the card. */
  lastCatalog: WorkBuddyCatalogFetch | undefined;
  constructor(options?: WorkBuddyUpstreamClientOptions);
  /**
   * POST the chat endpoint; a successful answer is the raw SSE response.
   *
   * A channel-validation block is retried. The gateway's check is *sampled*
   * (see {@link conversationChannelHeaders}), so the same request can be
   * refused once and accepted moments later — which is precisely what the
   * upstream's own 「请重新发送」 asks the caller to do. Every attempt mints a
   * fresh conversation family, because a new conversation id is the one input
   * this path can vary and the block is content-independent. Only that
   * signature is retried: a genuine bad request is returned on its first
   * answer, since repeating it would only burn a round trip.
   */
  chatStream(credential: WorkBuddyCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyChatResult>;
  /**
   * The identity a chat request presents, preferring a **complete** one.
   *
   * The resolver returns the built-in fallback when a reader throws — built-in
   * version, and no `CLI/…` segment. That is the shape the gateway refuses as
   * an unapproved client, and because the failure is deliberately not cached,
   * asking a second time usually yields the complete identity. One extra ask is
   * cheap next to a refused turn, and it is why the first request after startup
   * no longer fails while the app probe is still settling.
   */
  private chatIdentityFor;
  /** One resolution attempt; a thrown reader degrades to the built-in fallback. */
  private resolveIdentityOnce;
  /** Compose the UA, degrading to the fallback identity if the version is unusable. */
  private userAgentFor;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome>;
  /**
   * GET the personal model catalog.
   *
   * Both variants read `/v3/config`, the product document the desktop product
   * itself fetches. CN used to read `/console/enterprises/personal/models`
   * (the console catalog) instead, and that was why its model list drifted
   * from the desktop App's selector: the console document lags the product
   * one, and the product roster itself churns day to day (`auto`,
   * `kimi-k3-1`, `minimax-m3` have each appeared and disappeared within a
   * week).
   *
   * What distinguishes the two variants here is the User-Agent, not the path:
   * the gateway splits `/v3/config` by client identity, and the split is
   * load-bearing. A CLI-shaped UA yields the CLI's roster — the chat models
   * this plugin serves — while an App-shaped UA yields the App's internal
   * roster. CN keeps the CLI UA it sends for chat, so the catalog it
   * advertises is exactly the one its own requests can use. The international
   * variant has no CLI identity, so it keeps the App-shaped UA.
   *
   * The same split has an account-identity axis (issue #123): an enterprise
   * account must also present `X-User-Id` + `X-Enterprise-Id`, or the gateway
   * answers with the personal roster. CN sends that pair via
   * {@link identityHeaders} whenever the credential carries both halves; the
   * international gateway's split was never measured against account headers,
   * so it keeps its documented shape.
   *
   * Membership is the `cli` roster intersected with the usable rows (see
   * {@link parseModelCatalog}); the promo badges the product document does
   * not carry are merged in from a best-effort console read — see
   * {@link fetchPromoBadges}.
   *
   * Responses are unwrapped and classified the same way — `readEnvelope` plus
   * `envelopeError` — so an expired session or exhausted credit is reported as
   * such rather than as a generic catalog failure.
   */
  fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]>;
  /**
   * Read the console catalog's promotional tags, by model id.
   *
   * `/v3/config` carries no `badge:<label>:<color>` tags — the discount labels
   * the cards render (`限时免费`, `夜间折扣`, …) live only in
   * `/console/enterprises/personal/models`. Since the roster now comes from
   * the product document, those tags are read from the console one in a
   * second request and merged by id.
   *
   * Best-effort by construction: a badge is a label on a price, so failing to
   * read this document must not fail a catalog refresh. Every failure —
   * network, envelope, an unreadable body — returns undefined, and the models
   * simply ship without badges.
   */
  private fetchPromoBadges;
  /**
   * POST the billing endpoint for the aggregated remaining credit.
   *
   * Two upstream shapes, chosen by account type:
   *
   * - **CN enterprise** (`regionOf === 'cn'` and `enterpriseId` non-empty) asks
   *   `/v2/billing/meter/get-enterprise-user-usage`, which answers with a single
   *   cycle quota. The personal endpoint serves these accounts an empty
   *   `Accounts` list, which the card then renders as "0 credit" — a wrong
   *   number rather than a visible failure (issue #31).
   * - **Everyone else** keeps the personal endpoint unchanged.
   *
   * The region gate is load-bearing: the enterprise endpoint is unverified for
   * the global region, so an international credential that happens to carry an
   * `enterpriseId` must stay on the measured personal path instead of being
   * moved onto an unmeasured one.
   */
  fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits>;
  /**
   * CN enterprise credit read: a single cycle quota instead of a package list.
   *
   * Verified against the WorkBuddy desktop app (`app.asar`,
   * `BackendProvider.getEnterpriseUsage` and `CloudAccountRepo.billing`): the
   * body is an empty object and the account identity travels only in the
   * headers. The two official call sites disagree on the field spelling
   * (`limitNum`/`credit` vs `limit_num`/`used_num`), so both are accepted.
   *
   * A body carrying no recognisable quota field is a hard error rather than a
   * zero. Rendering `0` for "we did not understand the answer" is exactly how
   * issue #31 stayed invisible while users saw a plausible wrong number.
   *
   * The error names fields and types only: it reaches the browser, and the
   * response body may describe the account's usage.
   */
  private fetchEnterpriseCredits;
  /**
   * One probe request: a real streaming chat call carrying the effort under
   * test.
   *
   * Shares `chatHeaders` with the normal chat path on purpose — the plan
   * forbids probing through anything but the plugin's own credential handling,
   * so a result describes what a real message would experience.
   *
   * The caller aborts as soon as a parseable event arrives; the body is never
   * assembled into an answer. `reasoning_effort` is omitted entirely (rather
   * than sent empty) when `effort` is undefined, so the baseline case is a
   * genuinely bare request.
   *
   * Two international differences, both measured on 2026-09-11:
   *
   * - The gateway requires a leading `system` message (400/11128 otherwise), so
   *   one is prepended for the global region only.
   * - `max_tokens: 1` is below some models' floor (the GPT-5.6 family rejects it
   *   with 400/11133 `integer_below_min_value`), so the international probe asks
   *   for a slightly larger minimum. This is a floor the plugin must clear, not
   *   evidence about any model's effort support: a model still refusing that
   *   minimum is reported as an incompatible request, never as "effort
   *   unsupported", and the ceiling is never raised further to force an answer.
   */
  probeEffort(credential: WorkBuddyCredential, model: string, effort: string | undefined, signal: AbortSignal): Promise<ProbeAttempt>;
}
/**
 * Parse either response shape after its envelope has been checked.
 *
 * Membership is the `cli` agent's roster, intersected with the rows that are
 * usable: the roster is what the client identity this plugin presents is
 * allowed to chat with, and joining rather than trusting it outright drops
 * both ids the roster has retired and rows the document lists but cannot
 * serve (no row, `disabled: true`, or non-positive caps all drop out here —
 * a published-but-unservable id must never reach the picker).
 *
 * @param data - the unwrapped catalog/product document.
 * @param international - whether it is the international product document, whose
 * rows carry window objects and promotions.
 * @param promoBadges - badge tags by model id, read from the console document,
 * which is the only one that carries them.
 */
declare function parseModelCatalog(data: Record<string, unknown>, international?: boolean, promoBadges?: ReadonlyMap<string, readonly string[]>): readonly WorkBuddyUpstreamModel[];
/**
 * One verified promotion entry.
 *
 * Only the shape actually observed in the international App document is
 * modelled — an enabled, time-boxed, `displayMode: "replace"` discount. An
 * entry that does not match is dropped rather than guessed at: rendering a
 * discount the plugin does not understand could understate what the user pays.
 */
interface WorkBuddyPromotion {
  /** Window start, epoch ms, parsed from the document's offset timestamp. */
  start: number;
  /** Window end, epoch ms. */
  end: number;
  /** Badge text as the upstream wrote it, e.g. `Free now`. */
  label: string;
  /** Multiplier applied to the model's rate; `0` replaces it outright. */
  factor: number;
  /** Higher wins when several promotions cover one model. */
  priority: number;
}
/**
 * Re-evaluate a model's promotion against the current time.
 *
 * Promotions are time-boxed, and the catalog they arrive in is cached for the
 * life of the process. Frozen at parse time, a cached "Free now" would keep
 * claiming a discount after `validUntil` had passed, and would keep showing the
 * pre-discount rate as the discounted one. Re-deriving on every read means the
 * badge disappears on its own and the rate reverts, with no refresh needed.
 *
 * Non-destructive: the model's own `credits` and `badges` are the base, and the
 * promotion is layered onto a copy. A model with no live promotion is returned
 * as-is, so the common case allocates nothing.
 */
declare function modelWithCurrentPromotion(model: WorkBuddyUpstreamModel, now?: number): WorkBuddyUpstreamModel;
/**
 * Apply the international endpoint's extra chat requirement: the first message
 * must be a system prompt.
 *
 * The international gateway rejects a body whose first message is not `system`
 * with HTTP 400 code 11128 ("first message is not system prompt"). Note that
 * the *same* code means something else on the CN endpoint — there it reports a
 * rejected `developer` role — so the two are never branched on by code alone.
 *
 * The added prompt is deliberately empty of user content and prepended, never
 * merged: existing messages keep their order and wording. A body that is not a
 * JSON object is returned unchanged, exactly as {@link prepareChatBody} does,
 * so this is safe to run over an already-prepared-or-not body.
 */
/**
 * Prepare a body for the **CN** endpoint.
 *
 * Until #87 the CN wire was the caller's body verbatim. The only difference
 * now is the shared {@link dropUnsupportedEffort} strip, whose region scope was
 * lifted once measurements showed this endpoint rejects `off` too.
 *
 * Deliberately **not** routed through {@link prepareChatBody}: the shim already
 * applies it before handing the body to {@link WorkBuddyUpstreamClient.chatStream},
 * and re-running it would be a second `stream`/`developer`/`tool_choice`
 * normalisation of an already-normalised body. Only the strip belongs here.
 *
 * A body that is not a JSON object is returned unchanged, so this is safe to
 * run over an already-prepared-or-not body.
 */
declare function prepareCnChatBody(source: string): string;
declare function prepareInternationalChatBody(source: string): string;
//#endregion
//#region src/core/variants.d.ts
/** One WorkBuddy product variant. */
interface WorkBuddyVariant {
  /** Provider id registered with DSH, e.g. `workbuddy-ai`. */
  id: string;
  /** Model-group heading and card title stem, e.g. `WorkBuddy AI`. */
  displayName: string;
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string;
  /** Which upstream region this variant's credentials must belong to. */
  region: WorkBuddyRegion;
  /** Env var overriding the desktop auth-file location. */
  env: string;
  /**
   * How this product's Electron helper is identified and located.
   *
   * Optional for source compatibility: `WorkBuddyVariant` is a public type and
   * existing callers construct their own descriptors without it. Resolution
   * falls back to {@link electronProfileFor}, keyed by variant id — an
   * unknown id stays on the CN profile, the store's other legacy default.
   */
  electron?: WorkBuddyElectronProduct;
  /** Basename of the desktop app's own auth file in the shared auth directory. */
  desktopFilename: string;
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string;
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string;
  /**
   * Basename of the plugin-owned saved-catalog file under `$DSH_HOME`.
   *
   * One per variant, like the probe records: the two endpoints disagree about
   * rates, windows, and even which models exist for a shared id, so a catalog
   * saved from one must never be served as the other's.
   */
  catalogFilename: string;
  /**
   * Basename of the plugin-owned per-account model-visibility file under
   * `$DSH_HOME`.
   *
   * One per variant, for the same reason as the catalogs and probe records:
   * the two endpoints share model ids, so one variant's hidden list must never
   * answer for the other's picker.
   */
  visibilityFilename: string;
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string;
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string;
}
/**
 * How one product's Electron key helper is identified on each platform, and
 * which env var names an explicit binary for it (issues #59/#60).
 *
 * The profile is the *only* place product identity enters helper resolution —
 * never the discovery setting, which only says whether a platform may be
 * searched at all: two products on the same platform differ by bundle id /
 * registry name / exe basename, so a discovery that matches one can never
 * legitimately execute the other's binary.
 */
interface WorkBuddyElectronProduct {
  /** Product name for helper diagnostics and error copy, e.g. `WorkBuddy AI`. */
  productName: string;
  /** Env var naming an explicit Electron binary for this product alone. */
  envVar: string;
  /** macOS identity and default install layout, verified per product. */
  macOS: {
    bundleId: string;
    defaultPath: string;
  };
  /**
   * Windows identity from the uninstall registry and the exe it names.
   * `defaultPathSegments` exists only where the default install location has
   * been measured (CN); the international app has only been seen in
   * user-chosen locations, so it stays registry-only — an unverified default
   * is a guess, and guessing is how the wrong app gets executed.
   */
  windows: {
    displayNamePattern: RegExp;
    exeBasename: string;
    defaultPathSegments?: readonly string[];
  };
}
/** CN WorkBuddy first: the existing provider keeps its id, paths, and copy. */
declare const WORKBUDDY_VARIANTS: readonly WorkBuddyVariant[];
/** The CN variant; the plugin's long-standing default and compatibility anchor. */
declare const CN_VARIANT: WorkBuddyVariant;
/** The international variant. */
declare const AI_VARIANT: WorkBuddyVariant;
/** Look up a variant by provider id. */
declare function variantFor(id: string): WorkBuddyVariant | undefined;
/**
 * The Electron profile a variant resolves with.
 *
 * Callers inside the plugin pass their known-complete variants; descriptors
 * assembled outside (the type is public and predates the profile) fall back
 * by variant id, so an id-less or unknown custom variant stays on the CN
 * product — the same default the store's other legacy fields assume.
 */
declare function electronProfileFor(variant: Pick<WorkBuddyVariant, 'id' | 'electron'> | undefined): WorkBuddyElectronProduct;
//#endregion
//#region src/core/desktop-credential-protection.d.ts
/** The four states a desktop auth document can be read as. */
type DesktopAuthFormat = 'absent' | 'plaintext' | 'encrypted' | 'unrecognized';
/** The spawned helper. Separated from the provider so tests can stand it in. */
type WorkBuddyKeyPayloadSource = () => Promise<string>;
/**
 * Which automatic discovery, if any, this provider may run when no explicit
 * binary is configured.
 *
 * The value says which *platform* may be searched, never which product: two
 * products on the same platform are told apart by the product profile
 * ({@link WorkBuddyElectronProduct} — bundle id, registry name, exe basename),
 * so a search for one can never execute the other's binary. `none` remains the
 * safe default for platforms without a verified layout (Linux today).
 */
type WorkBuddyElectronDiscovery = 'none' | 'macos-workbuddy' | 'windows-workbuddy';
/**
 * The at-rest key provider one variant's store should use. Shared by the
 * plugin host and the CLI entry so the browser card and `doctor`/`status` can
 * never disagree about which binary a variant resolves.
 */
declare function atRestKeyProviderFor(variant: Pick<WorkBuddyVariant, 'id' | 'electron'>): WorkBuddyAtRestKeyProvider;
/** Seams the discovery flow runs through, so tests never spawn a process. */
interface WorkBuddyDiscoveryTools {
  /** Candidate `.app` bundles for the product's bundle id, or a throw for an unusable tool. */
  findApps: (signal: AbortSignal) => Promise<readonly string[]>;
  /**
   * `CFBundleIdentifier` of a bundle, or `undefined` when the tool could not
   * read it — which is "we could not check this candidate", never "it does not
   * match". A successful read of a *different* id returns that id, and the
   * caller excludes the candidate.
   */
  bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>;
  /** Display version, best effort; `undefined` when unavailable. */
  bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>;
}
/** Windows-only seam for querying one uninstall registry root. */
interface WorkBuddyWindowsDiscoveryTools {
  queryUninstallRoot: (root: string, signal: AbortSignal) => Promise<string>;
}
/** Provider options. */
interface WorkBuddyAtRestKeyProviderOptions {
  /**
   * Which product's Electron this provider resolves. Required and the only
   * source of product identity: it names the explicit-path env var, the bundle
   * id / registry name / exe basename discovery must match, and the platform
   * default. Without it the provider could not even decide which env var to
   * read — the discovery setting alone cannot carry this (both products are
   * `none` on Linux, yet each must read its own variable).
   */
  product: WorkBuddyElectronProduct;
  /** Explicit Electron binary; overrides the platform default and env. */
  electronPath?: string;
  /** Helper timeout in milliseconds; default 10s. */
  timeoutMs?: number;
  /**
   * Where the payload comes from. Defaults to spawning WorkBuddy's own
   * Electron with `ELECTRON_RUN_AS_NODE=1`; tests supply a stand-in so no
   * test ever touches the real binary or a real key. Supplying this replaces
   * path *resolution* too, so tests about resolution use
   * {@link spawnHelper} instead.
   */
  source?: WorkBuddyKeyPayloadSource;
  /**
   * Runs the helper at the resolved path. Distinct from {@link source}, which
   * replaces the whole payload path: this seam keeps resolution — explicit
   * config, platform default, discovery — real, so tests can exercise it
   * without spawning anything.
   */
  spawnHelper?: (electronPath: string) => Promise<string>;
  /**
   * Automatic discovery budget; defaults to `'none'` (see
   * {@link WorkBuddyElectronDiscovery}). Passed explicitly per variant at the
   * composition root, never inferred from the environment.
   */
  discovery?: WorkBuddyElectronDiscovery;
  /**
   * Platform default binary, consulted only when `discovery` is enabled and no
   * explicit path is configured. Injectable so tests can force the fallback
   * branch without moving the real app; `null` means "no default here".
   */
  defaultElectronPath?: string | undefined;
  /** Discovery subprocesses; injectable so tests never spawn. */
  tools?: WorkBuddyDiscoveryTools;
  /** Windows registry discovery subprocess; injectable so tests never spawn. */
  windowsTools?: WorkBuddyWindowsDiscoveryTools;
  /** Platform override for deterministic discovery tests. */
  platform?: NodeJS.Platform;
  /**
   * Whether the helper spawn crosses WSL→Windows interop. Injectable so tests
   * can simulate a WSL host on any platform; defaults to the shared
   * {@link isWsl} check. Only consulted for the key-helper spawn (#133) —
   * never for discovery.
   */
  wsl?: () => boolean;
  /**
   * Total budget for one discovery run, covering the search and every
   * candidate check. Injectable so tests can exercise exhaustion without
   * waiting out the production 10s.
   */
  discoveryBudgetMs?: number;
}
/**
 * In-memory protector-key resolver: one spawn per key id, single-flight, never
 * persisted. The cache is keyed by the id envelopes ask for, so an envelope
 * sealed under a rotated key triggers exactly one fresh resolution.
 */ declare class WorkBuddyAtRestKeyProvider {
  /**
   * The explicit binary, when one was configured. `undefined` here means "the
   * caller did not name one", which is what lets discovery run — an explicit
   * path that turns out to be unusable is an error, never a reason to look for
   * a different app.
   */
  private readonly explicitPath;
  private readonly product;
  private readonly defaultPath;
  private readonly discovery;
  private readonly tools;
  private readonly windowsTools;
  private readonly platform;
  private readonly discoveryBudgetMs;
  private readonly timeoutMs;
  private readonly wsl;
  private readonly source;
  private readonly spawnHelper;
  /**
   * The path discovery settled on, cached only on success. A failure leaves
   * this unset so the next attempt tries again — the user may install or move
   * the app without restarting DSH.
   */
  private discoveredPath;
  private cache;
  private inflight;
  constructor(options: WorkBuddyAtRestKeyProviderOptions);
  /**
   * The binary the default helper would use, for diagnostics.
   *
   * Reports a *discovery result* once one exists, so diagnostics describe what
   * would actually run rather than the default that was bypassed. Discovery
   * itself stays in {@link resolveElectronPath}: this accessor never triggers a
   * search (the constructor must remain I/O-free, and callers may ask before
   * any resolution has happened).
   */
  helperPath(): string | undefined;
  /**
   * A protector key matching one of the requested envelope key ids. The first
   * id the cache answers wins; otherwise one spawn resolves the current key,
   * which must match a request — a mismatch means the envelopes were sealed by
   * a different install than the one this machine now runs, and no key we can
   * reach will open them.
   */
  protectorKeyFor(requested: readonly string[]): Promise<Buffer>;
  private ingest;
  /**
   * The binary to spawn, or a diagnosable error saying why there is none.
   *
   * Order is the contract: an explicit path is used as-is and never falls back;
   * discovery runs only for a provider that was configured for it, and only
   * after the platform default has been tried and found unusable.
   */
  private resolveElectronPath;
  /**
   * Resolve this product's app through Spotlight, then prove each candidate's
   * identity before it can be executed.
   *
   * The whole flow shares one budget: a hang in one candidate must not extend
   * the wait for the others, and running out of budget is reported as an
   * unfinished check rather than an absent app.
   */
  private discoverMacosApp;
  /**
   * Resolve this product's app through Windows uninstall records. Registry
   * entries provide hints, not trust: every DisplayIcon candidate must still
   * be the product's Electron binary with the known Electron layout before
   * execution.
   */
  private discoverWindowsApp;
  private spawnPayload;
  private spawnAt;
}
//#endregion
//#region src/core/auth.d.ts
/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
interface WorkBuddyCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh';
}
/** Read-only sign-in summary for status and doctor output. */
interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out';
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
  /**
   * Why no credential is usable, when the reason is diagnosable rather than
   * "nobody is signed in" — a region mismatch being the case that matters.
   * Present only on `signed-out`, and never a substitute for fixing the file.
   */
  reason?: string;
  /**
   * Machine-readable companion to {@link reason}, for callers that must branch
   * on the cause. Never derived by matching `reason` text.
   */
  reasonCode?: WorkBuddySignedOutReasonCode;
}
/** Constructor options; only {@link refresh} is required. */
interface WorkBuddyStoreOptions {
  variant?: WorkBuddyVariant;
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string;
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string;
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
  /**
   * Resolver for WorkBuddy 5.6's at-rest protector key, needed when the
   * desktop file stores encrypted token fields. Defaults to the real
   * provider, which spawns the WorkBuddy Electron binary; tests stand in a
   * stub. Structural so a store never depends on how the key is reached.
   */
  keyProvider?: Pick<WorkBuddyAtRestKeyProvider, 'protectorKeyFor' | 'helperPath'>;
}
/** Basename of the plugin-owned credential copy inside the Harness home. */
declare const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/** Env variable that overrides the desktop auth-file location. */
declare const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Plugin-owned copy path inside the Harness home. */
declare function workbuddyOwnAuthPath(): string;
/**
 * Platform-default candidates for the WorkBuddy desktop app's auth file, in
 * probe order. Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). Linux
 * probes both XDG bases — most distributions write under the config home,
 * but UOS/deepin builds write under the data home (issue #43), and probing
 * only one silently reads a signed-in app as signed out. WSL probes those
 * same Windows locations through its mounted Windows profile before the
 * native Linux locations.
 */
declare function defaultDesktopAuthCandidates(): string[];
/**
 * The platform-default candidates for one variant, in probe order.
 *
 * Both apps write into the *same* shared `CodeBuddyExtension` auth directory
 * and differ only in the file's basename, so the per-platform ordering above
 * is reused verbatim and just the filename is swapped.
 */
declare function desktopAuthCandidatesFor(variant: WorkBuddyVariant): string[];
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
declare function defaultDesktopAuthPath(variant?: WorkBuddyVariant): string | undefined;
/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
declare function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined;
/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin
 * (or already expired), keep the refreshed credential in the plugin-owned
 * copy, and never write the desktop app's file. A failed refresh still
 * returns a not-yet-expired token so an unreachable refresh endpoint does
 * not take down a working session.
 */
declare class WorkBuddyCredentialStore {
  private readonly variant;
  private readonly refresh;
  private readonly refreshMarginMs;
  private readonly ownPath;
  private readonly keyProvider;
  private desktopPathOverride;
  private inflight;
  constructor(options: WorkBuddyStoreOptions);
  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates;
  private resolveDesktopPath;
  /**
   * Repoint the desktop file; a settings change applies on the next read.
   */
  setDesktopPath(path: string | undefined): void;
  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined;
  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string;
  /** Read the freshest stored credential without refreshing anything. */
  current(): Promise<WorkBuddyCredential | undefined>;
  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  resolve(): Promise<WorkBuddyCredential>;
  /** Read-only sign-in summary; never refreshes and never throws. */
  status(): Promise<WorkBuddyAuthStatus>;
  /** Remove the plugin-owned copy; the desktop file is untouched. */
  logout(): Promise<void>;
  private needsRefresh;
  private refreshNow;
  private saveOwn;
  /**
   * Read the first desktop candidate that exists. Only an absent file
   * (ENOENT) falls through to the next candidate; a file that is present
   * but unparsable is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one.
   *
   * Since WorkBuddy 5.6 the token fields may arrive in at-rest envelopes, so
   * the text is classified before the regular parser sees it. An encrypted
   * document must be *opened*, never skipped; an unrecognized one must fail
   * loudly. The desktop file, as long as it exists, is the identity
   * authority — a document this plugin cannot read must surface as a
   * diagnosis rather than be papered over by the plugin-owned copy, which
   * belongs to whatever account was signed in when it was last refreshed.
   * Only an absent (or empty) file lets the probe continue.
   */
  private readDesktop;
  /** Open a 5.6 encrypted desktop document into the regular credential shape. */
  private openEncryptedDesktop;
  /**
   * Classify the first desktop candidate that exists and carries content;
   * `absent` when none does. An empty first file is skipped so it cannot mask
   * a real document on the next candidate. Diagnostics only — it never spawns
   * the key helper and never decrypts, so doctor can describe the file
   * without attempting the unlock.
   */
  desktopAuthFormat(): Promise<DesktopAuthFormat>;
  private readOwn;
  /**
   * The first desktop candidate the probe would actually read from; `undefined`
   * when none qualifies. Semantics deliberately match the probe: empty files
   * are skipped (the probe classifies them as absent and moves on), so on an
   * XDG layout where the config-home file is empty but the data-home file
   * holds the credential, diagnostics name the *data-home* file — the one
   * authentication really uses. Like the probe it never parses or decrypts.
   */
  resolvedDesktopAuthPath(): Promise<string | undefined>;
  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  desktopFilePresent(): Promise<boolean>;
}
//#endregion
//#region src/core/catalog.d.ts
/** One model entry the adapter exposes. */
type WorkBuddyModelInfo = WorkBuddyUpstreamModel;
/**
 * Static CLI models observed on the CN endpoint (re-verified against the live
 * `/v3/config` document 2026-09-23, including the thinking-effort and billing
 * metadata). The upstream refresh replaces this list at startup; it exists so
 * the provider registers with a usable catalog even while the first fetch is
 * in flight or offline.
 *
 * The list tracks the `cli` agent's model roster exactly — the 16 models it
 * offered that day. The roster churns quickly (`auto`, `kimi-k3-1`,
 * `minimax-m3` each appeared or vanished within days, and a competing patch's
 * 2026-09-22 snapshot named three ids that were gone a day later), so this
 * table is a boot-time placeholder, never a promise: the live fetch
 * intersects the day's roster with the document's usable rows, and
 * `tests/upstream.spec.ts` pins this table to the same parse so the two
 * cannot drift apart silently. Reasoning metadata is verbatim from the live
 * document, and the `free` flag follows the normalized `x0.00` credits
 * marker.
 *
 * Deliberately NOT baked in: promotional badges. `限时免费` and friends are
 * dynamic console-side promotions with no reliable validity window, so a
 * static table would keep them alive long after the offers end. The live
 * refresh merges the day's badges best-effort from the console document (see
 * `fetchPromoBadges` in upstream.ts); until then the rows simply ship
 * without them.
 */
declare const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[];
/**
 * Static CLI models for the international endpoint, captured 2026-09-11 from
 * the App-form `/v3/config` document (the 20 ids of its `cli` agent, in order).
 *
 * Same purpose and same discipline as {@link FALLBACK_WORKBUDDY_MODELS}: it
 * covers the window before the first successful fetch and an offline start,
 * and it is deliberately *not* a promise about the upstream's current state.
 * Reasoning metadata is verbatim from that snapshot. No promo badge is baked
 * in: promotions are time-boxed (`modelPromotions` carries `validFrom`/
 * `validUntil`), so hard-coding a "Free now" label would keep claiming a
 * discount the upstream may have already ended.
 */
declare const FALLBACK_WORKBUDDY_AI_MODELS: readonly WorkBuddyModelInfo[];
/**
 * Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * Visibility is separate from content. A variant whose app has no credentials
 * must expose *no* models rather than a fallback roster: the DSH model picker
 * drops an empty group, so an empty catalog is exactly how a provider hides
 * without touching registration. Serving the fallback to a signed-out user
 * instead offers models that can only fail (`store.resolve()` throws on the
 * first message), which is worse than showing nothing.
 *
 * The flag defaults to visible so a directly-constructed catalog behaves as it
 * always has; the plugin runtime applies the credential gate.
 */
declare class WorkBuddyCatalog {
  private models;
  private visible;
  private useMaximumContextWindow;
  constructor(initial?: readonly WorkBuddyModelInfo[]);
  /** Current entries; empty while the variant has no usable credential. */
  current(): readonly WorkBuddyModelInfo[];
  /** Replace the list; callers invalidate their adapter snapshot after this. */
  set(models: readonly WorkBuddyModelInfo[]): void;
  /** Whether this variant's models are exposed at all. */
  isVisible(): boolean;
  /**
   * Show or hide the whole catalog. Returns whether the value changed, so the
   * caller can skip an invalidation that would re-render an identical list.
   */
  setVisible(visible: boolean): boolean;
  /** Select the largest declared international window where the upstream offers one. */
  setUseMaximumContextWindow(useMaximum: boolean): boolean;
  /** Models to fall back to when the upstream fetch fails; ignores visibility. */
  fallback(): readonly WorkBuddyModelInfo[];
}
//#endregion
//#region src/core/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WorkBuddyShimOptions {
  store: WorkBuddyCredentialStore;
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>;
  catalog: WorkBuddyCatalog;
  logger?: ShimLogger;
  /**
   * Preferred loopback port, so a restart can keep the address clients are
   * already configured with. A taken port falls back to an ephemeral one.
   */
  port?: number;
  /**
   * Preferred bearer secret, so a restart can keep the token clients already
   * hold. Absent means a fresh random secret for this process.
   */
  token?: string;
}
/**
 * The neutral loopback endpoint the WorkBuddy shim and the custom
 * OpenAI-compatible provider endpoint are both built on. It owns the
 * listener, the per-process secret, the inbound gates, the shared route
 * skeleton, and body reading; the flavor supplies only what routes exist.
 */
interface LoopbackEndpoint {
  ready: Promise<void>;
  baseUrl(): string;
  token(): string;
  close(): Promise<void>;
}
/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
declare function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim;
//#endregion
export { PROBE_EFFORT_CANDIDATES as $, UpstreamErrorKind as A, WorkBuddyUpstreamClient as B, AI_VARIANT as C, validAppVersion as Ct, WorkBuddyVariant as D, WorkBuddyElectronProduct as E, WorkBuddyModelBilling as F, modelWithCurrentPromotion as G, classifyUpstreamError as H, WorkBuddyModelReasoning as I, prepareChatBody as J, normalizeCredits as K, WorkBuddyPromotion as L, WorkBuddyChatResult as M, WorkBuddyCredits as N, electronProfileFor as O, WorkBuddyEffort as P, upstreamErrorCode as Q, WorkBuddyRefreshOutcome as R, atRestKeyProviderFor as S, resolveAppVersion as St, WORKBUDDY_VARIANTS as T, extractDisplayErrorMessage as U, WorkBuddyUpstreamModel as V, isChannelValidationBlock as W, prepareInternationalChatBody as X, prepareCnChatBody as Y, regionOf as Z, defaultDesktopAuthPath as _, WORKBUDDY_APP_VERSION_FILENAME as _t, createWorkBuddyShim as a, probeModel as at, workbuddyOwnAuthPath as b, installedAppVersion as bt, WorkBuddyCatalog as c, ChatIdentity as ct, WORKBUDDY_AUTH_FILE_ENV as d, chatUserAgent as dt, ProbeAttempt as et, WorkBuddyAuthStatus as f, fallbackChatIdentity as ft, defaultDesktopAuthCandidates as g, AppVersionInfo as gt, WorkBuddyStoreOptions as h, validCliVersion as ht, WorkBuddyShimOptions as i, SentinelFactory as it, WorkBuddyCatalogFetch as j, variantFor as k, WorkBuddyModelInfo as l, FALLBACK_CN_APP_VERSION as lt, WorkBuddyCredentialStore as m, resolveChatIdentity as mt, ShimLogger as n, ProbeRegion as nt, FALLBACK_WORKBUDDY_AI_MODELS as o, randomSentinel as ot, WorkBuddyCredential as p, readCliVersion as pt, parseModelCatalog as q, WorkBuddyShim as r, ProbeSender as rt, FALLBACK_WORKBUDDY_MODELS as s, CN_APP_VERSION_FILENAME as st, LoopbackEndpoint as t, ProbeOutcome as tt, WORKBUDDY_AUTH_FILENAME as u, ResolveChatIdentityOptions as ut, desktopAuthCandidatesFor as v, WorkBuddyAppVersionSource as vt, CN_VARIANT as w, WorkBuddyAtRestKeyProvider as x, readBundleVersion as xt, parseWorkBuddyAuth as y, appUserAgent as yt, WorkBuddyRegion as z };