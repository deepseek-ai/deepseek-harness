import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { resolvePrimaryRuntime } from '../packages/skill/tool-workspace-dependencies/src/index.ts'
import { syncPythonRuntimeProduct } from './build-exe-for-python-sdk-resources.ts'

it('copies standalone SDK products with their executable permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-product-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await writeFile(source, 'executable')
  await chmod(source, 0o755)
  await syncPythonRuntimeProduct(source, destination)
  expect(await readFile(destination, 'utf8')).toBe('executable')
  expect((await stat(destination)).mode & 0o777).toBe((await stat(source)).mode & 0o777)
})

// Windows uses python.exe and does not require POSIX file symlink privileges.
it.skipIf(process.platform === 'win32')('keeps SDK Python resources usable after deleting the build output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-resource-aliases-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'dist-exe', 'resources')
  const destination = join(root, 'carrier', 'resources')
  const bin = 'primary-runtime/dependencies/python/bin'
  await mkdir(join(source, bin), { recursive: true })
  await mkdir(join(source, 'primary-runtime/dependencies/python/lib/python3.12/site-packages'), { recursive: true })
  await writeFile(join(source, 'primary-runtime/runtime.json'), JSON.stringify({
    desktopVersion: '1', platform: process.platform, arch: process.arch, python: '3.12.14', pythonPackages: {},
  }))
  await writeFile(join(source, bin, 'python3.12'), 'interpreter')
  for (const alias of ['python', 'python3']) await symlink('python3.12', join(source, bin, alias))
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'stale'), 'previous product')

  await syncPythonRuntimeProduct(source, destination)
  await rm(join(root, 'dist-exe'), { recursive: true })

  await expect(stat(join(destination, 'stale'))).rejects.toMatchObject({ code: 'ENOENT' })
  const paths = await resolvePrimaryRuntime(join(destination, 'primary-runtime'))
  expect(await readFile(paths.python, 'utf8')).toBe('interpreter')
  for (const alias of ['python', 'python3']) {
    expect(await readlink(join(destination, bin, alias))).toBe('python3.12')
    expect(await readFile(join(destination, bin, alias), 'utf8')).toBe('interpreter')
  }
})
