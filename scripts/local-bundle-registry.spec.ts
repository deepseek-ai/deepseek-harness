/** Behavior of the local Official-bundle registry: closure selection, archive validation, HTTP, and shutdown. */

import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'
import { ON_DEMAND_BUNDLES } from '../packages/boot/app-boot/src/official-bundle-packages.ts'
import { generateOfficialBundleCatalog } from './gen-official-bundle-catalog.ts'
import {
  createRegistryManifest,
  hostPlatform,
  pnpmInvocationFor,
  readPackedArtifacts,
  readReleaseMembers,
  readWorkspacePackages,
  selectBundleDependencies,
  packBundleArtifacts,
  startBundleRegistry,
  writeRegistryManifest,
  type BundleArtifact,
  type ReleaseEntry,
  type WorkspacePackage,
} from './local-bundle-registry.ts'
import { releaseFamily, type ReleaseMember } from './release/families.ts'
import { capture } from './release/process.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

/** A private temporary root this spec owns, removed with the test. */
function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  return directory
}

/** One fabricated workspace package with a `1.0.0` version line. */
function workspacePackage(name: string, manifest: Record<string, unknown>): WorkspacePackage {
  return { name, directory: `/workspace/${name.replace('@', '').replace('/', '-')}`, manifest: { name, version: '1.0.0', ...manifest } }
}

/** An inventory of fabricated packages, keyed the way discovery keys them. */
function inventory(...members: WorkspacePackage[]): Map<string, WorkspacePackage> {
  return new Map(members.map(member => [member.name, member]))
}

/** One fabricated package's archive together with the identities needed to read it back. */
interface Fixture {
  readonly member: WorkspacePackage
  readonly entry: ReleaseEntry
}

/**
 * Pack one fabricated package archive into a run directory.
 * @param options - destination, identity, source text, dependency ranges, and an optional declared bundle patch.
 * @returns The workspace identity and the release entry its tarball must satisfy.
 */
