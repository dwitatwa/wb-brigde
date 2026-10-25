/**
 * The managed-provider store: validation, revision conflicts, persistence,
 * and credential-file hygiene. Pure store tests — no bridge, no network.
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_PROVIDERS_DIRNAME,
  MANAGED_PROVIDERS_FILENAME,
  ProviderManagementError,
  WorkBuddyManagedProviderStore,
} from '../src/standalone/provider-store.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-managed-'))
  vi.stubEnv('WORKBUDDY_BRIDGE_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const good = {
  displayName: 'My Gateway',
  baseUrl: 'https://api.example.com/v1',
  models: ['m-1'],
  authMode: 'none',
}
const docPath = () => join(home, MANAGED_PROVIDERS_DIRNAME, MANAGED_PROVIDERS_FILENAME)

async function writeDoc(value: unknown): Promise<void> {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(home, MANAGED_PROVIDERS_DIRNAME), { recursive: true })
  await writeFile(docPath(), typeof value === 'string' ? value : JSON.stringify(value))
}

async function readDoc(): Promise<any> {
  return JSON.parse(await readFile(docPath(), 'utf8'))
}

/** Create one provider through the API, returning its id and the snapshot. */
async function create(extra: Record<string, unknown> = {}): Promise<{ id: string, revision: string }> {
  const store = new WorkBuddyManagedProviderStore()
  const first = await store.save({ ...good, ...extra, revision: 'absent' })
  return { id: first.providers[0]!.id, revision: first.revision }
}

describe('managed provider store: list', () => {
  it('permits an empty managed list on a fresh home', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const snapshot = await store.list()
    expect(snapshot.providers).toEqual([])
    expect(typeof snapshot.revision).toBe('string')
    expect(snapshot.revision).not.toBe('')
  })

  it('lists metadata only: never the API key, only hasApiKey', async () => {
    const { id } = await create({ authMode: 'api-key', apiKey: 'sk-super-secret' })
    const store = new WorkBuddyManagedProviderStore()
    const snapshot = await store.list()
    expect(snapshot.providers).toEqual([
      { id, displayName: 'My Gateway', baseUrl: 'https://api.example.com/v1', models: ['m-1'], authMode: 'api-key', hasApiKey: true },
    ])
    expect(JSON.stringify(snapshot)).not.toContain('sk-super-secret')
  })
})

