import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MEMORY_PRESSURE_FILES,
  memoryLimitViolation,
  memoryPressureMachine,
  memoryScopeCommand,
} from './run-memory-pressure-bench.ts'

const root = resolve(import.meta.dirname, '..')

describe('memory-pressure benchmark launcher', () => {
  it('selects existing benchmark files', () => {
    for (const file of MEMORY_PRESSURE_FILES) expect(existsSync(resolve(root, file)), file).toBe(true)
  })

  it('accepts only the modeled machines', () => {
    expect(memoryPressureMachine('4g')).toBe('4g')
    expect(memoryPressureMachine('8g')).toBe('8g')
    expect(() => memoryPressureMachine('16g')).toThrow('usage')
    expect(() => memoryPressureMachine(undefined)).toThrow('usage')
  })

  it('confines the command to the machine memory without swap', () => {
    expect(memoryScopeCommand('4g', ['node', 'x.js'])).toEqual([
      'systemd-run', '--user', '--scope', '--quiet', '-p', 'MemoryMax=4G', '-p', 'MemorySwapMax=0', '--', 'node', 'x.js',
    ])
  })

  it('accepts only a cgroup capped at the machine size without swap', () => {
    const capped = { max: '4294967296', swapMax: '0', constrained: 4 * 1024 ** 3 }
    expect(memoryLimitViolation('4g', capped)).toBeUndefined()
    for (const limits of [
      { ...capped, max: 'max' },
      { ...capped, max: '8589934592' },
      { ...capped, swapMax: 'max' },
      { ...capped, swapMax: '4294967296' },
      { ...capped, constrained: 2 * 1024 ** 3 },
    ]) {
      expect(memoryLimitViolation('4g', limits)).toContain('does not cap 4g without swap')
    }
  })
})
