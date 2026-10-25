/**
 * Listening on a preferred port, with an ephemeral fallback.
 *
 * Every local listener in this package wants the same trade: a stable address
 * across restarts is convenient, but a port another process now holds must not
 * stop the bridge from starting. `listen(0)` is always safe and always
 * changes; a remembered port is usually the same and occasionally unavailable.
 * This module encodes the rule once so the shim, the web UI and the WSL
 * forwarder cannot drift apart on it.
 *
 * @module workbuddy-bridge/core/listen
 */

import type { Server } from 'node:http'

/** Whether a value can be a TCP port at all. */
export function isUsablePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536
}

/**
 * One bind attempt. Resolves once listening, rejects with the server's error.
 *
 * Listeners are attached with `once` and removed on the other outcome, so a
 * server that fails and is retried does not accumulate handlers — a retry on a
 * server whose `error` listener was left in place would report the first
 * failure forever.
 */
function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Bind `server`, preferring `port` and falling back to an OS-chosen one.
 *
 * The fallback covers the two failures that mean "that port is not available
 * to you" — `EADDRINUSE` (another process, or a second bridge) and `EACCES`
 * (reserved or policy-denied). Every other failure is a real problem and is
 * rethrown, because retrying it on a random port would hide it.
 *
 * An unusable `port` value (absent, zero, out of range, non-integer) means the
 * caller has no preference and gets the historical behaviour.
 */
export async function listenOnPreferredPort(server: Server, port: number | undefined, host: string): Promise<void> {
  if (!isUsablePort(port)) {
    await listenOnce(server, 0, host)
    return
  }
  try {
    await listenOnce(server, port, host)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    await listenOnce(server, 0, host)
  }
}
