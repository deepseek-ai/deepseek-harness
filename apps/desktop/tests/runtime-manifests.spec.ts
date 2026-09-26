import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareRuntimeManifests } from '../scripts/prepare-runtime-manifests.ts'
import { verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

it('seals dependency metadata that remains unchanged by archive preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-manifests-'))
  const fixture = runtimeFixture(root)
  try {
    const directory = join(root, 'node_modules/example/node_modules/nested')
    mkdirSync(directory, { recursive: true })
    const manifest = join(directory, 'package.json')
    writeFileSync(manifest, JSON.stringify({ name: 'nested', version: '1.0.0',
      scripts: { test: 'vitest' }, keywords: ['example'], bugs: 'https://example.com',
      main: 'index.js', dependencies: { runtime: '1.0.0' } }))
    await expect(verifyDesktopRuntime(root, fixture.release.version)).rejects.toThrow('integrity')
    await prepareRuntimeManifests(root)
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toEqual({ name: 'nested', version: '1.0.0',
      main: 'index.js', dependencies: { runtime: '1.0.0' } })
    writeDesktopRuntime(root, fixture.release, fixture.sharedPackages.map(entry => entry.name))
    await prepareRuntimeManifests(root)
    await verifyDesktopRuntime(root, fixture.release.version)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
