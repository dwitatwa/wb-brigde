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

import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '../core/atomic-write.ts'
import { resolveBridgeHome } from '../core/bridge-home.ts'
import { parseProviderConfig, RESERVED_IDS } from './provider-config.ts'
import { restrictDirToCurrentUser } from './windows-acl.ts'

/** On-disk format version this store reads and writes. */
export const MANAGED_PROVIDERS_VERSION = 1

/** Directory name under the bridge home holding the managed store. */
export const MANAGED_PROVIDERS_DIRNAME = 'managed-providers'

/** Document filename inside {@link MANAGED_PROVIDERS_DIRNAME}. */
export const MANAGED_PROVIDERS_FILENAME = 'providers.json'

/** One UI-managed provider, as every response carries it. Metadata only. */
export interface ManagedProvider {
  id: string
  displayName: string
  /** The full OpenAI-compatible API prefix; `/chat/completions` is appended. */
  baseUrl: string
  models: string[]
  authMode: 'api-key' | 'none'
  /** Whether a key is stored — never the key itself. */
  hasApiKey: boolean
}

/** The store's answer: the current roster and its concurrency token. */
export interface ManagedProviderSnapshot {
  revision: string
  providers: ManagedProvider[]
}

/** The management surface the UI and the bridge expose. */
export interface ProviderManagement {
  list(): Promise<ManagedProviderSnapshot>
  save(input: unknown): Promise<ManagedProviderSnapshot>
  remove(input: unknown): Promise<ManagedProviderSnapshot>
}

/**
 * A manager rejection with an HTTP status and a message safe to show: no
 * field value, no key, no filesystem detail ever appears in one.
 */
export class ProviderManagementError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ProviderManagementError'
  }
}

/** What the document holds on disk. The key lives here and nowhere else. */
interface StoredProvider {
  id: string
  displayName: string
  baseUrl: string
  models: string[]
  authMode: 'api-key' | 'none'
  apiKey?: string
}

interface StoredDocument {
  version: typeof MANAGED_PROVIDERS_VERSION
  revision: string
  providers: StoredProvider[]
}

/** Strip the stored key, yielding the metadata-only view. */
function viewOf(stored: StoredProvider): ManagedProvider {
  return {
    id: stored.id,
    displayName: stored.displayName,
    baseUrl: stored.baseUrl,
    models: [...stored.models],
    authMode: stored.authMode,
    hasApiKey: stored.apiKey !== undefined && stored.apiKey !== '',
  }
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/**
 * The id slug a display name would generate: lowercased, runs of anything
 * outside `[a-z0-9._-]` collapsed to a single dash, edge separators dropped.
 */
function slugOf(displayName: string): string {
  return displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/[-._]{2,}/gu, '-')
    .replace(/^[-._]+|[-._]+$/gu, '')
}

/** Whether the value is a string with content after trimming. */
function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Validate one save payload, or throw a {@link ProviderManagementError}.
 * The file-config parser stays the authority on base URLs; this adds the
 * management payload's own rules on top.
 */
