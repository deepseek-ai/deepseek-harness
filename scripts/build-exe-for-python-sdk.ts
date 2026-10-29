/**
 * Build the dsh executables and development Node carrier for the Python runtime wheel. The fixed
 * `@yao-pkg/pkg --sea` route, deploy flags, and artifact layout are owned by
 * .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.
 * The staged closure is symlink-free, and whole-tree assets cover Cordis's
 * runtime imports that pkg cannot discover statically.
 */

import { createHash } from 'node:crypto'
import { build as bundle } from 'tsdown'
import { spawn } from 'node:child_process'
import { pnpmInvocation, restoreLegacyHoists } from './executable-packaging.ts'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, glob, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolveLinuxNodePtyAddon, resolveWindowsNodePtyAddons } from './executable-native-pty.ts'
import { officeSidecarArchives, runtimeNpmArchive, OFFICE_ASSET_IGNORES } from './build-exe-for-python-sdk-office.ts'
import { syncPythonRuntimeProduct } from './build-exe-for-python-sdk-resources.ts'
import { deduplicateStagedWorkspacePackages, materializeStagedLinks } from './build-exe-for-python-sdk-staging.ts'
import { prepareOfficeSkillAssets } from './primary-runtime/prepare.ts'
import primaryLock from './primary-runtime/lock.json' with { type: 'json' }

const root = resolve(import.meta.dirname, '..')

/** The closure manifest whose dependencies define the executable. */
const DEPLOY_ROOT_PACKAGE = 'dsh-python-runtime-closure'
/** The sole executable entry inside the deployed closure. */
const ENTRY_BIN = 'runtime-bootstrap.mjs'
/** Python-visible executable basename. */
const OUTPUT_BASENAME = 'deepseek-harness-sdk-runtime'
/** Default Node major; SEA mode requires at least Node 22. */
const DEFAULT_NODE_RANGE = 'node24'
const OUT_DIR = 'dist-exe'
/** Python package destination; created when absent. */
const PYTHON_RUNTIME_DIR = 'python/sdk-runtime/src/deepseek_harness_runtime/runtime'
/** The deployed closure doubles as the node-mode carrier. */
const PYTHON_NODE_SUBDIR = 'node'
/** Legacy deploy may hoist peer-specialized workspace packages back here. */
const DEPLOY_SOURCE_NODE_MODULES = 'python/sdk-runtime/node_modules'
/** Documentation excluded from the generated runtime directory. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see. Package manifests are explicit because bare-name
 * resolution depends on them.
 */
const ASSET_GLOBS = [
  'package.json',
  '*.mjs',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  // Plugin display metadata resolves these package-owned images at runtime.
  'node_modules/@deepseek-ai/dsh-*/**/*.{svg,png,jpg,jpeg,webp}',
  // Package-owned Markdown includes runtime skill instructions.
  'node_modules/**/*.md',
  'node_modules/**/*.dylib',
  'node_modules/**/*.dll',
  'node_modules/**/*.node',
  'node_modules/**/*.so',
  'node_modules/**/*.so.*',
  'node_modules/**/*.wasm',
  'node_modules/**/*.yaml',
  'node_modules/**/*.yml',
  // web-app builds this path dynamically, so pkg cannot discover the static frontend.
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/**/*',
  // The diagnosis provider extracts its PowerShell script for an external interpreter.
  'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/assets/**/*',
]

