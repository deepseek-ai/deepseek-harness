/** Windows manifest paths still select the packages whose artifacts Desktop bundles. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { build } from 'tsdown'
import { expect, it, onTestFinished } from 'vitest'
import { workspacePackageGlobs } from './workspace-package-globs.ts'

it('selects workspace packages from Windows and POSIX manifest paths', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-workspace-globs-'))
  onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const manifests = ['packages\\util\\atomic-write\\package.json', 'vendor/cordis/package.json']
  for (const [index, directory] of ['packages/util/atomic-write', 'vendor/cordis'].entries()) {
    await mkdir(join(cwd, directory, 'src'), { recursive: true })
    await writeFile(join(cwd, directory, 'package.json'), JSON.stringify({ name: `fixture-${index}`, type: 'module' }))
    await writeFile(join(cwd, directory, 'src/index.ts'), `export const value = ${index}\n`)
  }
  const options = { cwd, config: false as const, entry: ['src/index.ts'], write: false, dts: false, logLevel: 'silent' as const }
  const selected = await build({ ...options, workspace: workspacePackageGlobs(manifests) })
  expect(selected).toHaveLength(2)
  const unnormalized = await build({ ...options, workspace: manifests.map(path => win32.dirname(path)) })
  expect(unnormalized.map(bundle => bundle.config.name)).toEqual(['fixture-1'])
})
