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

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '../core/atomic-write.ts'
import { resolveBridgeHome } from '../core/bridge-home.ts'

/** Basename of the identity document inside the bridge home. */
export const ENDPOINT_IDENTITY_FILENAME = '.workbuddy-bridge-identity.json'

/** Current document format; a different version is treated as absent. */
const IDENTITY_VERSION = 1

/**
 * Key used for the web UI's own listener.
 *
 * Not an endpoint — the UI publishes no bearer and is never in the descriptor
 * — but its URL is printed on start and opened by hand, so a stable port is
 * worth the same treatment. The leading space keeps it out of the id space
 * real providers use (ids are slugs, which cannot contain a space).
 */
export const UI_IDENTITY_KEY = ' ui'

/** What was remembered about one endpoint. */
export interface EndpointIdentity {
  /** The port it last bound. Absent when nothing usable was recorded. */
  port?: number
  /** The bearer secret it last served, when tokens are persisted at all. */
  token?: string
}

/** The on-disk document. */
interface StoredDocument {
  version: typeof IDENTITY_VERSION
  endpoints: Record<string, EndpointIdentity>
}

/** Path of the identity document. */
export function endpointIdentityPath(): string {
  return join(resolveBridgeHome(), ENDPOINT_IDENTITY_FILENAME)
}

/** A usable TCP port number, or undefined. */
function validPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536
    ? value
    : undefined
}

/** A usable bearer secret, or undefined. Empty strings are never usable. */
function validToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read one endpoint's record from an unparsed document.
 *
 * Deliberately lenient per entry: one damaged entry loses that endpoint's
 * stability, not the whole file's. A caller that gets `undefined` starts the
 * endpoint exactly as it would with no file at all.
 */
function parseEntry(raw: unknown): EndpointIdentity | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  const port = validPort(entry['port'])
  const token = validToken(entry['token'])
  if (port === undefined && token === undefined) return undefined
  return {
    ...port === undefined ? {} : { port },
    ...token === undefined ? {} : { token },
  }
}

/** Parse a document, or an empty map when it is absent, malformed, or stale. */
function parseDocument(text: string): Map<string, EndpointIdentity> {
  const identities = new Map<string, EndpointIdentity>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return identities
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return identities
  const document = parsed as Record<string, unknown>
  if (document['version'] !== IDENTITY_VERSION) return identities
  const endpoints = document['endpoints']
  if (typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)) return identities
  for (const [key, value] of Object.entries(endpoints)) {
    const entry = parseEntry(value)
    if (entry !== undefined) identities.set(key, entry)
  }
  return identities
}

/** Read the whole document; a missing or damaged file reads as empty. */
async function readIdentities(): Promise<Map<string, EndpointIdentity>> {
  let text: string
  try {
    text = await readFile(endpointIdentityPath(), 'utf8')
  } catch {
    // Absent is the ordinary first run. Unreadable for another reason is
    // treated the same way: stability is a convenience, and refusing to start
    // because a cache file cannot be read would be the wrong trade.
    return new Map()
  }
  return parseDocument(text)
}

/**
 * Every remembered endpoint, for a caller starting several listeners at once.
 *
 * One read for the whole start: the bridge asks for each pool's values from
 * this map rather than re-reading per endpoint.
 */
export async function loadEndpointIdentities(): Promise<Map<string, EndpointIdentity>> {
  return await readIdentities()
}

/** Options for {@link rememberEndpointIdentity}. */
export interface RememberEndpointIdentityOptions {
  /**
   * Whether the bearer secret may be written. False under `--no-descriptor`,
   * which promises an in-memory-only secret; the port is still recorded.
   */
  persistToken: boolean
}

/**
 * Record what an endpoint actually bound, so the next start can ask for it.
 *
 * Runs under the document's advisory lock and re-reads first, so two bridges
 * starting at once keep each other's keys instead of the last writer wiping
 * the file. Writes nothing when the record is already current, which keeps
 * repeated starts from churning the file.
 */
export async function rememberEndpointIdentity(
  key: string,
  identity: EndpointIdentity,
  options: RememberEndpointIdentityOptions,
): Promise<void> {
  const port = validPort(identity.port)
  const token = options.persistToken ? validToken(identity.token) : undefined
  if (port === undefined && token === undefined) return
  const path = endpointIdentityPath()
  await withFileLock(path, async () => {
    const current = await readIdentities()
    const existing = current.get(key)
    const samePort = existing?.port === port
    // A token that is not being persisted must not erase one that already is:
    // `--no-descriptor` is a per-run choice, and dropping the record would
    // make the next ordinary start mint a fresh token for no reason.
    const sameToken = options.persistToken ? existing?.token === token : true
    if (samePort && sameToken) return
    current.set(key, {
      ...port === undefined ? {} : { port },
      ...options.persistToken && token !== undefined
        ? { token }
        : existing?.token === undefined ? {} : { token: existing.token },
    })
    const document: StoredDocument = {
      version: IDENTITY_VERSION,
      endpoints: Object.fromEntries(current),
    }
    await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  })
}

/**
 * The port a published base URL names, or undefined when it cannot be read.
 *
 * Callers have the live base URL, not the bound port, so this is how a
 * just-started endpoint's port reaches the record.
 */
export function portOfBaseUrl(baseUrl: string): number | undefined {
  try {
    const port = new URL(baseUrl).port
    return port === '' ? undefined : validPort(Number(port))
  } catch {
    return undefined
  }
}
