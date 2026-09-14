/** Build, publish, and verify one commit-addressed npm workspace baseline. */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { discoverNpmBaselineManifests } from './npm-baseline-packages.ts'
import { validateTarballPayload } from './publication-payload.ts'

const DEFAULT_REGISTRY = 'https://registry.npm.harnessment.com'
const DEFAULT_OUTPUT_DIRECTORY = '.artifacts/npm-baseline'
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const
const RELEASE_MANIFEST_NAME = 'manifest.json'
const RELEASE_ENTRY_PACKAGE = '@deepseek-ai/dsh'
const LATEST_DIST_TAG = 'latest'
const POSIX_WEB_PROBE = String.raw`
import errno, os, pty, select, signal, sys, time
node, bin_path, cwd, timeout_seconds = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, bin_path, "web", "--no-open", "--host", "127.0.0.1", "--port", "0"], os.environ.copy())

output = bytearray()
ready_seen = False
termination_sent = False
deadline = time.monotonic() + float(timeout_seconds)
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)

    snapshot = bytes(output)
    if not termination_sent and b"dsh web: http://127.0.0.1:" in snapshot:
        ready_seen = True
        os.kill(pid, signal.SIGTERM)
        termination_sent = True

    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if not ready_seen:
    sys.stderr.write("installed dsh web did not reach its ready URL\n")
    sys.exit(124)
actual_exit = os.waitstatus_to_exitcode(status)
if actual_exit != 0:
    sys.stderr.write(f"installed dsh web exited {actual_exit}, expected 0\n")
    sys.exit(125)
`

interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

interface PackageTarget {
  name: string
  directory: string
  origin: PackageOrigin
}

type PackageOrigin = 'harness' | 'vendor'

interface PackedPackage {
  name: string
  tarball: string
  sha256: string
  integrity: string
  origin: PackageOrigin
}

interface ReleaseManifest {
  schemaVersion: 1
  commit: string
  version: string
  distTag: string
  registry: string
  packages: PackedPackage[]
}

interface PackOptions {
  ref: string
  registry: string
  outputDirectory: string
}

/** Fixes the identity of one pack attempt before any expensive work begins. */
class BaselinePackPlan {
  constructor(
    readonly commit: string,
    readonly shortCommit: string,
    readonly timestamp: string,
    readonly baseVersion: string,
    readonly version: string,
    readonly distTag: string,
    readonly registry: string,
    readonly artifactDirectory: string,
  ) {}

  async confirm(assumeYes: boolean): Promise<void> {
    console.log('publish-npm-baseline: planned pack')
    console.log(`  commit:    ${this.commit}`)
    console.log(`  timestamp: ${this.timestamp} UTC`)
    console.log(`  version:   ${this.version}`)
    console.log(`  dist-tag:  ${this.distTag}`)
    console.log(`  registry:  ${this.registry}`)
    console.log(`  output:    ${this.artifactDirectory}`)
    if (assumeYes) return
    await confirmEnter(
      'Press Enter to start packing or type anything to cancel: ',
      'pack requires an interactive terminal or --yes',
      'pack cancelled',
    )
  }
}

/** Runs child processes without involving a command shell. */
class CommandRunner {
  run(
    command: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv = process.env,
  ): void {
    const result = spawnSync(command, args, { cwd, env: environment, stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`${formatCommand(command, args)} exited with status ${String(result.status)}`)
    }
  }

  capture(
    command: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv = process.env,
  ): string {
    const result = this.result(command, args, cwd, environment)
    if (result.status !== 0) throw commandFailure(command, args, result)
    return result.stdout.trim()
  }

  result(
    command: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv = process.env,
  ): CommandResult {
    const result: SpawnSyncReturns<string> = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    })
    if (result.error !== undefined) throw result.error
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }
}

/** Owns a temporary detached worktree and removes it after staging. */
class DetachedWorktree {
  private constructor(
    readonly path: string,
    private readonly temporaryRoot: string,
    private readonly repositoryRoot: string,
    private readonly runner: CommandRunner,
  ) {}

  static create(repositoryRoot: string, commit: string, runner: CommandRunner): DetachedWorktree {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-npm-baseline-'))
    const path = join(temporaryRoot, 'worktree')
    try {
      runner.run('git', ['worktree', 'add', '--detach', path, commit], repositoryRoot)
      return new DetachedWorktree(path, temporaryRoot, repositoryRoot, runner)
    } catch (error: unknown) {
      rmSync(temporaryRoot, { recursive: true, force: true })
      throw error
    }
  }