function validateSave(input: unknown): {
  revision: string
  id: string | undefined
  displayName: string
  baseUrl: string
  models: string[]
  authMode: 'api-key' | 'none'
  apiKey: string | undefined
} {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProviderManagementError(400, 'provider payload must be a JSON object')
  }
  const record = input as Record<string, unknown>
  const allowed = new Set(['revision', 'id', 'displayName', 'baseUrl', 'models', 'authMode', 'apiKey'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      // Unknown field names are user input; never echo them.
      throw new ProviderManagementError(400, 'provider payload contains an unknown field')
    }
  }
  if (!isNonemptyString(record['revision'])) {
    throw new ProviderManagementError(400, 'provider payload must carry the current revision')
  }
  const rawId = record['id']
  if (rawId !== undefined && (typeof rawId !== 'string' || !SLUG_PATTERN.test(rawId))) {
    throw new ProviderManagementError(400, 'provider id must be a lowercase slug')
  }
  if (!isNonemptyString(record['displayName'])) {
    throw new ProviderManagementError(400, 'provider displayName must be a nonempty string')
  }
  if (!isNonemptyString(record['baseUrl'])) {
    throw new ProviderManagementError(400, 'provider baseUrl must be a nonempty string')
  }
  // Reuse the file-config parser's URL rules through a throwaway document:
  // it names `baseUrl` in its error and never echoes the value.
  const probe = parseProviderConfig({
    version: 1,
    providers: [{ id: 'probe', baseUrl: record['baseUrl'], models: ['probe'] }],
  })
  if (!probe.ok) {
    throw new ProviderManagementError(400, 'provider baseUrl is not a valid OpenAI-compatible base URL')
  }
  const rawModels = record['models']
  if (!Array.isArray(rawModels) || rawModels.length === 0 ||
    rawModels.some(model => typeof model !== 'string' || (model as string).trim() === '')) {
    throw new ProviderManagementError(400, 'provider models must be a nonempty array of nonempty strings')
  }
  if (new Set(rawModels).size !== rawModels.length) {
    throw new ProviderManagementError(400, 'provider models must not contain duplicates')
  }
  const authMode = record['authMode']
  if (authMode !== 'api-key' && authMode !== 'none') {
    throw new ProviderManagementError(400, 'provider authMode must be "api-key" or "none"')
  }
  // The generated id depends only on the payload, so its usability is a
  // validation concern: a stale tab must see the same 400 a fresh one would,
  // not a 409 that hides the real problem.
  const base = slugOf(record['displayName'] as string)
  if (!SLUG_PATTERN.test(base)) {
    throw new ProviderManagementError(400, 'provider displayName does not produce a usable id; choose another name')
  }
  if (RESERVED_IDS.has(base)) {
    throw new ProviderManagementError(400, 'provider displayName is reserved; choose another name')
  }
  let apiKey: string | undefined = record['apiKey'] as string | undefined
  if (typeof apiKey === 'string') {
    // A blank key counts as absent: an edit keeps the stored one.
    apiKey = apiKey.trim() === '' ? undefined : apiKey
  } else if (apiKey !== undefined) {
    throw new ProviderManagementError(400, 'provider apiKey must be a string when present')
  }
  if (authMode === 'api-key' && apiKey === undefined && rawId === undefined) {
    throw new ProviderManagementError(400, 'a new api-key provider requires an apiKey')
  }
  return {
    revision: record['revision'] as string,
    id: rawId,
    displayName: (record['displayName'] as string).trim(),
    baseUrl: probe.config.providers[0]!.baseUrl,
    models: [...rawModels] as string[],
    authMode,
    apiKey,
  }
}

/**
 * The generated id for a display name, unique against `taken` and never one
 * of the parser's reserved ids: `my-gateway`, then `my-gateway-2`, … and, as
 * a last resort, a short random suffix. A name whose own slug is reserved or
 * unusable is an explicit error rather than a silently mangled id.
 */
function generateId(displayName: string, taken: ReadonlySet<string>): string {
  // Reserved/usable checks already ran in `validateSave`; only collisions
  // are resolved here.
  const base = slugOf(displayName)
  if (!taken.has(base)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate) && !RESERVED_IDS.has(candidate)) return candidate
  }
  for (;;) {
    const candidate = `${base}-${randomBytes(4).toString('hex')}`
    if (!taken.has(candidate) && !RESERVED_IDS.has(candidate)) return candidate
  }
}

/** Options for {@link WorkBuddyManagedProviderStore}. */
export interface WorkBuddyManagedProviderStoreOptions {
  /** Explicit document path; defaults to the bridge home's managed directory. */
  path?: string
  /**
   * Restrict the credential directory to the current user on platforms whose
   * mode bits cannot (Windows). Injectable so tests never spawn a process;
   * the production seam takes the path and nothing else — a key never rides
   * a command line because the store never passes one.
   */
  restrictCredentialDir?: (dir: string) => Promise<void>
}

