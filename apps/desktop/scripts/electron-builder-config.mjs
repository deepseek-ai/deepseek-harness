import { officePackageDirectories } from '../../../scripts/libreoffice-packages.mjs'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
  resolveWindowsUpdatePublisher,
  scrubWindowsSigningEnvironment,
} from './windows-sign.mjs'
import { resolveDesktopAutoUpdateConfig } from './desktop-auto-update-environment.mjs'
import { resolveDesktopBuildCommit } from './desktop-build-commit.mjs'
import { resolveDesktopBuildVersion } from './desktop-build-version.mjs'
import { resolveDesktopPolicyEnvironment } from './desktop-policy-environment.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'
import { installWindowsDirectoryInstaller } from './windows-directory-installer.mjs'
import { preserveWindowsRuntimeSignature, signWindowsCode } from './windows-runtime-signature.mjs'
import { prepareWindowsAsarUnpack, verifyWindowsAsarUnpack } from './windows-asar-unpack.mjs'
import { recordPackagingEvent } from './packaging-run.mjs'
import {
  resolveMacOSAppUpdateFeed,
  verifyMacOSAppUpdateConfig,
  writeMacOSAppUpdateConfig,
} from './macos-app-update-config.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @param {string | undefined} preparedRuntime - Verified private dsh tree for installed-update qualification; ordinary releases use the target tree.
 * @param {string | undefined} preparedRuntimeVersion - Version that private tree declares, which qualification rewrites away from the product version.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
  preparedRuntime = undefined,
  preparedRuntimeVersion = undefined,
) {
  const appId = resolveDesktopAppId(env)
  const policy = resolveDesktopPolicyEnvironment(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  if (unsigned && resolvedPlatform !== 'win32') throw new Error('desktop package: unsigned builds require Windows')
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = resolvedPlatform === 'win32'
  if (resolvedPlatform === 'win32') installWindowsDirectoryInstaller()
  const macOSSigning = packagesMacOS ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS) resolveMacOSNotarizationEnvironment(env)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  let primaryRuntimeDestination
  let dshDestination
  let windowsCode = []
  const unpack = ['**/*.{node,dylib,dll,so,exe}', '**/*.so.*', '**/spawn-helper', '**/@vscode/ripgrep-*/bin/rg',
    `**/node_modules/@deepseek-ai/libreoffice-kit-${resolvedPlatform}-${resolvedArch}/**/*`]
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
        preserveSignature: async path => {
          for (const [sourceRoot, destinationRoot] of [[join(buildPaths.runtime, 'primary-runtime'), primaryRuntimeDestination], [buildPaths.dsh, dshDestination]]) {
            if (destinationRoot !== undefined && await preserveWindowsRuntimeSignature(path, {
              sourceRoot, destinationRoot, runDirectory: env.DSH_DESKTOP_PACKAGING_RUN_DIR,
            })) return true
          }
          return false
        },
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  if (preparedRuntime !== undefined) buildPaths.dsh = preparedRuntime
  // electron-builder merges extraMetadata into the packaged manifest, so a build version here reaches
  // the artifact names, the update feed, and the installed app.getVersion() the updater compares against.
  const productVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version
  const buildVersion = resolveDesktopBuildVersion(env, productVersion)
  const packaged = resolveDesktopBuildCommit(env)
  return {
    appId,
    protocols: [{ name: 'DeepSeek Harness', schemes: ['dsh'] }],
    extraMetadata: {
      dshDesktopAppId: appId,
      dshMandatoryUpdatePolicy: policy,
      ...buildVersion === productVersion ? {} : { version: buildVersion },
      ...packaged === undefined ? {} : { dshBuildCommit: packaged.commit, dshBuildDirty: packaged.dirty },
    },
    productName: 'DeepSeek Harness',
    // Unsigned builds carry their own suffix so a shared file can never pass for a release artifact.
    artifactName: `deepseek-harness-\${version}-\${os}-\${arch}${unsigned ? '-unsigned' : ''}.\${ext}`,
    directories: { output: unsigned ? buildPaths.unsignedArtifacts : buildPaths.artifacts },
    asar: true,
    electronDist: buildPaths.electron,
    electronFuses: { runAsNode: true },
    beforeBuild: async () => {
      if (resolvedPlatform !== 'win32') return true
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        fileURLToPath(new URL('./prepare-windows-installer.ps1', import.meta.url)),
        '-OutputDirectory', join(buildPaths.root, 'installer-ui')], {
        env: scrubWindowsSigningEnvironment(env), windowsHide: true,
      })
      if (windowsSigner !== undefined) {
        await windowsSigner({ path: join(buildPaths.root, 'installer-ui', 'window-frame.dll'), hash: 'sha256', isNest: false })
      }
      // A falsy result tells electron-builder to omit its production node_modules collection.
      return true
    },
    files: [
      'lib/main.js',
      'lib/welcome/**/*',
      'lib/preload-app.cjs',
      'lib/preload-mandatory.cjs',
      'lib/preload-platform-account.cjs',
      'lib/preload-update-dialog.cjs',
      'lib/preload-welcome.cjs',
      'renderer/**/*',
      'package.json',
      { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    asarUnpack: unpack,
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      { from: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)), to: 'icon.png' },
      // Windows tray bitmaps; macOS keeps the Dock and ships no menu bar icon.
      ...(packagesWindows ? [{ from: fileURLToPath(new URL('../resources/tray-windows.ico', import.meta.url)), to: 'tray.ico' }] : []),
    ],
    mac: {
      icon: fileURLToPath(new URL('../resources/icon-macos.png', import.meta.url)),
      category: 'public.app-category.developer-tools',
      // macOS matches the application locale against this bundle, not Electron Framework resources.
      extendInfo: { CFBundleLocalizations: ['en', 'zh_CN'] },
      identity: macOSSigning?.signingIdentity,
      forceCodeSigning: true,
      hardenedRuntime: true,
      extendInfo: { NSMicrophoneUsageDescription: 'DeepSeek Harness uses your microphone to transcribe speech into message drafts.' },
      // ASAR-unpacked native runtime files are pre-signed; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '/Contents/Resources/runtime/primary-runtime(?:/|$)', '\\.pak$'],
      notarize: true,
      target: ['dmg', 'zip'],
    },
    dmg: {
      sign: true,
      writeUpdateInfo: false,
    },
    beforePack: async context => {
      const office = await officePackageDirectories(buildPaths.dsh, { platform: resolvedPlatform, arch: resolvedArch })
      const patterns = office.map(directory => `**/${relative(buildPaths.dsh, directory).split(sep).join('/')}/**/*`)
      const existing = context.packager.config.asarUnpack ?? []
      context.packager.config.asarUnpack = [...(typeof existing === 'string' ? [existing] : existing), ...patterns]
      if (packagesWindows) windowsCode = await prepareWindowsAsarUnpack(context, buildPaths.dsh)
      if (windowsSigner !== undefined) {
        primaryRuntimeDestination = join(context.appOutDir, 'resources', 'runtime', 'primary-runtime')
        dshDestination = join(context.appOutDir, 'resources', 'app.asar.unpacked', 'dsh')
      }
      if (policy === undefined) return
      const { resolveDesktopPolicyConfig } = await import('../lib/types/mandatory-update-policy.js')
      resolveDesktopPolicyConfig(policy)
    },
    afterPack: async context => {
      const { verifyDesktopRuntime } = await import('../lib/types/runtime-tree.js')
      const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
      if (resolvedPlatform === 'darwin' && update !== undefined) {
        await writeMacOSAppUpdateConfig(resourcesDir, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      // The bundled runtime declares whichever version prepared it: the product version for an ordinary
      // release, and a rewritten one for installed-update qualification.
      await verifyDesktopRuntime(buildPaths.dsh,
        preparedRuntimeVersion ?? productVersion, { platform: resolvedPlatform, arch: resolvedArch })
      // Unsigned Windows builds skip electron-builder's afterSign hook.
      if (packagesWindows && unsigned) await verifyWindowsAsarUnpack(buildPaths.dsh, resourcesDir, windowsCode)
    },
    afterSign: async context => {
      if (windowsSigner !== undefined) {
        await signWindowsCode(context.appOutDir, {
          thumbprint: new X509Certificate(await readFile(env.DSH_DESKTOP_WINDOWS_CER_FILE)).fingerprint.replaceAll(':', ''),
          sign: windowsSigner,
          record: event => recordPackagingEvent(env.DSH_DESKTOP_PACKAGING_RUN_DIR, event),
        })
        await verifyWindowsAsarUnpack(buildPaths.dsh, context.packager.getResourcesDir(context.appOutDir), windowsCode)
      }
      if (context.electronPlatformName !== 'darwin') return
      const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      if (update !== undefined) {
        await verifyMacOSAppUpdateConfig(appPath, resolveMacOSAppUpdateFeed(context.packager.config.publish),
          context.packager.appInfo.updaterCacheDirName)
      }
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (!artifact.file.endsWith('.dmg')) return
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      icon: fileURLToPath(new URL('../resources/icon-windows.png', import.meta.url)),
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        publisherName: windowsSigner === undefined ? undefined : resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE),
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      category: 'Development',
      target: ['AppImage'],
    },
    nsis: {
      installerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      uninstallerSidebar: join(buildPaths.root, 'installer-ui', 'uninstaller-sidebar.bmp'),
      include: fileURLToPath(new URL('./installer.nsh', import.meta.url)),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      installerLanguages: ['en_US', 'zh_CN'],
      differentialPackage: true,
    },
    detectUpdateChannel: false,
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl, channel: 'nightly' }],
  }
}