function packFixture(options: {
  readonly destination: string
  readonly name: string
  readonly version: string
  readonly source: string
  readonly dependencies?: Record<string, string>
  readonly patch?: string
}): Fixture {
  const staging = join(options.destination, `${options.name.replace('@', '').replace('/', '-')}-staging`)
  const manifest: Record<string, unknown> = {
    name: options.name,
    version: options.version,
    main: 'lib/index.js',
    ...options.dependencies === undefined ? {} : { dependencies: options.dependencies },
    ...options.patch === undefined ? {} : { dsh: { bundle: { patch: options.patch } } },
  }
  mkdirSync(join(staging, 'package', 'lib'), { recursive: true })
  writeFileSync(join(staging, 'package', 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(staging, 'package', 'lib', 'index.js'), options.source)
  if (options.patch !== undefined) writeFileSync(join(staging, 'package', options.patch), '[]\n')
  const file = `${options.name.replace('@', '').replace('/', '-')}-${options.version}.tgz`
  capture('tar', ['-czf', join(options.destination, file), '-C', staging, 'package'])
  const releaseMember: ReleaseMember = { directory: staging, name: options.name, version: options.version, manifest }
  return {
    member: workspacePackage(options.name, { version: options.version, ...manifest }),
    entry: { family: releaseFamily('vendor'), member: releaseMember },
  }
}

/**
 * Pack a fixture archive and read it back through the real archive validation.
 * @param options - the fixture to pack.
 * @returns The servable artifact and the identities it was packed from.
 */
function fabricate(options: Parameters<typeof packFixture>[0]): Fixture & { readonly artifact: BundleArtifact } {
  const fixture = packFixture(options)
  const [artifact] = readPackedArtifacts({
    destination: options.destination,
    members: [fixture.member],
    release: new Map([[fixture.member.name, fixture.entry]]),
  })
  if (artifact === undefined) throw new Error('fabricated artifact was not read back')
  return { ...fixture, artifact }
}

/** Start a registry for one fabricated run, closed with the test. */
async function servingRun(options: {
  readonly destination: string
  readonly artifacts: readonly BundleArtifact[]
  readonly workspaceNames: readonly string[]
}): Promise<string> {
  const registry = await startBundleRegistry({
    directory: options.destination, artifacts: options.artifacts, workspaceNames: options.workspaceNames,
  })
  onTestFinished(() => registry.close())
  return registry.url
}

describe('catalog and local closure', () => {
  it('selects the real catalog closure from this checkout', () => {
    const entries = generateOfficialBundleCatalog(root).map(entry => entry.packageName)
    expect(entries).toEqual([...ON_DEMAND_BUNDLES])
    const packages = readWorkspacePackages(root)
    const release = readReleaseMembers(root)
    const selection = selectBundleDependencies({ entries, packages, platform: hostPlatform() })

    expect(selection.members.map(member => member.name)).toEqual(expect.arrayContaining([...entries]))
    for (const member of selection.members) {
      expect(member.manifest.private, member.name).not.toBe(true)
      expect(release.has(member.name), member.name).toBe(true)
    }
    expect(selection.workspaceNames).toEqual(expect.arrayContaining(selection.members.map(member => member.name)))
    // A vendor package keeps its own version line, so a run must not assume one shared version.
    expect(packages.get('@deepseek-ai/cordis')?.manifest.version)
      .not.toBe(packages.get('@deepseek-ai/dsh-brand')?.manifest.version)
    // Nothing in this closure is built for another platform, on any host.
    expect(selection.foreignTargets).toEqual([])
  })

  it('follows install, optional, and required peer edges but not optional peers', () => {
    const selection = selectBundleDependencies({
      entries: ['@scope/root'],
      packages: inventory(
        workspacePackage('@scope/root', {
          dependencies: { '@scope/required': 'workspace:*' },
          optionalDependencies: { '@scope/optional': 'workspace:*' },
          peerDependencies: { '@scope/peer': 'workspace:*', '@scope/unused-peer': 'workspace:*' },
          peerDependenciesMeta: { '@scope/unused-peer': { optional: true } },
        }),
        workspacePackage('@scope/required', {}),
        workspacePackage('@scope/optional', { dependencies: { '@scope/transitive': 'workspace:*' } }),
        workspacePackage('@scope/peer', {}),
        workspacePackage('@scope/transitive', {}),
        workspacePackage('@scope/unused-peer', {}),
        workspacePackage('@scope/unreferenced', {}),
      ),
      platform: { os: ['darwin'] },
    })
    expect(selection.members.map(member => member.name)).toEqual([
      '@scope/optional', '@scope/peer', '@scope/required', '@scope/root', '@scope/transitive',
    ])
  })

  it('leaves a dependency that is not a workspace package to its own registry', () => {
    const selection = selectBundleDependencies({
      entries: ['@scope/root'],
      packages: inventory(workspacePackage('@scope/root', {
        dependencies: { '@other/external': '^1.0.0', 'plain-external': '^2.0.0' },
      })),
      platform: {},
    })
    expect(selection.members.map(member => member.name)).toEqual(['@scope/root'])
  })

  it('fails when a catalog root is not a workspace package', () => {
    expect(() => selectBundleDependencies({ entries: ['@scope/missing'], packages: inventory(), platform: {} }))
      .toThrow(/cannot resolve workspace package @scope\/missing \(catalog entry @scope\/missing\)/u)
  })

  it('rejects an empty or duplicate catalog', () => {
    expect(() => selectBundleDependencies({ entries: [], packages: inventory(), platform: {} }))
      .toThrow(/no on-demand entries/u)
    expect(() => selectBundleDependencies({ entries: ['@scope/a', '@scope/a'], packages: inventory(), platform: {} }))
      .toThrow(/must be distinct/u)
  })

  it('fails on a required edge that targets another platform, naming the path', () => {
    expect(() => selectBundleDependencies({
      entries: ['@scope/root'],
      packages: inventory(
        workspacePackage('@scope/root', { dependencies: { '@scope/native-win': 'workspace:*' } }),
        workspacePackage('@scope/native-win', { os: ['win32'] }),
      ),
      platform: { os: ['darwin'], cpu: ['arm64'] },
    })).toThrow(/@scope\/root -> @scope\/native-win requires @scope\/native-win, which targets os=win32; this host is os=darwin cpu=arm64/u)
  })

  it('keeps an optional-only foreign-target member and reports it', () => {
    const selection = selectBundleDependencies({
      entries: ['@scope/root'],
      packages: inventory(
        workspacePackage('@scope/root', { optionalDependencies: { '@scope/native-win': 'workspace:*' } }),
        workspacePackage('@scope/native-win', { os: ['win32'] }),
      ),
      platform: { os: ['darwin'] },
    })
    expect(selection.members.map(member => member.name)).toEqual(['@scope/native-win', '@scope/root'])
    expect(selection.foreignTargets).toEqual(['@scope/native-win'])
  })
})

describe('packed archives', () => {
  it('describes exactly the bytes it will serve', () => {
    const destination = temporaryDirectory('dsh-local-registry-archive-')
    const { artifact } = fabricate({ destination, name: '@scope/pkg', version: '1.0.0', source: 'export default 1\n' })
    const bytes = readFileSync(artifact.archive)
    expect(artifact.bytes).toBe(bytes.byteLength)
    expect(artifact.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`)
    expect(artifact.shasum).toBe(createHash('sha1').update(bytes).digest('hex'))
    expect(artifact.file).toBe('scope-pkg-1.0.0.tgz')
    expect(artifact.platform).toEqual({})
    expect(artifact.manifest.version).toBe('1.0.0')
  })

  it('rejects an archive that lacks the main it declares', () => {
    const destination = temporaryDirectory('dsh-local-registry-payload-')
    const staging = join(destination, 'staging')
    mkdirSync(join(staging, 'package'), { recursive: true })
    writeFileSync(join(staging, 'package', 'package.json'), JSON.stringify({
      name: '@scope/pkg', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    capture('tar', ['-czf', join(destination, 'scope-pkg-1.0.0.tgz'), '-C', staging, 'package'])
    const member = workspacePackage('@scope/pkg', { version: '1.0.0' })
    const entry: ReleaseEntry = {
      family: releaseFamily('vendor'), member: { directory: staging, name: '@scope/pkg', version: '1.0.0', manifest: member.manifest },
    }
    expect(() => readPackedArtifacts({ destination, members: [member], release: new Map([['@scope/pkg', entry]]) }))
      .toThrow(/@scope\/pkg: packed archive lacks its declared main lib\/index\.js/u)
  })

  it('rejects a bundle whose patch is missing from its archive', () => {
    const destination = temporaryDirectory('dsh-local-registry-patch-')
    const { member, entry } = packFixture({
      destination, name: '@scope/bundle', version: '1.0.0', source: 'export default 1\n', patch: 'cordis.patch.yml',
    })
    const archive = join(destination, 'scope-bundle-1.0.0.tgz')
    const stripped = join(destination, 'stripped')
    mkdirSync(join(stripped, 'package'), { recursive: true })
    writeFileSync(join(stripped, 'package', 'package.json'), JSON.stringify({
      name: '@scope/bundle', version: '1.0.0', main: 'lib/index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    mkdirSync(join(stripped, 'package', 'lib'), { recursive: true })
    writeFileSync(join(stripped, 'package', 'lib', 'index.js'), 'export default 1\n')
    capture('tar', ['-czf', archive, '-C', stripped, 'package'])
    expect(() => readPackedArtifacts({ destination, members: [member], release: new Map([['@scope/bundle', entry]]) }))
      .toThrow(/@scope\/bundle: packed archive lacks its declared bundle patch cordis\.patch\.yml/u)
  })

  it('reports a preparation stopped by a signal as a cancellation', async () => {
    const destination = temporaryDirectory('dsh-local-registry-cancel-')
    const { member, entry } = packFixture({ destination, name: '@scope/pkg', version: '1.0.0', source: 'export default 1\n' })
    const controller = new AbortController()
    controller.abort()
    await expect(packBundleArtifacts({
      root, destination, members: [member], release: new Map([[member.name, entry]]), signal: controller.signal,
    })).rejects.toThrow(/packing was cancelled/u)
  })

  it('rejects a missing archive and a package that is not a public release member', () => {
    const destination = temporaryDirectory('dsh-local-registry-missing-')
    const missing = workspacePackage('@scope/pkg', { version: '1.0.0' })
    const entry: ReleaseEntry = {
      family: releaseFamily('vendor'), member: { directory: destination, name: '@scope/pkg', version: '1.0.0', manifest: missing.manifest },
    }
    expect(() => readPackedArtifacts({ destination, members: [missing], release: new Map([['@scope/pkg', entry]]) }))
      .toThrow(/@scope\/pkg produced no tarball/u)
    fabricate({ destination, name: '@scope/pkg', version: '1.0.0', source: 'export default 1\n' })
    expect(() => readPackedArtifacts({ destination, members: [missing], release: new Map() }))
      .toThrow(/not a public release member/u)
  })

  it('rejects a packed manifest that keeps a workspace protocol', () => {
    const destination = temporaryDirectory('dsh-local-registry-protocol-')
    const { member, entry } = packFixture({
      destination, name: '@scope/pkg', version: '1.0.0', source: 'export default 1\n',
      dependencies: { '@scope/dependency': 'workspace:*' },
    })
    // The fixture writes the manifest verbatim, so a protocol a real pack rewrites is still observable here.
    expect(() => readPackedArtifacts({ destination, members: [member], release: new Map([['@scope/pkg', entry]]) }))
      .toThrow(/packed dependencies\.@scope\/dependency still declares workspace:\*/u)
  })

  it('rejects a packed local dependency this run does not serve at the required version', () => {
    const destination = temporaryDirectory('dsh-local-registry-version-')
    const consumer = packFixture({
      destination, name: '@scope/pkg', version: '1.0.0', source: 'export default 1\n',
      dependencies: { '@scope/dependency': '^2.0.0' },
    })
    const dependency = packFixture({ destination, name: '@scope/dependency', version: '1.0.0', source: 'export default 2\n' })
    const release = new Map([[consumer.member.name, consumer.entry], [dependency.member.name, dependency.entry]])
    expect(() => readPackedArtifacts({ destination, members: [consumer.member, dependency.member], release }))
      .toThrow(/@scope\/pkg: packed dependencies\.@scope\/dependency requires \^2\.0\.0, but this run serves 1\.0\.0/u)
  })
})

describe('registry HTTP', () => {
  it('answers scoped packuments, version documents, and dist tags for its own artifacts', async () => {
    const destination = temporaryDirectory('dsh-local-registry-http-')
    const { artifact } = fabricate({ destination, name: '@scope/local', version: '1.2.3-alpha.1', source: 'export default 1\n' })
    const url = await servingRun({ destination, artifacts: [artifact], workspaceNames: ['@scope/local', '@scope/absent'] })

    // pnpm encodes the scope separator; an unencoded path names the same package.
    for (const path of ['@scope%2flocal', '@scope/local']) {
      const response = await fetch(`${url}${path}`)
      expect(response.status, path).toBe(200)
      const packument = await response.json() as {
        name: string
        'dist-tags': Record<string, string>
        versions: Record<string, { dist: { tarball: string; integrity: string } }>
        time: Record<string, string>
      }
      expect(packument.name).toBe('@scope/local')
      expect(packument['dist-tags']).toEqual({ latest: '1.2.3-alpha.1', next: '1.2.3-alpha.1' })
      expect(packument.versions['1.2.3-alpha.1']?.dist.tarball).toBe(`${url}tarballs/scope-local-1.2.3-alpha.1.tgz`)
      expect(packument.versions['1.2.3-alpha.1']?.dist.integrity).toBe(artifact.integrity)
      // The only publication time a run can claim is when its own archives were packed.
      expect(packument.time['1.2.3-alpha.1']).toBe(artifact.packedAt)
    }
    for (const path of ['@scope%2flocal/1.2.3-alpha.1', '@scope/local/latest', '@scope/local/next']) {
      const response = await fetch(`${url}${path}`)
      expect(response.status, path).toBe(200)
      expect(await response.json()).toMatchObject({ name: '@scope/local', version: '1.2.3-alpha.1' })
    }
    const unknown = await fetch(`${url}@scope%2flocal/9.9.9`)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ reason: 'this run serves @scope/local@1.2.3-alpha.1 only' })
  })

  it('serves exactly the archived bytes, and no body for HEAD', async () => {
    const destination = temporaryDirectory('dsh-local-registry-tarball-')
    const { artifact } = fabricate({ destination, name: '@scope/local', version: '1.0.0', source: 'export default 1\n' })
    const url = await servingRun({ destination, artifacts: [artifact], workspaceNames: ['@scope/local'] })
    const response = await fetch(`${url}tarballs/${artifact.file}`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(artifact.archive))
    const head = await fetch(`${url}tarballs/${artifact.file}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(artifact.bytes))
    expect(await head.text()).toBe('')
    expect((await fetch(`${url}tarballs/no-such-package-1.0.0.tgz`)).status).toBe(404)
  })

  it('keeps a repository-owned miss local and redirects only external packages', async () => {
    const destination = temporaryDirectory('dsh-local-registry-miss-')
    const { artifact } = fabricate({ destination, name: '@scope/local', version: '1.0.0', source: 'export default 1\n' })
    const url = await servingRun({
      destination, artifacts: [artifact], workspaceNames: ['@scope/local', '@deepseek-ai/dsh-private-thing'],
    })
    const owned = await fetch(`${url}@deepseek-ai%2fdsh-private-thing`)
    expect(owned.status).toBe(404)
    const refusal = await owned.json() as { reason?: string }
    expect(refusal.reason ?? '').toContain('repository-owned')
    // A repository-owned name that is not even in the closure must never reach npm.
    expect((await fetch(`${url}@deepseek-ai%2fdsh-private-thing/1.0.0`)).status).toBe(404)

    const external = await fetch(`${url}@anthropic-ai%2fclaude-agent-sdk`, { redirect: 'manual' })
    expect(external.status).toBe(302)
    expect(external.headers.get('location')).toBe('https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk')
  })

  it('keeps serving after a client abandons a tarball request', async () => {
    const destination = temporaryDirectory('dsh-local-registry-disconnect-')
    const { artifact } = fabricate({ destination, name: '@scope/local', version: '1.0.0', source: 'export default 1\n' })
    const url = await servingRun({ destination, artifacts: [artifact], workspaceNames: ['@scope/local'] })
    const { port, pathname } = new URL(url)
    const socket = connect(Number(port), '127.0.0.1')
    await new Promise<void>((resolveConnect, rejectConnect) => {
      socket.once('connect', resolveConnect)
      socket.once('error', rejectConnect)
    })
    socket.write(`GET ${pathname}tarballs/${artifact.file} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`)
    await new Promise<void>((resolveData) => { socket.once('data', () => { resolveData() }) })
    socket.destroy()
    const response = await fetch(`${url}@scope%2flocal`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ name: '@scope/local' })
  })

  it('rejects out-of-namespace, malformed, and non-GET requests, then stops listening', async () => {
    const destination = temporaryDirectory('dsh-local-registry-reject-')
    const { artifact } = fabricate({ destination, name: '@scope/local', version: '1.0.0', source: 'export default 1\n' })
    const registry = await startBundleRegistry({ directory: destination, artifacts: [artifact], workspaceNames: ['@scope/local'] })
    onTestFinished(() => registry.close())
    const { origin, pathname } = new URL(registry.url)

    expect((await fetch(`${origin}/@scope%2flocal`)).status).toBe(404)
    expect((await fetch(`${origin}${pathname}%zz`)).status).toBe(404)
    expect((await fetch(`${registry.url}@scope%2flocal/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status).toBe(404)
    expect((await fetch(`${registry.url}@scope%2flocal/1.0.0/extra`)).status).toBe(404)
    expect((await fetch(`${registry.url}tarballs/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)).status).toBe(404)
    expect((await fetch(`${registry.url}-/ping`)).status).toBe(404)
    expect((await fetch(registry.url, { method: 'POST', body: 'x' })).status).toBe(405)

    const other = await startBundleRegistry({ directory: destination, artifacts: [artifact], workspaceNames: ['@scope/local'] })
    onTestFinished(() => other.close())
    expect(other.url).not.toBe(registry.url)
    await registry.close()
    await expect(fetch(`${registry.url}@scope%2flocal`)).rejects.toThrow()
  })
})

