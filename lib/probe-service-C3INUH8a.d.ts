import { B as WorkBuddyUpstreamClient, P as WorkBuddyEffort, V as WorkBuddyUpstreamModel, c as WorkBuddyCatalog, it as SentinelFactory, l as WorkBuddyModelInfo, m as WorkBuddyCredentialStore, nt as ProbeRegion, rt as ProbeSender } from "./shim-C_F_ZwL7.js";
//#region src/core/catalog-store.d.ts
/** Basename of the CN variant's saved catalog inside the Harness home. */
declare const WORKBUDDY_CATALOG_FILENAME = ".workbuddy-catalog.json";
/** One saved catalog: the account it belonged to, and the models it listed. */
interface SavedCatalog {
  /** `uid:enterpriseId` the catalog was fetched for. */
  account: string;
  /** Which document answered, so a CN roster is never served as an AI one. */
  source: string;
  /** When the fetch succeeded, epoch milliseconds. */
  fetchedAtMs: number;
  models: readonly WorkBuddyUpstreamModel[];
  /** App version used as the UA, when the variant needed one. */
  appVersion?: string;
}
/** Plugin-owned saved-catalog path inside the Harness home. */
declare function workbuddyCatalogPath(filename?: string): string;
/** Options for {@link WorkBuddyCatalogStore}. */
interface WorkBuddyCatalogStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
}
/**
 * The last successful catalog per account, read once and written atomically.
 *
 * Malformed content reads as "nothing saved" rather than throwing: this file
 * is an optimization for the offline and first-seconds cases, and a corrupt one
 * must never be able to stop the plugin from serving models.
 */
declare class WorkBuddyCatalogStore {
  private readonly path;
  private entries;
  constructor(options?: WorkBuddyCatalogStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /** The saved catalog for one account, or `undefined` when there is none. */
  get(account: string): SavedCatalog | undefined;
  /**
   * Remember a catalog for an account, replacing whatever was saved before.
   *
   * A failed write is swallowed: the plugin has already served these models,
   * and losing the *memory* of them is not worth surfacing.
   */
  set(account: string, catalog: Omit<SavedCatalog, 'account'>): void;
  /** Forget one account's catalog — used when that account signs out. */
  delete(account: string): void;
  private persist;
}
//#endregion
//#region src/core/visibility-store.d.ts
/**
 * Per-account model-visibility preferences: which models the signed-in account
 * has hidden from the DSH model picker (issue #36).
 *
 * A disabled *list*, deliberately not an enabled whitelist: a new account and a
 * model the upstream adds both start visible, and an id that temporarily
 * disappears from the catalog is kept — when the model returns it stays hidden
 * until this account says otherwise. Entries are also kept across sign-outs, so
 * returning to an account restores exactly what it left.
 *
 * One file per variant (the two endpoints share model ids but never
 * preferences), keyed by the same `uid:enterpriseId` identity the saved
 * catalogs and probe records use. Not a place for secrets: model-id strings
 * only, never a token, and never written into the desktop auth file or the
 * plugin-owned credential copy — hiding a model is a picker preference, not
 * credential state.
 *
 * Why a plugin-owned file rather than a settings section: the settings sections
 * are statically-typed schemastery objects, and `settings.yaml` is account-global
 * — a per-uid dynamic map fits neither without weakening the schema or mixing
 * one account's preferences into another's config. The saved-catalog and probe
 * stores already persist per-account data this way, so this store follows them:
 * version-tagged document, atomic write with `0o600`, and a malformed file that
 * reads as "nothing saved" rather than throwing.
 *
 * @module dsh-workbuddy-connect/visibility-store
 */
/** Basename of the CN variant's visibility file inside the Harness home. */
declare const WORKBUDDY_VISIBILITY_FILENAME = ".workbuddy-model-visibility.json";
/** Plugin-owned visibility-file path inside the Harness home. */
declare function workbuddyVisibilityPath(filename?: string): string;
/** Options for {@link WorkBuddyVisibilityStore}. */
interface WorkBuddyVisibilityStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
}
/**
 * The per-account hidden-model lists, read once and written atomically.
 *
 * Unlike the saved-catalog store, a failed *write* propagates: the caller
 * reports it to the user rather than answering "hidden" for a preference that
 * did not persist. Reads stay forgiving — a corrupt or unreadable file is
 * "nothing hidden", which only ever shows models the account can still pick.
 */
