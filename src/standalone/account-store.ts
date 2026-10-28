/**
 * The bridge-owned account folder: desktop sign-in files the bridge keeps for
 * itself, one per account, so the pool's membership can be curated and an
 * account can be removed without editing the desktop app's own directory.
 *
 * The problem this solves is *ownership*, not portability. WorkBuddy's auth
 * directory belongs to the desktop app: the app writes it, rewrites it, and
 * leaves a snapshot behind on every sign-in. The bridge may read it, but it
 * must not delete from it, and it must not adopt accounts from it. A folder
 * the bridge owns answers both: an account is in the pool because the operator
 * uploaded its file here, and no account is in the pool for any other reason.
 *
 * **A stored file is a copy of a desktop auth file, not a new format.** That
 * is deliberate: the credential store already knows how to read both shapes
 * (plaintext and the 5.6 at-rest envelope), so this module never parses,
 * decrypts, or rewrites a token. It copies bytes and records the account
 * identity beside them.
 *
 * **A file sealed by another install cannot be read here.** The at-rest key is
 * machine-local, so an envelope carries the key id it was sealed with, and
 * this store refuses one whose key id the local WorkBuddy app cannot produce.
 * The check runs before the file is written, so a foreign file is refused with
 * a reason instead of becoming a member that fails on every turn.
 *
 * @module workbuddy-bridge/standalone/account-store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '../core/atomic-write.ts'
import { resolveBridgeHome } from '../core/bridge-home.ts'
import {
  classifyDesktopAuthDocument,
  keyIdsOf,
  type WorkBuddyAtRestKeyProvider,
} from '../core/desktop-credential-protection.ts'
import { restrictDirToCurrentUser } from './windows-acl.ts'
import { regionOf, type WorkBuddyRegion } from '../core/upstream.ts'

/** Directory name under the bridge home holding stored account files. */
export const ACCOUNT_STORE_DIRNAME = 'accounts'

/** Suffix of a stored auth document. The name before it is the account uid. */
const ACCOUNT_FILE_SUFFIX = '.info'

/** Uid values safe to use as a file name, and nothing else. */
const UID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/u

/** One stored account, as the UI lists it. Metadata only — never a token. */
export interface StoredAccount {
  /** The account identity, which is also the file's basename. */
  uid: string
  /** The desktop file this copy came from, for the operator's benefit. */
  origin: string
  /** When the copy was written. */
  savedAtMs: number
  /** Whether the stored document is a 5.6 at-rest envelope. */
  encrypted: boolean
  /**
   * Which product's upstream this sign-in belongs to, when it can be read.
   *
   * Absent means the document carried no domain, which is not a guess the
   * store will make: such an account is offered to every variant and the
   * credential store refuses it where it does not belong.
   */
  region?: WorkBuddyRegion
}

/** A management rejection with an HTTP status and a browser-safe message. */
export class AccountStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AccountStoreError'
  }
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
export interface AccountManagement {
  /** The stored accounts, metadata only. */
  list(): Promise<readonly StoredAccount[]>
  /**
   * Store one sign-in file and serve it from the next request. `text` is the
   * file's own bytes; the manager validates and refuses a foreign envelope.
   */
  import(input: { text: string, origin?: string }): Promise<StoredAccount>
  /** Remove one stored account; `removed: false` when it was not there. */
  remove(uid: string): Promise<{ removed: boolean, total: number }>
}

/** The sidecar recorded beside each stored file. Never holds a credential. */
interface AccountMetadata {
  version: 1
  uid: string
  origin: string
  savedAtMs: number
}

/**
 * What the store can read about a candidate file *without* decrypting it.
 *
 * The identity is needed to name the file, and the key ids are needed to
 * refuse a file from another install. Both are plaintext in both document
 * shapes, which is why this can be answered before any key helper runs.
 */
export interface AccountCandidate {
  uid: string
  /** Envelope key ids; empty for a plaintext document. */
  keyIds: readonly string[]
  /** Whether the document is an at-rest envelope. */
  encrypted: boolean
  /** The upstream region the document's domain names, when it carries one. */
  region?: WorkBuddyRegion
}

/** Options for {@link WorkBuddyAccountStore}. */
export interface WorkBuddyAccountStoreOptions {
  /** Explicit directory; defaults to the bridge home's account folder. */
  dir?: string
  /**
   * Restricts the credential directory to the current user on platforms whose
   * mode bits cannot (Windows). Injectable so tests never spawn a process.
   */
  restrictCredentialDir?: (dir: string) => Promise<void>
}

/**
 * Read the identity and key ids from a candidate auth document.
 *
 * Returns `undefined` when the text is not a document this store can name: an
 * unparsable file, or one with no plaintext uid. That is a refusal rather than
 * a guess — a stored account whose uid is unknown cannot be removed by name.
 */
