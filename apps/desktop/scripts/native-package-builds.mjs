/**
 * Build and verify native addons that runtime packages compile from shipped sources. A DeepSeek Harness package
 * (`@deepseek-ai/dsh-*`) opts in with `package.json` `dsh.native`; packaging ignores the declaration in any other
 * package, so no third-party build script runs. `build` names a Node script, relative to the package root, that the
 * packager runs on the target operating system as `node <build> --arch <arch>`, on Windows inside the MSVC developer
 * environment `vcvarsall.bat` sets up for the target, with `DSH_NODE_API_HEADERS` naming the root of Desktop's
 * `node-api-headers` package (`include/` headers, `def/` Windows symbol lists); `addons` lists the produced files relative to the package root,
 * with `{platform}` and `{arch}` expanded to the target. The build writes a record beside each addon, the addon path
 * with `.node` replaced by `.json`, holding at least `{ platform, sha256 }`. Packaging owns presence, record, hash, and
 * architecture checks; each package owns any further compatibility check its loader performs.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Only packages with this name prefix may declare `dsh.native`. */
const NATIVE_PACKAGE_PREFIX = '@deepseek-ai/dsh-'
/** Separates `vcvarsall.bat` output from the environment it leaves. */
const ENVIRONMENT_MARKER = '--- dsh native build environment ---'

/**
 * Whether an addon's object header matches the packaged operating system and CPU.
 * @param {Buffer} bytes - Addon file contents.
 * @param {{ platform: string, arch: string }} target - Electron execution target.
 * @returns {boolean} True for a Mach-O 64 binary on macOS or a PE image on Windows of the target CPU.
 */
export function matchingArchitecture(bytes, target) {
  if (target.platform === 'darwin') {
    return bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf
      && bytes.readUInt32LE(4) === (target.arch === 'arm64' ? 0x100000c : 0x1000007)
  }
  if (target.platform === 'win32' && bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
    const offset = bytes.readUInt32LE(0x3c)
    return offset <= bytes.length - 6 && bytes.readUInt32LE(offset) === 0x4550
      && bytes.readUInt16LE(offset + 4) === (target.arch === 'arm64' ? 0xaa64 : 0x8664)
  }
  return false
}

/**
 * Validate one package's `dsh.native` declaration.
 * @param {string} name - Package name for diagnostics.
 * @param {unknown} value - Raw `dsh.native` value.
 * @returns {{ build: string, addons: string[] }} The declaration.
 */
function nativeDeclaration(name, value) {
  const declaration = /** @type {{ build?: unknown, addons?: unknown }} */ (value)
  const relativePath = path => typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.split('/').includes('..')
  if (typeof value !== 'object' || value === null || !relativePath(declaration.build)
    || !Array.isArray(declaration.addons) || declaration.addons.length === 0
    || !declaration.addons.every(addon => relativePath(addon) && addon.endsWith('.node'))) {
    throw new Error(`desktop runtime: ${name} declares an invalid dsh.native; expected { build, addons: ["<relative>.node", ...] }`)
  }
  return { build: /** @type {string} */ (declaration.build), addons: /** @type {string[]} */ (declaration.addons) }
}

/**
 * Read the `dsh.native` declaration of one package directory.
 * @param {string} root - Package directory containing `package.json`.
 * @returns {{ name: string, root: string, build: string, addons: string[] } | undefined} The declaration, or undefined when
 *   the package declares none or is not a DeepSeek Harness package.
 */
export function nativePackageBuildAt(root) {
  const manifestPath = join(root, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh?.native === undefined || typeof manifest.name !== 'string' || !manifest.name.startsWith(NATIVE_PACKAGE_PREFIX)) return undefined
  return { name: manifest.name, root, ...nativeDeclaration(manifest.name, manifest.dsh.native) }
}

/**
 * Installed packages under a runtime root that declare `dsh.native`, including nested `node_modules`.
 * @param {string} runtimeRoot - Desktop runtime root containing `node_modules`.
 * @returns {{ name: string, root: string, build: string, addons: string[] }[]} Declarations in directory order.
 */
export function nativePackageBuilds(runtimeRoot) {
  const found = []
  /** @param {string} modules */
  const visit = (modules) => {
    if (!existsSync(modules)) return
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const directories = entry.name.startsWith('@')
        ? readdirSync(join(modules, entry.name), { withFileTypes: true }).filter(child => child.isDirectory())
          .map(child => join(modules, entry.name, child.name))
        : [join(modules, entry.name)]
      for (const root of directories) {
        const declaration = nativePackageBuildAt(root)
        if (declaration !== undefined) found.push(declaration)
        visit(join(root, 'node_modules'))
      }
    }
  }
  visit(join(runtimeRoot, 'node_modules'))
  return found
}

/**
 * The `vcvarsall.bat` argument that targets `arch` from this build host.
 * @param {string} host - Build host architecture.
 * @param {string} arch - Target architecture.
 * @returns {string} The target itself on a matching host, otherwise `<host>_<target>`.
 */
export function vcvarsallTarget(host, arch) {
  return host === arch ? arch : `${host}_${arch}`
}

/**
 * Read the environment `set` printed after {@link ENVIRONMENT_MARKER}.
 * @param {string} output - Output of `vcvarsall.bat`, the marker, and `set`.
 * @returns {Record<string, string>} The environment variables after the marker; throws when the marker is missing.
 */
