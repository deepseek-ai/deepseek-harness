/** Cold pnpm requests exercise shipped CUA dependency/platform metadata with inert package contents. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { expect, it, onTestFinished } from 'vitest'
import { pnpmCommand } from '../../../scripts/release/process.ts'

const repository = resolve(import.meta.dirname, '../../..')
const providerName = '@deepseek-ai/dsh-experimental-cua-macos'
const bundleName = '@deepseek-ai/dsh-cua-bundle'
const readManifest = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(repository, path, 'package.json'), 'utf8')) as Record<string, unknown>

it('fetches the macOS optional tarball only for Darwin, with an empty cache for every target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cua-cold-install-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const userconfig = join(root, 'npmrc')
  await writeFile(userconfig, '')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key) && !/^(npm|pnpm|corepack)_/iu.test(key)
    && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH'))
  const [pnpm, ...prefix] = pnpmCommand()
  const command = async (args: string[], cwd: string) => {
    const result = await execa(pnpm, [...prefix, `--config.userconfig=${userconfig}`, ...args], {
      cwd, env: { ...environment, CI: 'true', XDG_CACHE_HOME: join(cwd, 'xdg-cache'),
        XDG_DATA_HOME: join(cwd, 'xdg-data'), XDG_STATE_HOME: join(cwd, 'xdg-state'),
        XDG_CONFIG_HOME: join(cwd, 'xdg-config') }, extendEnv: false, reject: false, timeout: 60_000,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
    return result.stdout
  }
  const cli = await readManifest('apps/cli')
  const bundle = await readManifest('packages/experimental/cua-bundle')
  const native = await readManifest('packages/experimental/cua-macos')
  expect(cli.dependencies).toHaveProperty(bundleName)
  expect(bundle.dependencies).not.toHaveProperty(providerName)
  expect(bundle.optionalDependencies).toEqual({ [providerName]: 'workspace:*' })
  expect(native.os).toEqual(['darwin'])
  const version = '1.0.0'
  const bundleDependencies = Object.fromEntries(Object.keys(bundle.dependencies as Record<string, string>).map(name => [name, version]))
  const manifests = [
    { name: cli.name, version, dependencies: { [bundleName]: version } },
    { name: bundleName, version, dependencies: bundleDependencies, optionalDependencies: { [providerName]: version } },
    ...Object.keys(bundleDependencies).map(name => ({ name, version })),
    { name: providerName, version, os: native.os, files: native.files },
  ]
  const packages = new Map<string, { manifest: Record<string, unknown>; bytes: Buffer }>()
  for (const manifest of manifests) {
    const name = String(manifest.name)
    const directory = join(root, name.replace('@deepseek-ai/', ''))
    await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    if (name === providerName) {
      await mkdir(join(directory, 'native/bin/darwin-arm64'), { recursive: true })
      for (const file of ['.gitignore', '.npmignore']) {
        await writeFile(join(directory, 'native', file), await readFile(join(repository, 'packages/experimental/cua-macos/native', file)))
      }
      await writeFile(join(directory, 'native/bin/darwin-arm64/dsh-cua-native'), 'inert native payload')
    }
    await command(['pack', '--out', 'package.tgz'], directory)
    const bytes = await readFile(join(directory, 'package.tgz'))
    packages.set(name, { manifest, bytes })
    if (name === providerName) {
      const result = await execa('tar', ['-tzf', join(directory, 'package.tgz')])
      expect(result.stdout).toContain('package/native/bin/darwin-arm64/dsh-cua-native')
    }
  }
  const requests: string[] = []
  let unrestricted = false
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? '')
    requests.push(path)
    const tarball = path.endsWith('.tgz')
    const name = path.slice(1).replace(/\.tgz$/u, '')
    const entry = packages.get(name)
    if (!entry) { response.writeHead(404); response.end(); return }
    if (tarball) { response.end(entry.bytes); return }
    const manifest = { ...entry.manifest }
    // pnpm also infers macOS from this package name; an explicit any overrides that inference.
    if (unrestricted && name === providerName) manifest.os = ['any']
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: {
      [version]: { ...manifest, dist: {
        tarball: `http://${request.headers.host}/${name}.tgz`,
        integrity: `sha512-${createHash('sha512').update(entry.bytes).digest('base64')}`,
      } },
    } }))
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture registry has no TCP address')
  for (const target of ['darwin', 'win32', 'linux', 'linux-unrestricted']) {
    unrestricted = target === 'linux-unrestricted'
    const project = join(root, target)
    await mkdir(project)
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, dependencies: { [String(cli.name)]: version } }))
    await writeFile(join(project, 'pnpm-workspace.yaml'), [
      'autoInstallPeers: false', 'supportedArchitectures:', `  os: [${unrestricted ? 'linux' : target}]`,
      '  cpu: [arm64]', 'minimumReleaseAge: 0', '',
    ].join('\n'))
    requests.length = 0
    const output = await command([
      'install', '--ignore-scripts', '--config.enable-global-virtual-store=false',
      `--config.registry=http://127.0.0.1:${address.port}/`, `--config.store-dir=${join(project, 'store')}`,
      `--config.cache-dir=${join(project, 'cache')}`, `--config.state-dir=${join(project, 'state')}`,
    ], project)
    expect(requests).toContain(`/${bundleName}.tgz`)
    expect(requests).toContain('/@deepseek-ai/dsh-cua.tgz')
    expect(requests.includes(`/${providerName}.tgz`), `${target}: ${JSON.stringify(requests)}\n${output}`)
      .toBe(target === 'darwin' || unrestricted)
  }
}, 120_000)