  dispose(): void {
    const result = this.runner.result(
      'git',
      ['worktree', 'remove', '--force', this.path],
      this.repositoryRoot,
    )
    if (result.status !== 0) {
      console.error(`publish-npm-baseline: could not remove worktree ${this.path}`)
      if (result.stderr.trim() !== '') console.error(result.stderr.trim())
    }
    rmSync(this.temporaryRoot, { recursive: true, force: true })
  }
}

/** Discovers and stages every package published in one repository baseline. */
class WorkspacePackageSet {
  private constructor(
    readonly packages: PackageTarget[],
    readonly baseVersion: string,
  ) {}

  static discover(root: string): WorkspacePackageSet {
    const manifestPaths = discoverNpmBaselineManifests(root)
    if (manifestPaths.length === 0) {
      throw new Error('no package manifests found under vendor/, packages/, or apps/')
    }

    const packages: PackageTarget[] = []
    const names = new Set<string>()
    const baseVersion = expectString(readObject(resolve(root, 'package.json')), 'version', 'package.json')
    if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
      throw new Error(`package.json must have a stable X.Y.Z version, got ${baseVersion}`)
    }
    for (const manifestPath of manifestPaths) {
      const manifest = readObject(resolve(root, manifestPath))
      const name = expectString(manifest, 'name', manifestPath)
      const version = expectString(manifest, 'version', manifestPath)
      const isVendored = manifestPath.startsWith('vendor/')
      // Vendored packages are rescoped too (vendor/README.md), so publication
      // never carries an upstream name that would squat it on the registry.
      if (!name.startsWith('@deepseek-ai/')) {
        throw new Error(`${manifestPath} must name an @deepseek-ai package`)
      }
      if (name === '@deepseek-ai/dsh-root') {
        throw new Error(`${manifestPath} unexpectedly selected the workspace root`)
      }
      if (names.has(name)) throw new Error(`duplicate package name: ${name}`)
      if (!isVendored && version !== baseVersion) {
        throw new Error(`${manifestPath} has version ${version}; expected ${baseVersion}`)
      }
      names.add(name)
      packages.push({
        name,
        directory: dirname(manifestPath),
        origin: isVendored ? 'vendor' : 'harness',
      })
    }
    packages.sort((left, right) => left.name.localeCompare(right.name))
    return new WorkspacePackageSet(packages, baseVersion)
  }

  stage(root: string, releaseVersion: string): void {
    const internalNames = new Set(this.packages.map(pkg => pkg.name))
    for (const target of this.packages) {
      const manifestPath = resolve(root, target.directory, 'package.json')
      const manifest = readObject(manifestPath)
      manifest.version = releaseVersion
      delete manifest.private
      stageInternalDependencies(manifest, internalNames, releaseVersion, manifestPath)
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
  }
}

/** Immutable local release bundle consumed by publish and verify. */
class ReleaseBundle {
  private constructor(
    readonly directory: string,
    readonly manifest: ReleaseManifest,
  ) {}

