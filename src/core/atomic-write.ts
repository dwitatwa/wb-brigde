/**
 * Atomic file writes and advisory file locks, in plain Node.
 *
 * These replace the `@deepseek-ai/dsh-atomic-write` helper the bridge used to
 * import, so the core carries no DeepSeek Harness dependency. The exported
 * names and signatures are deliberately identical to the originals, which is
 * why no call site had to change when the module was swapped in.
 *
 * @module workbuddy-bridge/core/atomic-write
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Options for {@link writeFileAtomic}. */
export interface AtomicWriteOptions {
  /** Permission bits for the written file, applied to the temp file before the rename. */
  mode?: number
  /** Permission bits for directories this call has to create. */
  dirMode?: number
}

/** How long a lock holder may hold before another process is allowed to steal it. */
const LOCK_STALE_MS = 30_000

/** How long {@link withFileLock} waits on a contended lock before giving up. */
const LOCK_TIMEOUT_MS = 10_000

/** Backoff bounds for the lock retry loop. */
const LOCK_RETRY_MIN_MS = 5
const LOCK_RETRY_MAX_MS = 250

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Write a file so a reader never observes a partial document.
 *
 * The bytes land in a uniquely named temp file *in the same directory* as the
 * target, are flushed to disk, and are then renamed over it. Rename within one
 * directory is atomic, so the target holds either the old contents or the new
 * ones and never a truncated mix — which matters here because the credential
 * copy and the catalog cache are read by other processes.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  const temp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // `wx` refuses to reuse an existing name, so two concurrent writers can
    // never share a temp file. The mode is set at creation, and rename
    // preserves it onto the target.
    handle = await open(temp, 'wx', options.mode ?? 0o600)
    await handle.writeFile(data, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
  } catch (error: unknown) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Run `fn` while holding an exclusive lock named `<path>.lock`.
 *
 * The lock is an exclusively created (`wx`) marker file. That exact name is
 * part of the contract rather than an implementation detail: the credential
 * store's `logout()` deletes `<ownPath>.lock` alongside its copy, so renaming
 * the suffix would leave a stale marker behind.
 *
 * A holder that dies without releasing is recovered by stealing a lock older
 * than {@link LOCK_STALE_MS} — the same bounded-recovery idea the upstream
 * helper used, and the reason the file carries an mtime at all.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`
  // The lock can be the first thing to touch a fresh bridge home, so the
  // directory has to exist before the exclusive create can succeed.
  await mkdir(dirname(lock), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let delay = LOCK_RETRY_MIN_MS
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      await handle.close()
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const info = await stat(lock)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lock).catch(() => {})
          continue
        }
      } catch {
        // The lock disappeared between the failed create and this stat, so a
        // fresh attempt can take it immediately.
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`workbuddy-bridge: timed out waiting for the lock at ${lock}`)
      }
      await sleep(delay)
      delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
    }
  }
  try {
    return await fn()
  } finally {
    await unlink(lock).catch(() => {})
  }
}