describe('run record', () => {
  it('names the run, its membership, and the integrity of every served archive', async () => {
    const destination = temporaryDirectory('dsh-local-registry-manifest-')
    const { artifact } = fabricate({ destination, name: '@scope/local', version: '1.0.0', source: 'export default 1\n' })
    const manifest = createRegistryManifest({
      buildId: 'run-1',
      source: { commit: 'a'.repeat(40), dirty: true, dshVersion: '0.0.0-test' },
      entries: ['@scope/local'],
      workspaceNames: ['@scope/local', '@scope/absent'],
      artifacts: [artifact],
    })
    expect(manifest).toEqual({
      schemaVersion: 1,
      buildId: 'run-1',
      source: { commit: 'a'.repeat(40), dirty: true, dshVersion: '0.0.0-test' },
      entries: ['@scope/local'],
      workspaceNames: ['@scope/local', '@scope/absent'],
      packages: [{ name: '@scope/local', version: '1.0.0', file: artifact.file, bytes: artifact.bytes, integrity: artifact.integrity }],
    })
    const path = join(destination, 'bundle-registry.json')
    await writeRegistryManifest(path, manifest)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(manifest)
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true)
  })
})

/**
 * Run one pnpm command in a profile-shaped directory, terminating and awaiting it with the test.
 * @param options - consumer directory, environment, the store and cache directories an installing
 *   command shares, and the arguments to append.
 * @returns The settled child result.
 */
