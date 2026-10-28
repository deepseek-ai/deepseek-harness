/** Builds an isolated native payload through the production NSIS configuration and exercises its UI. */
import { readInstallerLocales, renderInstallerStrings } from './installer-locales.mjs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createWindowsTokenSigner, installWindowsNsisBootstrapSigner, scrubWindowsSigningEnvironment } from './windows-sign.mjs'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createPackagingRun } from './packaging-run.mjs'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Installer UI checks require an interactive Windows x64 desktop')
}
const execute = promisify(execFile)
const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { build, Platform, Arch } = require('electron-builder')
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js')
const guid = randomUUID()
const id = guid.replaceAll('-', '')
const productName = `Harness Installer Test ${id.slice(0, 8)}`
// Scoped like the shipped package so Electron user data nests under a scope directory; the scope is unique per run.
const packageName = `@harness-installer-test-${id.slice(0, 8)}/app-${id}`
const uninstallOnly = process.argv.includes('--uninstall-only')
const outputRoot = join(appRoot, '.desktop-build', 'installer-tests')
await mkdir(outputRoot, { recursive: true })
const output = await mkdtemp(join(outputRoot, 'run-'))
const payload = join(output, 'payload')
await mkdir(join(payload, 'resources'), { recursive: true })
const previousEnvironment = { ...process.env }
const signingEnvironment = process.argv.includes('--signed') ? loadDesktopPackageEnvironment('win32') : {}
const signingRun = process.argv.includes('--signed')
  ? createPackagingRun(join(output, 'packaging-runs'), { target: 'installer-test' }) : undefined
const sign = process.argv.includes('--signed') ? createWindowsTokenSigner({
  certificateFile: signingEnvironment.DSH_DESKTOP_WINDOWS_CER_FILE,
  signTool: signingEnvironment.DSH_DESKTOP_WINDOWS_SIGNTOOL,
  tokenPin: signingEnvironment.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
  keyContainer: signingEnvironment.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
  runDirectory: signingRun.directory,
}) : undefined
let succeeded = false
try {
  Object.assign(process.env, {
    DSH_DESKTOP_APP_ID: `com.deepseek.harness.installertest.n${id}`,
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_7Z_FILTER: 'BCJ',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: signingEnvironment.DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN
      ?? 'https://test.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: signingEnvironment.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG
      ?? JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    ...signingRun ? { DSH_DESKTOP_PACKAGING_RUN_DIR: signingRun.directory } : {},
  })
  const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
  const childOptions = { env: scrubWindowsSigningEnvironment(process.env), windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(appRoot, 'scripts', 'prepare-windows-installer.ps1'), '-OutputDirectory', join(output, 'ui'), '-CompileProgressOnly'], childOptions)
  const progressTest = join(output, 'ui', 'progress-test.exe')
  const presentationTest = join(output, 'ui', 'presentation-test.exe')
  const renderTest = join(output, 'ui', 'render-test.exe')
  const cleanupTest = join(output, 'ui', 'data-cleanup-test.exe')
  if (sign) {
    await sign({ path: progressTest, hash: 'sha256', isNest: false })
    await sign({ path: presentationTest, hash: 'sha256', isNest: false })
    await sign({ path: renderTest, hash: 'sha256', isNest: false })
    await sign({ path: cleanupTest, hash: 'sha256', isNest: false })
    await sign({ path: join(output, 'ui', 'window-frame.dll'), hash: 'sha256', isNest: false })
    installWindowsNsisBootstrapSigner({ sign })
  }
  if (!uninstallOnly) {
    await execute(progressTest, [], childOptions)
    await execute(presentationTest, [], childOptions)
    const renderResults = []
    const themeSource = await readFile(join(appRoot, 'installer', 'theme.nsh'), 'utf8')
    const captionColor = (name) => {
      const match = themeSource.match(new RegExp(`^!define ${name} (0x[0-9A-Fa-f]{8})\\r?$`, 'm'))
      if (!match) throw new Error(`Missing installer caption color: ${name}`)
      return match[1]
    }
    for (const dpi of [96, 192]) {
      for (const theme of ['light', 'dark']) {
        const brand = theme === 'dark' ? 'brand-dark-2x.bmp' : 'brand-2x.bmp'
        const prefix = theme === 'dark' ? 'INSTALLER_DARK_CONTROL' : 'INSTALLER_CONTROL'
        const result = await execute(renderTest, [join(output, 'ui', brand), String(dpi), theme,
          captionColor(`${prefix}_HOVER`), captionColor(`${prefix}_PRESSED`)], childOptions)
        renderResults.push(result.stdout)
      }
    }
    await writeFile(join(output, 'render-results.log'), renderResults.join(''))
  }
  await execute(cleanupTest, [join(output, 'ui', `cleanup-${id}`)], childOptions)
  const payloadSource = join(output, 'payload.nsi')
  await writeFile(payloadSource, `Unicode true
RequestExecutionLevel user
ManifestDPIAware true
Name "${productName}"
OutFile "${join(payload, `${productName}.exe`)}"
SilentInstall silent
Section
  FileOpen $0 "$EXEDIR\\launched.txt" w
  FileWrite $0 "launched"
  FileClose $0
  MessageBox MB_OK "Installer test application is running."
SectionEnd
`)
  const compiler = await getMakeNsisPath()
  await execute(compiler.path, ['/V2', payloadSource], { ...childOptions, env: { ...childOptions.env, ...compiler.env } })
  if (sign) await sign({ path: join(payload, `${productName}.exe`), hash: 'sha256', isNest: false })
  for (const locale of readInstallerLocales()) {
    const language = locale.id
    const config = createElectronBuilderConfig()
    if (sign) {
      config.win.forceCodeSigning = true
      config.win.signtoolOptions.sign = sign
    }
    const languageOutput = join(output, language)
    await mkdir(languageOutput)
    const strings = join(languageOutput, 'strings.nsh')
    await writeFile(strings, renderInstallerStrings([locale]), 'utf8')
    const include = join(languageOutput, 'include.nsh')
    await writeFile(include, `!define INSTALLER_BUILD_DIR "${join(output, 'ui')}"\n!define INSTALLER_STRINGS_FILE "${strings}"\n!include "${join(appRoot, 'scripts', 'installer.nsh')}"\n`)
    await build({ projectDir: appRoot, prepackaged: payload, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
      config: { ...config, productName, extraMetadata: { ...config.extraMetadata, name: packageName },
        artifactName: 'installer-test.exe', directories: { output: languageOutput },
        nsis: { ...config.nsis, guid, include, installerLanguages: [language] }, beforeBuild: undefined, afterPack: undefined, afterSign: undefined, artifactBuildCompleted: undefined },
    })
    if (process.argv.includes('--compile-only')) continue
    const result = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(appRoot, 'tests', uninstallOnly ? 'windows-uninstall-smoke.ps1' : 'windows-installer-smoke.ps1'),
      '-Installer', join(languageOutput, 'installer-test.exe'),
      '-ProductName', productName, '-RegistryKey', guid, '-OutputDirectory', languageOutput,
      '-Language', language, ...uninstallOnly ? ['-PackageName', packageName] : []], childOptions)
    process.stdout.write(`${language}\n${result.stdout}`)
  }
  succeeded = true
} finally {
  signingRun?.finish(succeeded)
  for (const name of Object.keys(process.env)) if (!(name in previousEnvironment)) delete process.env[name]
  Object.assign(process.env, previousEnvironment)
  process.stdout.write(`Installer test artifacts: ${output}\n`)
}
