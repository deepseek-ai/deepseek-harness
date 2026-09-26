/** Prepare pinned, relocatable script interpreters without installing into the build host. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import extractZip from 'extract-zip'
import { x as extractTar } from 'tar'
import { parsePrimaryRuntime, workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../../packages/skill/tool-workspace-dependencies/src/index.ts'
import lock from './lock.json' with { type: 'json' }

/**
 * Download or reuse an archive only when its bytes match the release lock.
 * @param url - Locked archive URL.
 * @param sha256 - Expected SHA-256 digest.
 * @param cache - Download cache directory.
 * @returns Verified local archive path.
 */
export async function downloadPrimaryRuntimeAsset(url: string, sha256: string, cache: string): Promise<string> {
  const destination = join(cache, sha256)
  let bytes: Buffer
  try { bytes = readFileSync(destination) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const response = await fetch(url)
    if (!response.ok) throw new Error(`primary runtime download: ${String(response.status)} ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`primary runtime download: checksum mismatch for ${url}`)
  writeFileSync(destination, bytes)
  return destination
}

async function pythonArchive(target: keyof typeof lock.targets, cache: string): Promise<string> {
  const artifact = lock.targets[target]
  const filename = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
  return downloadPrimaryRuntimeAsset(`https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(filename)}`, artifact.pythonSha256, cache)
}

/**
 * Identify the inputs that assemble one target's payload, excluding unrelated target locks.
 * @param target - Runtime target whose archives are installed.
 * @param runtimeLock - Locked interpreter and wheel inputs.
 * @param pnpmVersion - Package-manager version copied into the payload.
 * @returns SHA-256 payload identity for installation reuse.
 */
export function primaryRuntimePayloadDigest(
  target: keyof typeof lock.targets, runtimeLock: typeof lock, pnpmVersion: string | undefined,
): string {
  const { pythonVersion, pythonRelease, nodeVersion, wheels, pythonPackages } = runtimeLock
  // Identity preserves key order within the selected target, wheel records and distribution map, plus wheel-entry order.
  // Bump format when extraction or assembly changes payload bytes without changing locked inputs.
  return createHash('sha256').update(JSON.stringify({
    format: 4, target, pythonVersion, pythonRelease, nodeVersion: pnpmVersion === undefined ? undefined : nodeVersion,
    artifact: runtimeLock.targets[target], wheels, pythonPackages, pnpm: pnpmVersion,
  })).digest('hex')
}

/**
 * Unpack a locked library wheel, retaining auxiliary scripts in its distribution data directory.
 * @param archive - Hash-verified wheel archive.
 * @param destination - Absolute site-packages directory.
 * @returns Resolves after extraction without command wrappers; rejects other wheel installation schemes.
 */
export async function unpackPrimaryRuntimeWheel(archive: string, destination: string): Promise<void> {
  await extractZip(archive, {
    dir: destination,
    onEntry: (entry) => {
      const [directory, scheme] = entry.fileName.split('/')
      if (directory?.endsWith('.data') && scheme !== '' && scheme !== 'scripts') {
        throw new Error(`primary runtime: wheel requires unsupported installation paths: ${entry.fileName}`)
      }
    },
  })
}

/**
 * Copy the skill package's complete asset tree to ordinary filesystem resources.
 * @param source - The package's assets directory.
 * @param destination - External Office skill resource directory.
 * @returns Resolves after replacing the external assets with the complete package tree.
 */
export async function prepareOfficeSkillAssets(source: string, destination: string): Promise<void> {
  rmSync(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true, dereference: true })
}

/** A locked interpreter and wheel target. */
export type PrimaryRuntimeTarget = keyof typeof lock.targets

/** Build-only inputs shared by Desktop and SDK carriers. */
export interface PreparePrimaryRuntimeOptions {
  /** Target whose archives and wheels are downloaded. */
  readonly target: PrimaryRuntimeTarget
  /** Resource directory receiving primary-runtime/ and office-skills/. */
  readonly output: string
  /** SHA-256-addressed archive cache. */
  readonly cache: string
  /** Carrier release recorded in the legacy desktopVersion manifest field. */
  readonly version: string
  /** Omit Node.js and pnpm for carriers providing only Python. */
  readonly pythonOnly?: boolean
}

/**
 * Materialize locked interpreters, libraries and Office resources without executing target code.
 * @param options - Explicit target and carrier-owned output locations.
 * @returns Resolves after the complete payload and skills have been copied to the output directory.
 */
export async function preparePrimaryRuntime(options: PreparePrimaryRuntimeOptions): Promise<void> {
  const { target } = options
  const paths = { runtime: resolve(options.output), downloads: resolve(options.cache) }
  const artifact = lock.targets[target]
  mkdirSync(paths.runtime, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'dsh-primary-'))
  try {
    const output = join(staging, 'payload')
    const dependencies = join(output, 'dependencies')
    mkdirSync(dependencies, { recursive: true })
    let pnpmVersion: string | undefined
    if (!options.pythonOnly) {
      const nodeFilename = `node-v${lock.nodeVersion}-${artifact.nodeArchive}`
      const nodeArchive = await downloadPrimaryRuntimeAsset(`https://nodejs.org/dist/v${lock.nodeVersion}/${nodeFilename}`, artifact.nodeSha256, paths.downloads)
      const unpackedNode = join(staging, 'node')
      mkdirSync(unpackedNode)
      if (target === 'win-x64') await extractZip(nodeArchive, { dir: unpackedNode })
      else await extractTar({ file: nodeArchive, cwd: unpackedNode })
      const nodeSource = join(unpackedNode, nodeFilename.replace(/\.(?:zip|tar\.gz)$/u, ''))
      mkdirSync(join(dependencies, 'node', 'bin'), { recursive: true })
      mkdirSync(join(dependencies, 'node', 'node_modules'))
      writeFileSync(join(dependencies, 'node', 'node_modules', 'README.txt'), 'Reserved for bundled Node packages. pnpm uses its default installation directories.\n')
      cpSync(join(nodeSource, ...(target === 'win-x64' ? ['node.exe'] : ['bin', 'node'])),
        join(dependencies, 'node', 'bin', target === 'win-x64' ? 'node.exe' : 'node'))
      cpSync(join(nodeSource, 'LICENSE'), join(dependencies, 'node', 'LICENSE'))
      const require = createRequire(import.meta.url)
      const pnpmManifest = require.resolve('pnpm')
      pnpmVersion = (JSON.parse(readFileSync(pnpmManifest, 'utf8')) as { version: string }).version
      await cp(dirname(pnpmManifest), join(dependencies, 'pnpm'), { recursive: true, dereference: true })
    }
    await extractTar({ file: await pythonArchive(target, paths.downloads), cwd: dependencies })
    const manifest: PrimaryRuntimeManifest = {
      desktopVersion: options.version,
      platform: target === 'win-x64' ? 'win32' : target.startsWith('linux-') ? 'linux' : 'darwin',
      arch: target.endsWith('-arm64') ? 'arm64' : 'x64',
      payloadDigest: primaryRuntimePayloadDigest(target, lock, pnpmVersion),
      python: lock.pythonVersion,
      ...(pnpmVersion === undefined ? {} : { node: lock.nodeVersion, pnpm: pnpmVersion }),
      pythonPackages: lock.pythonPackages,
    }
    const entries = workspaceDependencyPaths(output, manifest)
    for (const wheel of [...artifact.wheels, ...lock.wheels]) {
      await unpackPrimaryRuntimeWheel(await downloadPrimaryRuntimeAsset(wheel.url, wheel.sha256, paths.downloads), entries.pythonPackages)
    }
    writeFileSync(join(output, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    const destination = join(paths.runtime, 'primary-runtime')
    rmSync(destination, { recursive: true, force: true })
    await cp(output, destination, { recursive: true, dereference: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  const require = createRequire(import.meta.url)
  await prepareOfficeSkillAssets(join(dirname(require.resolve('@deepseek-ai/dsh-skill-office/package.json')), 'assets'),
    join(paths.runtime, 'office-skills'))
}

/**
 * Execute the native payload's interpreters, package manager and Python libraries.
 * @param root - Final payload directory, including any platform signatures.
 * @param environment - Scrubbed subprocess environment; defaults to excluding credential-shaped names.
 */
export function smokePrimaryRuntime(root: string, environment: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)),
)): void {
  const manifest = parsePrimaryRuntime(JSON.parse(readFileSync(join(root, 'runtime.json'), 'utf8')))
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) return
  if (Object.keys(manifest.pythonPackages).length === 0) throw new Error('primary runtime: missing Python distribution versions; prepare the payload before running its smoke checks.')
  const entries = workspaceDependencyPaths(root, manifest)
  const options = { stdio: 'inherit', timeout: 120_000, env: environment } as const
  execFileSync(entries.python, ['-I', '-B', '-c', 'import decimal, xml.parsers.expat, lzma, uuid, numpy, pandas; assert numpy.arange(4).sum() == 6; assert pandas.DataFrame({"n": [1, 2]}).n.sum() == 3'], options)
  execFileSync(entries.python, ['-I', '-B', join(import.meta.dirname, 'smoke.py'), JSON.stringify(manifest.pythonPackages),
    manifest.python, join(dirname(root), 'office-skills', 'scripts', 'check_office.py')], options)
  execFileSync(entries.python, ['-I', '-B', '-m', 'pip', 'check'], options)
  if (entries.node !== undefined) execFileSync(entries.node, ['-e', `if (process.versions.node !== ${JSON.stringify(manifest.node)}) process.exit(1)`], options)
  if (entries.pnpm !== undefined && entries.node !== undefined) execFileSync(entries.node, [entries.pnpm, '--version'], options)
}

if (import.meta.main) {
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, output: { type: 'string' }, cache: { type: 'string' },
    'python-only': { type: 'boolean', default: false },
  } })
  if (!values.target || !Object.hasOwn(lock.targets, values.target) || !values.output) {
    throw new Error(`Usage: pnpm run prepare:primary-runtime --target <${Object.keys(lock.targets).join('|')}> --output <directory> [--cache <directory>] [--python-only]`)
  }
  const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  const output = resolve(values.output)
  await preparePrimaryRuntime({
    target: values.target as PrimaryRuntimeTarget, output,
    cache: values.cache ?? join(tmpdir(), 'dsh-primary-runtime-downloads'), version,
    pythonOnly: values['python-only'],
  })
  smokePrimaryRuntime(join(output, 'primary-runtime'))
}
