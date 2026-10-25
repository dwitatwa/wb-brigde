/**
 * Windows credential-directory restriction, behind a fail-closed seam.
 *
 * The managed-provider store keeps its document (which contains an API key)
 * under the bridge home. On POSIX the 0700/0600 mode bits are enough. On
 * Windows mode bits are advisory, so the directory is handed a private,
 * exact DACL before any credential is written.
 *
 * The boundary is deliberately strict and fail-closed:
 *
 * - the identity comes from Windows itself
 *   (`[System.Security.Principal.WindowsIdentity]::GetCurrent().User`),
 *   never from a spoofable environment variable;
 * - the directory's DACL is **replaced** by a fresh protected
 *   `DirectorySecurity` — not patched in place — so an arbitrary explicit
 *   ACE such as a Guests read grant (S-1-5-32-546) cannot survive;
 * - the allowlist is exactly the current user, LOCAL SYSTEM, and
 *   Administrators, each with FullControl;
 * - existing regular-file children of the managed credential directory are
 *   re-secured with the same exact DACL (file form), so a broad explicit ACE
 *   seeded on an already-written providers.json cannot survive either. The
 *   directory is exclusively the store's; reparse points are never followed
 *   and abort the pass (fail closed);
 * - every step is verified against the SID-level state afterwards, and any
 *   missing OS surface, failing command, or unexpected resulting ACL raises
 *   so the caller refuses the credential write.
 *
 * The seam takes a **path and nothing else**. The API key never appears in
 * any command line, argument vector, or environment of this module — that is
 * the whole reason it is separated from the store. The directory path rides
 * an environment variable; it is never interpolated into script text.
 *
 * @module workbuddy-bridge/standalone/windows-acl
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** Well-known SIDs on the allowlist besides the current user. */
const SYSTEM_SID = 'S-1-5-18' // LOCAL SYSTEM
const ADMINISTRATORS_SID = 'S-1-5-32-544' // BUILTIN\Administrators

/** The fixed Windows PowerShell executable — never PATH-resolved. */
function powershellPath(): string {
  const systemRoot = process.env['SystemRoot']?.trim()
  if (systemRoot === undefined || systemRoot === '') {
    throw new Error('SystemRoot is not configured; cannot locate Windows PowerShell')
  }
  return join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  )
}

/** Run a tool with argv-only arguments; resolves stdout, rejects on failure. */
export function execFileP(file: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error !== null && error !== undefined) reject(error)
      else resolve(String(stdout))
    })
  })
}

/**
 * Run one static PowerShell script (base64-encoded `-EncodedCommand`, argv
 * only). The script text is a fixed constant — the one value that varies
 * (the directory path) is passed through the environment and read with the
 * .NET environment API, because Windows PowerShell 5.1 cannot index `$env`
 * as a hashtable. Nothing from the caller is ever interpolated.
 */
function runStaticScript(script: string, envName: string, value: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      powershellPath(),
      [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, [envName]: value } },
      (error, stdout, stderr) => {
        if (error !== null && error !== undefined) {
          reject(new Error(`windows-acl powershell step failed: ${error.message}${stderr === '' ? '' : ` :: ${stderr}`}`))
        } else resolve(String(stdout))
      },
    )
  })
}

