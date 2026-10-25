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
export {
  endpointIdentityPath,
  loadEndpointIdentities,
  portOfBaseUrl,
  rememberEndpointIdentity,
  ENDPOINT_IDENTITY_FILENAME,
  UI_IDENTITY_KEY,
  type EndpointIdentity,
  type RememberEndpointIdentityOptions,
} from './endpoint-identity.ts'
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

export {
  parseProviderConfig,
  PROVIDER_CONFIG_VERSION,
  type ProviderConfigEntry,
  type ProviderConfigDocument,
  type ParseResult,
} from './provider-config.ts'
export {
  createOpenAICompatibleShim,
  startUpstreamTurn,
  writeUpstreamTurn,
  upstreamStatusRetryable,
  UPSTREAM_ERROR_BODY_LIMIT,
  type OpenAICompatibleShim,
  type OpenAICompatibleShimOptions,
  type OpenAIProviderLogger,
  type UpstreamErrorPayload,
  type UpstreamTurnFailure,
  type UpstreamTurnResponse,
  type UpstreamTurnResult,
} from './openai-provider.ts'
export {
  CUSTOM_POOL_ID,
  CustomPoolRequestError,
  CustomProviderFailoverPool,
  capturePoolMembers,
  createCustomProviderPoolShim,
  errorKindForStatus,
  poolMemberAvailable,
  poolModelList,
  type CapturedPoolMember,
  type CustomPoolMember,
  type CustomPoolTurnRecord,
  type CustomProviderPoolOptions,
  type CustomProviderPoolShim,
  type PoolAttemptResult,
  type PoolRouteOutcome,
} from './provider-pool.ts'
export {
  MANAGED_PROVIDERS_DIRNAME,
  MANAGED_PROVIDERS_FILENAME,
  MANAGED_PROVIDERS_VERSION,
  ProviderManagementError,
  WorkBuddyManagedProviderStore,
  type ManagedProvider,
  type ManagedProviderSnapshot,
  type ProviderManagement,
  type WorkBuddyManagedProviderStoreOptions,
} from './provider-store.ts'