async function pnpmIn(options: {
  readonly consumer: string
  readonly environment: NodeJS.ProcessEnv
  readonly store?: string
  readonly cache?: string
  readonly args: readonly string[]
}): Promise<{ exitCode?: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const invocation = pnpmInvocationFor([
    ...options.args,
    ...options.store === undefined ? [] : ['--store-dir', options.store],
    ...options.cache === undefined ? [] : ['--cache-dir', options.cache],
    '--config.fetch-retries=0',
  ])
  const child = execa(invocation.command, invocation.args, {
    cwd: options.consumer, env: options.environment, extendEnv: false, reject: false, timeout: 240_000,
  })
  onTestFinished(async () => {
    child.kill('SIGKILL')
    await child.catch(() => undefined)
  })
  return child
}

/** Prepare one isolated profile-shaped consumer directory. */
function consumerDirectory(parent: string, name: string): string {
  const consumer = join(parent, name)
  mkdirSync(consumer, { recursive: true })
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name, private: true, dependencies: {} }))
  writeFileSync(join(consumer, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  return consumer
}

/** The payload a consumer's installed fixture carries, or a marker when nothing is installed. */
function installedPayload(consumer: string): string {
  try { return readFileSync(join(consumer, 'node_modules', '@dsh-local', 'fixture', 'lib', 'index.js'), 'utf8').trim() }
  catch { return '(absent)' }
}

describe('package cache freshness', () => {
  it('installs a rebuilt archive at the same version through a retained pnpm store', { timeout: 300_000 }, async () => {
    const temporary = temporaryDirectory('dsh-local-registry-cache-')
    const store = join(temporary, 'store')
    const cache = join(temporary, 'cache')
    const userConfig = join(temporary, 'empty.npmrc')
    writeFileSync(userConfig, '')
    // A retained store, metadata cache, and npm configuration, so the second installation cannot pass by starting empty.
    const environment = { ...process.env, npm_config_userconfig: userConfig }

    const install = async (run: string, source: string): Promise<{ payload: string; settings: string }> => {
      const destination = join(temporary, run, 'artifacts')
      mkdirSync(destination, { recursive: true })
      const { artifact } = fabricate({ destination, name: '@dsh-local/fixture', version: '1.0.0', source })
      const registry = await startBundleRegistry({
        directory: destination, artifacts: [artifact], workspaceNames: ['@dsh-local/fixture'],
      })
      onTestFinished(() => registry.close())
      const consumer = consumerDirectory(temporary, `consumer-${run}`)
      const result = await pnpmIn({
        consumer, environment, store, cache,
        args: ['add', '@dsh-local/fixture@1.0.0', `--registry=${registry.url}`],
      })
      expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false)
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0)
      await registry.close()
      return { payload: installedPayload(consumer), settings: readFileSync(join(consumer, 'pnpm-workspace.yaml'), 'utf8') }
    }

    const first = await install('first', 'export default "first build"\n')
    expect(first.payload).toContain('first build')
    // pnpm 11's default minimumReleaseAge is 24 hours, and its non-strict mode records the exemption it granted
    // instead of faking an older publication time for a locally packed artifact.
    expect(first.settings).toContain('minimumReleaseAgeExclude')
    expect(first.settings).toContain('@dsh-local/fixture@1.0.0')

    const second = await install('second', 'export default "second build"\n')
    expect(second.payload).toContain('second build')
  })
})

