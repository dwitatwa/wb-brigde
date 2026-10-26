/**
 * Accounts added without a restart, and the bridge-owned account folder.
 *
 * Two behaviours are pinned here, both of which used to need a restart:
 *
 * - **Rescan** picks up a sign-in that appeared after the bridge started, and
 *   the pool endpoint keeps its URL and token because the listener is never
 *   rebuilt.
 * - **The account folder** lets an account be imported and removed, with the
 *   pool following the change and the head staying on the same account.
 *
 * The store tests are pure filesystem; the bridge tests stand up a real
 * listener and drive the public methods the UI routes call.
 */
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sealAuthFieldForTest } from '../src/core/desktop-credential-protection.ts'
import type { WorkBuddyCredential } from '../src/core/auth.ts'
import type { WorkBuddyChatResult } from '../src/core/upstream.ts'
import { AI_VARIANT } from '../src/core/variants.ts'
import {
  ACCOUNT_STORE_DIRNAME,
  AccountStoreError,
  WorkBuddyAccountStore,
  accountCandidateOf,
} from '../src/standalone/account-store.ts'
import { WorkBuddyBridge } from '../src/standalone/bridge.ts'
import { WorkBuddyFailoverPool, type WorkBuddyPoolMember } from '../src/standalone/pool.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-accounts-'))
  vi.stubEnv('WORKBUDDY_BRIDGE_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'token',
  refreshToken: '',
  expiresAtMs: Number.MAX_SAFE_INTEGER,
  domain: 'www.workbuddy.ai',
  uid: 'uid',
  source: 'desktop',
}

function ok(): WorkBuddyChatResult {
  return { ok: true, response: new Response('data: [DONE]\n\n', { status: 200 }) }
}

function failing(kind: 'hard_credit' | 'soft_rate', status: number): WorkBuddyChatResult {
  return { ok: false, status, kind, message: `upstream ${kind}` }
}

/** A stub member whose script plays out one result per call. */
function stubMember(id: string, script: WorkBuddyChatResult[]): { member: WorkBuddyPoolMember, calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    member: {
      id,
      store: { resolve: async () => ({ ...CREDENTIAL, uid: id }) },
      client: {
        chatStream: async () => {
          const next = script.shift() ?? ok()
          calls.push(next.ok ? 'ok' : next.kind)
          return next
        },
      },
    },
  }
}

/** One plaintext desktop auth document, as the app writes it before 5.6. */
function authText(nickname: string, uid: string): string {
  return JSON.stringify({
    auth: { accessToken: `token-${uid}`, expiresAt: 4_102_344_000, domain: 'www.workbuddy.ai' },
    account: { nickname, uid },
  })
}

/** A key provider that answers with one fixed key id, without spawning. */
function keyProvider(keyId: string) {
  return {
    protectorKeyFor: async (requested: readonly string[]) => {
      if (!requested.includes(keyId)) throw new Error(`key id ${requested.join(',')} is not this install's`)
      return Buffer.alloc(32)
    },
  } as unknown as import('../src/core/desktop-credential-protection.ts').WorkBuddyAtRestKeyProvider
}

