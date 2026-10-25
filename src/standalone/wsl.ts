/**
 * WSL reachability: a forwarder that re-exposes the loopback shim on the
 * Windows-side address of the WSL virtual switch.
 *
 * ## Why this is needed
 *
 * WSL2 in its default NAT mode is a separate network namespace with its own
 * loopback. `127.0.0.1` inside WSL is **not** the Windows loopback — it is
 * WSL's own, where the bridge is not listening. So an agent running inside WSL
 * (OpenCode, Claude Code, anything) cannot reach a bridge bound to `127.0.0.1`
 * on Windows, and the failure looks like a bare connection refusal.
 *
 * Windows does expose one address WSL can reach: the host side of the WSL
 * virtual switch, named `vEthernet (WSL)` (or `vEthernet (WSL (Hyper-V
 * firewall))` on newer builds). It is WSL's default gateway, so WSL can always
 * route to it. Binding there makes the bridge reachable from both the Windows
 * host (loopback) and WSL (this address).
 *
 * ## Why a forwarder rather than binding the shim wider
 *
 * The shim's loopback-only bind is part of its security model, and the port
 * promised to leave it exactly as upstream wrote it. So the shim keeps binding
 * `127.0.0.1`, and this module — a frontend concern — accepts the WSL
 * connection and proxies it to the loopback port.
 *
 * The forwarder deliberately does **not** loosen authentication. It forwards
 * the `Authorization` header untouched, so the shim's per-process bearer token
 * is still required on the WSL side. The forwarder only adds its own Host and
 * Origin gate, and it is bound to a host-only virtual adapter: nothing on the
 * LAN can reach it.
 *
 * ## The alternative with no code at all
 *
 * WSL 2.0+ on Windows 11 supports mirrored networking, which shares
 * `localhost` between Windows and WSL. Adding this to `%USERPROFILE%\.wslconfig`
 * and running `wsl --shutdown` makes the whole problem disappear:
 *
 * ```ini
 * [wsl2]
 * networkingMode=mirrored
 * ```
 *
 * That is the better option when the Windows build supports it, because it
 * needs no extra listener. This module is the fallback for NAT mode.
 *
 * @module workbuddy-bridge/standalone/wsl
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { hostnameOfHost, hostIsLoopback, originIsLoopback } from '../core/loopback.ts'
import { listenOnPreferredPort } from '../core/listen.ts'
import type { ShimLogger } from '../core/shim.ts'

/**
 * Are we running *inside* WSL, rather than on the Windows host?
 *
 * This decides which address to hand an agent: inside WSL the loopback URL is
 * useless and `wslBaseUrl` is the only one that resolves. Detection is two
 * cheap checks — the env var WSL sets, and the kernel banner, which every WSL
 * kernel carries "microsoft" in. Both are needed because `WSL_DISTRO_NAME` is
 * absent in some login paths (a bare `sh -c` from Windows, for instance).
 */
export function isRunningInWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined && process.env['WSL_DISTRO_NAME'] !== '') return true
  try {
    return /microsoft|wsl/iu.test(readFileSync('/proc/version', 'utf8'))
  } catch {
    return false
  }
}

/**
 * Interface names Windows gives the WSL virtual switch.
 *
 * Matched case-insensitively as a substring rather than by exact name: the
 * label has changed across builds (`vEthernet (WSL)` before the Hyper-V
 * firewall integration, `vEthernet (WSL (Hyper-V firewall))` after), and a
 * future rename should not silently disable this.
 */
const WSL_INTERFACE_PATTERN = /wsl/iu

/**
 * IPv4 addresses of the Windows-side WSL virtual switch, if any.
 *
 * Empty on a machine without WSL, which is not an error — it is how the caller
 * knows there is nothing to expose.
 */
export function wslHostAddresses(): string[] {
  const found: string[] = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!WSL_INTERFACE_PATTERN.test(name)) continue
    for (const address of addresses ?? []) {
      // `internal` would be loopback, which is the one thing WSL cannot use.
      if (address.family === 'IPv4' && !address.internal) found.push(address.address)
    }
  }
  return found
}

/** A running forwarder. */
export interface WslForwarder {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The address WSL should use, e.g. `http://172.20.96.1:41000`. */
  url(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WslForwarderOptions {
  /** Loopback origin of the service to re-expose, e.g. `http://127.0.0.1:53801`. */
  target: string
  /** Which host address to bind; one of {@link wslHostAddresses}. */
  host: string
  /** Preferred port on that address; a taken port falls back to an ephemeral one. */
  port?: number
  logger?: ShimLogger
}

/**
 * Is this request addressed to something we are willing to serve?
 *
 * Loopback is always acceptable, because the Windows host reaches the
 * forwarder that way too. Beyond that, only the exact address we bound —
 * which is the WSL switch address and nothing else.
 */
function requestAllowed(req: IncomingMessage, boundHost: string): boolean {
  const host = req.headers.host
  if (hostIsLoopback(host)) return originIsLoopback(req.headers.origin)
  if (host === undefined || hostnameOfHost(host) !== boundHost) return false
  // A browser-sent Origin must be loopback or the bound address itself.
  const origin = req.headers.origin
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return hostIsLoopback(hostname) || hostname === boundHost
  } catch {
    return false
  }
}

/**
 * Start a forwarder from `host` to the loopback `target`.
 *
 * The Host header is rewritten to the target's before forwarding, because the
 * shim's own gate requires a loopback Host and would otherwise reject every
 * request that arrived through here. Everything else — method, path, body,
 * `Authorization` — passes through unchanged, and the response is piped rather
 * than buffered so the shim's `text/event-stream` chat responses keep
 * streaming.
 */
export function createWslForwarder(options: WslForwarderOptions): WslForwarder {
  const { host, logger } = options
  const target = new URL(options.target)
  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })
  // Bound to the WSL switch address only. Binding 0.0.0.0 would also expose
  // the bridge on the real LAN interface, which is a much larger surface than
  // the problem requires. A remembered port keeps the address an agent inside
  // WSL was configured with; a taken one falls back.
  const ready = listenOnPreferredPort(server, options.port, host)

  const url = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('workbuddy WSL forwarder has no address')
    return `http://${host}:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!requestAllowed(req, host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'request-not-trusted' }))
      return
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    headers['host'] = target.host
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers,
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error: unknown) => {
      logger?.warn('workbuddy-bridge: WSL forwarder could not reach the loopback shim', error)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'loopback-unreachable' }))
        return
      }
      res.end()
    })
    // Streamed, not collected: a chat request body can be tens of megabytes.
    req.pipe(upstream)
  }

  return {
    ready,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
