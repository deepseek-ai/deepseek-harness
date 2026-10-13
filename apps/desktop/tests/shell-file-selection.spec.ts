import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Packager, type Configuration, type PlatformSpecificBuildOptions } from 'app-builder-lib'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import type { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { MacPackager } from 'app-builder-lib/out/macPackager.js'
import { PM } from 'app-builder-lib/out/node-module-collector/index.js'
import type { PlatformPackager } from 'app-builder-lib/out/platformPackager.js'
import type { ResolvedFileSet } from 'app-builder-lib/out/util/appFileCopier.js'
import { WinPackager } from 'app-builder-lib/out/winPackager.js'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

const require = createRequire(import.meta.url)
// The locked builder exports these packaging operations without declarations.
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js') as {
  getNodeModuleFileMatcher: (app: string, destination: string, expand: (value: string) => string,
    options: PlatformSpecificBuildOptions, packager: Packager) => FileMatcher
}
const { computeNodeModuleFileSets } = require('app-builder-lib/out/util/appFileCopier.js') as {
  computeNodeModuleFileSets: (packager: PlatformPackager<PlatformSpecificBuildOptions>, matcher: FileMatcher) => Promise<ResolvedFileSet[]>
}
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil.js') as {
  AsarPackager: new (packager: object, configuration: object) => { pack(files: ResolvedFileSet[]): Promise<void> }
}

it.each([
  ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'],
] as const)('omits shell build files from %s/%s ASAR while retaining runtime assets', async (platform, arch) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-shell-files-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const appDir = join(root, 'app')
  const resources = join(root, 'resources')
  const destination = join(resources, 'app')
  await mkdir(resources, { recursive: true })
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { shell: '1.0.0', '@fixture/shared': '2.0.0' } }
  const packages = [
    ['node_modules/shell', { name: 'shell', version: '1.0.0', dependencies: { '@fixture/shared': '1.0.0' } }],
    ['node_modules/@fixture/shared', { name: '@fixture/shared', version: '2.0.0' }],
    ['node_modules/shell/node_modules/@fixture/shared', { name: '@fixture/shared', version: '1.0.0' }],
  ] as const
  const omitted = [
    'index.js.map', 'lib/index.cjs.map', 'lib/index.mjs.map', 'lib/index.ts.map',
    'lib/index.cts.map', 'lib/index.mts.map', 'lib/style.css.map', 'tsconfig.tsbuildinfo', 'lib/types/tsconfig.tsbuildinfo',
  ]
  const retained = [
    'index.js', 'lib/index.cjs', 'lib/index.mjs', 'lib/index.ts', 'lib/index.cts', 'lib/index.mts',
    'lib/style.css', 'lib/types/runtime.js', 'data.map', 'lib/data.map', 'lib/addon.node', 'lib/engine.wasm', 'LICENSE', 'NOTICE',
  ]
  const originals = new Map<string, Buffer>()
  for (const [directory, metadata] of packages) {
    for (const name of [...retained, ...omitted, 'package.json']) {
      const file = join(appDir, directory, name)
      const contents = Buffer.from(name === 'package.json' ? JSON.stringify(metadata) : `${directory}/${name}\n`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, contents)
      originals.set(file, contents)
    }
  }
  await writeFile(join(appDir, 'package.json'), JSON.stringify(manifest))
  const desktopConfig = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.shell-files',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
    DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    APPLE_KEYCHAIN_PROFILE: 'shell-files-test',
    DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  }, platform, arch)
  const config: Configuration = {
    files: desktopConfig.files.map(file => typeof file === 'string' ? file : { ...file, filter: [...file.filter] }),
  }
  const info = new Packager({ projectDir: appDir })
  onTestFinished(() => info.tempDirManager.cleanup())
  Object.defineProperties(info, {
    appDir: { value: appDir }, config: { value: config },
    metadata: { value: manifest }, originalMetadata: { value: manifest },
    appInfo: { value: { type: 'commonjs' } },
    framework: { value: { name: 'electron' } },
  })
  // Traverse the installed fixture without invoking a host package manager.
  vi.spyOn(info, 'getPackageManager').mockResolvedValue(PM.TRAVERSAL)
  vi.spyOn(info, 'getWorkspaceRoot').mockResolvedValue(appDir)
  const packager = platform === 'darwin' ? new MacPackager(info) : new WinPackager(info)
  const matcher = getNodeModuleFileMatcher(appDir, destination, value => value, packager.platformSpecificBuildOptions, info)
  const fileSets = await computeNodeModuleFileSets(packager, matcher)
  expect(fileSets.map(set => relative(destination, set.destination).replaceAll('\\', '/')).sort())
    .toEqual(packages.map(([directory]) => directory).sort())
  const consoleLog = console.log
  try {
    await new AsarPackager(packager, {
      defaultDestination: destination, resourcePath: resources, options: { smartUnpack: false },
    }).pack(fileSets)
  } finally {
    // Builder temporarily intercepts console.log while writing ASAR.
    console.log = consoleLog
  }
  const archive = await readAsar(join(resources, 'app.asar'))
  for (const [directory] of packages) {
    for (const name of [...retained, 'package.json']) {
      expect(await archive.readFile(join(directory, name))).toEqual(originals.get(join(appDir, directory, name)))
    }
    for (const name of omitted) expect(archive.getNode(join(directory, name))).toBeUndefined()
  }
  for (const [file, contents] of originals) expect(await readFile(file)).toEqual(contents)
})
