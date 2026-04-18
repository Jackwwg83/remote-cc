/**
 * machineId.ts — persistent machine identifier
 *
 * Generates a UUID v4 on first run, persists to ~/.remote-cc/machine-id.
 * Used as the cluster-wide routing key for multi-machine setups.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MACHINE_ID_FILE = join(homedir(), '.remote-cc', 'machine-id')

export async function getOrCreateMachineId(): Promise<string> {
  try {
    const content = await readFile(MACHINE_ID_FILE, 'utf8')
    const id = content.trim()
    if (id && /^[0-9a-f-]{36}$/i.test(id)) return id
  } catch {
    // file doesn't exist, create it
  }
  const id = randomUUID()
  await mkdir(join(homedir(), '.remote-cc'), { recursive: true })
  await writeFile(MACHINE_ID_FILE, id + '\n')
  return id
}