/**
 * The file-backed managed-provider store. Every operation serializes through
 * the document's advisory lock, so two tabs (or two processes) cannot lose
 * each other's writes, and the revision check turns a loser into a 409
 * instead of a silent overwrite.
 */
export class WorkBuddyManagedProviderStore implements ProviderManagement {
  private readonly path: string
  private readonly dir: string
  private readonly restrictCredentialDir: (dir: string) => Promise<void>

  constructor(options: WorkBuddyManagedProviderStoreOptions = {}) {
    this.path = options.path ?? join(resolveBridgeHome(), MANAGED_PROVIDERS_DIRNAME, MANAGED_PROVIDERS_FILENAME)
    this.dir = join(this.path, '..')
    this.restrictCredentialDir = options.restrictCredentialDir ?? restrictDirToCurrentUser
  }

  /** The document path, for diagnostics and tests. */
  filePath(): string {
    return this.path
  }

  /**
   * The id a new provider with this display name would get, **without
   * persisting anything** — the staging step's dry run. `undefined` when the
   * name would generate an unusable or reserved id (the caller treats that
   * as a validation failure). Collision suffixes depend on what is already
   * stored, so a concurrent create can still change the final id; the commit
   * is authoritative.
   */
  previewId(displayName: unknown): string | undefined {
    if (!isNonemptyString(displayName)) return undefined
    const base = slugOf(displayName)
    if (!SLUG_PATTERN.test(base) || RESERVED_IDS.has(base)) return undefined
    return base
  }