export function accountCandidateOf(text: string): AccountCandidate | undefined {
  const classification = classifyDesktopAuthDocument(text)
  if (classification.format === 'plaintext' || classification.format === 'encrypted') {
    const document = classification.format === 'plaintext'
      ? plaintextDocumentOf(text)
      : classification.wrapped.document
    if (document === undefined) return undefined
    const uid = plaintextUidOf(document)
    if (uid === undefined || !UID_PATTERN.test(uid)) return undefined
    const region = plaintextRegionOf(document)
    return {
      uid,
      encrypted: classification.format === 'encrypted',
      keyIds: classification.format === 'encrypted' ? keyIdsOf(classification.wrapped.fields) : [],
      ...region === undefined ? {} : { region },
    }
  }
  return undefined
}

/** Parse a plaintext document; `undefined` when it is not a JSON object. */
function plaintextDocumentOf(text: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/**
 * The plaintext account uid from either document shape.
 *
 * Mirrors the discovery sweep's rule — `account.uid`, or the document's own
 * `uid` in the flat panel form — because a stored file must be nameable by the
 * same identity the desktop directory is deduplicated by.
 */
function plaintextUidOf(document: Record<string, unknown>): string | undefined {
  const identity = typeof document['account'] === 'object' && document['account'] !== null
    ? document['account'] as Record<string, unknown>
    : document
  const uid = identity['uid']
  return typeof uid === 'string' && uid !== '' ? uid : undefined
}

/**
 * The plaintext upstream domain from either document shape, when present.
 *
 * `auth.domain` stays plaintext in both formats, so a stored account can be
 * routed to the product it belongs to without decrypting anything. A document
 * with no domain yields `undefined` rather than a default: guessing a region
 * would put the account in a pool that cannot use it.
 */
function plaintextDomainOf(document: Record<string, unknown>): string | undefined {
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  const domain = auth['domain']
  return typeof domain === 'string' && domain !== '' ? domain : undefined
}

/** The region a document's domain names, when it names one. */
function plaintextRegionOf(document: Record<string, unknown>): WorkBuddyRegion | undefined {
  const domain = plaintextDomainOf(document)
  return domain === undefined ? undefined : regionOf(domain)
}

/**
 * The bridge's own account folder.
 *
 * Every write is atomic (`writeFileAtomic`, mode `0600`) inside a `0700`
 * directory, with the Windows ACL pass applied where mode bits cannot. Files
 * are named by account uid, so a re-import replaces that account's copy rather
 * than creating a second one, and the position of an account in the pool can
 * never decide which file it reads.
 */
export class WorkBuddyAccountStore {
  private readonly dir: string
  private readonly restrictCredentialDir: (dir: string) => Promise<void>

  constructor(options: WorkBuddyAccountStoreOptions = {}) {
    this.dir = options.dir ?? join(resolveBridgeHome(), ACCOUNT_STORE_DIRNAME)
    this.restrictCredentialDir = options.restrictCredentialDir ?? restrictDirToCurrentUser
  }

  /** The directory stored accounts live in, for diagnostics and tests. */
  directory(): string {
    return this.dir
  }

  /** The path one account's auth document is stored at. */
  pathOf(uid: string): string {
    if (!UID_PATTERN.test(uid)) throw new AccountStoreError(400, 'the account identity is not usable as a file name')
    return join(this.dir, `${uid}${ACCOUNT_FILE_SUFFIX}`)
  }

  /**
   * Create the directory with `0700` **before** any lock or write runs: the
   * lock helper makes its own directory with default modes, which would leave
   * a credential folder broader than intended. A failed restriction fails
   * closed — a credential is not written into a directory whose protection
   * could not be verified.
   */
  private async ensurePrivateDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      const { chmod } = await import('node:fs/promises')
      try {
        await chmod(this.dir, 0o700)
      } catch {
        throw new AccountStoreError(500, 'the account directory could not be locked down; refusing to store a credential')
      }
    }
    try {
      await this.restrictCredentialDir(this.dir)
    } catch {
      // Safe message only: the raw error could carry paths or tool output.
      throw new AccountStoreError(500, 'the account directory could not be restricted to the current user; refusing to store a credential')
    }
  }

  /**
   * Every stored account, oldest first. A missing directory is an empty list,
   * not an error: the store exists from the first account on.
   *
   * A file whose sidecar is missing or damaged is still listed, using the
   * filename as its identity and a zero timestamp — a stored credential the
   * operator cannot see would be one they cannot remove.
   */
  async list(): Promise<StoredAccount[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const accounts: StoredAccount[] = []
    for (const name of names) {
      if (!name.endsWith(ACCOUNT_FILE_SUFFIX)) continue
      const uid = name.slice(0, -ACCOUNT_FILE_SUFFIX.length)
      if (!UID_PATTERN.test(uid)) continue
      const metadata = await this.readMetadata(uid)
      const stored = await this.readDocument(uid)
      const region = stored?.document === undefined ? undefined : plaintextRegionOf(stored.document)
      accounts.push({
        uid,
        origin: metadata?.origin ?? '',
        savedAtMs: metadata?.savedAtMs ?? 0,
        encrypted: stored === undefined ? false : classifyDesktopAuthDocument(stored.text).format === 'encrypted',
        ...region === undefined ? {} : { region },
      })
    }
    return accounts.sort((left, right) => left.savedAtMs - right.savedAtMs || left.uid.localeCompare(right.uid))
  }

  /**
   * The paths of the stored accounts that belong to one product.
   *
   * A file whose region cannot be read is offered to every product, because
   * the credential store is the authority on usability and it refuses a
   * foreign file on its own. Offering a file to nobody would make an account
   * the operator uploaded silently absent from every pool.
   */
  async pathsFor(region: WorkBuddyRegion): Promise<string[]> {
    return (await this.list())
      .filter(account => account.region === undefined || account.region === region)
      .map(account => this.pathOf(account.uid))
  }

  /** The paths of every stored account, for the pool's membership. */
  async paths(): Promise<string[]> {
    return (await this.list()).map(account => this.pathOf(account.uid))
  }

  /**
   * Store one desktop auth document.
   *
   * The text is copied verbatim: this store never re-seals a token, so what it
   * holds is exactly what the desktop app wrote. When the document is an
   * at-rest envelope, its key ids are checked against what the local app can
   * produce *before* the write, so a file from another machine is refused with
   * the reason rather than stored as a member that cannot answer.
   *
   * Returns the stored account; re-importing the same uid replaces it.
   */
  async save(input: {
    text: string
    origin: string
    keyProvider: WorkBuddyAtRestKeyProvider
    /** Overrides the clock, for tests. */
    nowMs?: number
  }): Promise<StoredAccount> {
    const candidate = accountCandidateOf(input.text)
    if (candidate === undefined) {
      throw new AccountStoreError(
        400,
        'the file is not a WorkBuddy sign-in: it must be a JSON auth document with a readable account identity',
      )
    }
    if (candidate.encrypted) {
      // Resolving the key both proves this install can open the envelope and
      // warms the provider's cache; a foreign key id fails here.
      try {
        await input.keyProvider.protectorKeyFor(candidate.keyIds)
      } catch {
        throw new AccountStoreError(
          400,
          'this sign-in file was sealed by a different WorkBuddy install;'
          + ' copy it from this computer\'s own auth directory instead',
        )
      }
    }
    await this.ensurePrivateDir()
    const path = this.pathOf(candidate.uid)
    const metadata: AccountMetadata = {
      version: 1,
      uid: candidate.uid,
      origin: input.origin,
      savedAtMs: input.nowMs ?? Date.now(),
    }
    await withFileLock(path, async () => {
      await writeFileAtomic(path, input.text, { mode: 0o600 })
      await writeFileAtomic(`${path}.json`, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
    })
    return {
      uid: candidate.uid,
      origin: metadata.origin,
      savedAtMs: metadata.savedAtMs,
      encrypted: candidate.encrypted,
      ...candidate.region === undefined ? {} : { region: candidate.region },
    }
  }

  /**
   * Remove one stored account. Returns whether anything was removed.
   *
   * Only this bridge's own copy is deleted — the desktop app's file and its
   * snapshots are never touched, so the account can be added back by copying
   * the same file again.
   */
  async remove(uid: string): Promise<boolean> {
    const path = this.pathOf(uid)
    try {
      await readFile(path)
    } catch {
      return false
    }
    await rm(path, { force: true })
    await rm(`${path}.json`, { force: true })
    return true
  }

  /** The sidecar, when it is present and readable. */
  private async readMetadata(uid: string): Promise<AccountMetadata | undefined> {
    let text: string
    try {
      text = await readFile(`${this.pathOf(uid)}.json`, 'utf8')
    } catch {
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (record['version'] !== 1 || typeof record['uid'] !== 'string') return undefined
    return {
      version: 1,
      uid: record['uid'],
      origin: typeof record['origin'] === 'string' ? record['origin'] : '',
      savedAtMs: typeof record['savedAtMs'] === 'number' ? record['savedAtMs'] : 0,
    }
  }

  /**
   * The stored document's text and its parsed plaintext fields.
   *
   * Read once per account rather than twice: `list()` needs both the document
   * shape (for `encrypted`) and the plaintext domain (for the region), and a
   * credential folder is the last place to spend redundant reads.
   */
  private async readDocument(uid: string): Promise<{ text: string, document: Record<string, unknown> | undefined } | undefined> {
    let text: string
    try {
      text = await readFile(this.pathOf(uid), 'utf8')
    } catch {
      return undefined
    }
    const classification = classifyDesktopAuthDocument(text)
    const document = classification.format === 'plaintext'
      ? plaintextDocumentOf(text)
      : classification.format === 'encrypted' ? classification.wrapped.document : undefined
    return { text, document }
  }
}

/** A fresh opaque token, for callers that need one per operation. */
export function newAccountStoreRevision(): string {
  return randomBytes(16).toString('base64url')
}
