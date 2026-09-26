/** Verify identity and update configuration from an extracted installer payload, not a neighboring unpacked build. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'
import { readAsar, type Node as AsarNode } from 'app-builder-lib/out/asar/asar.js'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'
import { verifyInstalledUpdateApplication } from './prepare-installed-update-application.ts'
import { inventoryDesktopRuntime, readDesktopRuntime, runtimePath, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { resolveDesktopPolicyConfig } from '../src/mandatory-update-policy.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { extractAll } = builderRequire('@electron/asar') as { extractAll: (archive: string, destination: string) => void }
const { createTransformer } = builderRequire('app-builder-lib/out/fileTransformer.js') as {
  createTransformer: (source: string, configuration: object, metadata: null) =>
  (file: string) => string | null | Promise<string | null>
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('installed update: invalid package metadata')
  return value as Record<string, unknown>
}

/**
 * Check the actual payload's ASAR, bundled runtime, private identity, feed, cache, and publisher metadata.
 * @param manifest Retained qualification manifest.
 * @param version Exact selected version.
 * @param payload Extracted installer payload in a private verification directory.
 * @param publisher Expected DN derived from the public release certificate.
 * @returns Content observations only; signatures, installation, and restart are separate checks.
 */
export async function verifyInstalledUpdatePackageContent(manifest: string, version: string, payload: string, publisher: string) {
  const run = await readInstalledUpdateRun(manifest)
  if (!run.versions.includes(version)) throw new Error('installed update: payload version is outside the run')
  await verifyInstalledUpdateApplication(run.root)
  const archive = await readAsar(join(payload, 'resources/app.asar'))
  const metadata = object(await archive.readJson('package.json'))
  const policy = resolveDesktopPolicyConfig(metadata.dshMandatoryUpdatePolicy)
  if (metadata.name !== `dsh-update-test-${run.id}` || metadata.version !== version
    || metadata.dshDesktopAppId !== run.appId || metadata.main !== 'qualification-bootstrap.mjs'
    || metadata.type !== 'module' || policy?.authentication !== 'feishu-test') {
    throw new Error('installed update: packaged application identity, version, entry, or policy differs')
  }
  const inventory = JSON.parse(await readFile(join(run.root, 'application/result.json'), 'utf8')) as {
    files: { path: string; sha256: string }[]
  }
  const expectedPaths = new Set(inventory.files.map(file => file.path))
  const inspect = (node: AsarNode, path = ''): void => {
    if (path === 'node_modules' || path === 'package.json') return
    if (node.link !== undefined || (node.unpacked === true && !path.startsWith('dsh/'))) {
      throw new Error('installed update: application archive contains external entries')
    }
    if (node.files !== undefined) {
      for (const [name, child] of Object.entries(node.files)) {
        if (name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/u.test(name)) {
          throw new Error('installed update: application archive contains an unsafe path')
        }
        inspect(child, path === '' ? name : `${path}/${name}`)
      }
    } else if (!path.startsWith('dsh/') && !expectedPaths.has(path)) {
      throw new Error('installed update: application archive contains additional files')
    }
  }
  inspect(archive.header)
  if (archive.header.files?.dsh?.files === undefined) throw new Error('installed update: application archive lacks the dsh runtime')
  for (const file of inventory.files) {
    const path = file.path.split('/').join(process.platform === 'win32' ? '\\' : '/')
    const node = archive.getFile(path, false)
    if (node.link !== undefined || node.unpacked === true
      || createHash('sha256').update(await archive.readFile(path)).digest('hex') !== file.sha256) {
      throw new Error('installed update: packaged application file differs from frozen inputs')
    }
  }
  const dependencies = []
  for (const name of ['electron-updater', 'semver']) {
    const actual = object(await archive.readJson(join('node_modules', name, 'package.json')))
    const expected = object(JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8')))
    if (actual.name !== name || actual.version !== expected.version) throw new Error('installed update: packaged updater dependency differs from verification tools')
    dependencies.push({ name, version: actual.version })
  }
  const update = object(load(await readFile(join(payload, 'resources/app-update.yml'), 'utf8')))
  const url = `${run.origin}/${run.feedKey.slice(0, -'nightly.yml'.length)}`
  if (update.provider !== 'generic' || update.url !== url || update.channel !== 'nightly'
    || update.updaterCacheDirName !== `dsh-update-test-${run.id}-updater`
    || !Array.isArray(update.publisherName) || update.publisherName.length !== 1 || update.publisherName[0] !== publisher) {
    throw new Error('installed update: packaged feed, cache identity, channel, or publisher differs')
  }
  const extracted = await mkdtemp(join(dirname(payload), 'asar-'))
  extractAll(join(payload, 'resources/app.asar'), extracted)
  const prepared = await verifyDesktopRuntime(join(run.root, version, 'dsh'), version, { platform: 'win32', arch: 'x64' })
  const runtime = readDesktopRuntime(join(extracted, 'dsh'))
  if (JSON.stringify(runtime.release) !== JSON.stringify(prepared.release)
    || JSON.stringify(runtime.sharedPackages) !== JSON.stringify(prepared.sharedPackages)
    || JSON.stringify(runtime.files.map(file => file.path)) !== JSON.stringify(prepared.files.map(file => file.path))) {
    throw new Error('installed update: packaged runtime does not describe the prepared release')
  }
  const actualFiles = inventoryDesktopRuntime(join(extracted, 'dsh'))
  if (JSON.stringify(actualFiles.map(file => file.path)) !== JSON.stringify(prepared.files.map(file => file.path))) {
    throw new Error('installed update: packaged runtime file list differs from prepared inputs')
  }
  const transform = createTransformer('', {}, null)
  for (const [index, file] of prepared.files.entries()) {
    if (file.path.endsWith('.exe')) continue
    if (runtime.files[index]!.sha256 !== file.sha256 || runtime.files[index]!.bytes !== file.bytes) {
      throw new Error('installed update: non-executable runtime descriptor differs from prepared inputs')
    }
    const transformed = file.path.startsWith('node_modules/') && file.path.endsWith('/package.json')
      ? await transform(runtimePath(join(run.root, version, 'dsh'), file.path)) : null
    const bytes = transformed === null ? file.bytes : Buffer.byteLength(transformed)
    const hash = transformed === null ? file.sha256 : createHash('sha256').update(transformed).digest('hex')
    if (actualFiles[index]!.sha256 !== hash || actualFiles[index]!.bytes !== bytes) {
      throw new Error('installed update: non-executable runtime bytes differ from prepared inputs')
    }
  }
  return { version, appId: run.appId, applicationFiles: inventory.files.length, dependencies, dependenciesFrozen: false,
    runtimeFiles: runtime.files.length, feedUrl: `${run.origin}/${run.feedKey}`, installed: false,
    resignedExecutables: runtime.files.filter(file => file.path.endsWith('.exe')).map((file) => {
      if (archive.getFile(join('dsh', file.path), false).unpacked !== true) {
        throw new Error('installed update: executable runtime file must be outside ASAR')
      }
      return join(payload, 'resources/app.asar.unpacked/dsh', file.path)
    }) }
}
