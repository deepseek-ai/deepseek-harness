/** Build a relocatable, native-host SSH helper archive with its private Node workers. */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'tsdown'
import { create as createTar } from 'tar'
import { verifyRuntimeClosure } from './verify-runtime-closure.ts'
import { pnpmInvocation, restoreLegacyHoists } from './executable-packaging.ts'
import { materializeStagedLinks, deduplicateStagedWorkspacePackages } from './build-exe-for-python-sdk-staging.ts'
import { resolveLinuxNodePtyAddon } from './executable-native-pty.ts'
import { artifactManifestSchema, fileDigest, payloadFiles, SSH_HELPER_TARGETS, verifyPayload, type SshHelperTarget } from './ssh-helper/artifact.ts'
import { probeHelper } from './ssh-helper/probe.ts'
import { verifyNativePayload } from './ssh-helper/native.ts'

const root = resolve(import.meta.dirname, '..')
const closureDirectory = 'packages/ssh/ssh-helper-runtime'
const closureName = '@deepseek-ai/dsh-ssh-helper-runtime'
const assets = ['package.json', 'lib/**/*.js', ...['js', 'cjs', 'mjs', 'json', 'node', 'so', 'so.*', 'dylib', 'wasm', 'sh', 'bash'].map(extension => `node_modules/**/*.${extension}`)]

interface Manifest { name: string; version: string; license?: string; dependencies?: Record<string, string> }

async function manifest(path: string): Promise<Manifest> { return JSON.parse(await readFile(path, 'utf8')) as Manifest }

async function run(command: string, args: string[]): Promise<void> {
  console.log(`ssh-helper build: ${[command, ...args].join(' ')}`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`SSH helper build command failed (${code ?? signal}): ${command}`))
    })
  })
}

async function pnpm(...args: string[]): Promise<void> { const [command, argv] = pnpmInvocation(args); await run(command, argv) }

