/**
 * Record the last channel-validation failure so a report can be diagnosed.
 *
 * The gateway's check is only partly understood. It rejects request shapes that
 * could not be reproduced by hand, and the block behaves differently from one
 * report to the next — per request in some, clustered in minutes-long bursts in
 * others. Asking an operator to enable tracing *before* a rare failure is not
 * realistic, so the bridge records the failing exchange itself.
 *
 * What is kept is deliberately narrow: the body the agent sent, and the
 * upstream's error envelope. No credential, no response text, nothing from a
 * successful turn. One file, overwritten each time, so it cannot accumulate.
 *
 * @module workbuddy-bridge/standalone/failure-capture
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveBridgeHome } from '../core/bridge-home.ts'
import { isChannelValidationBlock, type WorkBuddyChatResult } from '../core/upstream.ts'
import { modelOfBody } from './request-log.ts'

/** Filename under the bridge home. */
export const CHANNEL_FAILURE_FILENAME = 'last-channel-failure.json'

/** How much of the agent's body to keep; enough to see every field. */
const REQUEST_BODY_LIMIT = 32 * 1024

/** How much of the upstream's answer to keep. */
const UPSTREAM_BODY_LIMIT = 4 * 1024

/** One captured failure. */
export interface ChannelFailureRecord {
  /** When the final attempt failed, ISO 8601. */
  at: string
  /** Which product served the request. */
  provider: string
  /** The model the agent asked for, as it appeared on the wire. */
  model: string
  /** HTTP status the upstream answered. */
  upstreamStatus: number
  /** The upstream's error envelope, verbatim. */
  upstreamBody: string
  /** The body the shim handed upstream, after its own normalisation. */
  requestBody: string
  /**
   * The identity the final attempt sent — the headers the channel check judges.
   * Empty only when the failure happened before any request was built.
   */
  channelHeaders: Record<string, string>
}

/** Absolute path of the capture file. */
export function channelFailurePath(): string {
  return join(resolveBridgeHome(), CHANNEL_FAILURE_FILENAME)
}

/**
 * Persist a channel-validation failure, if that is what happened.
 *
 * Fire-and-forget on purpose: this runs on a failure path where the caller is
 * already being told something went wrong, and a disk problem must not turn a
 * diagnosable refusal into a crash.
 */
export async function captureChannelFailure(
  provider: string,
  bodyJson: string,
  result: WorkBuddyChatResult,
): Promise<void> {
  if (result.ok) return
  if (!isChannelValidationBlock(result.status, result.message)) return
  const record: ChannelFailureRecord = {
    at: new Date().toISOString(),
    provider,
    model: modelOfBody(bodyJson),
    upstreamStatus: result.status,
    upstreamBody: result.message.slice(0, UPSTREAM_BODY_LIMIT),
    requestBody: bodyJson.slice(0, REQUEST_BODY_LIMIT),
    channelHeaders: result.channelHeaders ?? {},
  }
  try {
    await writeFile(channelFailurePath(), JSON.stringify(record, null, 2), 'utf8')
  } catch {
    // Best effort: the failure itself has already been reported to the caller.
  }
}