declare class WorkBuddyVisibilityStore {
  private readonly path;
  private accounts;
  constructor(options?: WorkBuddyVisibilityStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /** The model ids one account has hidden; empty when it never hid any. */
  disabled(account: string): readonly string[];
  /**
   * Show or hide one model for one account, persisting before committing.
   *
   * Re-enabling (showing) the last hidden model removes the account's entry
   * entirely — an absent entry and an empty list mean the same thing
   * (everything visible), and the file should not accumulate empty buckets.
   * Throws when the write fails, leaving the in-memory state untouched so a
   * re-read cannot lie about what was persisted.
   */
  setVisible(account: string, model: string, visible: boolean): void;
  private persist;
}
//#endregion
//#region src/core/probe-store.d.ts
/** Basename of the probe record inside the Harness home. */
declare const WORKBUDDY_PROBE_FILENAME = ".workbuddy-probe.json";
/**
 * Whether the model's effort parameter is actually validated.
 *
 * - `validating`: the upstream rejected an unknown sentinel value, so a
 *   per-level answer is meaningful.
 * - `non-validating`: the upstream accepted the sentinel, so it ignores or
 *   loosely coerces the parameter and no per-level answer can be trusted.
 * - `unknown`: baseline or sentinel failed for an unrelated reason (auth,
 *   rate limit, transport, ambiguous error body). Not a negative claim.
 */
type WorkBuddyProbeValidation = 'validating' | 'non-validating' | 'unknown';
/** One model's recorded observation. */
interface WorkBuddyProbeRecord {
  /** Fingerprint of the catalog row this observation was made against. */
  fingerprint: string;
  validation: WorkBuddyProbeValidation;
  /** Efforts verified as accepted; only ever non-empty for `validating`. */
  efforts: readonly WorkBuddyEffort[];
  /** When the probe ran, epoch milliseconds. */
  probedAtMs: number;
  /** Plugin version that produced the record. */
  pluginVersion: string;
  /**
   * The account this observation was made under, as `uid:enterpriseId`.
   *
   * An effort set is a fact about one account's entitlement as much as about
   * the model: the same model id can accept different levels under a different
   * subscription. Records are stored under this identity and only ever served
   * back to it, so one account never inherits another's detected levels — and
   * because the store nests by this identity, switching back finds this
   * account's own records intact rather than re-probing from scratch.
   */
  account: string;
}
/**
 * Plugin-owned probe record path inside the Harness home.
 *
 * One file per variant. Same-named models exist on both endpoints (the
 * international catalog repeats `glm-5.3`, `glm-5.2`, `hy3`, `kimi-k2.6`), and
 * {@link fingerprintModel} covers only `id`/`reasoning`/`supportsImages` —
 * never the provider — so a single shared file would let one variant's
 * observation answer for the other. The paths differ; the format does not.
 */
declare function workbuddyProbePath(filename?: string): string;
/**
 * Fingerprint the catalog fields a probe depends on.
 *
 * Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
 * so a rename or a promo badge does not throw away a valid observation, and
 * deliberately includes the whole reasoning object so any change to the
 * declared shape re-probes.
 */
declare function fingerprintModel(info: WorkBuddyModelInfo): string;
/** Options for {@link WorkBuddyProbeStore}. */
interface WorkBuddyProbeStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
  /** Observation lifetime; defaults to 14 days. */
  ttlMs?: number;
  /** Plugin version stamped into new records. */
  pluginVersion: string;
  /** Clock injection for tests. */
  now?: () => number;
}
/**
 * The plugin's probe records: read once, written atomically, keyed by the
 * account that produced each observation, and never trusted across a
 * fingerprint change or past the TTL.
 */
