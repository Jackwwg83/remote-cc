/**
 * machineId.ts — persistent machine identifier
 *
 * Generates a UUID v4 on first run, persists to ~/.remote-cc/machine-id.
 * Used as the cluster-wide routing key for multi-machine setups.
 */

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MACHINE_DIR = join(homedir(), '.remote-cc')
const MACHINE_ID_FILE = join(MACHINE_DIR, 'machine-id')

// Strict UUID v4: 8-4-4-4-12 hex, version nibble=4, variant=8|9|a|b
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function readValid(): Promise<string | null> {
  try {
    const content = await readFile(MACHINE_ID_FILE, 'utf8')
    const id = content.trim()
    if (UUID_V4_REGEX.test(id)) return id
    if (id === '') return null // treat empty as "not yet written" — caller retries
    // non-empty + invalid → corruption; don't silently overwrite
    throw new Error(
      `Invalid machine-id in ${MACHINE_ID_FILE}: ${JSON.stringify(id)}. ` +
      `Delete the file manually if you want to regenerate.`,
    )
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return null
    throw err
  }
}

export async function getOrCreateMachineId(): Promise<string> {
  // 1. Try existing file
  const existing = await readValid()
  if (existing) return existing

  // 2. Create atomically:
  //    write to a unique temp file, then rename() onto the target.
  //    rename() is atomic on POSIX — the target either has the old file or
  //    the new one, never an empty / partial file. If we lose the race, we
  //    simply read the winner's value.
  await mkdir(MACHINE_DIR, { recursive: true })
  const id = randomUUID()
  const tempPath = join(MACHINE_DIR, `machine-id.tmp.${process.pid}.${Date.now()}`)

  try {
    // write to temp file fully
    await writeFile(tempPath, id + '\n', { flag: 'wx' })
    try {
      // Linux/macOS: rename() is atomic and will overwrite the target.
      // If another process already renamed a valid ID onto the target, we'll
      // end up overwriting it with our own ID — but that's only possible if
      // readValid() at step 1 was racing. To avoid overwriting, re-check and
      // bail out if someone beat us to it.
      const raced = await readValid()
      if (raced) {
        // Lost the race. Clean up our temp file and return the winner.
        return raced
      }
      await rename(tempPath, MACHINE_ID_FILE)
      return id
    } finally {
      // If rename succeeded, temp file is gone (moved). If we returned `raced`
      // above, temp file is orphaned — clean it up.
      await removeIfExists(tempPath)
    }
  } catch (err: unknown) {
    await removeIfExists(tempPath)
    // Retry path: if writeFile('wx') got EEXIST because we collided with our
    // own previous leftover (extremely unlikely given pid+timestamp), bubble
    // up. Real-world first-run race will be caught by the raced-check above.
    throw err
  }
}

async function removeIfExists(p: string): Promise<void> {
  try {
    await unlink(p)
  } catch {
    // ignore — best effort
  }
}