  static create(
    directory: string,
    expectedPackages: PackageTarget[],
    commit: string,
    version: string,
    distTag: string,
    registry: string,
    runner: CommandRunner,
  ): ReleaseBundle {
    const internalNames = new Set(expectedPackages.map(pkg => pkg.name))
    const expectedByName = new Map(expectedPackages.map(pkg => [pkg.name, pkg]))
    const missingNames = new Set(internalNames)
    const packages = readdirSync(directory)
      .filter(name => name.endsWith('.tgz'))
      .sort()
      .map((tarball) => {
        const artifact = inspectTarball(resolve(directory, tarball), runner)
        const expected = expectedByName.get(artifact.name)
        if (expected === undefined || !missingNames.delete(artifact.name)) {
          throw new Error(`unexpected or duplicate packed package: ${artifact.name}`)
        }
        if (expected.origin === 'harness') {
          validateTarballPayload(artifact.files, tarball)
        }
        if (artifact.version !== version) {
          throw new Error(`${tarball} has version ${artifact.version}; expected ${version}`)
        }
        if (artifact.private === true) throw new Error(`${tarball} is still private`)
        if (containsWorkspaceProtocol(artifact.manifest)) {
          throw new Error(`${tarball} still contains a workspace: dependency`)
        }
        validateInternalDependencyPins(artifact.manifest, internalNames, version, tarball)
        return packedPackage(artifact.name, resolve(directory, tarball), expected.origin)
      })
      .sort((left, right) => left.name.localeCompare(right.name))

    if (missingNames.size !== 0) {
      throw new Error(`missing tarballs for: ${[...missingNames].sort().join(', ')}`)
    }
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      commit,
      version,
      distTag,
      registry,
      packages,
    }
    writeFileSync(resolve(directory, RELEASE_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
    writeFileSync(
      resolve(directory, 'SHA256SUMS'),
      `${packages.map(pkg => `${pkg.sha256}  ${pkg.tarball}`).join('\n')}\n`,
    )
    return new ReleaseBundle(directory, manifest)
  }

  static load(manifestPath: string, runner: CommandRunner): ReleaseBundle {
    const absoluteManifestPath = resolve(manifestPath)
    const raw = readObject(absoluteManifestPath)
    if (raw.schemaVersion !== 1) {
      throw new Error(`unsupported release manifest schema: ${String(raw.schemaVersion)}`)
    }
    const directory = dirname(absoluteManifestPath)
    const packageValues = raw.packages
    if (!Array.isArray(packageValues) || packageValues.length === 0) {
      throw new Error('release manifest contains no packages')
    }
    const packages = packageValues.map((value, index) => parsePackedPackage(value, index))
    const names = new Set<string>()
    for (const pkg of packages) {
      if (names.has(pkg.name)) throw new Error(`duplicate package in release manifest: ${pkg.name}`)
      names.add(pkg.name)
    }
    const manifest: ReleaseManifest = {
      schemaVersion: 1,
      commit: expectString(raw, 'commit', RELEASE_MANIFEST_NAME),
      version: expectString(raw, 'version', RELEASE_MANIFEST_NAME),
      distTag: expectString(raw, 'distTag', RELEASE_MANIFEST_NAME),
      registry: normalizeRegistry(expectString(raw, 'registry', RELEASE_MANIFEST_NAME)),
      packages,
    }
    const bundle = new ReleaseBundle(directory, manifest)
    bundle.verifyLocal(runner)
    return bundle
  }

  private verifyLocal(runner: CommandRunner): void {
    const internalNames = new Set(this.manifest.packages.map(pkg => pkg.name))
    for (const pkg of this.manifest.packages) {
      if (isAbsolute(pkg.tarball) || dirname(pkg.tarball) !== '.' || normalize(pkg.tarball) !== pkg.tarball) {
        throw new Error(`invalid tarball path for ${pkg.name}: ${pkg.tarball}`)
      }
      const path = resolve(this.directory, pkg.tarball)
      const actual = packedPackage(pkg.name, path, pkg.origin)
      if (actual.sha256 !== pkg.sha256 || actual.integrity !== pkg.integrity) {
        throw new Error(`tarball checksum mismatch: ${pkg.tarball}`)
      }
      const artifact = inspectTarball(path, runner)
      if (pkg.origin === 'harness') {
        validateTarballPayload(artifact.files, pkg.tarball)
      }
      if (artifact.name !== pkg.name || artifact.version !== this.manifest.version) {
        throw new Error(`tarball identity mismatch: ${pkg.tarball}`)
      }
      if (artifact.private === true) throw new Error(`${pkg.tarball} is still private`)
      if (containsWorkspaceProtocol(artifact.manifest)) {
        throw new Error(`${pkg.tarball} still contains a workspace: dependency`)
      }
      validateInternalDependencyPins(
        artifact.manifest,
        internalNames,
        this.manifest.version,
        pkg.tarball,
      )
    }
  }

  tarballPath(pkg: PackedPackage): string {
    return resolve(this.directory, pkg.tarball)
  }
}

/** Installs one complete bundle outside the workspace and probes the shipped dsh entry. */
class InstalledBundleSmoke {
  constructor(
    private readonly bundle: ReleaseBundle,
    private readonly runner: CommandRunner,
  ) {}

