import type { AfterPackContext, BeforePackContext } from 'app-builder-lib'

/** Electron-builder fields asserted by the Desktop release tests. */
export interface DesktopElectronBuilderConfig {
  readonly appId: string
  readonly artifactName: string
  readonly protocols: readonly [{ readonly name: 'DeepSeek Harness'; readonly schemes: readonly ['dsh'] }]
  readonly directories: {
    readonly output: string
  }
  readonly files: readonly [
    string,
    string,
    string,
    string,
    { readonly from: string, readonly to: 'dsh', readonly filter: readonly ['**/*'] },
    { readonly from: string, readonly to: 'dsh/node_modules', readonly filter: readonly ['**/*'] },
  ]
  readonly extraMetadata: { readonly dshDesktopAppId: string }
  readonly asarUnpack: readonly string[]
  readonly extraResources: readonly [
    { readonly from: string, readonly to: 'runtime' },
    { readonly from: string, readonly to: 'icon.png' },
    ...{ readonly from: string, readonly to: 'tray.ico' }[],
  ]
  readonly mac: {
    readonly extendInfo: { readonly NSMicrophoneUsageDescription: string }
    readonly identity: string | undefined
    readonly forceCodeSigning: boolean
    readonly notarize: boolean
    readonly signIgnore: readonly string[]
  }
  readonly dmg: {
    readonly sign: boolean
    readonly writeUpdateInfo: boolean
  }
  readonly win: {
    readonly forceCodeSigning: boolean
    readonly signtoolOptions: {
      readonly publisherName: string | undefined
      readonly sign: ((configuration: { path: string, hash: string, isNest: boolean }) => Promise<void>) | undefined
      readonly signingHashAlgorithms: readonly string[]
    }
  }
  readonly nsis: {
    readonly include: string
    readonly oneClick: false
    readonly perMachine: false
    readonly allowElevation: false
    readonly allowToChangeInstallationDirectory: false
    readonly installerLanguages: readonly ['en_US', 'zh_CN']
  }
  readonly beforeBuild: () => Promise<boolean>
  readonly beforePack: (context: BeforePackContext) => Promise<void>
  readonly afterPack: (context: AfterPackContext) => Promise<void>
  readonly afterSign: (context: AfterPackContext) => Promise<void>
  readonly artifactBuildCompleted: (artifact: { readonly file: string }) => Promise<void> | undefined
  readonly publish: readonly [{ readonly provider: 'generic', readonly url: string }] | null
}

/**
 * Create electron-builder configuration from one release environment.
 * @param env - Packaging environment.
 * @param hostPlatform - Build-host platform used when no explicit target is present.
 * @param hostArch - Build-host architecture used when no explicit target is present.
 * @param preparedRuntime - Verified private qualification runtime; ordinary releases use target-owned resources.
 * @param preparedRuntimeVersion - Version that private runtime declares, which qualification rewrites away from the product version.
 * @returns electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env?: NodeJS.ProcessEnv,
  hostPlatform?: NodeJS.Platform,
  hostArch?: string,
  preparedRuntime?: string,
  preparedRuntimeVersion?: string,
): DesktopElectronBuilderConfig

declare const electronBuilderConfig: DesktopElectronBuilderConfig

export default electronBuilderConfig