describe('same-version iteration', () => {
  it('needs the earlier run\'s stale resolution cleared before a new run at the same version installs', { timeout: 300_000 }, async () => {
    const temporary = temporaryDirectory('dsh-local-registry-iteration-')
    const store = join(temporary, 'store')
    const userConfig = join(temporary, 'empty.npmrc')
    writeFileSync(userConfig, '')
    const environment = { ...process.env, npm_config_userconfig: userConfig }
    const consumer = consumerDirectory(temporary, 'profile')
    const serve = async (tag: string, payload: string) => {
      const destination = join(temporary, tag)
      mkdirSync(destination, { recursive: true })
      const { artifact } = fabricate({ destination, name: '@dsh-local/fixture', version: '1.0.0', source: `export default ${payload}\n` })
      return startBundleRegistry({ directory: destination, artifacts: [artifact], workspaceNames: ['@dsh-local/fixture'] })
    }
    const add = (url: string) => pnpmIn({ consumer, environment, store, args: ['add', '@dsh-local/fixture@1.0.0', `--registry=${url}`] })

    const first = await serve('run-a', '"A"')
    expect((await add(first.url)).exitCode).toBe(0)
    expect(installedPayload(consumer)).toContain('"A"')
    await first.close()

    // A new run answers at a new URL, so the recorded tarball no longer verifies against it.
    const second = await serve('run-b', '"B"')
    onTestFinished(() => second.close())
    const refused = await add(second.url)
    expect(refused.exitCode).not.toBe(0)
    expect(`${refused.stdout}${refused.stderr}`).toContain('ERR_PNPM_TARBALL_URL_MISMATCH')
    expect(installedPayload(consumer)).toContain('"A"')

    // pnpm's own remedy for that error: drop the stale resolution, then resolve again from the new run.
    const cleaned = await pnpmIn({ consumer, environment, args: ['clean', '--lockfile'] })
    expect(cleaned.exitCode, `${cleaned.stdout}\n${cleaned.stderr}`).toBe(0)
    const reinstalled = await add(second.url)
    expect(reinstalled.exitCode, `${reinstalled.stdout}\n${reinstalled.stderr}`).toBe(0)
    expect(installedPayload(consumer)).toContain('"B"')
  })
})