const PLATFORMS = ['linux', 'macos', 'win'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/**
 * A parsed pkg target triple, constructed from `--targets` or the host.
 */
class Target {
  private constructor(
    /** pkg Node range (`node<major>`). */
    readonly nodeRange: string,
    /** pkg platform tag. */
    readonly platform: Platform,
    /** pkg CPU tag. */
    readonly arch: Arch,
  ) {}

  /** The pkg `--targets` spec string `<nodeRange>-<platform>-<arch>`. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse one target spec, rejecting malformed triples and unsupported platform or architecture.
   * @param spec - the raw triple, e.g. `node24-linux-x64`.
   * @returns the parsed target.
   */
  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    if (platform === 'win' && arch !== 'x64') {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: Windows supports x64 only.`)
    }
    return new Target(nodeRange, platform, arch)
  }

  /**
   * Resolve the host-platform default on Node 24.
   * @returns the host target; throws on an unsupported host platform or arch.
   */
  static host(): Target {
    const platform = process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'linux'
        ? 'linux'
        : process.platform === 'win32'
          ? 'win'
          : undefined
    if (platform === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    if (platform === 'win' && arch !== 'x64') {
      throw new Error('build-exe-for-python-sdk: Windows supports x64 only; use an x64 Node process.')
    }
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
/** pkg's `--compress` values, whose build cost differs by two orders of magnitude. */
const COMPRESS_TYPES = ['None', 'GZip', 'Brotli', 'Zstd'] as const
type CompressType = typeof COMPRESS_TYPES[number]

/**
 * Narrow a raw `--compress` value to a supported pkg compressor.
 * @param value - the command-line value.
 * @returns whether pkg accepts the value.
 */
function isCompressType(value: string): value is CompressType {
  return (COMPRESS_TYPES as readonly string[]).includes(value)
}

class BuildCli {
  private constructor(
    /** Build targets; defaults to the host platform only. */
    readonly targets: readonly Target[],
    /** Skip the package build; lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Build through `pnpm run build:artifacts`, which omits the aggregate test and script typechecks. */
    readonly buildArtifacts: boolean,
    /** pkg archive compression; Brotli is the smallest and by far the slowest. */
    readonly compress: CompressType,
    /** Print every command and config patch instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; invalid or colliding
   * targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-for-python-sdk: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    if (values['skip-build'] && values['build-artifacts']) {
      throw new Error('build-exe-for-python-sdk: --skip-build and --build-artifacts cannot be combined.')
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-for-python-sdk: --targets is empty.')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = `${target.platform}-${target.arch}`
      if (seen.has(key)) {
        throw new Error(`build-exe-for-python-sdk: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
      }
      seen.add(key)
    }
    const compress = values.compress ?? 'Brotli'
    if (!isCompressType(compress)) {
      throw new Error(`build-exe-for-python-sdk: --compress must be one of ${COMPRESS_TYPES.join(' | ')}, got ${JSON.stringify(compress)}.`)
    }
    return new BuildCli(targets, values['skip-build'], values['build-artifacts'], compress, values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'build-artifacts': { type: 'boolean', default: false },
        'compress': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-exe-for-python-sdk.ts [flags]',
      '',
      '  --targets=<t1,t2,...>  pkg targets, e.g. node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64.',
      '                         Default: the host platform only (on node24).',
      '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --build-artifacts      run `pnpm run build:artifacts` instead, omitting the aggregate test and script typechecks.',
      '  --compress=<type>      pkg archive compression: None | GZip | Brotli | Zstd. Default: Brotli (smallest, slowest).',
      '  --dry-run              print every command and config patch without executing.',
      '  --help                 print this help.',
      '',
      'Build route: @yao-pkg/pkg --sea with the selected --compress type (root devDependency, pnpm-patched); see .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.',
      `Stages the node carrier in ${PYTHON_RUNTIME_DIR}/${PYTHON_NODE_SUBDIR} and writes executables to ${OUT_DIR}/.`,
    ].join('\n')
  }
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Sequential build pipeline. Subprocesses inherit stdio and errors include
 * the command; dry runs print commands and filesystem changes.
 */
class SingleExeBuild {
  /**
   * The cleared deploy target, pkg input, and Python node-mode carrier.
   */
  readonly staging = resolve(root, PYTHON_RUNTIME_DIR, PYTHON_NODE_SUBDIR)
  private readonly outDir = resolve(root, OUT_DIR)

  constructor(private readonly cli: BuildCli) {}