  /**
   * Create the credential directory with 0700 **before** the lock runs:
   * `withFileLock` makes its own recursive mkdir with default modes, so
   * letting it create the directory would leave a 0755 credential directory
   * behind. chmod after mkdir repairs a directory an older version created
   * wide; the Windows seam runs in the same place. A failed ACL pass fails
   * closed — the caller refuses to write a credential into a directory whose
   * protection could not be verified.
   */
  private async ensurePrivateDir(): Promise<void> {
    const { mkdir, chmod } = await import('node:fs/promises')
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      // A mode repair that fails leaves the credential directory broader
      // than 0700, so the save must fail closed rather than write a key
      // into a directory whose protection is unverified.
      try {
        await chmod(this.dir, 0o700)
      } catch {
        throw new ProviderManagementError(
          500,
          'the credential directory could not be locked down to 0700; refusing to store a key',
        )
      }
    }
    try {
      await this.restrictCredentialDir(this.dir)
    } catch (error: unknown) {
      // Safe message only: the raw error could carry paths or tool output.
      throw new ProviderManagementError(
        500,
        'the credential directory could not be restricted to the current user; refusing to store a key',
      )
    }
  }

  async list(): Promise<ManagedProviderSnapshot> {
    await this.ensurePrivateDir()
    return await withFileLock(this.path, async () => {
      const document = await this.readUnderLock()
      return { revision: document.revision, providers: document.providers.map(viewOf) }
    })
  }

  /**
   * The full committed state under one lock: the metadata snapshot AND every
   * provider's captured credential, from the **same** document at the **same**
   * revision. The runtime consumes this so a configuration and its key can
   * never be assembled from two different commits (this process's or another
   * process's). Secrets live in the return value only — never in the public
   * projection, never in a log.
   */
  async loadInternal(): Promise<{ metadata: ManagedProviderSnapshot, secrets: Record<string, string | undefined> }> {
    await this.ensurePrivateDir()
    return await withFileLock(this.path, async () => {
      const document = await this.readUnderLock()
      return {
        metadata: { revision: document.revision, providers: document.providers.map(viewOf) },
        secrets: Object.fromEntries(document.providers.map(provider => [provider.id, provider.apiKey])),
      }
    })
  }

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
  async saveInternal(input: unknown, options: { blockedIds?: readonly string[] } = {}): Promise<{
    metadata: ManagedProviderSnapshot
    secrets: Record<string, string | undefined>
  }> {
    const request = validateSave(input)
    await this.ensurePrivateDir()
    const blocked = new Set(options.blockedIds ?? [])
    const { metadata, secrets } = await this.withDocumentInternal(request.revision, async document => {
      if (request.id === undefined) {
        const id = generateId(request.displayName, new Set(document.providers.map(provider => provider.id)))
        if (blocked.has(id)) {
          throw new ProviderManagementError(400, 'the new provider would collide with an external configured provider; choose another name')
        }
        document.providers.push({
          id,
          displayName: request.displayName,
          baseUrl: request.baseUrl,
          models: request.models,
          authMode: request.authMode,
          ...(request.authMode === 'api-key' && request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
        })
      } else {
        const index = document.providers.findIndex(candidate => candidate.id === request.id)
        if (index === -1) throw new ProviderManagementError(404, 'no stored provider with that id')
        const existing = document.providers[index]!
        document.providers[index] = {
          id: existing.id,
          displayName: request.displayName,
          baseUrl: request.baseUrl,
          models: request.models,
          authMode: request.authMode,
          ...(request.authMode === 'api-key'
            ? { apiKey: request.apiKey ?? existing.apiKey }
            : {}),
        }
        if (document.providers[index]!.authMode === 'api-key' && document.providers[index]!.apiKey === undefined) {
          throw new ProviderManagementError(400, 'the stored provider has no key to keep; supply an apiKey')
        }
      }
      document.revision = newRevision()
      await writeFileInternal(this.path, document)
      return {
        metadata: { revision: document.revision, providers: document.providers.map(viewOf) },
        secrets: Object.fromEntries(document.providers.map(provider => [provider.id, provider.apiKey])),
      }
    })
    return { metadata, secrets }
  }

  /** The public metadata-only save: a thin projection over the transaction. */
  async save(input: unknown): Promise<ManagedProviderSnapshot> {
    return (await this.saveInternal(input)).metadata
  }

  /** The transactional remove: same contract as {@link remove} with the internal return. */
  async removeInternal(input: unknown): Promise<{
    metadata: ManagedProviderSnapshot
    secrets: Record<string, string | undefined>
  }> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ProviderManagementError(400, 'remove payload must be a JSON object')
    }
    const record = input as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'revision' && key !== 'id') {
        throw new ProviderManagementError(400, 'remove payload contains an unknown field')
      }
    }
    if (!isNonemptyString(record['revision'])) {
      throw new ProviderManagementError(400, 'remove payload must carry the current revision')
    }
    if (!isNonemptyString(record['id'])) {
      throw new ProviderManagementError(400, 'remove payload must carry the provider id')
    }
    await this.ensurePrivateDir()
    const revision = record['revision']
    const id = record['id']
    return await this.withDocumentInternal(revision, async document => {
      const index = document.providers.findIndex(candidate => candidate.id === id)
      if (index === -1) throw new ProviderManagementError(404, 'no stored provider with that id')
      document.providers.splice(index, 1)
      document.revision = newRevision()
      await writeFileInternal(this.path, document)
      return {
        metadata: { revision: document.revision, providers: document.providers.map(viewOf) },
        secrets: Object.fromEntries(document.providers.map(provider => [provider.id, provider.apiKey])),
      }
    })
  }

  /** The public metadata-only remove: a thin projection over the transaction. */
  async remove(input: unknown): Promise<ManagedProviderSnapshot> {
    return (await this.removeInternal(input)).metadata
  }

  /**
   * Load, mutate, and persist under one lock, checking the caller's revision
   * against the document just loaded — the cross-tab and cross-process guard.
   */
  private async withDocumentInternal(
    expectedRevision: string,
    mutate: (document: StoredDocument) => Promise<{
      metadata: ManagedProviderSnapshot
      secrets: Record<string, string | undefined>
    }>,
  ): Promise<{
    metadata: ManagedProviderSnapshot
    secrets: Record<string, string | undefined>
  }> {
    return await withFileLock(this.path, async () => {
      const document = await this.readUnderLock()
      if (document.revision !== expectedRevision) {
        throw new ProviderManagementError(409, 'the provider list changed elsewhere; reload and retry')
      }
      return await mutate(document)
    })
  }

  /** Read and parse the document; a corrupt one fails safe. */
  private async readUnderLock(): Promise<StoredDocument> {
    const { readFile } = await import('node:fs/promises')
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: MANAGED_PROVIDERS_VERSION, revision: ABSENT_REVISION, providers: [] }
      }
      // Unreadable for a real reason (permissions, disk): fail safe too.
      throw new ProviderManagementError(500, 'the managed provider document could not be read')
    }
    const parsed = parseDocument(text)
    if (parsed === undefined) {
      throw new ProviderManagementError(500, 'the managed provider document is corrupt; fix or remove it by hand')
    }
    return parsed
  }
}

