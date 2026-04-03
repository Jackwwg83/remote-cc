/**
 * T-38: Tests for versionCheck — semver parsing, comparison, and version check logic
 */

import { describe, it, expect } from 'vitest'
import { compareSemver, parseVersion } from '../src/versionCheck.js'

// ---------------------------------------------------------------------------
// Tests: compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })

  it('returns negative when a < b', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0)
    expect(compareSemver('2.0.0', '2.1.0')).toBeLessThan(0)
    expect(compareSemver('2.1.0', '2.1.1')).toBeLessThan(0)
  })

  it('returns positive when a > b', () => {
    expect(compareSemver('3.0.0', '2.0.0')).toBeGreaterThan(0)
    expect(compareSemver('2.2.0', '2.1.0')).toBeGreaterThan(0)
    expect(compareSemver('2.1.2', '2.1.1')).toBeGreaterThan(0)
  })

  it('handles multi-digit version numbers', () => {
    expect(compareSemver('10.0.0', '9.9.9')).toBeGreaterThan(0)
    expect(compareSemver('1.10.0', '1.9.0')).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: parseVersion
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
  it('extracts version from "claude 2.1.0"', () => {
    expect(parseVersion('claude 2.1.0')).toBe('2.1.0')
  })

  it('extracts version from plain "2.1.0"', () => {
    expect(parseVersion('2.1.0')).toBe('2.1.0')
  })

  it('extracts version from "v2.1.0"', () => {
    expect(parseVersion('v2.1.0')).toBe('2.1.0')
  })

  it('extracts version from "Claude Code v2.3.1"', () => {
    expect(parseVersion('Claude Code v2.3.1')).toBe('2.3.1')
  })

  it('extracts version from multiline output', () => {
    expect(parseVersion('Claude Code\nVersion: 2.5.0\nBuild: abc')).toBe('2.5.0')
  })

  it('returns null for unrecognized output', () => {
    expect(parseVersion('no version here')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })

  it('extracts first version if multiple present', () => {
    expect(parseVersion('claude 2.1.0 (node 20.0.0)')).toBe('2.1.0')
  })
})
