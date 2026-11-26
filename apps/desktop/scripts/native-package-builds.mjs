/**
 * Native addon build support for Desktop packaging: the build environment for a target (on Windows, the MSVC
 * developer environment `vcvarsall.bat` sets up, with `DSH_NODE_API_HEADERS` naming Desktop's `node-api-headers`
 * package: `include/` headers and `def/` Windows symbol lists) and object-file architecture checks.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

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
