/**
 * machineId.ts — persistent machine identifier
 *
 * Generates a UUID v4 on first run, persists to ~/.remote-cc/machine-id.
 * Used as the cluster-wide routing key for multi-machine setups.
 */

import { readFile, writeFile, link, mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MACHINE_DIR = join(homedir(), '.remote-cc')
const MACHINE_ID_FILE = join(MACHINE_DIR, 'machine-id')

// Strict UUID v4: 8-4-4-4-12 hex, version nibble=4, variant=8|9|a|b
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Invalid content marker — file exists with non-UUID content that looks complete. */
export class CorruptMachineIdError extends Error {
  constructor(public readonly content: string) {
    super(`Invalid machine-id in ${MACHINE_ID_FILE}: ${JSON.stringify(content)}`)
    this.name = 'CorruptMachineIdError'
  }
}

/**
 * Returns:
 *   - valid UUID v4 string → file has a complete valid ID
 *   - null → file missing OR appears to be mid-write (partial contents)
 *   - throws CorruptMachineIdError → file has non-UUID content that is clearly
 *     not a partial write (long enough to be "final" but wrong shape)
 */
async function readValid(): Promise<string | null> {
  let content: string
  try {
    content = await readFile(MACHINE_ID_FILE, 'utf8')
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return null
    throw err
  }

  const id = content.trim()
  if (UUID_V4_REGEX.test(id)) return id

  // Heuristic: a valid entry is exactly 36 chars after trim. Anything shorter
  // is treated as a partial write (retryable). Anything else looks like a
  // complete-but-wrong file (corruption).
  if (id.length < 36) return null

  throw new CorruptMachineIdError(id)
}

export async function getOrCreateMachineId(): Promise<string> {
  // 1. Try existing file
  const existing = await readValid()
  if (existing) return existing

  // 2. Create atomically via tmp-file + link():
  //    link() is POSIX atomic — fails with EEXIST if target already exists.
  //    Unlike rename(), it never overwrites. The winner gets target == their
  //    ID. Any loser's link() call fails with EEXIST, and they read the
  //    winner's value instead. No TOCTOU, no partial file visibility.
  //
  //    Non-POSIX fallback: a few filesystems (e.g. some exFAT mounts) don't
  //    support hardlinks. In that case link() throws EPERM / ENOSYS and we
  //    fall back to a best-effort writeFile('wx') + retry loop.
  await mkdir(MACHINE_DIR, { recursive: true })
  const id = randomUUID()
  const tempPath = join(MACHINE_DIR, `machine-id.tmp.${process.pid}.${Date.now()}.${randomUUID()}`)

  try {
    await writeFile(tempPath, id + '\n', { flag: 'wx' })

    try {
      await link(tempPath, MACHINE_ID_FILE)
      // Winner path — target now exists with our ID.
      return id
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'EEXIST') {
        // Loser path — someone else got there first. Read winner's ID.
        // Retry a few times in case winner is still writing (shouldn't happen
        // with link() but defensive nonetheless).
        for (let attempt = 0; attempt < 20; attempt++) {
          const winner = await readValid()
          if (winner) return winner
          await sleepMs(25)
        }
        throw new Error(`Raced on machine-id creation but could not read winner after retries`)
      }
      if (e.code === 'EPERM' || e.code === 'ENOSYS' || e.code === 'EOPNOTSUPP') {
        // Filesystem doesn't support hardlinks. Fall back to writeFile('wx')
        // on the target directly. There IS a partial-write window here
        // between create and complete write; we make readValid() tolerant
        // of partial content (returns null for content < 36 chars).
        try {
          await writeFile(MACHINE_ID_FILE, id + '\n', { flag: 'wx' })
          return id
        } catch (err2: unknown) {
          const e2 = err2 as NodeJS.ErrnoException
          if (e2.code !== 'EEXIST') throw err2
          // Someone else got there. Poll with tolerance for partial reads.
          for (let attempt = 0; attempt < 40; attempt++) {
            try {
              const winner = await readValid()
              if (winner) return winner
            } catch (err3: unknown) {
              if (err3 instanceof CorruptMachineIdError) throw err3
              // other errors: retry
            }
            await sleepMs(25)
          }
          throw new Error(`Raced on machine-id creation (fallback) but could not read winner after 1s`)
        }
      }
      throw err
    }
  } finally {
    // Always clean up temp file (link() leaves it as a second name; removing
    // the temp leaves only the target, which is now a regular file).
    await removeIfExists(tempPath)
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function removeIfExists(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch {
    // ignore — best effort
  }
}
