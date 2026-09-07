/** Build the release seed through the same embedded pnpm used on first launch. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { createSeedMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import {
  archivePnpmStore,
  extractPnpmStoreArchives,
  removePnpmProjectRegistrations,
} from '../src/seed-store.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import {
  signMacOSSeedStore,
  verifyMacOSSeedStore,
} from './macos-seed-store.ts'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const SEED_OUTPUT_ROOT = BUILD_PATHS.seed
const SEED_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-'))
const STORE_ROOT = join(SEED_ROOT, 'store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.seedPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(RUNTIME_ROOT, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const PNPM = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.mjs')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop seed: ${subject} has no version`)
  return manifest.version
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop seed: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop seed: pnpm command is required')
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      PNPM,
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: SEED_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        PATH: `${dirname(NODE)}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop seed: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

function inventory(root: string): readonly { path: string; bytes: number; sha256: string }[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
      else throw new Error(`desktop seed: unsupported filesystem entry ${relative(root, path)}`)
    }
  }
  visit(root)
  return files.sort().map((path) => {
    const body = readFileSync(path)
    return {
      path: relative(root, path).split(sep).join('/'),
      bytes: statSync(path).size,
      sha256: createHash('sha256').update(body).digest('hex'),
    }
  })
}

async function verifyOfflineInstallation(release: DesktopRelease): Promise<void> {
  const installedModules = join(SEED_ROOT, 'node_modules')
  try {
    await runPnpm(['install', '--offline', '--frozen-lockfile', '--trust-lockfile'])
    const hostRoot = join(installedModules, ...DESKTOP_HOST_PACKAGE.split('/'))
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(hostRoot, file))) {
        throw new Error(`desktop seed: local ${DESKTOP_HOST_PACKAGE}@${release.version} does not contain ${file}`)
      }
    }
  } finally {
    rmSync(installedModules, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  rmSync(SEED_OUTPUT_ROOT, { recursive: true, force: true })
  rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  try {
    const release = desktopRelease()
    copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(SEED_ROOT, DESKTOP_PACKAGE_SET_FILE))
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(SEED_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
    createSeedMetadata(SEED_ROOT, release)
    await runPnpm(['install', '--lockfile-only'])
    verifyDesktopCoreLockfile(
      readFileSync(join(SEED_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(SEED_ROOT, release.version),
    )
    const installedModules = join(SEED_ROOT, 'node_modules')
    await runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile', '--ignore-scripts'])
    rmSync(installedModules, { recursive: true, force: true })
    rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
    await verifyOfflineInstallation(release)
    const targetPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform
    let signedMachOFiles: number | undefined
    let macOSSigning: ReturnType<typeof resolveMacOSSigningEnvironment> | undefined
    if (targetPlatform === 'darwin') {
      macOSSigning = resolveMacOSSigningEnvironment(process.env)
      const signing = await signMacOSSeedStore(
        STORE_ROOT,
        resolveDesktopAppId(process.env),
        macOSSigning,
      )
      signedMachOFiles = signing.signedFiles
      process.stdout.write(
        `desktop seed: signed ${signing.signedFiles} Mach-O files, updated ${signing.updatedIndexRows} pnpm index records, and pruned ${signing.prunedOrphans} native orphans\n`,
      )
      await verifyOfflineInstallation(release)
    }
    removePnpmProjectRegistrations(STORE_ROOT)
    archivePnpmStore(SEED_ROOT, STORE_ROOT)
    if (macOSSigning !== undefined && signedMachOFiles !== undefined) {
      const extractedStore = mkdtempSync(join(tmpdir(), 'dsh-desktop-seed-verification-'))
      try {
        extractPnpmStoreArchives(SEED_ROOT, extractedStore)
        const verified = verifyMacOSSeedStore(extractedStore, macOSSigning)
        if (verified !== signedMachOFiles) {
          throw new Error(`desktop seed: archived store contains ${verified} signed Mach-O files; expected ${signedMachOFiles}`)
        }
      } finally {
        rmSync(extractedStore, { recursive: true, force: true })
      }
    }
    const records = inventory(SEED_ROOT).filter(entry => entry.path !== 'integrity.json')
    writeFileSync(join(SEED_ROOT, 'integrity.json'), `${JSON.stringify({ schemaVersion: 2, files: records }, undefined, 2)}\n`)
    cpSync(SEED_ROOT, SEED_OUTPUT_ROOT, { recursive: true })
  } finally {
    rmSync(SEED_ROOT, { recursive: true, force: true })
  }
}

await main()
