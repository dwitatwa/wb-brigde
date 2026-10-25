/**
 * Windows DACL boundary for the managed-credential directory: the exact,
 * protected DACL installed by `restrictDirToCurrentUser`, verified through
 * Windows itself (SID-level .NET reads, never localized `icacls` strings).
 *
 * The headline case is the reviewer's reproduction: an arbitrary explicit
 * ACE (BUILTIN\Guests, S-1-5-32-546) seeded on the credential directory and
 * on an existing file inside it must not survive the restriction pass.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileP, restrictDirToCurrentUser } from '../src/standalone/windows-acl.ts'

const POWERSHELL = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)

/** Allowlist: current user + SYSTEM + Administrators, nothing else. */
const SYSTEM_SID = 'S-1-5-18'
const ADMIN_SID = 'S-1-5-32-544'
const GUESTS_SID = 'S-1-5-32-546'
const EVERYONE_SID = 'S-1-1-0'

/**
 * Static probe: dump the target's protection, owner, and every ACE as SID
 * tokens. The path rides an environment variable, never argv, and is never
 * interpolated into the script text.
 */
const PROBE_SCRIPT = `
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 cannot index $env like a hashtable; use the .NET API.
$target = [System.Environment]::GetEnvironmentVariable('WB_ACL_PROBE')
if ([string]::IsNullOrEmpty($target)) { throw 'WB_ACL_PROBE is not set' }
$isDir = [System.IO.Directory]::Exists($target)
$sec = if ($isDir) { [System.IO.Directory]::GetAccessControl($target) } else { [System.IO.File]::GetAccessControl($target) }
Write-Output ('WBPROBE-PROTECTED|' + $sec.AreAccessRulesProtected)
Write-Output ('WBPROBE-OWNER|' + $sec.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)
$rules = $sec.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  Write-Output ('WBPROBE-ACE|' + $rule.IdentityReference.Value + '|' + $rule.AccessControlType + '|' + $rule.FileSystemRights + '|' + $rule.InheritanceFlags + '|' + $rule.IsInherited)
}
Write-Output 'WBPROBE-OK'
`

const SID_SCRIPT = `
$ErrorActionPreference = 'Stop'
Write-Output ('WBSID|' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
`

interface Ace { sid: string, type: string, rights: string, flags: string, inherited: boolean }
interface Acl { isProtected: boolean, owner: string, aces: Ace[] }

/** Run a static PowerShell script with one value passed via the environment. */
function runPowerShell(script: string, envName: string, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, [envName]: value } },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          reject(new Error(`${String(error.message)} :: ${String(stderr)}`))
        } else resolve(String(stdout))
      },
    )
  })
}

/** The current user's SID as Windows itself reports it (env-independent). */
async function realSid(): Promise<string> {
  const out = await runPowerShell(SID_SCRIPT, 'WB_ACL_PROBE', '')
  const line = out.split(/\r?\n/u).find(l => l.startsWith('WBSID|'))
  if (line === undefined) throw new Error(`the SID probe produced no answer: ${out}`)
  return line.slice('WBSID|'.length).trim()
}

async function probeAcl(target: string): Promise<Acl> {
  const out = await runPowerShell(PROBE_SCRIPT, 'WB_ACL_PROBE', target)
  const lines = out.split(/\r?\n/u).map(l => l.trim())
  if (!lines.includes('WBPROBE-OK')) throw new Error(`the ACL probe produced no answer: ${out}`)
  const acl: Acl = { isProtected: false, owner: '', aces: [] }
  for (const line of lines) {
    if (line.startsWith('WBPROBE-PROTECTED|')) acl.isProtected = line.endsWith('True')
    else if (line.startsWith('WBPROBE-OWNER|')) acl.owner = line.slice('WBPROBE-OWNER|'.length)
    else if (line.startsWith('WBPROBE-ACE|')) {
      const [, sid, type, rights, flags, inherited] = line.split('|')
      acl.aces.push({ sid: sid ?? '', type: type ?? '', rights: rights ?? '', flags: flags ?? '', inherited: inherited === 'True' })
    }
  }
  return acl
}

/** The exact private DACL: protected, current-user owner, exactly the allowlist. */
function expectExactDacl(acl: Acl, me: string, opts: { flags: string, inherited: boolean }): void {
  expect(acl.isProtected).toBe(true)
  expect(acl.owner).toBe(me)
  expect(acl.aces.map(a => a.sid).sort()).toEqual([me, SYSTEM_SID, ADMIN_SID].sort())
  for (const ace of acl.aces) {
    expect(ace.type).toBe('Allow')
    expect(ace.rights).toBe('FullControl')
    expect(ace.flags).toBe(opts.flags)
    expect(ace.inherited).toBe(opts.inherited)
  }
}