/** Persist under the caller's lock; the caller assembles the answer. */
async function writeFileInternal(path: string, document: StoredDocument): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
}

/**
 * The revision an absent document reports, fixed until the first write: two
 * callers looking at the same empty store must agree it is "revision zero",
 * or a create would race itself. Random tokens start with the first write.
 */
const ABSENT_REVISION = 'absent'

/** A fresh opaque revision token. */
function newRevision(): string {
  return randomBytes(16).toString('base64url')
}

/** Parse an on-disk document; `undefined` when it is not one we trust. */
function parseDocument(text: string): StoredDocument | undefined {
  // Only an *absent* file means "nothing saved yet"; an existing blank file
  // is a damaged one and must fail safe rather than read as an empty roster.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  for (const key of Object.keys(document)) {
    if (key !== 'version' && key !== 'revision' && key !== 'providers') return undefined
  }
  if (document['version'] !== MANAGED_PROVIDERS_VERSION) return undefined
  if (!isNonemptyString(document['revision'])) return undefined
  if (!Array.isArray(document['providers'])) return undefined
  const providers: StoredProvider[] = []
  const seenIds = new Set<string>()
  for (const raw of document['providers']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const entry = raw as Record<string, unknown>
    for (const key of Object.keys(entry)) {
      if (key !== 'id' && key !== 'displayName' && key !== 'baseUrl' && key !== 'models' && key !== 'authMode' && key !== 'apiKey') {
        return undefined
      }
    }
    if (!isNonemptyString(entry['id']) || !SLUG_PATTERN.test(entry['id']) || RESERVED_IDS.has(entry['id'] as string)) {
      return undefined
    }
    if (seenIds.has(entry['id'] as string)) return undefined
    seenIds.add(entry['id'] as string)
    if (!isNonemptyString(entry['displayName'])) return undefined
    if (!isNonemptyString(entry['baseUrl'])) return undefined
    // The document is validated by the same parser rules a save would pass
    // through, so a hand-edited file can never hold what a save could not.
    const urlProbe = parseProviderConfig({
      version: 1,
      providers: [{ id: 'probe', baseUrl: entry['baseUrl'], models: ['probe'] }],
    })
    if (!urlProbe.ok) return undefined
    if (!Array.isArray(entry['models']) || entry['models'].length === 0 ||
      entry['models'].some(model => typeof model !== 'string' || (model as string).trim() === '')) return undefined
    if (new Set(entry['models']).size !== entry['models'].length) return undefined
    const authMode = entry['authMode']
    if (authMode !== 'api-key' && authMode !== 'none') return undefined
    const apiKey = entry['apiKey']
    if (authMode === 'none' && apiKey !== undefined) return undefined
    // An api-key entry without a stored key is not a loadable state: the
    // editor requires one for a new provider, so the document cannot hold
    // what a save could not write.
    if (authMode === 'api-key' && (typeof apiKey !== 'string' || apiKey === '')) return undefined
    providers.push({
      id: entry['id'] as string,
      displayName: entry['displayName'] as string,
      baseUrl: urlProbe.config.providers[0]!.baseUrl,
      models: [...entry['models']] as string[],
      authMode,
      ...typeof apiKey === 'string' && apiKey !== '' ? { apiKey } : {},
    })
  }
  return { version: MANAGED_PROVIDERS_VERSION, revision: document['revision'] as string, providers }
}