describe('managed provider store: save validation', () => {
  it.each([
    [{}, 'revision'],
    [{ revision: 'absent' }, 'displayName'],
    [{ revision: 'absent', displayName: 'A' }, 'baseUrl'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://x.test/v1' }, 'models'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://x.test/v1', models: ['m'] }, 'authMode'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://x.test/v1', models: ['m'], authMode: 'none', extra: 1 }, 'unknown'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'ftp://x.test/v1', models: ['m'], authMode: 'none' }, 'baseUrl'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://u:p@x.test/v1', models: ['m'], authMode: 'none' }, 'baseUrl'],
    [{ revision: 'absent', displayName: '  ', baseUrl: 'https://x.test/v1', models: ['m'], authMode: 'none' }, 'displayName'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://x.test/v1', models: ['m', 'm'], authMode: 'none' }, 'models'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://x.test/v1', models: [''], authMode: 'none' }, 'models'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://x.test/v1', models: ['m'], authMode: 'api-key' }, 'key'],
    [{ revision: 'absent', displayName: 'A', baseUrl: 'https://x.test/v1', models: ['m'], authMode: 'api-key', apiKey: '  ' }, 'key'],
  ])('rejects an invalid save payload: %j', async (input: unknown, _why: string) => {
    void _why
    const store = new WorkBuddyManagedProviderStore()
    await expect(store.save(input)).rejects.toMatchObject({
      name: 'ProviderManagementError',
    })
  })

  it('names the offending field without echoing values', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const caught: unknown = await store.save({ ...good, revision: 'absent', apiKey: 'sk-secret', authMode: 'api-key', extraField: 'boom' })
      .catch((e: unknown) => e)
    expect(caught).toBeInstanceOf(ProviderManagementError)
    const error = caught as ProviderManagementError
    expect(error.status).toBe(400)
    expect(error.message).toMatch(/unknown field/u)
    expect(error.message).not.toContain('sk-secret')
  })

  it('rejects an https-less non-loopback baseUrl and accepts a loopback http one', async () => {
    const store = new WorkBuddyManagedProviderStore()
    await expect(store.save({ ...good, revision: 'absent', baseUrl: 'http://api.example.com/v1' }))
      .rejects.toMatchObject({ status: 400 })
    const ok = await store.save({ ...good, revision: 'absent', baseUrl: 'http://127.0.0.1:8080/v1' })
    expect(ok.providers[0]!.baseUrl).toBe('http://127.0.0.1:8080/v1')
  })
})

describe('managed provider store: save create', () => {
  it('auto-generates a slug id from the display name', async () => {
    const { id } = await create()
    expect(id).toBe('my-gateway')
  })

  it('avoids id collisions with a safe suffix and keeps them slug-valid and unreserved', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const one = await store.save({ ...good, revision: 'absent' })
    const two = await store.save({ ...good, revision: one.revision })
    const ids = two.providers.map(p => p.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[1]).toMatch(/^my-gateway-[a-z0-9]+$/u)
  })

  it('rejects a reserved id the generated slug would produce (the name itself is reserved)', async () => {
    const store = new WorkBuddyManagedProviderStore()
    await expect(store.save({ ...good, displayName: 'workbuddy', revision: 'absent' }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('requires the revision to match the current one (optimistic concurrency)', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent' })
    // A caller that still holds the pre-save revision must not overwrite.
    await expect(store.save({ ...good, displayName: 'Other', revision: 'absent' }))
      .rejects.toMatchObject({ status: 409 })
    expect((await store.list()).providers).toHaveLength(1)
    // The current revision is accepted; the first provider is still there.
    const second = await store.save({ ...good, displayName: 'Other', revision: first.revision })
    expect(second.providers.map(p => p.displayName)).toEqual(['My Gateway', 'Other'])
  })

  it('persists the document and a fresh home gets the right permissions', async () => {
    await create({ authMode: 'api-key', apiKey: 'sk-live-key' })
    const doc = await readDoc()
    expect(doc.version).toBe(1)
    expect(doc.revision).toBeTruthy()
    expect(doc.providers).toHaveLength(1)
    expect(doc.providers[0]!.apiKey).toBe('sk-live-key')
    if (process.platform !== 'win32') {
      const dir = await stat(join(home, MANAGED_PROVIDERS_DIRNAME))
      const file = await stat(docPath())
      expect(dir.mode & 0o777).toBe(0o700)
      expect(file.mode & 0o777).toBe(0o600)
    }
  })

  it('never writes the key to a lock or temp file left behind', async () => {
    await create({ authMode: 'api-key', apiKey: 'sk-tmp-check' })
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(join(home, MANAGED_PROVIDERS_DIRNAME))
    for (const name of entries) {
      if (name === MANAGED_PROVIDERS_FILENAME) continue
      const text = await readFile(join(home, MANAGED_PROVIDERS_DIRNAME, name), 'utf8').catch(() => '')
      expect(text).not.toContain('sk-tmp-check')
    }
  })
})

describe('managed provider store: save edit', () => {
  it('edits by id: immutability of id, revision bump, metadata-only answer', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent' })
    const id = first.providers[0]!.id
    const second = await store.save({
      revision: first.revision, id, displayName: 'Renamed',
      baseUrl: 'https://other.example.com/v2', models: ['m-2'], authMode: 'none',
    })
    expect(second.providers).toHaveLength(1)
    expect(second.providers[0]).toMatchObject({ id, displayName: 'Renamed', baseUrl: 'https://other.example.com/v2', models: ['m-2'], authMode: 'none' })
    expect(second.revision).not.toBe(first.revision)
  })

  it('keeps the stored key when the edit omits it, and replaces it when a new one arrives', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-original' })
    const id = first.providers[0]!.id
    const second = await store.save({
      revision: first.revision, id, ...good, authMode: 'api-key',
    })
    expect(second.providers[0]!.hasApiKey).toBe(true)
    const doc = await readDoc()
    expect(doc.providers[0]!.apiKey).toBe('sk-original')
    const third = await store.save({
      revision: second.revision, id, ...good, authMode: 'api-key', apiKey: 'sk-rotated',
    })
    expect((await readDoc()).providers[0]!.apiKey).toBe('sk-rotated')
    expect(third.revision).not.toBe(second.revision)
  })

  it('clears the key when the edit switches to authMode none', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-clearme' })
    const id = first.providers[0]!.id
    const second = await store.save({ revision: first.revision, id, ...good, authMode: 'none' })
    expect(second.providers[0]).toMatchObject({ authMode: 'none', hasApiKey: false })
    expect((await readDoc()).providers[0]!.apiKey).toBeUndefined()
  })

  it('rejects editing an unknown id', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent' })
    await expect(store.save({ revision: first.revision, id: 'nope', ...good, authMode: 'none' }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('rejects an edit whose id would change', async () => {
    const { id } = await create()
    const store = new WorkBuddyManagedProviderStore()
    const snapshot = await store.list()
    await expect(store.save({ revision: snapshot.revision, id, ...good, authMode: 'none' }))
      .resolves.toBeTruthy()
  })
})

describe('managed provider store: remove', () => {
  it('removes by id with a matching revision and bumps the revision', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent' })
    const id = first.providers[0]!.id
    const second = await store.remove({ revision: first.revision, id })
    expect(second.providers).toEqual([])
    expect(second.revision).not.toBe(first.revision)
    await expect(store.remove({ revision: second.revision, id })).rejects.toMatchObject({ status: 404 })
  })

  it('rejects an unknown id and a stale revision', async () => {
    const store = new WorkBuddyManagedProviderStore()
    await expect(store.remove({ revision: 'absent', id: 'ghost' })).rejects.toMatchObject({ status: 404 })
    const first = await store.save({ ...good, revision: 'absent' })
    await expect(store.remove({ revision: 'stale', id: first.providers[0]!.id }))
      .rejects.toMatchObject({ status: 409 })
  })
})

describe('managed provider store: durability', () => {
  it('a second store instance (fresh process) sees the saved providers', async () => {
    const { id } = await create({ authMode: 'api-key', apiKey: 'sk-persist' })
    const store = new WorkBuddyManagedProviderStore()
    const snapshot = await store.list()
    expect(snapshot.providers[0]!.id).toBe(id)
    expect(snapshot.providers[0]!.hasApiKey).toBe(true)
  })

  it('a blank existing file is corrupt, never silently reset (fail safe)', async () => {
    await writeDoc('   ')
    const store = new WorkBuddyManagedProviderStore()
    await expect(store.list()).rejects.toMatchObject({ status: 500 })
    expect(await readFile(docPath(), 'utf8')).toBe('   ')
    await expect(store.save({ ...good, revision: 'absent' })).rejects.toMatchObject({ status: 500 })
    expect(await readFile(docPath(), 'utf8')).toBe('   ')
  })

  it.each([
    { name: 'unknown top-level key', doc: { version: 1, revision: 'r', providers: [], extra: 1 } },
    { name: 'unknown provider key', doc: { version: 1, revision: 'r', providers: [{ id: 'a', displayName: 'A', baseUrl: 'https://a.test/v1', models: ['m'], authMode: 'none', junk: 1 }] } },
    { name: 'duplicate ids', doc: { version: 1, revision: 'r', providers: [
      { id: 'a', displayName: 'A', baseUrl: 'https://a.test/v1', models: ['m'], authMode: 'none' },
      { id: 'a', displayName: 'B', baseUrl: 'https://b.test/v1', models: ['m'], authMode: 'none' },
    ] } },
    { name: 'reserved id', doc: { version: 1, revision: 'r', providers: [{ id: 'workbuddy', displayName: 'W', baseUrl: 'https://w.test/v1', models: ['m'], authMode: 'none' }] } },
    { name: 'bad slug id', doc: { version: 1, revision: 'r', providers: [{ id: 'Bad Slug', displayName: 'B', baseUrl: 'https://b.test/v1', models: ['m'], authMode: 'none' }] } },
    { name: 'non-loopback http baseUrl', doc: { version: 1, revision: 'r', providers: [{ id: 'a', displayName: 'A', baseUrl: 'http://evil.example.com/v1', models: ['m'], authMode: 'none' }] } },
    { name: 'baseUrl with query', doc: { version: 1, revision: 'r', providers: [{ id: 'a', displayName: 'A', baseUrl: 'https://a.test/v1?x=1', models: ['m'], authMode: 'none' }] } },
    { name: 'baseUrl with credentials', doc: { version: 1, revision: 'r', providers: [{ id: 'a', displayName: 'A', baseUrl: 'https://u:p@a.test/v1', models: ['m'], authMode: 'none' }] } },
    { name: 'duplicate models', doc: { version: 1, revision: 'r', providers: [{ id: 'a', displayName: 'A', baseUrl: 'https://a.test/v1', models: ['m', 'm'], authMode: 'none' }] } },
    { name: 'api-key with no stored key', doc: { version: 1, revision: 'r', providers: [{ id: 'a', displayName: 'A', baseUrl: 'https://a.test/v1', models: ['m'], authMode: 'api-key' }] } },
    { name: 'empty models', doc: { version: 1, revision: 'r', providers: [{ id: 'a', displayName: 'A', baseUrl: 'https://a.test/v1', models: [], authMode: 'none' }] } },
    { name: 'empty id', doc: { version: 1, revision: 'r', providers: [{ id: '', displayName: 'A', baseUrl: 'https://a.test/v1', models: ['m'], authMode: 'none' }] } },
    { name: 'providers not an array', doc: { version: 1, revision: 'r', providers: { id: 'a' } } },
    { name: 'missing revision', doc: { version: 1, providers: [] } },
  ])('a structurally invalid document is corrupt: $name', async ({ doc }) => {
    await writeDoc(doc)
    const store = new WorkBuddyManagedProviderStore()
    await expect(store.list()).rejects.toMatchObject({ status: 500 })
    // The corrupt file is never overwritten by a save.
    await expect(store.save({ ...good, revision: 'r' })).rejects.toMatchObject({ status: 500 })
    expect(await readFile(docPath(), 'utf8')).toBe(JSON.stringify(doc))
  })

  it('a saved provider whose authMode is none never carries a key', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent', authMode: 'none', apiKey: 'ignored-key' })
    const doc = await readDoc()
    expect(doc.providers[0]!.apiKey).toBeUndefined()
    expect(first.providers[0]!.hasApiKey).toBe(false)
  })

  it('the credential directory exists with 0700 before any lock touches it', async () => {
    if (process.platform === 'win32') return
    const { stat } = await import('node:fs/promises')
    const store = new WorkBuddyManagedProviderStore()
    await store.save({ ...good, revision: 'absent' })
    const dir = await stat(join(home, MANAGED_PROVIDERS_DIRNAME))
    expect(dir.mode & 0o777).toBe(0o700)
  })

  it('a failed chmod on the credential directory fails the save closed (deterministic, scoped)', async () => {
    if (process.platform === 'win32') return
    const chmodError = Object.assign(new Error('EACCES: operation not permitted, chmod'), { code: 'EACCES' })
    vi.doMock('node:fs/promises', async importOriginal => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        chmod: async () => {
          throw chmodError
        },
      }
    })
    try {
      // The store module may already be cached, so the registry is reset
      // before the isolated import picks up the scoped mock.
      vi.resetModules()
      const { WorkBuddyManagedProviderStore: IsolatedStore } =
        await import('../src/standalone/provider-store.ts')
      const store = new IsolatedStore()
      // Capture the rejection once, then assert shape and safe message.
      const error = await store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-chmodfail' })
        .catch((e: unknown) => e)
      expect(error).toMatchObject({ name: 'ProviderManagementError', status: 500 })
      expect((error as Error).message).not.toContain('EACCES')
      // The key must not be persisted when the mode repair cannot run.
      await expect(readFile(docPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('serializes concurrent saves so neither loses the other', async () => {
    const store = new WorkBuddyManagedProviderStore()
    const first = await store.save({ ...good, revision: 'absent' })
    // Both target the same base revision: exactly one may win.
    const results = await Promise.allSettled([
      store.save({ revision: first.revision, displayName: 'A Gateway', baseUrl: 'https://a.test/v1', models: ['m'], authMode: 'none' }),
      store.save({ revision: first.revision, displayName: 'B Gateway', baseUrl: 'https://b.test/v1', models: ['m'], authMode: 'none' }),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((await store.list()).providers).toHaveLength(2)
  })
})

describe('managed provider store: credential-file permissions', () => {
  it('the platform seam restricts the credential directory on Windows (icacls, key never on the command line)', async () => {
    if (process.platform !== 'win32') return
    const calls: Array<{ file: string, args: readonly string[] }> = []
    const store = new WorkBuddyManagedProviderStore({
      restrictCredentialDir: async file => {
        calls.push({ file, args: [] })
      },
    })
    await store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-win' })
    // Once per operation (list + write), never per request.
    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const call of calls) {
      expect(call.file).toBe(join(home, MANAGED_PROVIDERS_DIRNAME))
    }
    // The key must never appear in an argument vector (the injected seam
    // records exactly what the real implementation would pass).
    expect(JSON.stringify(calls)).not.toContain('sk-win')
  })

  it('the default Windows seam runs icacls and restricts the directory to the current user', async () => {
    if (process.platform !== 'win32') return
    const store = new WorkBuddyManagedProviderStore()
    await store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-win-real' })
    // Real icacls behavior, not a mock: the saved directory must no longer
    // inherit and must not list principals beyond the current user. Read the
    // actual ACL through icacls itself.
    const { execFileP } = await import('../src/standalone/windows-acl.ts')
    const output = await execFileP('icacls.exe', [join(home, MANAGED_PROVIDERS_DIRNAME)])
    const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(line => line.includes(':'))
    const grants = lines.filter(line => line.includes('(I)'))
    // Inheritance was stripped: no inherited grants remain.
    expect(grants).toEqual([])
    // Exactly the current user keeps full control.
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines.join(' ')).toMatch(/\(OI\)\(CI\)\(F\)/u)
    expect(lines.join(' ').toLowerCase()).toContain((process.env['USERNAME'] ?? '').toLowerCase())
  })

  it('the Windows ACL pass fails closed when the restriction tool fails', async () => {
    if (process.platform !== 'win32') return
    const store = new WorkBuddyManagedProviderStore({
      restrictCredentialDir: async () => {
        throw new Error('icacls unavailable')
      },
    })
    await expect(store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-failclosed' }))
      .rejects.toMatchObject({ name: 'ProviderManagementError', status: 500 })
    // The key must not be persisted when the ACL boundary cannot be enforced.
    await expect(readFile(docPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('the Windows ACL pass removes explicit non-owner grants left in the directory', async () => {
    if (process.platform !== 'win32') return
    const dir = join(home, MANAGED_PROVIDERS_DIRNAME)
    const { mkdir } = await import('node:fs/promises')
    const { execFileP } = await import('../src/standalone/windows-acl.ts')
    await mkdir(dir, { recursive: true })
    // Create the broad explicit state the reviewer found, then run the seam.
    await execFileP('icacls.exe', [dir, '/grant', 'Everyone:(OI)(CI)F'])
    const store = new WorkBuddyManagedProviderStore()
    await store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-grant' })
    const output = await execFileP('icacls.exe', [dir])
    const text = output.toUpperCase()
    expect(text).not.toMatch(/EVERYONE|Authenticated Users/u)
    expect(text).toContain('(OI)(CI)(F)')
  })

  it('the Windows ACL pass fails closed when the credential directory itself is a junction', async () => {
    if (process.platform !== 'win32') return
    const { mkdir, readdir, rm, symlink } = await import('node:fs/promises')
    // The reviewer's bypass at store level: the credential-directory path is
    // a junction to another directory. The store must refuse the save —
    // never write the key into a destination whose protection is unknown.
    const credentialDir = join(home, MANAGED_PROVIDERS_DIRNAME)
    const destination = join(home, 'victim-providers')
    await mkdir(destination, { recursive: true })
    await rm(credentialDir, { recursive: true, force: true })
    await symlink(destination, credentialDir, 'junction')
    const store = new WorkBuddyManagedProviderStore()
    await expect(store.save({ ...good, revision: 'absent', authMode: 'api-key', apiKey: 'sk-junction' }))
      .rejects.toMatchObject({ name: 'ProviderManagementError', status: 500 })
    // Nothing was persisted: not behind the junction path and nothing inside
    // the seeded destination either.
    await expect(readFile(docPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(destination)).toEqual([])
  })
})