  run(): void {
    const consumerRoot = mkdtempSync(join(tmpdir(), 'dsh-npm-consumer-'))
    try {
      const dependencies = Object.fromEntries(this.bundle.manifest.packages.map(pkg => [
        pkg.name,
        pathToFileURL(this.bundle.tarballPath(pkg)).href,
      ]))
      writeFileSync(resolve(consumerRoot, 'package.json'), `${JSON.stringify({
        name: 'dsh-npm-baseline-consumer',
        version: '0.0.0',
        private: true,
        dependencies,
      }, null, 2)}\n`)

      console.log(
        `publish-npm-baseline: installing ${this.bundle.manifest.packages.length} local tarballs`,
      )
      this.runner.run('npm', [
        'install',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        `--registry=${this.bundle.manifest.registry}`,
      ], consumerRoot, npmClientEnvironment())

      const bin = resolve(consumerRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
      assertPathWithin(consumerRoot, bin, 'installed dsh bin')
      const environment = installedArtifactEnvironment(consumerRoot)
      const version = this.runner.capture(
        process.execPath,
        [bin, '--version'],
        consumerRoot,
        environment,
      )
      if (version !== this.bundle.manifest.version) {
        throw new Error(
          `installed dsh --version returned ${JSON.stringify(version)}; `
          + `expected ${this.bundle.manifest.version}`,
        )
      }
      this.probeWeb(bin, consumerRoot, environment)
      console.log('publish-npm-baseline: installed dsh entry and Web startup probes passed')
    } finally {
      rmSync(consumerRoot, { recursive: true, force: true })
    }
  }

  private probeWeb(bin: string, consumerRoot: string, environment: NodeJS.ProcessEnv): void {
    if (process.platform === 'win32') {
      throw new Error('installed dsh Web probe requires a POSIX host with python3')
    }
    const result = this.runner.result(
      'python3',
      ['-c', POSIX_WEB_PROBE, process.execPath, bin, consumerRoot, '60'],
      consumerRoot,
      environment,
    )
    if (result.status !== 0) {
      throw commandFailure('python3', ['installed-dsh-web-probe'], result)
    }
  }
}

/** Builds a release bundle without mutating the caller's checkout. */
class BaselinePackager {
  constructor(
    private readonly repositoryRoot: string,
    private readonly runner: CommandRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  plan(options: PackOptions): BaselinePackPlan {
    const timestamp = formatUtcTimestamp(this.now())
    const registry = normalizeRegistry(options.registry)
    const commit = this.runner.capture(
      'git',
      ['rev-parse', '--verify', `${options.ref}^{commit}`],
      this.repositoryRoot,
    )
    const shortCommit = this.runner.capture(
      'git',
      ['rev-parse', '--short=10', commit],
      this.repositoryRoot,
    )
    const rootManifest = parseObject(
      this.runner.capture('git', ['show', `${commit}:package.json`], this.repositoryRoot),
      `${commit}:package.json`,
    )
    const baseVersion = expectString(rootManifest, 'version', `${commit}:package.json`)
    validateBaseVersion(baseVersion, `${commit}:package.json`)
    const version = `${baseVersion}-${timestamp}-${shortCommit}`
    const distTag = `dev-${baseVersion}`
    validateDistTag(distTag)
    const artifactDirectory = resolve(options.outputDirectory, version)
    if (existsSync(artifactDirectory)) {
      throw new Error(`output already exists: ${artifactDirectory}`)
    }
    return new BaselinePackPlan(
      commit,
      shortCommit,
      timestamp,
      baseVersion,
      version,
      distTag,
      registry,
      artifactDirectory,
    )
  }

  pack(plan: BaselinePackPlan): ReleaseBundle {
    const { artifactDirectory } = plan
    if (existsSync(artifactDirectory)) {
      throw new Error(`output already exists: ${artifactDirectory}`)
    }
    const worktree = DetachedWorktree.create(this.repositoryRoot, plan.commit, this.runner)
    let createdArtifactDirectory = false
    try {
      const packageSet = WorkspacePackageSet.discover(worktree.path)
      if (packageSet.baseVersion !== plan.baseVersion) {
        throw new Error(
          `workspace package version ${packageSet.baseVersion} does not match root version `
          + `${plan.baseVersion} at ${plan.commit}`,
        )
      }

      console.log(`publish-npm-baseline: installing detached worktree ${plan.shortCommit}`)
      this.runner.run('pnpm', ['install', '--frozen-lockfile'], worktree.path)
      this.runner.run('pnpm', ['run', 'constraints'], worktree.path)
      packageSet.stage(worktree.path, plan.version)
      mkdirSync(artifactDirectory, { recursive: true })
      createdArtifactDirectory = true

      console.log(
        `publish-npm-baseline: building ${packageSet.packages.length} packages as ${plan.version}`,
      )
      this.runner.run('pnpm', ['run', 'build'], worktree.path)
      this.runner.run('pnpm', ['run', 'publint'], worktree.path)
      this.runner.run('pnpm', ['run', 'verify-built-package-invariants'], worktree.path)
      this.runner.run('pnpm', [
        '--filter', './vendor/**',
        '--filter', './packages/**',
        '--filter', './apps/**',
        '--recursive',
        'pack',
        '--pack-destination', artifactDirectory,
      ], worktree.path)

      const bundle = ReleaseBundle.create(
        artifactDirectory,
        packageSet.packages,
        plan.commit,
        plan.version,
        plan.distTag,
        plan.registry,
        this.runner,
      )
      new InstalledBundleSmoke(bundle, this.runner).run()
      createdArtifactDirectory = false
      console.log(`publish-npm-baseline: packed ${bundle.manifest.packages.length} packages`)
      console.log(`  version:  ${bundle.manifest.version}`)
      console.log(`  dist-tag: ${bundle.manifest.distTag}`)
      console.log(`  manifest: ${resolve(bundle.directory, RELEASE_MANIFEST_NAME)}`)
      console.log('  publish:  ' + formatCopyableCommand('pnpm', [
        '--dir',
        this.repositoryRoot,
        'exec',
        'tsx',
        resolve(this.repositoryRoot, 'scripts/publish-npm-baseline.ts'),
        'publish',
        '--manifest',
        resolve(bundle.directory, RELEASE_MANIFEST_NAME),
        '--yes',
      ]))
      return bundle
    } finally {
      worktree.dispose()
      if (createdArtifactDirectory) {
        rmSync(artifactDirectory, { recursive: true, force: true })
      }
    }
  }
}

/** Publishes and verifies a release bundle against its recorded registry. */
class RegistryPublication {
  private readonly npmEnvironment = npmClientEnvironment()
  private readonly npmWorkingDirectory = tmpdir()

