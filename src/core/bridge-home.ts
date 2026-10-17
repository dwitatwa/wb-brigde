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

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Env var naming an explicit bridge home. Takes precedence over everything. */
export const WORKBUDDY_BRIDGE_HOME_ENV = 'WORKBUDDY_BRIDGE_HOME'

/** Directory name used under the user's home when nothing else is configured. */
export const WORKBUDDY_BRIDGE_HOME_DIRNAME = '.workbuddy-bridge'

/** Read a trimmed, non-empty env var, or undefined. */
function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

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
export function resolveBridgeHome(): string {
  return envPath(WORKBUDDY_BRIDGE_HOME_ENV)
    ?? envPath('DSH_HOME')
    ?? join(homedir(), WORKBUDDY_BRIDGE_HOME_DIRNAME)
}
