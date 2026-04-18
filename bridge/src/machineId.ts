/**
 * machineId.ts — persistent machine identifier
 *
 * Generates a UUID v4 on first run, persists to ~/.remote-cc/machine-id.
 * Used as the cluster-wide routing key for multi-machine setups.
 */

import { readFile, open, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MACHINE_DIR = join(homedir(), '.remote-cc')
const MACHINE_ID_FILE = join(MACHINE_DIR, 'machine-id')

// Strict UUID v4: 8-4-4-4-12 hex, version nibble=4, variant=8|9|a|b
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function getOrCreateMachineId(): Promise<string> {
  // Try to read existing file first
  try {
    const content = await readFile(MACHINE_ID_FILE, 'utf8')
    const id = content.trim()
    if (UUID_V4_REGEX.test(id)) return id
    // File exists but content is invalid — don't silently overwrite; abort
    throw new Error(
      `Invalid machine-id in ${MACHINE_ID_FILE}: ${JSON.stringify(id)}. ` +
      `Delete the file manually if you want to regenerate.`,
    )
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') throw err
    // File doesn't exist — fall through to create
  }

  // Create with exclusive open (O_EXCL) so concurrent first-runs can't both write
  await mkdir(MACHINE_DIR, { recursive: true })
  const id = randomUUID()
  let handle
  try {
    handle = await open(MACHINE_ID_FILE, 'wx')
    await handle.writeFile(id + '\n')
    return id
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EEXIST') {
      // Another process beat us to it — read what they wrote
      const content = await readFile(MACHINE_ID_FILE, 'utf8')
      const existing = content.trim()
      if (UUID_V4_REGEX.test(existing)) return existing
      throw new Error(`Raced on machine-id creation but found invalid content: ${existing}`)
    }
    throw err
  } finally {
    if (handle) await handle.close()
  }
}