  constructor(
    private readonly bundle: ReleaseBundle,
    private readonly runner: CommandRunner,
  ) {}

  async publish(assumeYes: boolean): Promise<void> {
    this.pingRegistry()
    this.requireIdentity()
    if (!assumeYes) await this.confirm()

    for (const pkg of this.bundle.manifest.packages) {
      const existingIntegrity = this.remoteIntegrity(pkg.name)
      if (existingIntegrity === undefined) {
        this.runner.run('npm', [
          'publish',
          this.bundle.tarballPath(pkg),
          `--registry=${this.bundle.manifest.registry}`,
          `--tag=${this.bundle.manifest.distTag}`,
        ], this.npmWorkingDirectory, this.npmEnvironment)
      } else {
        if (existingIntegrity !== pkg.integrity) {
          throw new Error(
            `${pkg.name}@${this.bundle.manifest.version} already exists with different integrity`,
          )
        }
        console.log(
          `publish-npm-baseline: already published ${pkg.name}@${this.bundle.manifest.version}`,
        )
      }
      this.ensureDistTag(pkg.name, this.bundle.manifest.distTag)
    }
    this.ensureDistTag(RELEASE_ENTRY_PACKAGE, LATEST_DIST_TAG)
    this.verifyRemote()
    this.verifyReleaseEntryDistTag()
  }

  verify(): void {
    this.pingRegistry()
    this.verifyRemote()
    this.verifyReleaseEntryDistTag()
  }

  private verifyRemote(): void {
    for (const pkg of this.bundle.manifest.packages) {
      const integrity = this.remoteIntegrity(pkg.name)
      if (integrity === undefined) {
        throw new Error(`package is missing: ${pkg.name}@${this.bundle.manifest.version}`)
      }
      if (integrity !== pkg.integrity) {
        throw new Error(`integrity mismatch: ${pkg.name}@${this.bundle.manifest.version}`)
      }
      const tagVersion = this.remoteDistTag(pkg.name, this.bundle.manifest.distTag)
      if (tagVersion !== this.bundle.manifest.version) {
        throw new Error(
          `${pkg.name}@${this.bundle.manifest.distTag} points to ${tagVersion ?? '<missing>'}; `
          + `expected ${this.bundle.manifest.version}`,
        )
      }
      console.log(`publish-npm-baseline: verified ${pkg.name}@${this.bundle.manifest.version}`)
    }
    console.log(
      `publish-npm-baseline: verified ${this.bundle.manifest.packages.length} packages and `
      + `dist-tag ${this.bundle.manifest.distTag}`,
    )
  }