describe('the failover pool with an editable membership', () => {
  it('serves a member added after construction, without a new listener', async () => {
    const first = stubMember('a', [ok()])
    const pool = new WorkBuddyFailoverPool([first.member])
    expect(pool.size).toBe(1)

    const second = stubMember('b', [ok()])
    pool.setMembers([first.member, second.member])

    expect(pool.size).toBe(2)
    expect((await pool.chatStream(CREDENTIAL, '{}')).ok).toBe(true)
    expect(first.calls).toEqual(['ok'])
  })

  it('keeps the head on the same account when a member is appended', async () => {
    const first = stubMember('a', [failing('hard_credit', 402), ok()])
    const second = stubMember('b', [ok(), ok()])
    const pool = new WorkBuddyFailoverPool([first.member, second.member])

    // The first account is exhausted, so the head moves to the second.
    await pool.chatStream(CREDENTIAL, '{}')
    expect(pool.headIndex()).toBe(1)

    // A third account arriving must not move the head back to the first.
    const third = stubMember('c', [ok()])
    pool.setMembers([first.member, second.member, third.member])
    expect(pool.headIndex()).toBe(1)

    await pool.chatStream(CREDENTIAL, '{}')
    expect(second.calls).toEqual(['ok', 'ok'])
    expect(third.calls).toEqual([])
  })

  it('carries a member\'s traffic record across a membership change', async () => {
    const first = stubMember('a', [ok()])
    const pool = new WorkBuddyFailoverPool([first.member])
    await pool.chatStream(CREDENTIAL, '{}')
    expect(pool.memberHealth()[0]?.successes).toBe(1)

    const second = stubMember('b', [ok()])
    pool.setMembers([first.member, second.member])

    // The record followed the identity, so account `a` did not reset to zero
    // merely because the list was rebuilt.
    expect(pool.memberHealth()[0]).toMatchObject({ index: 0, successes: 1 })
    expect(pool.memberHealth()[1]).toMatchObject({ index: 1, successes: 0 })
  })

  it('re-anchors the head by position when a member names no identity', async () => {
    const unlabelled = (script: WorkBuddyChatResult[]): WorkBuddyPoolMember => {
      const built = stubMember('', script)
      return { store: built.member.store, client: built.member.client }
    }
    const first = unlabelled([failing('soft_rate', 429), ok()])
    const second = unlabelled([ok(), ok()])
    const pool = new WorkBuddyFailoverPool([first, second])
    await pool.chatStream(CREDENTIAL, '{}')
    expect(pool.headIndex()).toBe(1)

    // No identities, so the position is all the router has: appending keeps
    // the index in range, and a shrinking list clamps it.
    pool.setMembers([first, second, unlabelled([ok()])])
    expect(pool.headIndex()).toBe(1)
  })

  it('refuses an empty membership rather than turning every request into a 500', () => {
    const pool = new WorkBuddyFailoverPool([stubMember('a', [ok()]).member])
    expect(() => pool.setMembers([])).toThrow(/at least one account/)
  })
})

describe('the account store', () => {
  it('names a plaintext document by its account uid', () => {
    expect(accountCandidateOf(authText('alice', 'uid-a'))).toMatchObject({
      uid: 'uid-a',
      encrypted: false,
      keyIds: [],
    })
  })

  it('reports the envelope key ids of an encrypted document', () => {
    const key = Buffer.alloc(32, 7)
    const sealed = JSON.stringify({
      auth: {
        accessToken: sealAuthFieldForTest(key, 'access-token'),
        refreshToken: sealAuthFieldForTest(key, 'refresh-token'),
        domain: 'www.workbuddy.ai',
      },
      account: { uid: 'uid-enc' },
    })
    const candidate = accountCandidateOf(sealed)
    expect(candidate?.encrypted).toBe(true)
    expect(candidate?.uid).toBe('uid-enc')
    expect(candidate?.keyIds.length).toBe(1)
  })

  it('refuses a document it cannot name', () => {
    expect(accountCandidateOf('not json')).toBeUndefined()
    expect(accountCandidateOf(JSON.stringify({ auth: {} }))).toBeUndefined()
  })

  it('stores a file under its uid with 0600, and lists metadata only', async () => {
    const store = new WorkBuddyAccountStore()
    const saved = await store.save({ text: authText('alice', 'uid-a'), origin: 'uploaded', keyProvider: keyProvider('') })

    expect(saved).toMatchObject({ uid: 'uid-a', origin: 'uploaded', encrypted: false })
    const path = join(home, ACCOUNT_STORE_DIRNAME, 'uid-a.info')
    expect(await readFile(path, 'utf8')).toBe(authText('alice', 'uid-a'))
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)

    const listed = await store.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ uid: 'uid-a', origin: 'uploaded' })
    // Metadata only: the token is not part of what the page can read.
    expect(JSON.stringify(listed)).not.toContain('token-uid-a')
  })

  it('replaces an existing copy instead of adding a second one', async () => {
    const store = new WorkBuddyAccountStore()
    await store.save({ text: authText('alice', 'uid-a'), origin: 'first', keyProvider: keyProvider(''), nowMs: 1 })
    await store.save({ text: authText('alice', 'uid-a'), origin: 'second', keyProvider: keyProvider(''), nowMs: 2 })

    expect((await store.list()).map(account => account.origin)).toEqual(['second'])
    expect((await readdir(join(home, ACCOUNT_STORE_DIRNAME))).filter(name => name.endsWith('.info'))).toHaveLength(1)
  })

  it('refuses an envelope sealed by a different install, before writing it', async () => {
    const key = Buffer.alloc(32, 7)
    const sealed = JSON.stringify({
      auth: {
        accessToken: sealAuthFieldForTest(key, 'access-token'),
        refreshToken: sealAuthFieldForTest(key, 'refresh-token'),
        domain: 'www.workbuddy.ai',
      },
      account: { uid: 'uid-foreign' },
    })
    const store = new WorkBuddyAccountStore()
    // This provider answers for a key id the envelope does not carry.
    await expect(store.save({ text: sealed, origin: 'other machine', keyProvider: keyProvider('0000000000000000') }))
      .rejects.toMatchObject({ status: 400 })
    await expect(store.list()).resolves.toEqual([])
  })

  it('removes only its own copy, and reports whether anything went', async () => {
    const store = new WorkBuddyAccountStore()
    await store.save({ text: authText('alice', 'uid-a'), origin: 'uploaded', keyProvider: keyProvider('') })
    await expect(store.remove('uid-a')).resolves.toBe(true)
    await expect(store.list()).resolves.toEqual([])
    await expect(store.remove('uid-a')).resolves.toBe(false)
  })

  it('rejects a uid that is not safe as a file name', () => {
    const store = new WorkBuddyAccountStore()
    expect(() => store.pathOf('../escape')).toThrow(AccountStoreError)
    expect(() => store.pathOf('')).toThrow(AccountStoreError)
  })
})

