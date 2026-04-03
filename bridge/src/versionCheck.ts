/**
 * T-38: Claude CLI version compatibility check
 *
 * Runs `claude --version`, parses the output, and checks against known
 * compatible versions. Returns a warning if the version is too old or
 * unrecognized, but never blocks startup.
 */

import { execFile } from 'node:child_process'

export interface VersionCheckResult {
  version: string | null
  compatible: boolean
  warning: string | null
}

/** Minimum compatible Claude CLI version */
const MIN_VERSION = '2.0.0'

/**
 * Compare two semver strings (major.minor.patch).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Extract a semver version string from claude --version output.
 * Handles formats like "claude 2.1.0", "2.1.0", "v2.1.0", etc.
 */
export function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/)
  return match ? match[1] : null
}

/**
 * Run `claude --version` and check compatibility.
 * Never throws — returns a result object with version/compatible/warning.
 */
export async function checkClaudeVersion(): Promise<VersionCheckResult> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile('claude', ['--version'], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          reject(err)
          return
        }
        resolve((stdout || stderr).trim())
      })
    })

    const version = parseVersion(output)

    if (!version) {
      return {
        version: null,
        compatible: false,
        warning: `Could not parse Claude CLI version from output: "${output}". Expected format: X.Y.Z`,
      }
    }

    if (compareSemver(version, MIN_VERSION) < 0) {
      return {
        version,
        compatible: false,
        warning: `Claude CLI version ${version} is below minimum ${MIN_VERSION}. Please upgrade: npm install -g @anthropic-ai/claude-code`,
      }
    }

    return { version, compatible: true, warning: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      version: null,
      compatible: false,
      warning: `Could not check Claude CLI version: ${message}`,
    }
  }
}