  private verifyReleaseEntryDistTag(): void {
    const tagVersion = this.remoteDistTag(RELEASE_ENTRY_PACKAGE, LATEST_DIST_TAG)
    if (tagVersion !== this.bundle.manifest.version) {
      throw new Error(
        `${RELEASE_ENTRY_PACKAGE}@${LATEST_DIST_TAG} points to ${tagVersion ?? '<missing>'}; `
        + `expected ${this.bundle.manifest.version}`,
      )
    }
    console.log(
      `publish-npm-baseline: verified ${RELEASE_ENTRY_PACKAGE}@${LATEST_DIST_TAG} at `
      + this.bundle.manifest.version,
    )
  }

  private pingRegistry(): void {
    const { registry } = this.bundle.manifest
    this.runner.capture(
      'npm', ['ping', `--registry=${registry}`], this.npmWorkingDirectory, this.npmEnvironment,
    )
  }

  private requireIdentity(): void {
    const { registry } = this.bundle.manifest
    const identity = this.runner.capture(
      'npm', ['whoami', `--registry=${registry}`], this.npmWorkingDirectory, this.npmEnvironment,
    )
    console.log(`publish-npm-baseline: registry identity ${identity} at ${registry}`)
  }

  private async confirm(): Promise<void> {
    await confirmEnter(
      `Publish ${this.bundle.manifest.packages.length} packages as `
      + `${this.bundle.manifest.version} to ${this.bundle.manifest.registry}? `
      + 'Press Enter to continue or type anything to cancel: ',
      'publish requires an interactive terminal or --yes',
      'publication cancelled',
    )
  }

  private remoteIntegrity(name: string): string | undefined {
    const { registry, version } = this.bundle.manifest
    const result = this.runner.result(
      'npm',
      ['view', `${name}@${version}`, 'dist.integrity', '--json', `--registry=${registry}`],
      this.npmWorkingDirectory,
      this.npmEnvironment,
    )
    if (result.status !== 0) {
      if (/E404|NOT_FOUND|404 Not Found/.test(`${result.stdout}\n${result.stderr}`)) return undefined
      throw commandFailure('npm', ['view', `${name}@${version}`], result)
    }
    const value: unknown = result.stdout.trim() === '' ? undefined : JSON.parse(result.stdout)
    if (typeof value !== 'string' || !value.startsWith('sha512-')) {
      throw new Error(`registry returned no integrity for ${name}@${version}`)
    }
    return value
  }

  private remoteDistTag(name: string, distTag: string): string | undefined {
    const { registry } = this.bundle.manifest
    const raw = this.runner.capture(
      'npm',
      ['dist-tag', 'ls', name, `--registry=${registry}`],
      this.npmWorkingDirectory,
      this.npmEnvironment,
    )
    return parseDistTagListing(raw, name).get(distTag)
  }

