/** Desktop carriers keep a complete interpreter payload even when SDK carriers choose Python-only. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { smokePrimaryRuntime } from '../scripts/prepare-primary-runtime.ts'

it('rejects a Python-only native Desktop payload before executing interpreters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-python-only-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
      desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
      python: '3.12.14', pythonPackages: { numpy: '2.3.5', pandas: '3.0.1' },
    }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('Desktop payload must declare node and pnpm')
  } finally { await rm(root, { recursive: true, force: true }) }
})
