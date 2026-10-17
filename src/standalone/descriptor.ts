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

import { readdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../core/atomic-write.ts'
import { resolveBridgeHome, WORKBUDDY_BRIDGE_HOME_DIRNAME } from '../core/bridge-home.ts'
import { isRunningInWsl } from './wsl.ts'

/** Basename of the descriptor inside the bridge home. */
export const BRIDGE_DESCRIPTOR_FILENAME = '.workbuddy-bridge-endpoint.json'

/** Current descriptor format; readers reject others. */
const DESCRIPTOR_VERSION = 1

/** One served variant, as an external client needs to address it. */
export interface BridgeEndpoint {
  /** Provider id, `workbuddy` or `workbuddy-ai`. */
  provider: string
  /** Human-readable group name, e.g. `WorkBuddy AI`. */
  displayName: string
  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  baseUrl: string
  /**
   * The same endpoint as reachable from inside WSL, including the `/v1`
   * suffix, when the bridge was started with `--wsl`. Absent otherwise.
   *
   * A second field rather than a second endpoint entry because it *is* the
   * same endpoint — same token, same models, same account — merely addressed
   * over the WSL virtual switch instead of loopback. Tooling running inside
   * WSL prefers this and falls back to `baseUrl` everywhere else.
   */
  wslBaseUrl?: string
  /** The bearer token this endpoint accepts, or `''` when redacted. */
  token: string
  /** How many models `/v1/models` currently lists. */
  modelCount: number
  /** Whether a credential is currently usable for this variant. */
  signedIn: boolean
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
  error?: string
}

/** The whole published document. */
export interface BridgeDescriptor {
  version: typeof DESCRIPTOR_VERSION
  /** Owning process, so a stale descriptor can be told from a live one. */
  pid: number
  startedAtMs: number
  endpoints: BridgeEndpoint[]
}

/** Path of the descriptor file. */
export function bridgeDescriptorPath(): string {
  return join(resolveBridgeHome(), BRIDGE_DESCRIPTOR_FILENAME)
}

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
export function bridgeDescriptorCandidates(): string[] {
  const candidates = [bridgeDescriptorPath()]
  if (!isRunningInWsl()) return candidates
  for (const usersDir of ['/mnt/c/Users', '/mnt/d/Users']) {
    let entries: string[]
    try {
      entries = readdirSync(usersDir)
    } catch {
      // That drive is not mounted; try the next.
      continue
    }
    for (const entry of entries) {
      candidates.push(join(usersDir, entry, WORKBUDDY_BRIDGE_HOME_DIRNAME, BRIDGE_DESCRIPTOR_FILENAME))
    }
  }
  return candidates
}

/** A located descriptor and the path it was found at. */
interface FoundDescriptor {
  path: string
  descriptor: BridgeDescriptor
}

/** Parse a descriptor document, or undefined when it is absent or malformed. */
function parseDescriptor(text: string): BridgeDescriptor | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const document = parsed as Record<string, unknown>
    if (document['version'] !== DESCRIPTOR_VERSION) return undefined
    if (!Array.isArray(document['endpoints'])) return undefined
    return parsed as BridgeDescriptor
  } catch {
    return undefined
  }
}

/** Find the first readable descriptor among {@link bridgeDescriptorCandidates}. */
async function findBridgeDescriptor(): Promise<FoundDescriptor | undefined> {
  for (const path of bridgeDescriptorCandidates()) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const descriptor = parseDescriptor(text)
    if (descriptor !== undefined) return { path, descriptor }
  }
  return undefined
}

/** Write the descriptor atomically at 0600. */
export async function writeBridgeDescriptor(descriptor: BridgeDescriptor): Promise<string> {
  const path = bridgeDescriptorPath()
  await writeFileAtomic(path, `${JSON.stringify(descriptor, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
  return path
}

/**
 * Read the descriptor back, or undefined when there is none or it is
 * unreadable. Never throws: a malformed file is a "no descriptor" answer, the
 * same way a missing one is.
 *
 * Searches every candidate location, so this works when run from inside WSL as
 * well as on Windows.
 */
export async function readBridgeDescriptor(): Promise<BridgeDescriptor | undefined> {
  return (await findBridgeDescriptor())?.descriptor
}

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
export async function removeBridgeDescriptor(pid: number = process.pid): Promise<void> {
  const found = await findBridgeDescriptor()
  if (found === undefined) return
  if (found.descriptor.pid !== pid) return
  await rm(found.path, { force: true })
}
