import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverDesktopAuthFiles } from '../src/core/auth.ts'
import { sealAuthFieldForTest } from '../src/core/desktop-credential-protection.ts'
import { AI_VARIANT, CN_VARIANT } from '../src/core/variants.ts'

/**
 * Account discovery: the desktop app's atomic writes leave one snapshot per
 * sign-in behind, so the auth directory already holds a file per account.
 * These tests pin what the sweep keeps — one file per uid, newest copy — and
 * what it refuses: unparseable files, the other region's credentials, and the
 * observation sidecars that share the directory.
 */

const previousHome = process.env['WORKBUDDY_BRIDGE_HOME']
let home: string | undefined

afterEach(async () => {
  if (previousHome === undefined) delete process.env['WORKBUDDY_BRIDGE_HOME']
  else process.env['WORKBUDDY_BRIDGE_HOME'] = previousHome
  if (home !== undefined) {
    await rm(home, { recursive: true, force: true })
    home = undefined
  }
})

/** An AI-region auth document; `domain` lives under `auth`, per the parser. */
function aiAccount(uid: string, token = `token-${uid}`): string {
  return JSON.stringify({
    auth: { accessToken: token, expiresAt: 4_102_344_000, domain: 'www.workbuddy.ai' },
    account: { nickname: `nick-${uid}`, uid },
  })
}

function cnAccount(uid: string): string {
  return JSON.stringify({
    auth: { accessToken: `token-${uid}`, expiresAt: 4_102_344_000, domain: 'copilot.tencent.com' },
    account: { nickname: `nick-${uid}`, uid },
  })
}

async function useAuthDir(): Promise<string> {
  home = await mkdtemp(join(tmpdir(), 'wb-discover-'))
  const dir = join(home, 'auth')
  await mkdir(dir)
  return dir
}

/** Stamp a file's mtime, since discovery keeps the newest copy per uid. */
async function touch(path: string, iso: string): Promise<void> {
  const when = new Date(iso)
  await utimes(path, when, when)
}

describe('discovering every account in the desktop auth directory', () => {
  it('collects the live file and snapshots, one entry per uid, oldest first', async () => {
    const dir = await useAuthDir()
    await writeFile(join(dir, 'workbuddy-desktop-ai.info'), aiAccount('uid-live'))
    await touch(join(dir, 'workbuddy-desktop-ai.info'), '2026-10-17T03:00:00Z')
    await writeFile(join(dir, 'workbuddy-desktop-ai.2026-10-12T23-47-45-924Z.21124.aaaa.info'), aiAccount('uid-old'))
    await touch(join(dir, 'workbuddy-desktop-ai.2026-10-12T23-47-45-924Z.21124.aaaa.info'), '2026-10-12T23:47:00Z')
    await writeFile(join(dir, 'workbuddy-desktop-ai.2026-10-15T04-17-06-085Z.16176.bbbb.info'), aiAccount('uid-mid'))
    await touch(join(dir, 'workbuddy-desktop-ai.2026-10-15T04-17-06-085Z.16176.bbbb.info'), '2026-10-15T04:17:00Z')

    const found = discoverDesktopAuthFiles(AI_VARIANT, [dir])
    expect(found.map(account => account.uid)).toEqual(['uid-old', 'uid-mid', 'uid-live'])
  })

  it('keeps the newest copy when one account has several snapshots', async () => {
    const dir = await useAuthDir()
    await writeFile(join(dir, 'workbuddy-desktop-ai.old.info'), aiAccount('uid-a', 'stale-token'))
    await touch(join(dir, 'workbuddy-desktop-ai.old.info'), '2026-10-10T00:00:00Z')
    await writeFile(join(dir, 'workbuddy-desktop-ai.new.info'), aiAccount('uid-a', 'fresh-token'))
    await touch(join(dir, 'workbuddy-desktop-ai.new.info'), '2026-10-16T00:00:00Z')

    const found = discoverDesktopAuthFiles(AI_VARIANT, [dir])
    expect(found.length).toBe(1)
    expect(found[0]!.path.endsWith('workbuddy-desktop-ai.new.info')).toBe(true)
  })

  it('skips unparseable files, observation sidecars, and the other region', async () => {
    const dir = await useAuthDir()
    await writeFile(join(dir, 'workbuddy-desktop-ai.broken.info'), '{not json')
    await writeFile(join(dir, 'workbuddy-desktop-ai.empty.info'), JSON.stringify({ auth: {} }))
    // Sidecar: same prefix, different suffix — must not enter the list.
    await writeFile(join(dir, 'workbuddy-desktop-ai.info.4e3c.observation.json'), '{}')
    // A CN credential is real but belongs to the other product.
    await writeFile(join(dir, 'workbuddy-desktop-ai.cn.info'), cnAccount('uid-cn'))
    await writeFile(join(dir, 'workbuddy-desktop-ai.good.info'), aiAccount('uid-good'))
    await touch(join(dir, 'workbuddy-desktop-ai.good.info'), '2026-10-16T00:00:00Z')

    const found = discoverDesktopAuthFiles(AI_VARIANT, [dir])
    expect(found.map(account => account.uid)).toEqual(['uid-good'])
  })

  it('finds the CN product in the same directory by its own filename', async () => {
    const dir = await useAuthDir()
    await writeFile(join(dir, 'workbuddy-desktop.info'), cnAccount('uid-cn'))
    await writeFile(join(dir, 'workbuddy-desktop-ai.info'), aiAccount('uid-ai'))

    expect(discoverDesktopAuthFiles(CN_VARIANT, [dir]).map(account => account.uid)).toEqual(['uid-cn'])
    expect(discoverDesktopAuthFiles(AI_VARIANT, [dir]).map(account => account.uid)).toEqual(['uid-ai'])
  })

  it('reads the identity out of a 5.6 encrypted document without any key', async () => {
    const dir = await useAuthDir()
    // WorkBuddy 5.6 seals the token fields at rest while `account.uid` and
    // `auth.domain` stay plaintext — exactly what the real files look like.
    // Discovery must deduplicate on that plaintext identity alone.
    const key = Buffer.alloc(32, 7)
    const sealed = sealAuthFieldForTest(key, 'secret-token')
    await writeFile(join(dir, 'workbuddy-desktop-ai.enc.info'), JSON.stringify({
      auth: { accessToken: sealed, refreshToken: sealed, expiresAt: 4_102_344_000, domain: 'www.workbuddy.ai' },
      account: { nickname: 'sealed-too', uid: 'uid-enc' },
    }), 'utf8')
    await touch(join(dir, 'workbuddy-desktop-ai.enc.info'), '2026-10-16T00:00:00Z')

    expect(discoverDesktopAuthFiles(AI_VARIANT, [dir]).map(account => account.uid)).toEqual(['uid-enc'])
  })

  it('returns an empty list for a missing or empty directory', async () => {
    const missing = join(await useAuthDir(), 'does-not-exist')
    expect(discoverDesktopAuthFiles(AI_VARIANT, [missing])).toEqual([])
    const empty = join(home!, 'empty')
    await mkdir(empty)
    expect(discoverDesktopAuthFiles(AI_VARIANT, [empty])).toEqual([])
  })
})
