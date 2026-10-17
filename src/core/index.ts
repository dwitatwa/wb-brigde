/**
 * The agent-agnostic core of the WorkBuddy bridge.
 *
 * Everything exported here is free of any agent or harness dependency: it
 * talks to the WorkBuddy upstream, reads the desktop app's sign-in, and serves
 * a loopback OpenAI-compatible endpoint. The DeepSeek Harness plugin and the
 * standalone CLI are both thin frontends over this surface.
 *
 * @module workbuddy-bridge/core
 */

export { withFileLock, writeFileAtomic, type AtomicWriteOptions } from './atomic-write.ts'
export {
  resolveBridgeHome,
  WORKBUDDY_BRIDGE_HOME_DIRNAME,
  WORKBUDDY_BRIDGE_HOME_ENV,
} from './bridge-home.ts'

export {
  WorkBuddyCredentialStore,
  parseWorkBuddyAuth,
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  desktopAuthCandidatesFor,
  workbuddyOwnAuthPath,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
  type WorkBuddyStoreOptions,
} from './auth.ts'

export {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.ts'

export {
  WorkBuddyCatalogStore,
  workbuddyCatalogPath,
  WORKBUDDY_CATALOG_FILENAME,
} from './catalog-store.ts'

export {
  WorkBuddyVisibilityStore,
  workbuddyVisibilityPath,
  WORKBUDDY_VISIBILITY_FILENAME,
} from './visibility-store.ts'

export { createWorkBuddyShim, type ShimLogger, type WorkBuddyShim, type WorkBuddyShimOptions } from './shim.ts'
export { hostIsLoopback, originIsLoopback, LOOPBACK_HOSTS } from './loopback.ts'

export {
  WorkBuddyUpstreamClient,
  classifyUpstreamError,
  extractDisplayErrorMessage,
  isChannelValidationBlock,
  normalizeCredits,
  parseModelCatalog,
  prepareChatBody,
  prepareCnChatBody,
  prepareInternationalChatBody,
  regionOf,
  upstreamErrorCode,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyRegion,
  type WorkBuddyUpstreamModel,
} from './upstream.ts'

export {
  AI_VARIANT,
  CN_VARIANT,
  electronProfileFor,
  variantFor,
  WORKBUDDY_VARIANTS,
  type WorkBuddyElectronProduct,
  type WorkBuddyVariant,
} from './variants.ts'

export {
  appUserAgent,
  installedAppVersion,
  resolveAppVersion,
  type AppVersionInfo,
} from './app-version.ts'

export {
  chatUserAgent,
  resolveChatIdentity,
  type ChatIdentity,
} from './client-identity.ts'

export {
  WorkBuddyProbeStore,
  workbuddyProbePath,
  WORKBUDDY_PROBE_FILENAME,
  type WorkBuddyProbeRecord,
} from './probe-store.ts'

export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.ts'
export { probeModel, PROBE_EFFORT_CANDIDATES, type ProbeOutcome } from './probe.ts'
export { atRestKeyProviderFor, WorkBuddyAtRestKeyProvider } from './desktop-credential-protection.ts'
export { WORKBUDDY_CONNECT_VERSION } from './version.ts'