/** Write one desktop auth file into the temp home and return its path. */
async function desktopFile(nickname: string, uid: string): Promise<string> {
  const path = join(home, `desktop-${uid}.info`)
  await writeFile(path, authText(nickname, uid), 'utf8')
  return path
}

describe('adding an account without a restart', () => {
  it('rescan adds a stored account, keeping the published URL and token', async () => {
    const bridge = new WorkBuddyBridge({
      variants: [AI_VARIANT],
      manageAccounts: true,
      persistEndpointIdentity: false,
    })
    try {
      await bridge.start()
      const before = bridge.endpoints()[0]!

      // A sign-in file appears in the bridge's own folder — written directly
      // here, because the import route's own rescan is a separate test.
      await new WorkBuddyAccountStore().save({
        text: authText('bob', 'uid-b'),
        origin: 'uploaded',
        keyProvider: keyProvider(''),
      })

      const result = await bridge.rescanAccounts()
      expect(result.added).toEqual(['uid-b.info'])
      expect(result.total).toBeGreaterThan(1)

      const labels = (await bridge.uiState()).endpoints[0]?.pool?.members.map(member => member.label)
      expect(labels).toContain('bob')

      // The listener was never rebuilt, so a client configured once keeps
      // working across the membership change.
      const after = bridge.endpoints()[0]!
      expect(after.baseUrl).toBe(before.baseUrl)
      expect(after.token).toBe(before.token)
    } finally {
      await bridge.close()
    }
  })

  it('rescan is idempotent: the same account is never added twice', async () => {
    const bridge = new WorkBuddyBridge({
      variants: [AI_VARIANT],
      manageAccounts: true,
      persistEndpointIdentity: false,
    })
    try {
      await bridge.start()
      await new WorkBuddyAccountStore().save({
        text: authText('bob', 'uid-b'),
        origin: 'uploaded',
        keyProvider: keyProvider(''),
      })

      await expect(bridge.rescanAccounts()).resolves.toMatchObject({ added: ['uid-b.info'] })
      await expect(bridge.rescanAccounts()).resolves.toMatchObject({ added: [] })
    } finally {
      await bridge.close()
    }
  })

  it('does not widen an explicit auth-file list', async () => {
    const first = await desktopFile('alice', 'uid-a')
    const bridge = new WorkBuddyBridge({
      variants: [AI_VARIANT],
      authFiles: new Map([['workbuddy-ai', [first]]]),
      manageAccounts: true,
      persistEndpointIdentity: false,
    })
    try {
      await bridge.start()
      await new WorkBuddyAccountStore().save({
        text: authText('bob', 'uid-b'),
        origin: 'uploaded',
        keyProvider: keyProvider(''),
      })

      // A hand-picked list stays exactly what the operator named: a rescan
      // must not add an account they did not select.
      await expect(bridge.rescanAccounts()).resolves.toEqual({ added: [], total: 1 })
      const labels = (await bridge.uiState()).endpoints[0]?.pool?.members.map(member => member.label)
      expect(labels).toEqual(['alice'])
    } finally {
      await bridge.close()
    }
  })
})