declare class WorkBuddyProbeStore {
  private readonly path;
  private readonly ttlMs;
  private readonly pluginVersion;
  private readonly now;
  private records;
  constructor(options: WorkBuddyProbeStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /**
   * The usable record for one account and model, or `undefined` when there is
   * none, it is expired, it was taken against a different catalog row, or it
   * belongs to a different account.
   *
   * @param account - the account in effect, as `uid:enterpriseId`. Records are
   *   only returned for the account that produced them.
   */
  get(modelId: string, fingerprint: string, account: string): WorkBuddyProbeRecord | undefined;
  /**
   * Store one observation under the account stamped on it. Only a decisive
   * answer (`validating` / `non-validating`) replaces an existing decisive
   * record *of the same account*: a transient `unknown` must not erase
   * knowledge the user already paid for.
   */
  set(modelId: string, record: WorkBuddyProbeRecord): void;
  /** Drop every record of every account; used by the card's explicit "clear" action. */
  clear(): void;
  /** Every record currently held, grouped by account, for status display. */
  all(): Readonly<Record<string, Readonly<Record<string, WorkBuddyProbeRecord>>>>;
  /** Build a record stamped with this store's clock, version, and account. */
  record(fingerprint: string, validation: WorkBuddyProbeValidation, efforts: readonly WorkBuddyEffort[], account: string): WorkBuddyProbeRecord;
  /**
   * Write through a temporary file and rename, so a crash mid-write cannot
   * leave a half-parsed document that reads as "no records" and silently drops
   * every observation.
   */
  private persist;
}
//#endregion
//#region src/core/probe-service.d.ts
/** What the caller learns about a completed probe. */
type WorkBuddyProbeStatus = {
  state: 'ok';
  validation: WorkBuddyProbeRecord['validation'];
  efforts: readonly string[];
  requests: number;
} | {
  state: 'unavailable';
  reason: string;
};
/** Options for {@link WorkBuddyProbeService}. */
interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore;
  catalog: WorkBuddyCatalog;
  credentials: WorkBuddyCredentialStore;
  client: WorkBuddyUpstreamClient;
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean;
  /**
   * The account currently in effect, as `uid:enterpriseId`, or `undefined`
   * while signed out.
   *
   * Records are read and written against this identity, and it is re-checked
   * after the sweep finishes: an observation produced under account A must not
   * be stored once account B is in effect, however long the probe took. The
   * store's per-account keying alone cannot catch that, because an in-flight
   * probe completes *after* the switch has already happened.
   */
  account: () => string | undefined;
  sentinel?: SentinelFactory;
  /**
   * Which endpoint's rejection vocabulary sweeps read. The two apps talk to
   * different upstreams that answer a bad effort with different codes, so each
   * runtime passes its own region instead of sharing one widening set.
   */
  region: ProbeRegion;
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender;
}
/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
declare class WorkBuddyProbeService {
  private readonly options;
  private queue;
  private readonly pending;
  private running;
  constructor(options: WorkBuddyProbeServiceOptions);
  /** Whether a sweep is in flight right now. */
  isRunning(): boolean;
  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * Applies the plan's precedence (§5): a declared set always wins, so a model
   * that declares `supportedEfforts` is never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined;
  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  probe(modelId: string, manualConsent?: boolean): Promise<WorkBuddyProbeStatus>;
}
//#endregion
export { WorkBuddyProbeStore as a, workbuddyProbePath as c, workbuddyVisibilityPath as d, WORKBUDDY_CATALOG_FILENAME as f, WorkBuddyProbeRecord as i, WORKBUDDY_VISIBILITY_FILENAME as l, workbuddyCatalogPath as m, WorkBuddyProbeStatus as n, WorkBuddyProbeValidation as o, WorkBuddyCatalogStore as p, WORKBUDDY_PROBE_FILENAME as r, fingerprintModel as s, WorkBuddyProbeService as t, WorkBuddyVisibilityStore as u };