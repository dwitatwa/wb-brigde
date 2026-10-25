/**
 * Pure parser for the custom-provider configuration document. No I/O, no
 * Node builtins — the loader that reads a file lives with the caller, and
 * the parser here is the only place validation rules are defined.
 *
 * The document shape is:
 *
 * ```json
 * {
 *   "version": 1,
 *   "providers": [
 *     { "id": "my-llm", "displayName": "My LLM", "baseUrl": "https://api.example.com/v1",
 *       "apiKeyEnv": "MY_API_KEY", "models": ["gpt-x", "gpt-y"] }
 *   ]
 * }
 * ```
 *
 * `baseUrl` is the **full API prefix**: the shim appends `/chat/completions`
 * itself, so a gateway that mounts OpenAI under a non-`/v1` path works as-is.
 * `apiKeyEnv` is optional; a provider without one is served without an
 * upstream credential (for local gateways that need none).
 *
 * Error messages name the offending field by path but never echo config
 * values, so a secret-bearing document can be logged safely.
 *
 * @module workbuddy-bridge/provider-config
 */

/** The only config document version this parser accepts. */
export const PROVIDER_CONFIG_VERSION = 1

/** One custom OpenAI-compatible provider. */
export interface ProviderConfigEntry {
  /** Slug identifier, unique across the document, not a built-in id. */
  id: string
  /** Optional display label for `status`, `models`, and the web UI. */
  displayName?: string
  /** Full API prefix; `/chat/completions` is appended by the endpoint. */
  baseUrl: string
  /**
   * Environment variable holding the upstream API key, resolved per request.
   * Absent means the provider is served without an upstream credential.
   */
  apiKeyEnv?: string
  /** Model ids offered on `/v1/models`, nonempty and unique, kept verbatim. */
  models: string[]
}

/** A validated custom-provider document. */
export interface ProviderConfigDocument {
  providers: ProviderConfigEntry[]
}

/** Discriminated parser result. */
export type ParseResult =
  | { ok: true; config: ProviderConfigDocument }
  | { ok: false; error: string }

/** ids owned by the bridge itself or used as CLI aliases; custom ids cannot take them. */
export const RESERVED_IDS: ReadonlySet<string> = new Set([
  // built-in products and their CLI aliases
  'workbuddy', 'workbuddy-ai', 'cn', 'ai', 'both',
  // pool endpoints derive their id as `<variant>-pool`
  'workbuddy-pool', 'workbuddy-ai-pool',
])

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set(['version', 'providers'])
const ALLOWED_PROVIDER_KEYS: ReadonlySet<string> = new Set(['id', 'displayName', 'baseUrl', 'apiKeyEnv', 'models'])

/** Parse and validate an already-read config value (an object from JSON). */
export function parseProviderConfig(input: unknown): ParseResult {
  if (!isPlainObject(input)) {
    return { ok: false, error: 'provider config must be a JSON object' }
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      // The key name is arbitrary input and could carry a secret; do not
      // echo it into the error.
      return { ok: false, error: 'provider config contains an unknown key' }
    }
  }
  if (input['version'] !== PROVIDER_CONFIG_VERSION) {
    return { ok: false, error: `provider config version must be ${PROVIDER_CONFIG_VERSION}` }
  }
  const rawProviders = input['providers']
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
    return { ok: false, error: 'provider config must contain a nonempty providers array' }
  }

  const seenIds = new Set<string>()
  const providers: ProviderConfigEntry[] = []
  for (let index = 0; index < rawProviders.length; index += 1) {
    const entry: unknown = rawProviders[index]
    const at = `providers[${index}]`
    if (!isPlainObject(entry)) {
      return { ok: false, error: `${at} must be an object` }
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_PROVIDER_KEYS.has(key)) {
        // Same rule as the top level: the key name is arbitrary input.
        return { ok: false, error: `${at} contains an unknown key` }
      }
    }

    const id = entry['id']
    if (typeof id !== 'string' || !SLUG_PATTERN.test(id)) {
      return { ok: false, error: `${at}.id must be a lowercase slug ([a-z0-9._-], starting alphanumeric)` }
    }
    if (RESERVED_IDS.has(id)) {
      return { ok: false, error: `${at}.id is reserved` }
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `${at}.id is a duplicate` }
    }
    seenIds.add(id)

    let displayName: string | undefined
    const rawDisplayName = entry['displayName']
    if (rawDisplayName !== undefined) {
      if (typeof rawDisplayName !== 'string' || rawDisplayName.trim() === '') {
        return { ok: false, error: `${at}.displayName must be a nonempty string` }
      }
      displayName = rawDisplayName
    }

    const baseUrl = validateBaseUrl(entry['baseUrl'], `${at}.baseUrl`)
    if (!baseUrl.ok) return baseUrl

    let apiKeyEnv: string | undefined
    const rawEnv = entry['apiKeyEnv']
    if (rawEnv !== undefined) {
      if (typeof rawEnv !== 'string' || !ENV_NAME_PATTERN.test(rawEnv)) {
        return { ok: false, error: `${at}.apiKeyEnv must be a valid environment variable name` }
      }
      apiKeyEnv = rawEnv
    }

    const rawModels = entry['models']
    if (!Array.isArray(rawModels) || rawModels.length === 0 ||
      rawModels.some(model => typeof model !== 'string' || model.trim() === '')) {
      return { ok: false, error: `${at}.models must be a nonempty array of nonempty strings` }
    }
    if (new Set(rawModels).size !== rawModels.length) {
      return { ok: false, error: `${at}.models contains duplicates` }
    }

    providers.push({
      id,
      ...(displayName === undefined ? {} : { displayName }),
      baseUrl: baseUrl.value,
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      models: [...rawModels] as string[],
    })
  }

  return { ok: true, config: { providers } }
}

/**
 * The normalized base URL a validated entry carries: origin + path with
 * trailing slashes stripped, validated by the same rules as
 * {@link parseProviderConfig} (https, or http only for loopback; no
 * credentials, query, or fragment). `undefined` for an invalid URL — the
 * caller turns that into its own field-naming error.
 */
export function normalizeBaseUrl(value: unknown): string | undefined {
  const result = validateBaseUrl(value, 'baseUrl')
  return result.ok ? result.value : undefined
}

/**
 * Validate the base URL: absolute HTTPS (HTTP allowed for loopback hosts
 * only, matching the shim's own bind policy), no credentials, query, or
 * fragment, trailing slashes stripped. Everything else — path shape, port,
 * host — is preserved exactly, because the value is a full API prefix the
 * endpoint appends `/chat/completions` to.
 */
function validateBaseUrl(value: unknown, at: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `${at} must be a nonempty string` }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: `${at} must be an absolute URL` }
  }
  const hostname = url.hostname.toLowerCase()
  const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, error: `${at} must use https (http only for loopback hosts)` }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: `${at} must not carry credentials` }
  }
  if (url.search !== '') {
    return { ok: false, error: `${at} must not carry a query string` }
  }
  if (url.hash !== '') {
    return { ok: false, error: `${at} must not carry a fragment` }
  }
  return { ok: true, value: url.origin + url.pathname.replace(/\/+$/, '') }
}