describe('the bridge-owned account folder', () => {
  /** A bridge that discovers the temp home's files and manages accounts. */
  async function managedBridge(accounts: Array<[string, string]>): Promise<WorkBuddyBridge> {
    const paths: string[] = []
    for (const [nickname, uid] of accounts) paths.push(await desktopFile(nickname, uid))
    return new WorkBuddyBridge({
      variants: [AI_VARIANT],
      authFiles: new Map([['workbuddy-ai', paths]]),
      manageAccounts: true,
      persistEndpointIdentity: false,
    })
  }

  it('lists stored accounts as metadata, never a token', async () => {
    const bridge = await managedBridge([['alice', 'uid-a']])
    try {
      await bridge.start()
      const store = new WorkBuddyAccountStore()
      await store.save({ text: authText('bob', 'uid-b'), origin: 'uploaded', keyProvider: keyProvider('') })

      const listed = await bridge.listStoredAccounts()
      expect(listed.map(account => account.uid)).toEqual(['uid-b'])
      expect(JSON.stringify(listed)).not.toContain('token-uid-b')
    } finally {
      await bridge.close()
    }
  })

  it('refuses account management when the bridge was not started with it', async () => {
    const path = await desktopFile('alice', 'uid-a')
    const bridge = new WorkBuddyBridge({
      variants: [AI_VARIANT],
      authFiles: new Map([['workbuddy-ai', [path]]]),
      persistEndpointIdentity: false,
    })
    try {
      await bridge.start()
      await expect(bridge.listStoredAccounts()).rejects.toMatchObject({ status: 409 })
      await expect(bridge.removeStoredAccount('uid-a')).rejects.toMatchObject({ status: 409 })
    } finally {
      await bridge.close()
    }
  })

  it('serves a stored account after import and stops serving it after remove', async () => {
    // No explicit list: the bridge's own folder is the only source, which is
    // what makes the account's arrival and departure observable here.
    const bridge = new WorkBuddyBridge({
      variants: [AI_VARIANT],
      manageAccounts: true,
      persistEndpointIdentity: false,
    })
    try {
      await bridge.start()
      // One runtime in the ordinary single-account mode, reading the desktop
      // default — which does not exist in the temp home, so nothing is signed
      // in yet.
      const before = bridge.endpoints()[0]!
      expect(before.baseUrl).toBeTruthy()

      const imported = await bridge.importStoredAccount({ text: authText('alice', 'uid-a'), origin: 'uploaded' })
      expect(imported.uid).toBe('uid-a')

      const afterImport = await bridge.uiState()
      const labels = afterImport.endpoints[0]?.pool?.members.map(member => member.label)
      expect(labels).toContain('alice')

      const removed = await bridge.removeStoredAccount('uid-a')
      expect(removed.removed).toBe(true)

      const afterRemove = await bridge.uiState()
      const remaining = afterRemove.endpoints[0]?.pool?.members.map(member => member.label) ?? []
      expect(remaining).not.toContain('alice')

      // The listener never moved: the published URL and token are the ones a
      // client was already configured with.
      const after = bridge.endpoints()[0]!
      expect(after.baseUrl).toBe(before.baseUrl)
      expect(after.token).toBe(before.token)
    } finally {
      await bridge.close()
    }
  })

  it('reports a removal of an account that was never stored', async () => {
    const bridge = await managedBridge([['alice', 'uid-a']])
    try {
      await bridge.start()
      await expect(bridge.removeStoredAccount('uid-missing')).resolves.toMatchObject({ removed: false })
    } finally {
      await bridge.close()
    }
  })
})