let home: string
let dir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wb-acl-'))
  dir = join(home, 'providers')
  await mkdir(dir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('restrictDirToCurrentUser (Windows, real DACLs)', () => {
  it('removes an explicit Guests/Everyone bypass on the directory and an existing file', async () => {
    if (process.platform !== 'win32') return
    const me = await realSid()
    const doc = join(dir, 'providers.json')
    await writeFile(doc, '{"providers":[]}')
    // Seed exactly the state the security reviewer reproduced: arbitrary
    // explicit ACEs that are not on the helper's old removal list.
    await execFileP('icacls.exe', [dir, '/grant', `*${EVERYONE_SID}:(OI)(CI)F`, `*${GUESTS_SID}:(OI)(CI)R`])
    await execFileP('icacls.exe', [doc, '/grant', `*${GUESTS_SID}:R`])
    const seeded = await probeAcl(dir)
    expect(seeded.aces.some(a => a.sid === GUESTS_SID)).toBe(true)

    await restrictDirToCurrentUser(dir)

    expectExactDacl(await probeAcl(dir), me, { flags: 'ContainerInherit, ObjectInherit', inherited: false })
    expectExactDacl(await probeAcl(doc), me, { flags: 'None', inherited: false })
  })

  it('installs an exact DACL: protected, current-user owner, three allowlisted FullControl grants', async () => {
    if (process.platform !== 'win32') return
    const me = await realSid()

    await restrictDirToCurrentUser(dir)

    expectExactDacl(await probeAcl(dir), me, { flags: 'ContainerInherit, ObjectInherit', inherited: false })
    // A file created afterwards inherits only allowlisted FullControl.
    const doc = join(dir, 'providers.json')
    await writeFile(doc, '{}')
    const fileAcl = await probeAcl(doc)
    expect(fileAcl.isProtected).toBe(false)
    expect(fileAcl.aces.map(a => a.sid).sort()).toEqual([me, SYSTEM_SID, ADMIN_SID].sort())
    for (const ace of fileAcl.aces) {
      expect(ace.type).toBe('Allow')
      expect(ace.rights).toBe('FullControl')
      expect(ace.inherited).toBe(true)
    }
  })

  it('handles a path with spaces and an apostrophe, including a file named with one', async () => {
    if (process.platform !== 'win32') return
    const me = await realSid()
    const tricky = join(await mkdtemp(join(tmpdir(), "wb acl's dir-")), 'vault one')
    await mkdir(tricky)
    const doc = join(tricky, "O'Brien.key.json")
    await writeFile(doc, '{"providers":[]}')

    await restrictDirToCurrentUser(tricky)

    expectExactDacl(await probeAcl(tricky), me, { flags: 'ContainerInherit, ObjectInherit', inherited: false })
    expectExactDacl(await probeAcl(doc), me, { flags: 'None', inherited: false })
    await rm(tricky, { recursive: true, force: true })
  })

  it('is not fooled by a spoofed USERNAME environment variable', async () => {
    if (process.platform !== 'win32') return
    const me = await realSid()
    vi.stubEnv('USERNAME', 'EvilAdmin')
    vi.stubEnv('USERPROFILE', join(home, 'evil'))

    await restrictDirToCurrentUser(dir)

    const acl = await probeAcl(dir)
    expect(acl.owner).toBe(me)
    expect(acl.owner.toLowerCase()).not.toContain('eviladmin')
    expectExactDacl(acl, me, { flags: 'ContainerInherit, ObjectInherit', inherited: false })
  })

  it('fails closed when SystemRoot is missing', async () => {
    if (process.platform !== 'win32') return
    vi.stubEnv('SystemRoot', '')
    await expect(restrictDirToCurrentUser(dir)).rejects.toThrow(/SystemRoot/u)
  })

  it('fails closed when the PowerShell executable cannot be launched', async () => {
    if (process.platform !== 'win32') return
    vi.stubEnv('SystemRoot', join(home, 'not-windows'))
    await expect(restrictDirToCurrentUser(dir)).rejects.toThrow()
  })

  it('fails closed when the target directory does not exist', async () => {
    if (process.platform !== 'win32') return
    await expect(restrictDirToCurrentUser(join(dir, 'absent'))).rejects.toThrow()
  })

  it('fails closed when the target directory itself is a junction, before touching any ACL', async () => {
    if (process.platform !== 'win32') return
    // The reviewer's second bypass: the *target* is a junction into another
    // directory seeded with a Guests grant; following it would install (and
    // then verify) the private DACL on the *destination*, while the path the
    // store believes it protected stays reachable through the broad original.
    const destination = join(home, 'victim')
    await mkdir(destination)
    await execFileP('icacls.exe', [destination, '/grant', `*${GUESTS_SID}:(OI)(CI)R`])
    // fs.symlink cannot overwrite the mkdtemp-created directory, so the
    // junction replaces it via the filesystem API (rm first, then create).
    await rm(dir, { recursive: true, force: true })
    await symlink(destination, dir, 'junction')

    await expect(restrictDirToCurrentUser(dir)).rejects.toThrow(/reparse/u)

    // Nothing was rewritten through the link: the destination keeps the
    // seeded Guests grant and its DACL was never made protected. (The owner
    // assertion is meaningless here — this user owns the temp dirs already —
    // so protection and the surviving Guests grant are the evidence.)
    const victimAcl = await probeAcl(destination)
    expect(victimAcl.isProtected).toBe(false)
    expect(victimAcl.aces.some(a => a.sid === GUESTS_SID)).toBe(true)
  })

  it('fails closed when the target path is a regular file, not a directory', async () => {
    if (process.platform !== 'win32') return
    const asFile = join(home, 'not-a-dir')
    await writeFile(asFile, 'x')
    await expect(restrictDirToCurrentUser(asFile)).rejects.toThrow()
  })

  it('fails closed on a reparse-point child instead of following it', async () => {
    if (process.platform !== 'win32') return
    await symlink(home, join(dir, 'escape'), 'junction')
    await expect(restrictDirToCurrentUser(dir)).rejects.toThrow(/reparse/u)
  })
})
