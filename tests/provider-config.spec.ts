import { describe, expect, it } from 'vitest'
import { parseProviderConfig, PROVIDER_CONFIG_VERSION, type ProviderConfigDocument } from '../src/standalone/provider-config.ts'

const VALID = {
  version: 1,
  providers: [
    { id: 'my-llm', displayName: 'My LLM', baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'MY_API_KEY', models: ['gpt-x', 'gpt-y'] },
  ],
}

describe('parseProviderConfig', () => {
  it('accepts the documented version only', () => {
    expect(PROVIDER_CONFIG_VERSION).toBe(1)
    expect(parseProviderConfig(VALID).ok).toBe(true)
    const ok = parseProviderConfig(VALID)
    expect(ok).toEqual({
      ok: true,
      config: {
        providers: [{
          id: 'my-llm',
          displayName: 'My LLM',
          baseUrl: 'https://api.example.com/v1',
          apiKeyEnv: 'MY_API_KEY',
          models: ['gpt-x', 'gpt-y'],
        }],
      },
    })
  })

  it('rejects non-objects and wrong versions without echoing input', () => {
    for (const input of [null, 'x', 42, [], { version: 2, providers: [] }, { providers: [] }, {}]) {
      const result = parseProviderConfig(input)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error).toMatch(/^provider config /)
      expect(result.error).not.toContain('x')
    }
  })

  it('rejects unknown keys without echoing the key name', () => {
    const secret = 'sk-super-secret-value'
    const result = parseProviderConfig({ ...VALID, [secret]: true })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('unknown key')
    expect(result.error).not.toContain(secret)
  })

  it('rejects unknown keys on a provider entry without echoing the key name', () => {
    const secret = 'sk-provider-level-secret'
    const result = parseProviderConfig({
      version: 1,
      providers: [{ ...VALID.providers[0], [secret]: true }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('unknown key')
    expect(result.error).not.toContain(secret)
  })

  it('rejects wrong types on provider fields', () => {
    const base = VALID.providers[0] as Record<string, unknown>
    const cases: Record<string, unknown>[] = [
      { ...base, id: 7 },
      { ...base, id: 'UPPER' },
      { ...base, id: '-bad' },
      { ...base, id: 'bad space' },
      { ...base, displayName: '' },
      { ...base, displayName: 3 },
      { ...base, baseUrl: 'not-a-url' },
      { ...base, baseUrl: 'ftp://api.example.com' },
      { ...base, baseUrl: 'http://api.example.com' },
      { ...base, baseUrl: 'https://user:pw@api.example.com' },
      { ...base, baseUrl: 'https://api.example.com/v1?q=1' },
      { ...base, baseUrl: 'https://api.example.com/#frag' },
      { ...base, apiKeyEnv: '1BAD' },
      { ...base, apiKeyEnv: 'HAS SPACE' },
      { ...base, models: [] },
      { ...base, models: 'gpt-x' },
      { ...base, models: ['ok', ''] },
      { ...base, models: ['a', 'a'] },
      { ...base, models: [42] },
    ]
    for (const provider of cases) {
      expect(parseProviderConfig({ version: 1, providers: [provider] }).ok).toBe(false)
    }
  })

  it('accepts http loopback base URLs but not other http hosts', () => {
    expect(parseProviderConfig({
      version: 1,
      providers: [{ id: 'a', baseUrl: 'http://127.0.0.1:8080/v1', models: ['m'] }],
    }).ok).toBe(true)
    expect(parseProviderConfig({
      version: 1,
      providers: [{ id: 'a', baseUrl: 'http://localhost:8080', models: ['m'] }],
    }).ok).toBe(true)
    expect(parseProviderConfig({
      version: 1,
      providers: [{ id: 'a', baseUrl: 'http://[::1]:8080', models: ['m'] }],
    }).ok).toBe(true)
    expect(parseProviderConfig({
      version: 1,
      providers: [{ id: 'a', baseUrl: 'http://192.168.1.5:8080', models: ['m'] }],
    }).ok).toBe(false)
  })

  it('strips trailing slashes from baseUrl and preserves it otherwise', () => {
    const one = parseProviderConfig({
      version: 1,
      providers: [{ id: 'a', baseUrl: 'https://api.example.com/v1///', models: ['m'] }],
    })
    expect(one.ok).toBe(true)
    if (one.ok) expect(one.config.providers[0]?.baseUrl).toBe('https://api.example.com/v1')

    const two = parseProviderConfig({
      version: 1,
      providers: [{ id: 'a', baseUrl: 'https://gw.example.com/openai', models: ['m'] }],
    })
    expect(two.ok).toBe(true)
    if (two.ok) expect(two.config.providers[0]?.baseUrl).toBe('https://gw.example.com/openai')
  })

  it('rejects duplicate ids and reserved ids (built-ins, aliases, pool suffix)', () => {
    const dup = parseProviderConfig({
      version: 1,
      providers: [
        { id: 'a', baseUrl: 'https://api.example.com', models: ['m'] },
        { id: 'a', baseUrl: 'https://api2.example.com', models: ['m'] },
      ],
    })
    expect(dup.ok).toBe(false)

    for (const id of ['workbuddy', 'workbuddy-ai', 'cn', 'ai', 'both', 'workbuddy-ai-pool', 'workbuddy-pool']) {
      const result = parseProviderConfig({
        version: 1,
        providers: [{ id, baseUrl: 'https://api.example.com', models: ['m'] }],
      })
      expect(result.ok, id).toBe(false)
      if (!result.ok) expect(result.error).toContain('reserved')
    }
  })

  it('allows a pool-suffixed id that is not a built-in', () => {
    expect(parseProviderConfig({
      version: 1,
      providers: [{ id: 'my-llm-pool', baseUrl: 'https://api.example.com', models: ['m'] }],
    }).ok).toBe(true)
  })

  it('requires at least one provider', () => {
    expect(parseProviderConfig({ version: 1, providers: [] }).ok).toBe(false)
    expect(parseProviderConfig({ version: 1, providers: 'x' }).ok).toBe(false)
  })

  it('rejects unknown top-level structure gracefully without echoing values', () => {
    const result = parseProviderConfig({ version: 1, providers: [null] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('providers[0]')
  })

  it('types the parsed document', () => {
    const result = parseProviderConfig(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const doc: ProviderConfigDocument = result.config
    expect(doc.providers[0]?.models).toEqual(['gpt-x', 'gpt-y'])
  })
})
