import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { prepareInstalledUpdateRuntime } from '../scripts/prepare-installed-update-runtime.ts'
import { verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const versions = ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'] as const
const source = { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] }

async function fixture<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-update-materials-'))
  try { return await body(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

describe('installed-update runtime preparation', () => {
  it('retags only release-owned packages and dependencies while preserving source and third-party versions', async () => {
    await fixture(async (directory) => {
      const original = join(directory, 'source')
      runtimeFixture(original, source.version)
      const before = await readFile(join(original, 'desktop-runtime.json'))
      const run = await createInstalledUpdateRun(join(directory, 'runs'), versions, source)
      const result = await prepareInstalledUpdateRuntime(join(run.root, 'run.json'), original)
      expect(result).toMatchObject({ signed: false, bootTested: false })
      for (const version of versions) {
        const runtime = join(run.root, version, 'dsh')
        const descriptor = await verifyDesktopRuntime(runtime, version)
        expect(descriptor.sharedPackages.find(entry => entry.name === '@deepseek-ai/cordis')?.version).toBe(source.version)
        expect(descriptor.sharedPackages.find(entry => entry.name === '@deepseek-ai/dsh')?.version).toBe(version)
        const metadata = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')) as {
          dependencies: Record<string, string>
        }
        expect(metadata.dependencies['@deepseek-ai/dsh-desktop-host']).toBe(version)
        expect(metadata.dependencies['@deepseek-ai/cordis']).toBe(source.version)
      }
      expect(await readFile(join(original, 'desktop-runtime.json'))).toEqual(before)
      await expect(verifyDesktopRuntime(original, source.version)).resolves.toBeDefined()
      await expect(prepareInstalledUpdateRuntime(join(run.root, 'run.json'), original)).rejects.toMatchObject({ code: 'EEXIST' })
    })
  })

  it('stops after a failed version and retains partial materials without a completion receipt', async () => {
    await fixture(async (directory) => {
      const original = join(directory, 'source')
      runtimeFixture(original, source.version)
      const run = await createInstalledUpdateRun(join(directory, 'runs'), versions, source)
      await mkdir(join(run.root, versions[1]))
      await writeFile(join(run.root, versions[1], 'owner.txt'), 'do not overwrite')
      await expect(prepareInstalledUpdateRuntime(join(run.root, 'run.json'), original)).rejects.toMatchObject({ code: 'EEXIST' })
      const files = await readdir(join(run.root, 'runtime-preparation'))
      expect(files.sort()).toEqual(['failed.json', 'source.json', 'started.json'])
      expect(JSON.parse(await readFile(join(run.root, 'runtime-preparation/failed.json'), 'utf8')))
        .toMatchObject({ failed: true, completedVersions: 1, retryAllowed: false })
      expect(await readFile(join(run.root, versions[1], 'owner.txt'), 'utf8')).toBe('do not overwrite')
    })
  })

  it('rejects stale or damaged prepared resources before copying either version', async () => {
    await fixture(async (directory) => {
      const original = join(directory, 'source')
      runtimeFixture(original, source.version)
      await writeFile(join(original, 'package.json'), '{}')
      const run = await createInstalledUpdateRun(join(directory, 'runs'), versions, source)
      await expect(prepareInstalledUpdateRuntime(join(run.root, 'run.json'), original)).rejects.toThrow('integrity')
      expect((await readdir(run.root)).sort()).toEqual(['run.json', 'runtime-preparation'])
      expect(JSON.parse(await readFile(join(run.root, 'runtime-preparation/failed.json'), 'utf8')))
        .toMatchObject({ failed: true, completedVersions: 0 })
    })
  })
})
