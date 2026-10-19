/** Compatibility checks execute command entrypoints; importing helpers cannot detect a silent no-op. */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('repository command entrypoints', () => {
  it.each([
    ['run-gates.ts', ['invalid-compat-mode'], 'run-gates: expected mode'],
    ['build.ts', ['--scope', 'invalid-compat-scope'], 'build: --scope must be'],
  ] as const)('executes %s argument validation on the running Node version', (script, args, diagnostic) => {
    const child = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'scripts', script), ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.signal).toBeNull()
    expect(child.status).toBe(1)
    expect(child.stderr).toContain(diagnostic)
  })
})
