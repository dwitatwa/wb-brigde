/**
 * The standalone bridge frontend.
 *
 * Exposes the running bridge as a library — useful for embedding it in a
 * launcher script or a test — alongside the CLI that `workbuddy-bridge`
 * installs.
 *
 * @module workbuddy-bridge/standalone
 */

export { WorkBuddyBridge, type BridgeOptions } from './bridge.ts'
export {
  bridgeDescriptorCandidates,
  bridgeDescriptorPath,
  readBridgeDescriptor,
  removeBridgeDescriptor,
  writeBridgeDescriptor,
  BRIDGE_DESCRIPTOR_FILENAME,
  type BridgeDescriptor,
  type BridgeEndpoint,
} from './descriptor.ts'
export { main } from './cli.ts'
export { coalesceReasoning } from './coalesce.ts'
export {
  CHAT_PROBE_TIMEOUT_MS,
  probeChatTurn,
  type ChatProbeOptions,
  type ChatProbeResult,
} from './account-probe.ts'
export {
  POOL_FAILOVER_KINDS,
  WorkBuddyFailoverPool,
  type WorkBuddyPoolAttempt,
  type WorkBuddyPoolMember,
  type WorkBuddyPoolMemberHealth,
} from './pool.ts'
export {
  attemptRecord,
  modelOfBody,
  REQUEST_LOG_LIMIT,
  REQUEST_ROWS_PER_CARD,
  WorkBuddyRequestLog,
  type WorkBuddyRequestAttempt,
  type WorkBuddyRequestRecord,
} from './request-log.ts'
export {
  createWslForwarder,
  isRunningInWsl,
  wslHostAddresses,
  type WslForwarder,
  type WslForwarderOptions,
} from './wsl.ts'
export {
  createWorkBuddyUiServer,
  redactForBrowser,
  UiRequestError,
  type UiCreditAccount,
  type UiCredits,
  type UiEndpoint,
  type UiModel,
  type UiPool,
  type UiPoolMember,
  type UiProbeRequest,
  type UiProbeResult,
  type UiRequestRow,
  type UiState,
  type WorkBuddyUiOptions,
  type WorkBuddyUiServer,
} from './ui.ts'