  private ensureDistTag(name: string, distTag: string): void {
    if (this.remoteDistTag(name, distTag) === this.bundle.manifest.version) return
    const { registry, version } = this.bundle.manifest
    this.runner.run(
      'npm',
      ['dist-tag', 'add', `${name}@${version}`, distTag, `--registry=${registry}`],
      this.npmWorkingDirectory,
      this.npmEnvironment,
    )
  }
}

interface InspectedTarball {
  name: string
  version: string
  private: unknown
  manifest: Record<string, unknown>
  files: string[]
}

function inspectTarball(path: string, runner: CommandRunner): InspectedTarball {
  const manifest = JSON.parse(
    runner.capture('tar', ['-xOf', path, 'package/package.json'], dirname(path)),
  ) as unknown
  if (!isRecord(manifest)) throw new Error(`${path} contains an invalid package.json`)
  return {
    name: expectString(manifest, 'name', path),
    version: expectString(manifest, 'version', path),
    private: manifest.private,
    manifest,
    files: runner.capture('tar', ['-tf', path], dirname(path)).split(/\r?\n/),
  }
}

function packedPackage(name: string, path: string, origin: PackageOrigin): PackedPackage {
  const bytes = readFileSync(path)
  return {
    name,
    tarball: basename(path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    origin,
  }
}

function parsePackedPackage(value: unknown, index: number): PackedPackage {
  if (!isRecord(value)) throw new Error(`invalid release manifest package at index ${index}`)
  const context = `release manifest package at index ${index}`
  const name = expectString(value, 'name', context)
  const origin = value.origin === undefined ? 'harness' : value.origin
  if (origin !== 'harness' && origin !== 'vendor') {
    throw new Error(`invalid package origin in release manifest: ${JSON.stringify(origin)}`)
  }
  if (origin === 'harness' && (!name.startsWith('@deepseek-ai/') || name === '@deepseek-ai/dsh-root')) {
    throw new Error(`invalid package name in release manifest: ${name}`)
  }
  return {
    name,
    tarball: expectString(value, 'tarball', context),
    sha256: expectString(value, 'sha256', context),
    integrity: expectString(value, 'integrity', context),
    origin,
  }
}

function containsWorkspaceProtocol(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('workspace:')
  if (Array.isArray(value)) return value.some(containsWorkspaceProtocol)
  return isRecord(value) && Object.values(value).some(containsWorkspaceProtocol)
}

function stageInternalDependencies(
  manifest: Record<string, unknown>,
  internalNames: ReadonlySet<string>,
  releaseVersion: string,
  context: string,
): void {
  for (const { dependencies, name } of internalDependencyEntries(manifest, internalNames, context)) {
    dependencies[name] = releaseVersion
  }
}

function validateInternalDependencyPins(
  manifest: Record<string, unknown>,
  internalNames: ReadonlySet<string>,
  releaseVersion: string,
  context: string,
): void {
  for (const { section, name, range } of internalDependencyEntries(manifest, internalNames, context)) {
    if (range !== releaseVersion) {
      throw new Error(
        `${context} has internal ${section} ${name}@${String(range)}; `
        + `expected exact version ${releaseVersion}`,
      )
    }
  }
}

function* internalDependencyEntries(
  manifest: Record<string, unknown>,
  internalNames: ReadonlySet<string>,
  context: string,
): Generator<{
  section: typeof DEPENDENCY_SECTIONS[number]
  dependencies: Record<string, unknown>
  name: string
  range: unknown
}> {
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section]
    if (dependencies === undefined) continue
    if (!isRecord(dependencies)) throw new Error(`${context} ${section} must be an object`)
    for (const [name, range] of Object.entries(dependencies)) {
      if (!internalNames.has(name)) continue
      yield { section, dependencies, name, range }
    }
  }
}

function readObject(path: string): Record<string, unknown> {
  return parseObject(readFileSync(path, 'utf8'), path)
}

function parseObject(source: string, context: string): Record<string, unknown> {
  const value: unknown = JSON.parse(source)
  if (!isRecord(value)) throw new Error(`${context} must contain a JSON object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expectString(value: Record<string, unknown>, key: string, context: string): string {
  const result = value[key]
  if (typeof result !== 'string' || result === '') {
    throw new Error(`${context} must contain a non-empty ${key}`)
  }
  return result
}

function normalizeRegistry(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`registry must use HTTP or HTTPS: ${value}`)
  }
  return value.replace(/\/+$/, '')
}

function npmClientEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.npm_config_user_agent
  delete environment.NPM_CONFIG_USER_AGENT
  return environment
}

function installedArtifactEnvironment(consumerRoot: string): NodeJS.ProcessEnv {
  const environment = npmClientEnvironment()
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.DSH_HOME = resolve(consumerRoot, '.dsh')
  environment.DSH_AGENTS_HOME = resolve(consumerRoot, '.agents')
  environment.DSH_TELEMETRY_DISABLED = '1'
  environment.DEEPSEEK_API_KEY = 'keyless-installed-web-no-call'
  environment.LANG = 'en_US.UTF-8'
  environment.LC_ALL = 'en_US.UTF-8'
  environment.LC_CTYPE = 'en_US.UTF-8'
  environment.TERM = 'xterm-256color'
  environment.COLUMNS = '100'
  environment.LINES = '30'
  delete environment.COLORTERM
  return environment
}

function assertPathWithin(root: string, path: string, label: string): void {
  const rootPath = realpathSync.native(root)
  const candidate = realpathSync.native(path)
  const fromRoot = relative(rootPath, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} resolved outside the isolated consumer: ${candidate}`)
  }
}

function validateDistTag(value: string): void {
  if (value === '' || /\s/.test(value)) throw new Error(`invalid dist-tag: ${JSON.stringify(value)}`)
}

function validateBaseVersion(value: string, context: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${context} must have a stable X.Y.Z version, got ${value}`)
  }
}

function parseDistTagListing(raw: string, name: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') continue
    const separator = line.indexOf(': ')
    if (separator <= 0 || separator + 2 === line.length) {
      throw new Error(`registry returned an invalid dist-tag for ${name}: ${line}`)
    }
    const tag = line.slice(0, separator)
    if (tags.has(tag)) throw new Error(`registry returned duplicate dist-tag ${tag} for ${name}`)
    tags.set(tag, line.slice(separator + 2))
  }
  return tags
}

async function confirmEnter(
  prompt: string,
  nonInteractiveError: string,
  cancellationError: string,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(nonInteractiveError)
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await readline.question(prompt)
    if (answer !== '') throw new Error(cancellationError)
  } finally {
    readline.close()
  }
}

function formatUtcTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error('pack timestamp must be a valid date')
  return value.toISOString().replaceAll(/[-:TZ.]/g, '').slice(0, 14)
}

function commandFailure(command: string, args: string[], result: CommandResult): Error {
  const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  return new Error(
    `${formatCommand(command, args)} exited with status ${result.status}${detail === '' ? '' : `\n${detail}`}`,
  )
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(value => JSON.stringify(value)).join(' ')
}

function formatCopyableCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteShellArgument).join(' ')
}

function quoteShellArgument(value: string): string {
  if (/^[\w./:@=+-]+$/.test(value)) return value
  const singleQuote = String.fromCodePoint(39)
  const escapedSingleQuote = `${singleQuote}"${singleQuote}"${singleQuote}`
  return `${singleQuote}${value.replaceAll(singleQuote, escapedSingleQuote)}${singleQuote}`
}

function printUsage(): void {
  console.log(`Usage:
  pnpm exec tsx scripts/publish-npm-baseline.ts pack [options]
  pnpm exec tsx scripts/publish-npm-baseline.ts release [options] [--yes]
  pnpm exec tsx scripts/publish-npm-baseline.ts publish --manifest <path> [--yes]
  pnpm exec tsx scripts/publish-npm-baseline.ts verify --manifest <path>

Pack/release options:
  --ref <git-ref>       Git commit to stage (default: HEAD)
  --registry <url>      npm registry (default: ${DEFAULT_REGISTRY})
  --output-dir <path>   Artifact root (default: ${DEFAULT_OUTPUT_DIRECTORY})
  --yes                 pack/release without waiting for Enter`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    printUsage()
    return
  }
  if (process.argv.slice(3).some(value => value === '--help' || value === '-h')) {
    printUsage()
    return
  }
  const runner = new CommandRunner()
  const repositoryRoot = runner.capture('git', ['rev-parse', '--show-toplevel'], process.cwd())

  if (command === 'pack' || command === 'release') {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        ref: { type: 'string', default: 'HEAD' },
        registry: { type: 'string', default: DEFAULT_REGISTRY },
        'output-dir': { type: 'string', default: resolve(repositoryRoot, DEFAULT_OUTPUT_DIRECTORY) },
        yes: { type: 'boolean', default: false },
      },
      strict: true,
    })
    const packager = new BaselinePackager(repositoryRoot, runner)
    const plan = packager.plan({
      ref: values.ref,
      registry: values.registry,
      outputDirectory: resolve(values['output-dir']),
    })
    await plan.confirm(values.yes)
    const bundle = packager.pack(plan)
    if (command === 'release') {
      await new RegistryPublication(bundle, runner).publish(values.yes)
    }
    return
  }

  if (command === 'publish' || command === 'verify') {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        manifest: { type: 'string' },
        yes: { type: 'boolean', default: false },
      },
      strict: true,
    })
    if (values.manifest === undefined) throw new Error(`${command} requires --manifest`)
    if (command === 'verify' && values.yes) throw new Error('verify does not accept --yes')
    const bundle = ReleaseBundle.load(values.manifest, runner)
    const publication = new RegistryPublication(bundle, runner)
    if (command === 'publish') await publication.publish(values.yes)
    else publication.verify()
    return
  }

  throw new Error(`unknown command: ${command}`)
}

try {
  await main()
} catch (error: unknown) {
  console.error(`publish-npm-baseline: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