async function compileRuntime(dependencies: Readonly<Record<string, string>>): Promise<void> {
  await pnpm('exec', 'tsx', 'native/system/scripts/build.ts')
  await pnpm('exec', 'tsc', '-b', closureDirectory, 'native/system/packages/entry')
  const names = new Set([closureName, ...Object.keys(dependencies)])
  for (const path of globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root }).sort()) {
    if (!names.has((await manifest(join(root, path))).name)) continue
    const cwd = dirname(join(root, path))
    const config = join(cwd, 'tsdown.config.ts')
    if (existsSync(config)) await build({ cwd, config })
    else await build({ cwd, config: false, entry: ['lib/types/{index,invariant,startup}.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false })
  }
}

async function prepareNative(staging: string, product: string, platform: string, arch: 'x64' | 'arm64'): Promise<void> {
  const pty = join(staging, 'node_modules', 'node-pty')
  await rm(join(pty, 'build'), { recursive: true, force: true })
  for (const entry of await readdir(join(pty, 'prebuilds'))) {
    if (entry !== `${platform}-${arch}`) await rm(join(pty, 'prebuilds', entry), { recursive: true, force: true })
  }
  if (platform === 'linux') {
    const addon = resolveLinuxNodePtyAddon(join(root, 'packages/subprocess/subprocess-local/node_modules/node-pty'), arch)
    await mkdir(join(pty, 'build/Release'), { recursive: true })
    await copyFile(addon, join(pty, 'build/Release/pty.node'))
  } else {
    const destination = join(product, 'dsh-ssh-helper-spawn-helper')
    await copyFile(join(pty, 'prebuilds', `darwin-${arch}`, 'spawn-helper'), destination)
    await chmod(destination, 0o755)
  }
  const source = join(root, 'native/system/packages', `${platform}-${arch}`)
  const destination = join(product, 'native/system')
  await mkdir(destination, { recursive: true })
  await copyFile(join(source, 'package.json'), join(destination, 'package.json'))
  await cp(join(source, 'bin'), join(destination, 'bin'), { recursive: true })
  // The Linux carrier targets glibc; no unused musl addon travels in this archive.
  if (platform === 'linux') await rm(join(destination, 'bin/musl'), { recursive: true, force: true })
  const binaries = platform === 'linux' ? ['bin/landlock-run', 'bin/glibc/system.node'] : ['bin/system.node']
  for (const binary of binaries) {
    if (!(await lstat(join(destination, binary))).isFile()) throw new Error(`Missing SSH native resource: ${binary}`)
  }
}

async function copyLicenses(staging: string, product: string): Promise<void> {
  const destination = join(product, 'LICENSES')
  await mkdir(destination, { recursive: true })
  const inventory: { name: string; version: string; license?: string }[] = []
  for (const path of globSync(['node_modules/*/package.json', 'node_modules/@*/*/package.json'], { cwd: staging }).sort()) {
    const directory = dirname(join(staging, path))
    const data = await manifest(join(staging, path))
    inventory.push({ name: data.name, version: data.version, ...(data.license === undefined ? {} : { license: data.license }) })
    const licenses = (await readdir(directory)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/i.test(name))
    for (const name of licenses) {
      const source = join(directory, name)
      if (!(await lstat(source)).isFile()) continue
      const output = join(destination, data.name.replaceAll('/', '__'), name)
      await mkdir(dirname(output), { recursive: true })
      await copyFile(source, output)
    }
  }
  await copyFile(join(root, 'LICENSE'), join(destination, 'deepseek-harness-MIT.txt'))
  await copyFile(join(root, 'native/system/LICENSE'), join(destination, 'node-addon-system-BSD.txt'))
  await writeFile(join(destination, 'packages.json'), `${JSON.stringify(inventory, null, 2)}\n`)
}

/**
 * Build the selected native target and retain only its complete release archive.
 * @param argv - command-line arguments, excluding the interpreter and script.
 */
export async function buildSshHelper(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: {
    target: { type: 'string' }, output: { type: 'string' },
    'skip-build': { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  } })
  const host = `node24-${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`
  const selected = values.target ?? host
  if (!SSH_HELPER_TARGETS.some(target => target === selected)) throw new Error(`Unsupported SSH helper target: ${selected}`)
  if (!values['dry-run'] && selected !== host) throw new Error(`SSH helper target ${selected} requires its native host; current host is ${host}`)
  const target = selected as SshHelperTarget
  const definition = await manifest(join(root, closureDirectory, 'package.json'))
  const closure = await verifyRuntimeClosure(root, `${closureDirectory}/package.json`, false)
  if (closure.failures.length > 0) throw new Error(`SSH helper runtime dependencies are incomplete:\n${closure.failures.join('\n')}`)
  const output = resolve(root, values.output ?? 'dist-exe/ssh-helper')
  if (values['dry-run']) {
    console.log(`SSH helper ${target}: ${values['skip-build'] ? 'reuse built modules' : 'compile runtime'} -> deploy ${closureName} -> pkg --sea -> handshake -> ${output}`)
    return
  }
  if (!values['skip-build']) await compileRuntime(definition.dependencies ?? {})
  await mkdir(join(root, '.dsh-build'), { recursive: true })
  const temporary = await mkdtemp(join(root, '.dsh-build/ssh-helper-'))
  try {
    const staging = join(temporary, 'staging')
    const product = join(temporary, 'dsh-ssh-helper')
    await mkdir(product)
    try {
      await pnpm('--filter', closureName, 'deploy', '--legacy', '--prod', '--config.allow-unused-patches=true', '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.link-workspace-packages=true', '--config.hoist-workspace-packages=false', staging)
    } finally {
      // Legacy deploy records production-only workspace state; pnpm's next exec otherwise prunes build tools.
      await pnpm('install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts')
    }
    await restoreLegacyHoists(staging, join(root, closureDirectory, 'node_modules'))
    await materializeStagedLinks(staging)
    await deduplicateStagedWorkspacePackages(staging, root)
    await prepareNative(staging, product, process.platform, process.arch as 'x64' | 'arm64')
    await verifyNativePayload(join(staging, 'node_modules'), target)
    const stagedManifest = await manifest(join(staging, 'package.json'))
    await writeFile(join(staging, 'runtime-bootstrap.mjs'), 'import { runSshHelperRuntime } from "./lib/index.js";\nawait runSshHelperRuntime();\n')
    await writeFile(join(staging, 'package.json'), `${JSON.stringify({ ...stagedManifest,
      bin: 'runtime-bootstrap.mjs', pkg: { assets, ignore: ['node_modules/@deepseek-ai/node-addon-system-*/**/*'] },
    }, null, 2)}\n`)
    const executable = join(product, 'dsh-ssh-helper')
    await pnpm('exec', 'pkg', staging, '--sea', '--targets', target, '--output', executable)
    await chmod(executable, 0o755)
    await verifyNativePayload(product, target)
    await copyLicenses(staging, product)
    const hello = await probeHelper(executable, product)
    if (hello.kind !== 'executable' || hello.executable !== executable) throw new Error('Packaged SSH helper did not report its physical executable')
    const metadata = artifactManifestSchema.parse({
      format: 1, version: definition.version, target,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
      protocol: hello.protocol, nodeVersion: hello.nodeVersion,
      files: await Promise.all((await payloadFiles(product)).map(async path => ({
        path, sha256: await fileDigest(join(product, path)), mode: (await lstat(join(product, path))).mode & 0o777,
      }))),
    })
    await writeFile(join(product, 'manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    await verifyPayload(product)
    await mkdir(output, { recursive: true })
    const archive = join(output, `dsh-ssh-helper-${definition.version}-${target.slice('node24-'.length)}.tar.gz`)
    await createTar({ cwd: temporary, file: archive, gzip: true, portable: true }, ['dsh-ssh-helper'])
    await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  ${basename(archive)}\n`)
    console.log(`SSH helper archive: ${archive}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) await buildSshHelper(process.argv.slice(2))