  /** Verify the closure before compiling or packaging. */
  async verifyClosure(): Promise<void> {
    await this.runPnpm('runtime dependency closure', ['run', 'verify-runtime-closure'])
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-python-sdk: skipping pnpm run build (--skip-build)')
      return
    }
    const args = this.cli.buildArtifacts ? ['run', 'build:artifacts'] : ['run', 'build']
    await this.runPnpm('build', args)
  }

  /** Clear and deploy the runtime closure into the node carrier. */
  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-for-python-sdk: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    try { await this.runPnpm('deploy', [
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--legacy',
      '--prod',
      // Production deployment omits workspace tooling such as Electron's patched signer.
      '--config.allow-unused-patches=true',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      '--config.hoist-workspace-packages=false',
      this.staging,
    ]) } finally {
      // Legacy deploy records production-only workspace state; restore the development installation before exec.
      await this.runPnpm('restore development dependencies', ['install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts'])
    }
    await this.restoreLegacyHoists()
    await this.materializeStagedLinks()
    if (this.cli.dryRun) {
      for (const name of DEPLOY_ONLY_DOCS) console.log(`build-exe-for-python-sdk: [dry-run] rm -f ${join(this.staging, name)}`)
    } else {
      await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(this.staging, name), { force: true })))
      for await (const file of glob('node_modules/**/{README*.md,CHANGELOG*.md,HISTORY*.md,*.map,*.d.ts,*.d.mts,*.d.cts}', {
        cwd: this.staging, exclude: ['node_modules/**/assets/**'],
      })) await rm(join(this.staging, file), { force: true })
    }
  }

  /**
   * Restore direct packages that pnpm's legacy hoister places beside the deploy
   * source instead of in the target. The runtime manifest supplies every peer,
   * so package-local node_modules trees are omitted to preserve one flat Cordis
   * instance and a symlink-free packaged payload.
   */
  private async restoreLegacyHoists(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-python-sdk: [dry-run] restore direct dependencies omitted by legacy deploy')
      return
    }
    const restored = await restoreLegacyHoists(this.staging, resolve(root, DEPLOY_SOURCE_NODE_MODULES))
    if (restored.length > 0) console.log(`build-exe-for-python-sdk: restored legacy deploy hoists: ${restored.join(', ')}`)
  }

  /** Replace deploy-time package links with files and reject any remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-python-sdk: [dry-run] materialize staged package links')
      return
    }
    await materializeStagedLinks(this.staging)
    await deduplicateStagedWorkspacePackages(this.staging, root)
  }

  /** Add the executable entry and pkg assets to the staged manifest. */
  async injectPkgConfig(): Promise<void> {
    const sourceModules = join(root, 'node_modules').replaceAll('\\', '/')
    const patch = { bin: ENTRY_BIN, pkg: { assets: ASSET_GLOBS, ignore: [
      ...OFFICE_ASSET_IGNORES,
      `${sourceModules}/**`, `${sourceModules}/.pnpm/**`,
      ...['packages', 'apps', 'vendor', 'native', 'scripts'].map(directory => `${join(root, directory).replaceAll('\\', '/')}/**`),
      `${root.replaceAll('\\', '/')}/tsconfig*.json`,
      '**/*.map', '**/*.d.ts', '**/*.d.mts', '**/*.d.cts',
    ] } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`build-exe-for-python-sdk: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    if (!existsSync(join(this.staging, ENTRY_BIN))) {
      throw new Error(`build-exe-for-python-sdk: staged bootstrap ${join(this.staging, ENTRY_BIN)} is missing.`)
    }
    const helpers = [
      { name: 'primary-runtime', source: 'scripts/primary-runtime/prepare.ts', exports: 'downloadNodeRuntime, preparePrimaryRuntime' },
      { name: 'office-sidecar', source: 'scripts/build-exe-for-python-sdk-office.ts', exports: 'downloadOfficeSidecar' },
    ]
    const entries: Record<string, string> = {}
    for (const helper of helpers) {
      const entry = join(this.staging, `.${helper.name}-entry.ts`)
      entries[helper.name] = entry
      await writeFile(entry, `export { ${helper.exports} } from ${JSON.stringify(join(root, helper.source).replaceAll('\\', '/'))}\n`)
    }
    try {
      await bundle({ config: false, tsconfig: false, inputOptions: { tsconfig: false }, target: 'es2024', entry: entries,
        outDir: this.staging, clean: false, format: 'esm', platform: 'node', dts: false,
        deps: { neverBundle: [/^@deepseek-ai\//u], alwaysBundle: [/.*/u] }, shims: true, outExtensions: () => ({ js: '.mjs' }),
        define: { 'import.meta.main': 'false' } })
    } finally {
      for (const entry of Object.values(entries)) await rm(entry, { force: true })
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    await this.run('resource helper imports', process.execPath, ['--input-type=module', '--eval',
      ['primary-runtime.mjs', 'office-sidecar.mjs'].map(file => `await import(${JSON.stringify(pathToFileURL(join(this.staging, file)).href)})`).join('\n')])
    console.log(`build-exe-for-python-sdk: injected pkg config into ${manifestPath}`)
  }

  /**
   * Package one target; SEA mode accepts one target per invocation.
   * @param target - the pkg target triple to build.
   * @returns the executable, resource directories, ripgrep, and required macOS spawn helper paths.
   */
  async pack(target: Target): Promise<string[]> {
    const productBase = join(this.outDir, `${OUTPUT_BASENAME}-${target.platform}-${target.arch}`)
    const product = target.platform === 'win' ? `${productBase}.exe` : productBase
    await this.prepareNativePty(target)
    const platform = target.platform === 'macos' ? 'darwin' : target.platform === 'win' ? 'win32' : target.platform
    if (!this.cli.dryRun) await mkdir(this.outDir, { recursive: true })
    await this.runPnpm(`pkg ${target.spec}`, [
      'exec',
      'pkg',
      this.staging,
      '--sea',
      '--compress',
      this.cli.compress,
      '--targets',
      target.spec,
      '--output',
      product,
    ])
    if (!this.cli.dryRun && !existsSync(product)) {
      throw new Error(`build-exe-for-python-sdk: product ${product} is missing after the pkg run; inspect ${this.outDir}.`)
    }
    const ripgrep = await this.copyRipgrepSidecar(target, product)
    const resources = join(this.outDir, `${target.platform}-${target.arch}`)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] lock optional resource downloads and copy Office skills to ${resources}`)
    } else {
      await rm(resources, { recursive: true, force: true })
      await mkdir(resources, { recursive: true })
      const { version, packageManager } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string; packageManager: string }
      const office = await officeSidecarArchives(this.staging, { platform, arch: target.arch })
      const pnpm = await runtimeNpmArchive('pnpm', packageManager.replace('pnpm@', ''))
      const inputs = { version, target: `${target.platform === 'macos' ? 'mac' : target.platform}-${target.arch}`, office, pnpm }
      const identity = createHash('sha256').update(JSON.stringify({ ...inputs, primaryLock })).digest('hex')
      await writeFile(join(resources, 'downloads.json'), JSON.stringify({ ...inputs, identity }, undefined, 2) + '\n')
      await prepareOfficeSkillAssets(join(this.staging, 'node_modules/@deepseek-ai/dsh-skill-office/assets'), join(resources, 'office-skills'))
    }
    if (target.platform !== 'macos') return [product, ripgrep, resources]
    const spawnHelper = `${product}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return [product, ripgrep, spawnHelper, resources]
  }

  /** Copy the target ripgrep binary beside the executable so Node can spawn it outside pkg's virtual filesystem. */
  private async copyRipgrepSidecar(target: Target, product: string): Promise<string> {
    const platform = target.platform === 'macos' ? 'darwin' : target.platform === 'win' ? 'win32' : target.platform
    const executable = target.platform === 'win' ? 'rg.exe' : 'rg'
    const source = join(
      this.staging,
      'node_modules',
      '@vscode',
      `ripgrep-${platform}-${target.arch}`,
      'bin',
      executable,
    )
    const destination = target.platform === 'win'
      ? `${product.slice(0, -'.exe'.length)}-rg.exe`
      : `${product}-rg`
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${destination}`)
      return destination
    }
    if (!existsSync(source)) {
      throw new Error(`build-exe-for-python-sdk: target ripgrep binary is missing at ${source}.`)
    }
    await copyFile(source, destination)
    await chmod(destination, 0o755)
    return destination
  }

  /**
   * Put the target node-pty addon in the staged closure. The release workflow
   * provides a manylinux build; ordinary installs use node-pty's target prebuild.
   * @param target - the pkg target whose native addon is being staged.
   */
  private async prepareNativePty(target: Target): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    const packageDirectory = join(
      root,
      'packages',
      'subprocess',
      'subprocess-local',
      'node_modules',
      'node-pty',
    )
    const platform = target.platform === 'macos' ? 'darwin' : target.platform === 'win' ? 'win32' : target.platform
    const selected = `${platform}-${target.arch}`
    const prebuilds = join(this.staging, 'node_modules/node-pty/prebuilds')
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] keep only node-pty prebuilds ${selected}`)
    else {
      const source = join(packageDirectory, 'prebuilds', selected)
      if (existsSync(source)) await cp(source, join(prebuilds, selected), { recursive: true })
      for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== selected) await rm(join(prebuilds, entry.name), { recursive: true, force: true })
      }
    }
    if (target.platform === 'win') {
      if (target.arch !== 'x64') {
        throw new Error('build-exe-for-python-sdk: Windows supports x64 only.')
      }
      const host = Target.host()
      if (target.platform !== host.platform || target.arch !== host.arch) {
        throw new Error(
          'build-exe-for-python-sdk: build the Windows runtime under x64 Node on its target host; '
          + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
        )
      }
      resolveWindowsNodePtyAddons(join(this.staging, 'node_modules', 'node-pty'), target.arch)
      return
    }
    if (target.platform !== 'linux') return
    const destination = join(stagedBuild, 'Release', 'pty.node')
    const source = resolveLinuxNodePtyAddon(packageDirectory, target.arch)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = Target.host()
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        'build-exe-for-python-sdk: build the Linux runtime on its target architecture; '
        + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  /**
   * Print each product path and, outside dry-run mode, its size.
   * @param products - the product paths returned by {@link pack}.
   */
  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'build-exe-for-python-sdk: [dry-run] would produce:' : 'build-exe-for-python-sdk: products:')
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      if (statSync(path).isDirectory()) {
        console.log(`  ${path}  (resource directory)`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /**
   * Copy each product into the Python runtime package. The deployed node
   * carrier is already in place, and `dist-exe/` retains upload copies.
   * @param products - the product paths returned by {@link pack}.
   */
  async syncToPythonRuntime(products: string[]): Promise<void> {
    const destDir = resolve(root, PYTHON_RUNTIME_DIR)
    if (this.cli.dryRun) {
      for (const path of products) {
        console.log(`build-exe-for-python-sdk: [dry-run] cp ${path} ${join(destDir, basename(path))}`)
      }
      return
    }
    await mkdir(destDir, { recursive: true })
    for (const path of products) {
      const destination = join(destDir, basename(path))
      await syncPythonRuntimeProduct(path, destination)
      console.log(`build-exe-for-python-sdk: synced ${destination}`)
    }
  }

  /**
   * Run one subprocess with inherited stdio. Spawn and non-zero-exit errors
   * include the command; dry runs only print it.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-for-python-sdk: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`build-exe-for-python-sdk: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-for-python-sdk: ${label} failed (${cause}): ${printable}`))
      })
    })
  }

  /** Run pnpm through its JavaScript entrypoint when the caller supplies one. */
  private async runPnpm(label: string, args: string[]): Promise<void> {
    const [command, invocationArgs] = pnpmInvocation(args)
    await this.run(label, command, invocationArgs)
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const pipeline = new SingleExeBuild(cli)
  console.log(`build-exe-for-python-sdk: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-python-sdk: staging: ${pipeline.staging}`)
  await pipeline.verifyClosure()
  await pipeline.build()
  await pipeline.deployStaging()
  await pipeline.injectPkgConfig()
  const products: string[] = []
  for (const target of cli.targets) products.push(...await pipeline.pack(target))
  pipeline.printProducts(products)
  await pipeline.syncToPythonRuntime(products)
}

await main()
