/**
 * Build Desktop's Node-API 8 shared-texture addons with the target C++ toolchain: clang on macOS, MSVC on Windows.
 * The Desktop Host loads frame-forwarding.node and shared-texture-hop.node. Main loads shared-texture-ingress.node.
 * All three are written with their build records to `apps/desktop/lib/native/<platform>-<arch>/`.
 * Usage: `tsx scripts/build.ts [--arch x64|arm64]`. Headers come from `DSH_NODE_INCLUDE` or Desktop's `node-api-headers`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeBuildEnvironment } from '../../../scripts/native-package-builds.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const archIndex = process.argv.indexOf('--arch')
const requestedArch = archIndex < 0 ? process.arch : process.argv[archIndex + 1]
if ((requestedArch !== 'arm64' && requestedArch !== 'x64') || (process.platform !== 'darwin' && process.platform !== 'win32')) {
  throw new Error(`shared-texture: unsupported build target ${process.platform}-${String(requestedArch)}`)
}
const arch: 'arm64' | 'x64' = requestedArch
const platform = `${process.platform}-${arch}`
const output = resolve(root, '..', '..', 'lib', 'native', platform)
mkdirSync(output, { recursive: true })

const environment = nativeBuildEnvironment(arch)
const headers = environment.DSH_NODE_API_HEADERS ?? ''
if (headers === '') throw new Error('shared-texture: DSH_NODE_API_HEADERS is unset')

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: environment })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`shared-texture: ${command} failed (${String(result.status)})`)
}

const candidates = [environment.DSH_NODE_INCLUDE, join(headers, 'include'), resolve(dirname(process.execPath), '..', 'include', 'node')]
  .filter((path): path is string => path !== undefined)
const include = candidates.find(path => existsSync(join(path, 'node_api.h')))
if (include === undefined) throw new Error(`shared-texture: Node-API headers missing; set DSH_NODE_INCLUDE or install Node with development headers (looked in ${candidates.join(', ')})`)

/** Extra link inputs per platform. */
type Libraries = Record<'darwin' | 'win32', readonly string[]>

/** Compile one addon from its sources and write its build record beside it. */
function buildAddon(name: string, moduleName: string, sources: readonly string[], libraries: Libraries,
  record: object = {}, windowsCompilerFlags: readonly string[] = []): void {
  const addon = resolve(output, `${name}.node`)
  rmSync(resolve(output, `${name}.json`), { force: true })
  const defines = ['NAPI_VERSION=8', `NODE_GYP_MODULE_NAME=${moduleName}`]
  if (process.platform === 'win32') {
    // Objects, the Node-API import library, and the addon's own import library stay out of the packaged directory.
    const scratch = mkdtempSync(join(tmpdir(), `dsh-${name}-`))
    try {
      const library = join(scratch, 'node.lib')
      run('lib.exe', ['/nologo', `/def:${join(headers, 'def', 'node_api.def')}`, '/name:node.exe', `/machine:${arch}`, `/out:${library}`])
      run('cl.exe', ['/nologo', '/LD', '/O2', '/EHsc', '/MD', '/std:c++17', '/W4', ...windowsCompilerFlags, `/I${include}`,
        ...defines.map(define => `/D${define}`), `/Fo${scratch}\\`, ...sources, 'win-delay-load.cc',
        '/link', '/DELAYLOAD:node.exe', 'delayimp.lib', library, ...libraries.win32, `/IMPLIB:${join(scratch, `${name}.lib`)}`, `/OUT:${addon}`])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  } else {
    run('clang++', [
      '-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-mmacosx-version-min=11.0', '-std=c++17', '-O2', '-fPIC', '-Wall', '-Wextra',
      `-I${include}`, ...defines.map(define => `-D${define}`),
      '-shared', '-undefined', 'dynamic_lookup', `-Wl,-install_name,@rpath/${name}.node`,
      ...sources, '-framework', 'IOSurface', '-framework', 'CoreFoundation', ...libraries.darwin, '-o', addon,
    ])
    run('codesign', ['--force', '--sign', '-', addon])
  }
  writeFileSync(resolve(output, `${name}.json`), `${JSON.stringify({
    platform, ...record,
    sha256: createHash('sha256').update(readFileSync(addon)).digest('hex'),
  }, null, 2)}\n`)
  console.log(`shared-texture: built ${addon}`)
}

buildAddon('shared-texture-hop', 'dsh_shared_texture_hop', ['hop.cc', `hop-${process.platform}.cc`], { darwin: [], win32: [] })
buildAddon('shared-texture-ingress', 'dsh_shared_texture_ingress', ['ingress.cc', `ingress-${process.platform}.cc`],
  { darwin: ['-lbsm'], win32: ['bcrypt.lib', 'dxgi.lib'] })

const receiver = resolve(root, '../../../../packages/experimental/frame-forwarding/native')
const header = readFileSync(join(receiver, 'transport.h'), 'utf8')
const protocolVersion = Number(/DSH_FRAME_FORWARDING_PROTOCOL_VERSION (\d+)/u.exec(header)?.[1])
if (!Number.isInteger(protocolVersion)) throw new Error('Missing frame-forwarding protocol version in transport.h')
buildAddon('frame-forwarding', 'dsh_frame_forwarding', ['receiver.cc', 'transport.cc', 'desktop-bridge.cc'].map(file => join(receiver, file)),
  { darwin: ['-lbsm'], win32: ['d3d11.lib', 'dxgi.lib', 'advapi32.lib', 'bcrypt.lib'] },
  { protocolVersion, capabilities: ['transferable-tx', 'producer-local-handles'] }, ['/D_WIN32_WINNT=0x0602'])
copyFileSync(join(receiver, 'LICENSE'), join(output, 'frame-forwarding.LICENSE'))
