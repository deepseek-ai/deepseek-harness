import { describe, expect, it } from 'vitest'
import type { Config } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'
import { resolveConfig, validateConfig } from '@deepseek-ai/dsh-terminal-bash/src/config.ts'

function config(overrides: Partial<Config> = {}): Config {
  return {
    backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: [], rows: 40, cols: 160,
    scrollbackLines: 100, scrollbackMaxBytes: 1024, maxReadBytes: 512,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 100, handoffGraceMs: 50, promptTailGraceMs: 0, timeoutMs: 1000,
    disposeGraceMs: 100,
    ...overrides,
  }
}

describe('terminal-bash config', () => {
  it('accepts resolved positive bounds', () => {
    expect(() => { validateConfig(config()) }).not.toThrow()
  })

  it('rejects empty names, invalid numbers, and a read cap above retention', () => {
    expect(() => { validateConfig(config({ backendType: '' })) }).toThrow('backendType')
    expect(() => { validateConfig(config({ shellPath: '' })) }).toThrow('shellPath')
    expect(() => { validateConfig(config({ rows: 0 })) }).toThrow('rows')
    expect(() => { validateConfig(config({ rows: 1.5 })) }).toThrow('rows')
    expect(() => { validateConfig(config({ maxReadBytes: 2048 })) }).toThrow('must not exceed')
  })

  it('rejects a handoff grace shorter than one readiness poll', () => {
    expect(() => { validateConfig(config({ handoffGraceMs: 9, pollIntervalMs: 10 })) }).toThrow('handoffGraceMs must be at least pollIntervalMs')
    expect(() => { validateConfig(config({ handoffGraceMs: 10, pollIntervalMs: 10 })) }).not.toThrow()
  })

  it('accepts the prompt tail grace at zero and rejects negative or fractional values', () => {
    expect(() => { validateConfig(config({ promptTailGraceMs: 0 })) }).not.toThrow()
    expect(() => { validateConfig(config({ promptTailGraceMs: 2_000 })) }).not.toThrow()
    expect(() => { validateConfig(config({ promptTailGraceMs: -1 })) }).toThrow('promptTailGraceMs must be a non-negative safe integer')
    expect(() => { validateConfig(config({ promptTailGraceMs: 1.5 })) }).toThrow('promptTailGraceMs must be a non-negative safe integer')
  })

  it('accepts the prompt tail grace at zero or at least one readiness poll', () => {
    expect(() => { validateConfig(config({ promptTailGraceMs: 5, pollIntervalMs: 10 })) }).toThrow('promptTailGraceMs must be zero or at least pollIntervalMs')
    expect(() => { validateConfig(config({ promptTailGraceMs: 10, pollIntervalMs: 10 })) }).not.toThrow()
    expect(() => { validateConfig(config({ promptTailGraceMs: 0, pollIntervalMs: 10 })) }).not.toThrow()
  })

})

describe('terminal-bash dialect resolution', () => {
  it('defaults bash argv to the interactive profile-free form', () => {
    const { shellPath, shellArgs, shellDialect } = resolveConfig({ backendType: 'shell', rows: 24, cols: 80 })
    expect(shellDialect).toBe('bash')
    expect(shellPath).toBe('/bin/bash')
    expect(shellArgs).toEqual(['--noprofile', '--norc', '-i'])
  })

  it('defaults pwsh argv to the interactive profile-free form and resolves the executable', () => {
    const resolved = resolveConfig({ backendType: 'shell', shellDialect: 'pwsh', rows: 24, cols: 80 })
    expect(resolved.shellDialect).toBe('pwsh')
    expect(resolved.shellPath.length).toBeGreaterThan(0)
    expect(resolved.shellArgs).toEqual(['-NoLogo', '-NoProfile'])
  })

  it('lets an explicit shell specification win over the dialect defaults', () => {
    const resolved = resolveConfig({
      backendType: 'shell', shellDialect: 'pwsh', shellPath: '/custom/pwsh', shellArgs: ['-NoProfile'], rows: 24, cols: 80,
    })
    expect(resolved.shellPath).toBe('/custom/pwsh')
    expect(resolved.shellArgs).toEqual(['-NoProfile'])
  })

  it('treats empty shell values as unset so Schemastery materialization cannot drop the dialect defaults', () => {
    // Schemastery materializes an absent optional array as `[]`; the resolver
    // must treat that shape like an unset value or a real bash spawn would
    // start non-interactive without the controlled prompt.
    const resolved = resolveConfig({
      backendType: 'shell', shellDialect: 'bash', shellPath: '', shellArgs: [], rows: 24, cols: 80,
    })
    expect(resolved.shellPath).toBe('/bin/bash')
    expect(resolved.shellArgs).toEqual(['--noprofile', '--norc', '-i'])
  })

  it('validates the effective shell path, not only the raw one', () => {
    expect(() => { validateConfig(resolveConfig({ backendType: 'shell', shellDialect: 'bash', rows: 24, cols: 80 })) }).not.toThrow()
    expect(() => { validateConfig(resolveConfig({ backendType: 'shell', shellDialect: 'pwsh', rows: 24, cols: 80 })) }).not.toThrow()
  })
})
