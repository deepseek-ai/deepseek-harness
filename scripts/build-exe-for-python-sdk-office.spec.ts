import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { copyOfficeSidecar } from './build-exe-for-python-sdk-office.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-python-office-'))
  temporaryDirectories.push(root)
  const staging = join(root, 'staging')
  const destination = join(root, 'runtime-office')
  async function packageAt(name: string, fields: Record<string, unknown> = {}, parent = staging) {
    const directory = join(parent, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...fields }))
    return directory
  }
  return { root, staging, destination, packageAt }
}

it('copies package-owned data, licenses, helper permissions, and nested dependencies', async () => {
  const { staging, destination, packageAt } = await fixture()
  const entry = await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: { '@deepseek-ai/libreoffice-kit-wasm': '0.0.1' }, dependencies: { decoder: '1' } })
  const engine = await packageAt('@deepseek-ai/libreoffice-kit-wasm')
  const decoder = await packageAt('decoder', { dependencies: { codec: '1' } }, entry)
  await packageAt('codec', {}, decoder)
  await packageAt('codec', { version: '2.0.0' })
  const assets = ['assets/soffice.data', 'prebuilds.json', 'licenses/LICENSE', 'bin/helper']
  for (const name of assets) {
    const path = join(engine, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, name)
  }
  await chmod(join(engine, 'bin/helper'), 0o755)

  const packages = await copyOfficeSidecar(staging, destination, { platform: 'linux', arch: 'x64' })

  expect(packages).toHaveLength(4)
  expect(await readFile(join(destination, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.data'), 'utf8')).toBe('assets/soffice.data')
  expect(await readFile(join(destination, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/licenses/LICENSE'), 'utf8')).toBe('licenses/LICENSE')
  expect(await readFile(join(destination, 'node_modules/@deepseek-ai/libreoffice-kit/node_modules/decoder/node_modules/codec/package.json'), 'utf8')).toContain('codec')
  await expect(stat(join(destination, 'node_modules/codec'))).rejects.toMatchObject({ code: 'ENOENT' })
  if (process.platform !== 'win32') expect((await stat(join(destination, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/bin/helper'))).mode & 0o111).toBe(0o111)
})

it('copies installed target optionals and leaves other platforms and absent optionals out', async () => {
  const { staging, destination, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', {
    optionalDependencies: { native: '1', foreign: '1', absent: '1' },
  })
  await packageAt('@deepseek-ai/libreoffice-kit-wasm')
  await packageAt('native', { os: ['linux'], cpu: ['x64'] })
  await packageAt('foreign', { os: ['darwin'], cpu: ['arm64'] })

  const packages = await copyOfficeSidecar(staging, destination, { platform: 'linux', arch: 'x64' })

  expect(packages.map(path => path.replaceAll('\\', '/'))).toEqual([
    'node_modules/@deepseek-ai/libreoffice-kit',
    'node_modules/@deepseek-ai/libreoffice-kit-wasm',
    'node_modules/native',
  ])
})

it('rejects a missing required dependency before producing a sidecar', async () => {
  const { staging, destination, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { dependencies: { 'dsh-missing-office-fixture': '1' } })

  await expect(copyOfficeSidecar(staging, destination, { platform: 'linux', arch: 'x64' }))
    .rejects.toThrow('dsh-missing-office-fixture required by @deepseek-ai/libreoffice-kit is missing')
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an incomplete installed optional instead of omitting it', async () => {
  const { staging, destination, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: { broken: '1' } })
  await mkdir(join(staging, 'node_modules/broken'), { recursive: true })

  await expect(copyOfficeSidecar(staging, destination, { platform: 'linux', arch: 'x64' }))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an ancestor dependency outside the deployed closure', async () => {
  const { root, staging, destination, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { dependencies: { 'ancestor-office-fixture': '1' } })
  await packageAt('ancestor-office-fixture', {}, root)

  await expect(copyOfficeSidecar(staging, destination, { platform: 'linux', arch: 'x64' }))
    .rejects.toThrow('outside the deployed closure')
})

it('requires the declared WASM engine inside the deployed closure', async () => {
  const { root, staging, destination, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: { '@deepseek-ai/libreoffice-kit-wasm': '0.0.1' } })
  await packageAt('@deepseek-ai/libreoffice-kit-wasm', {}, root)
  await expect(copyOfficeSidecar(staging, destination, { platform: 'linux', arch: 'x64' }))
    .rejects.toThrow('Office engine @deepseek-ai/libreoffice-kit-wasm required for linux/x64 is missing.')
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'],
  ['win32', 'arm64', 'win32-arm64'], ['win32', 'x64', 'win32-x64'],
  ['linux', 'x64', 'linux-x64'], ['linux', 'arm64', 'wasm'], ['freebsd', 'x64', 'wasm'],
])('copies only the %s/%s engine even when other engines are staged', async (platform, arch, selected) => {
  const { staging, destination, packageAt } = await fixture()
  const targets = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-x64', 'wasm']
  const names = targets.map(target => `@deepseek-ai/libreoffice-kit-${target}`)
  await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: Object.fromEntries(names.map(name => [name, '0.0.1'])) })
  for (const name of names) await packageAt(name)
  const expected = `@deepseek-ai/libreoffice-kit-${selected}`
  const packages = await copyOfficeSidecar(staging, destination, { platform, arch })
  expect(packages.map(path => path.replaceAll('\\', '/'))).toEqual([
    'node_modules/@deepseek-ai/libreoffice-kit', `node_modules/${expected}`,
  ])
})

it.each(['darwin', 'win32', 'linux'])('%s requires its native package even when WASM is staged', async (platform) => {
  const { staging, destination, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit', { optionalDependencies: {
    '@deepseek-ai/libreoffice-kit-wasm': '0.0.1', [`@deepseek-ai/libreoffice-kit-${platform}-arm64`]: '0.0.1',
  } })
  await packageAt('@deepseek-ai/libreoffice-kit-wasm')
  await expect(copyOfficeSidecar(staging, destination, { platform, arch: 'arm64' }))
    .rejects.toThrow(`Office engine @deepseek-ai/libreoffice-kit-${platform}-arm64 required for ${platform}/arm64 is missing.`)
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('requires a staged Linux WASM engine even when an ancestor has one', async () => {
  const { root, staging, destination, packageAt } = await fixture()
  await packageAt('@deepseek-ai/libreoffice-kit')
  await packageAt('@deepseek-ai/libreoffice-kit-wasm', {}, root)
  await expect(copyOfficeSidecar(staging, destination, { platform: 'linux', arch: 'x64' }))
    .rejects.toThrow('Office engine @deepseek-ai/libreoffice-kit-wasm required for linux/x64 is missing.')
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})