export function parseDeveloperEnvironment(output) {
  const lines = output.split(/\r?\n/u)
  // `echo` keeps the space before `&&`.
  const marker = lines.findIndex(line => line.trim() === ENVIRONMENT_MARKER)
  if (marker < 0) throw new Error('desktop native build: vcvarsall.bat printed no environment')
  /** @type {Record<string, string>} */
  const environment = {}
  for (const line of lines.slice(marker + 1)) {
    const separator = line.indexOf('=', 1)
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return environment
}

/**
 * The environment native builds for a target run in: the packaging environment, or on Windows the MSVC developer
 * environment that `vcvarsall.bat` of the newest Visual Studio installation with the target's C++ tools sets up, with
 * `DSH_NODE_API_HEADERS` added.
 * @param {string} arch - Target architecture.
 * @param {NodeJS.ProcessEnv} environment - Packaging environment.
 * @returns {NodeJS.ProcessEnv} The build environment; throws when Windows lacks the target's C++ tools.
 */
export function nativeBuildEnvironment(arch, environment = process.env) {
  const headers = dirname(createRequire(import.meta.url).resolve('node-api-headers/package.json'))
  return { ...toolchainEnvironment(arch, environment), DSH_NODE_API_HEADERS: headers }
}

/**
 * @param {string} arch - Target architecture.
 * @param {NodeJS.ProcessEnv} environment - Packaging environment.
 * @returns {NodeJS.ProcessEnv} The packaging environment, or on Windows the target's MSVC developer environment.
 */
function toolchainEnvironment(arch, environment) {
  if (process.platform !== 'win32' || environment.VSCMD_ARG_TGT_ARCH === arch) return environment
  const component = arch === 'arm64' ? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' : 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
  // Windows names are case-insensitive, but a copied environment object no longer is.
  const programFiles = Object.entries(environment).find(([name]) => name.toLowerCase() === 'programfiles(x86)')?.[1]
  const located = programFiles === undefined ? undefined : spawnSync(join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'),
    ['-latest', '-products', '*', '-requires', component, '-property', 'installationPath'], { encoding: 'utf8', env: environment, windowsHide: true })
  const installation = located?.status === 0 ? located.stdout.trim() : ''
  if (installation === '') throw new Error(`desktop native build: win32-${arch} needs Visual Studio C++ build tools (${component})`)
  const vcvarsall = join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
  const target = vcvarsallTarget(process.arch, arch)
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"call "${vcvarsall}" ${target} && echo ${ENVIRONMENT_MARKER} && set"`], {
    encoding: 'utf8', env: environment, windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`desktop native build: vcvarsall.bat ${target} failed (${String(result.status)}): ${result.stdout}`)
  return parseDeveloperEnvironment(result.stdout)
}

/**
 * Run one package's declared build for a target architecture on the host toolchain.
 * @param {{ name: string, root: string, build: string }} declaration - Package declaration.
 * @param {string} arch - Target architecture.
 * @param {NodeJS.ProcessEnv} environment - Build environment from {@link nativeBuildEnvironment}.
 * @returns {void}
 */
export function buildNativePackage(declaration, arch, environment = process.env) {
  const result = spawnSync(process.execPath, [join(declaration.root, declaration.build), '--arch', arch], { cwd: declaration.root, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`desktop runtime: ${declaration.name} native build failed (${String(result.status)})`)
}

/**
 * Expand one declared addon path for a target.
 * @param {string} addon - Declared path with `{platform}` and `{arch}` placeholders.
 * @param {{ platform: string, arch: string }} target - Electron execution target.
 * @returns {string} Target-specific relative path.
 */
function targetPath(addon, target) {
  return addon.replaceAll('{platform}', target.platform).replaceAll('{arch}', target.arch)
}

/**
 * Compile every declared native addon in the runtime for the packaged target with the host toolchain.
 * @param {string} runtimeRoot - Desktop runtime root containing `node_modules`.
 * @param {string} arch - Target architecture.
 * @returns {string[]} Names of the packages whose builds ran.
 */
export function buildNativePackages(runtimeRoot, arch) {
  const declarations = nativePackageBuilds(runtimeRoot)
  if (declarations.length === 0) return []
  const environment = nativeBuildEnvironment(arch)
  for (const declaration of declarations) buildNativePackage(declaration, arch, environment)
  return declarations.map(declaration => declaration.name)
}

/**
 * Require every declared addon of the target, its build record, its hash, and its architecture.
 * @param {string} runtimeRoot - Desktop runtime root containing `node_modules`.
 * @param {{ platform: string, arch: string }} target - Electron execution target.
 * @returns {void}
 */
export function verifyNativePackages(runtimeRoot, target) {
  const name = `${target.platform}-${target.arch}`
  for (const declaration of nativePackageBuilds(runtimeRoot)) {
    for (const declared of declaration.addons) {
      const addon = join(declaration.root, targetPath(declared, target))
      if (!existsSync(addon)) throw new Error(`desktop runtime: ${addon} is missing; prepare:dsh builds ${declaration.name} for the target`)
      const bytes = readFileSync(addon)
      const recordPath = addon.replace(/\.node$/u, '.json')
      const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : undefined
      if (record?.platform !== name || record.sha256 !== createHash('sha256').update(bytes).digest('hex')) {
        throw new Error(`desktop runtime: ${addon} differs from its build record`)
      }
      if (!['x64', 'arm64'].includes(target.arch) || !matchingArchitecture(bytes, target)) throw new Error(`desktop runtime: ${addon} is not ${name}`)
    }
  }
}
