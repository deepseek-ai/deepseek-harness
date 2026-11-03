/** Content and machine identity for reusing a signed helper before installing dependencies. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readDesktopPackageSettings } from '../../apps/desktop/scripts/desktop-file-settings.mjs'
import { resolveMacOSSigningEnvironment } from '../../apps/desktop/scripts/desktop-release-environment.mjs'

const sourcePaths = [
  'packages/experimental/cua-macos/native', 'scripts/cua-helper', 'apps/desktop/scripts',
  '.github/workflows/cua-helper-package.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  ':(glob)tsconfig*.json',
]

/**
 * Hash tracked build inputs by path, raw bytes and executable mode; product version and unrelated packages are excluded.
 * Missing tracked files and links fail; build outputs and untracked files never enter the digest.
 * @param root - Clean repository checkout containing all helper build inputs.
 * @returns SHA-256 of the helper sources, resources, packaging scripts and locked dependencies.
 */
export function cuaHelperSourceDigest(root: string): string {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...sourcePaths], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).sort()
  for (const required of ['packages/experimental/cua-macos/native/Package.swift', 'scripts/cua-helper/package.ts', 'pnpm-lock.yaml']) {
    if (!files.includes(required)) throw new Error(`CUA source: missing tracked build input ${required}`)
  }
  const hash = createHash('sha256')
  for (const file of files) {
    const path = join(root, file)
    const stat = lstatSync(path)
    if (!stat.isFile()) throw new Error(`CUA source: build input must be a regular file: ${file}`)
    hash.update(`${file}\0`).update(createHash('sha256').update(readFileSync(path)).digest())
      .update(Buffer.from([(stat.mode & 0o111) === 0 ? 0 : 1]))
  }
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('packageManager' in manifest) || typeof manifest.packageManager !== 'string') {
    throw new Error('CUA source: package.json must declare packageManager')
  }
  return hash.update(`packageManager\0${manifest.packageManager}`).digest('hex')
}

/**
 * Read the signing preset's public identity and certificate location without installing desktop dependencies.
 * @param environment - Actions environment with the machine configuration directory and selected preset.
 * @returns File-owned signing settings and the selected preset; no values are logged.
 */
export function readCuaSigningSettings(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = environment.DSH_PACKAGING_CONFIG_DIR
  const preset = environment.DSH_PACKAGING_PRESET
  if (!root || !isAbsolute(root) || !['test', 'production'].includes(preset ?? '')) {
    throw new Error('CUA reuse: DSH_PACKAGING_CONFIG_DIR and a test or production preset are required')
  }
  const settings = readDesktopPackageSettings(join(root, 'secrets/macos-signing.env'), () => true)
  return { ...settings, DSH_PACKAGING_PRESET: preset }
}

/**
 * Bind source bytes to the active toolchain, preset and signing certificate container.
 * @param source - Current source digest.
 * @param environment - File-owned signing settings including CSC_LINK and the selected preset.
 * @param run - Synchronous toolchain query; injected tests never invoke signing or Apple's services.
 * @returns SHA-256 build key; credential values and certificate bytes are not recorded.
 */
export function cuaHelperBuildKey(source: string, environment: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => string = (command, args) =>
    execFileSync(command, args, { encoding: 'utf8', timeout: 60_000, stdio: 'pipe' }).trim()): string {
  const signing = resolveMacOSSigningEnvironment(environment)
  const certificate = environment.CSC_LINK
  if (!certificate || !isAbsolute(certificate)) throw new Error('CUA reuse: CSC_LINK must identify the signing certificate file')
  const configuration = {
    source, preset: environment.DSH_PACKAGING_PRESET ?? 'local', ...signing,
    certificate: createHash('sha256').update(readFileSync(certificate)).digest('hex'),
    node: process.version,
    swift: run('/usr/bin/xcrun', ['swift', '--version']),
    clang: run('/usr/bin/xcrun', ['clang', '--version']),
    sdk: run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']),
    python: run('/usr/bin/xcrun', ['python3', '--version']),
  }
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const env = process.env
  if (!env.GITHUB_OUTPUT || !env.GITHUB_STEP_SUMMARY) throw new Error('CUA build inputs: Actions context required')
  const root = resolve(import.meta.dirname, '../..')
  const sourceDigest = cuaHelperSourceDigest(root)
  const buildKey = cuaHelperBuildKey(sourceDigest, readCuaSigningSettings(env))
  appendFileSync(env.GITHUB_OUTPUT, `source-digest=${sourceDigest}\nbuild-key=${buildKey}\n`)
  appendFileSync(env.GITHUB_STEP_SUMMARY, `CUA helper 源码摘要：\`${sourceDigest}\`。\n\n`)
  console.log(`CUA helper source digest: ${sourceDigest}`)
}
