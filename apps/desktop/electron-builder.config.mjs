import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveDesktopAppId,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './scripts/desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './scripts/notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './scripts/verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
} from './scripts/windows-sign.mjs'
import { resolveDesktopAutoUpdateConfig } from './scripts/desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './scripts/desktop-build-paths.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  const appId = resolveDesktopAppId(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  if (unsigned && resolvedPlatform !== 'win32') throw new Error('desktop package: unsigned builds require Windows')
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = targetPlatform === 'win32'
  const macOSSigning = packagesMacOS ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS) resolveMacOSNotarizationEnvironment(env)
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  return {
    appId,
    productName: 'DeepSeek Harness',
    artifactName: 'deepseek-harness-${version}-${os}-${arch}.${ext}',
    directories: { output: unsigned ? join(buildPaths.root, 'unsigned-artifacts') : buildPaths.artifacts },
    asar: true,
    files: [
      'lib/*.js',
      'lib/*.cjs',
      'renderer/**/*',
      'package.json',
    ],
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      { from: buildPaths.dsh, to: 'dsh' },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules' },
    ],
    mac: {
      category: 'public.app-category.developer-tools',
      identity: macOSSigning?.signingIdentity,
      forceCodeSigning: true,
      hardenedRuntime: true,
      // Native runtime files are pre-signed; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/dsh(?:/|$)', '\\.pak$'],
      notarize: true,
      target: ['dmg', 'zip'],
    },
    dmg: {
      sign: true,
      writeUpdateInfo: false,
    },
    afterPack: async context => {
      const { verifyDesktopRuntime } = await import('./lib/types/runtime-tree.js')
      await verifyDesktopRuntime(join(context.packager.getResourcesDir(context.appOutDir), 'dsh'),
        context.packager.appInfo.version, { platform: resolvedPlatform, arch: resolvedArch })
    },
    afterSign: async context => {
      if (context.electronPlatformName !== 'darwin') return
      const { verifyDesktopRuntime } = await import('./lib/types/runtime-tree.js')
      await verifyDesktopRuntime(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'dsh'),
        context.packager.appInfo.version, { platform: 'darwin', arch: resolvedArch })
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
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      category: 'Development',
      target: ['AppImage'],
    },
    nsis: {
      include: fileURLToPath(new URL('./scripts/installer.nsh', import.meta.url)),
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      differentialPackage: true,
    },
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl }],
  }
}

export default createElectronBuilderConfig()
