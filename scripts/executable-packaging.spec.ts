import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { restoreLegacyHoists } from './executable-packaging.ts'
import { materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-exe-deploy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const staging = join(root, 'staging')
  await mkdir(source)
  await mkdir(join(staging, 'node_modules'), { recursive: true })
  return { root, source, staging, modules: join(staging, 'node_modules') }
}

it('restores omitted direct peers without copying their nested module instances', async () => {
  const test = await fixture()
  await writeFile(join(test.staging, 'package.json'), JSON.stringify({ dependencies: { peer: 'workspace:^' } }))
  await mkdir(join(test.source, 'peer/node_modules/shadow'), { recursive: true })
  await writeFile(join(test.source, 'peer/index.js'), 'export const identity = 1\n')
  await writeFile(join(test.source, 'peer/node_modules/shadow/index.js'), 'shadow')
  expect(await restoreLegacyHoists(test.staging, test.source)).toEqual(['peer'])
  expect(await readFile(join(test.modules, 'peer/index.js'), 'utf8')).toBe('export const identity = 1\n')
  await expect(lstat(join(test.modules, 'peer/node_modules'))).rejects.toThrow('ENOENT')
  expect(await restoreLegacyHoists(test.staging, test.source)).toEqual([])
})

it('rejects a missing dependency instead of packaging an incomplete graph', async () => {
  const test = await fixture()
  await writeFile(join(test.staging, 'package.json'), JSON.stringify({ dependencies: { missing: 'workspace:^' } }))
  await expect(restoreLegacyHoists(test.staging, test.source)).rejects.toThrow('absent from both')
})

it('materializes a package junction without deleting its source and drops linked command directories', async () => {
  const test = await fixture()
  await mkdir(join(test.source, 'peer'))
  await writeFile(join(test.source, 'peer/index.js'), 'intact')
  await symlink(join(test.source, 'peer'), join(test.modules, 'peer'), 'junction')
  await symlink(join(test.source, 'peer'), join(test.modules, '.bin'), 'junction')
  await materializeStagedLinks(test.staging)
  expect((await lstat(join(test.modules, 'peer'))).isSymbolicLink()).toBe(false)
  expect(await readFile(join(test.modules, 'peer/index.js'), 'utf8')).toBe('intact')
  expect(await readFile(join(test.source, 'peer/index.js'), 'utf8')).toBe('intact')
  await expect(lstat(join(test.modules, '.bin'))).rejects.toThrow('ENOENT')
})