/** The script that reports the caller's Windows SID (identity from the OS). */
const SID_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'Windows would not report the current user SID' }
Write-Output ('WBSID|' + $sid.Value)
`

/**
 * The script that, for the path in `WB_ACL_TARGET`, installs the exact
 * private DACL: protection on (inheritance and inherited ACEs gone), owner
 * = current user, and exactly three FullControl allow rules — current user,
 * LOCAL SYSTEM, Administrators. The .NET `SetAccessControl` persist applies
 * it; ACL sets propagate inherited ACEs onto existing children, which is how
 * broad explicit grants on already-written files are displaced too.
 * Reparse-point children are never followed: they abort the step. The
 * target itself is checked first — without following a possible link — so a
 * junction placed at the credential-directory path cannot redirect the pass
 * into another (still Guests-readable) destination.
 *
 * (The `Set-Acl` cmdlet is deliberately not used as the persist path: on
 * Windows PowerShell 5.1 it throws `PrivilegeNotHeldException`
 * (`SeSecurityPrivilege`) whenever it rewrites the descriptor of an
 * already-protected target — reproducible with any input object, including
 * the `Get-Acl` roundtrip — and the store restricts the directory on every
 * operation. `SetAccessControl` persists the very same
 * `DirectorySecurity` object through the same primitive without that defect.)
 */
const APPLY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = [System.Environment]::GetEnvironmentVariable('WB_ACL_TARGET')
if ([string]::IsNullOrEmpty($path)) { throw 'WB_ACL_TARGET is not set' }
# The target itself is inspected WITHOUT following a possible link first:
# GetAttributes reports ReparsePoint on a junction/symlink instead of
# traversing into the destination, and Directory.Exists would follow it.
$targetAttributes = [System.IO.File]::GetAttributes($path)
if (-not ($targetAttributes -band [System.IO.FileAttributes]::Directory)) {
  throw ('the credential directory target is not a directory: ' + $path)
}
if ($targetAttributes -band [System.IO.FileAttributes]::ReparsePoint) {
  throw ('the credential directory target itself is a reparse point and is not followed: ' + $path)
}
if (-not [System.IO.Directory]::Exists($path)) { throw ('the target directory does not exist: ' + $path) }
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $me) { throw 'Windows would not report the current user SID' }
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')

# Reparse points are refused before any DACL is touched, so the pass can
# never be turned into a walk into attacker-chosen targets.
foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($path)) {
  if ([System.IO.File]::GetAttributes($child) -band [System.IO.FileAttributes]::ReparsePoint) {
    throw ('a reparse-point child is not followed by the credential restriction: ' + $child)
  }
}

function New-PrivateSecurity {
  param([bool] $forDirectory)
  $sec = if ($forDirectory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $sec.SetAccessRuleProtection($true, $false)
  $sec.SetOwner($me)
  foreach ($sid in @($me, $system, $admins)) {
    if ($forDirectory) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    } else {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'Allow')
    }
    $sec.SetAccessRule($rule)
  }
  return $sec
}

[System.IO.Directory]::SetAccessControl($path, (New-PrivateSecurity $true))

# Re-secure existing regular children so a broad explicit ACE seeded on a
# file that predates this pass cannot survive. Inherited ACEs flowing from
# the protected directory are also replaced, keeping each child exact.
foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($path)) {
  if ([System.IO.File]::GetAttributes($child) -band [System.IO.FileAttributes]::Directory) {
    [System.IO.Directory]::SetAccessControl($child, (New-PrivateSecurity $true))
  } else {
    [System.IO.File]::SetAccessControl($child, (New-PrivateSecurity $false))
  }
}

Write-Output 'WBAPPLY-OK'
`

/**
 * The script that, for the path in `WB_ACL_TARGET`, reports the protection
 * flag, owner, and every ACE at SID level so the caller can enforce the
 * exact allowlist — no localized names, no icacls text.
 */
const VERIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = [System.Environment]::GetEnvironmentVariable('WB_ACL_TARGET')
if ([string]::IsNullOrEmpty($path)) { throw 'WB_ACL_TARGET is not set' }
$isDir = [System.IO.Directory]::Exists($path)
$sec = if ($isDir) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
Write-Output ('WBVERIFY-PROTECTED|' + $sec.AreAccessRulesProtected)
$owner = $sec.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($null -ne $owner) { Write-Output ('WBVERIFY-OWNER|' + $owner.Value) }
$rules = $sec.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  Write-Output ('WBVERIFY-ACE|' + $rule.IdentityReference.Value + '|' + $rule.AccessControlType + '|' + $rule.FileSystemRights + '|' + $rule.InheritanceFlags + '|' + $rule.IsInherited)
}
Write-Output 'WBVERIFY-OK'
`

interface AclLine { sid: string, type: string, rights: string, flags: string, inherited: boolean }

/** Parse a `WBVERIFY-*` probe answer; the OK sentinel must be present. */
function parseVerify(output: string): { isProtected: boolean, owner: string, aces: AclLine[] } {
  const lines = output.split(/\r?\n/u).map(line => line.trim())
  if (!lines.includes('WBVERIFY-OK')) {
    throw new Error('the Windows ACL verification did not complete')
  }
  const result = { isProtected: false, owner: '', aces: [] as AclLine[] }
  for (const line of lines) {
    if (line.startsWith('WBVERIFY-PROTECTED|')) result.isProtected = line.endsWith('True')
    else if (line.startsWith('WBVERIFY-OWNER|')) result.owner = line.slice('WBVERIFY-OWNER|'.length)
    else if (line.startsWith('WBVERIFY-ACE|')) {
      const [, sid = '', type = '', rights = '', flags = '', inherited = ''] = line.split('|')
      result.aces.push({ sid, type, rights, flags, inherited: inherited === 'True' })
    }
  }
  return result
}

/** Assert the target carries exactly the private DACL the allowlist defines. */
async function verifyExactAcl(target: string, sid: string, isDirectory: boolean): Promise<void> {
  const acl = parseVerify(await runStaticScript(VERIFY_SCRIPT, 'WB_ACL_TARGET', target))
  const expected = [sid, SYSTEM_SID, ADMINISTRATORS_SID].sort()
  const sids = acl.aces.map(ace => ace.sid).sort()
  if (acl.isProtected !== true) throw new Error(`the credential ACL on ${target} is not protected from inheritance`)
  if (acl.owner !== sid) throw new Error(`the credential ACL on ${target} is not owned by the current user`)
  if (sids.length !== expected.length || sids.some((value, index) => value !== expected[index])) {
    throw new Error(`the credential ACL on ${target} grants a principal outside the allowlist (found: ${sids.join(', ')})`)
  }
  for (const ace of acl.aces) {
    if (ace.type !== 'Allow' || ace.rights !== 'FullControl') {
      throw new Error(`the credential ACL on ${target} grants ${ace.sid} something other than FullControl Allow`)
    }
    if (ace.inherited === true) {
      throw new Error(`the credential ACL on ${target} still carries an inherited ACE`)
    }
    const flags = isDirectory ? 'ContainerInherit, ObjectInherit' : 'None'
    if (ace.flags !== flags) {
      throw new Error(`the credential ACL on ${target} has unexpected inheritance flags on ${ace.sid}`)
    }
  }
}

/**
 * Restrict `dir` to an exact private DACL, then return. Any failure
 * propagates to the caller so a credential write is refused while the
 * directory's protection is unverified.
 *
 * The path rides the environment and the identity comes from Windows; no
 * key, document, or file content is ever passed here or logged here.
 */
export async function restrictDirToCurrentUser(dir: string): Promise<void> {
  if (process.platform !== 'win32') return
  const sid = parseSid(await runStaticScript(SID_SCRIPT, 'WB_ACL_TARGET', ''))
  await runStaticScript(APPLY_SCRIPT, 'WB_ACL_TARGET', dir)
  await verifyExactAcl(dir, sid, true)
}

/** Extract the `S-1-...` token from the SID probe; absence is an error. */
function parseSid(output: string): string {
  const line = output.split(/\r?\n/u).map(l => l.trim()).find(l => l.startsWith('WBSID|'))
  const sid = line === undefined ? undefined : line.slice('WBSID|'.length)
  if (sid === undefined || !/^S-1-\d+(?:-\d+)+$/u.test(sid)) {
    throw new Error('the current Windows user SID could not be resolved')
  }
  return sid
}
