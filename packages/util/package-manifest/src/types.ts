/**
 * Shared declarations for `package.json.dsh`.
 * Each reader owns JSON validation and resolved defaults.
 * @module @deepseek-ai/dsh-package-manifest/types
 */

/** The `dsh` property of an npm manifest; a package may declare several roles. */
export interface DshManifest {
  /** Bundle metadata consumed by the profile launcher. */
  bundle?: DshBundleManifest
  /** Profile metadata consumed by the profile launcher. */
  profile?: DshProfileManifest
  /** Client module loading and build metadata. */
  client?: DshClientManifest
  /** Config directories consumed by the experimental deployment-image packer. */
  configTrees?: DshConfigTreeDeclaration[]
  /** Adjacent Session migration metadata consumed by the workspace catalog generator. */
  sessionFormatMigration?: DshSessionFormatMigrationManifest
  /**
   * Launcher-generated module proxy metadata, not an author configuration entry.
   * @internal
   */
  moduleFallback?: DshModuleFallbackManifest
}

/** The configuration layer exported by a bundle package. */
export interface DshBundleManifest {
  /** Patch file path relative to the declaring package root. */
  patch: string
}

/** The bundle composition declared by a profile directory. */
export interface DshProfileManifest {
  /** Ordered bundle layer list, using installed package names. */
  bundles?: string[]
  /** User patch lifecycle; omitted means `live` for custom profiles. */
  patchReload?: ProfilePatchReload
}

/** Whether user patch files reload while a profile remains active or apply only at startup. */
export type ProfilePatchReload = 'live' | 'startup'

/** Client module declaration read by client-modules and the client build. */
export interface DshClientManifest {
  /** Client platform identifier; the Web consumer selects `web`. */
  platform: string
  /** Informational package-name dependencies, not Cordis service injection. */
  inject?: string[]
  /** Boot phase-one registration barrier; absent means the shared application batch. */
  immediately?: boolean
  /**
   * Exact module-table requests beyond the implicit client baseline, including
   * subpaths such as `<pkg>/client`; absent means baseline externals only.
   * Type-only imports are erased and create no module request.
   */
  external?: string[]
}

/** One config directory read from the CLI package by the experimental image packer. */
export interface DshConfigTreeDeclaration {
  /** Non-empty destination path in the image; mount values must be unique. */
  mount: string
  /** Non-empty source directory path relative to the declaring package root. */
  path: string
  /** Include the directory's YAML plugin rows in the package roster; absent means false. */
  scanRoster?: boolean
}

/**
 * Adjacent Session migration metadata declared on disk. The catalog generator
 * discovers only packages/session/session-format-vN-to-vN+1, not external plugins.
 */
export interface DshSessionFormatMigrationManifest {
  /** Non-negative safe integer source version; negative zero is rejected. */
  from: number
  /** Non-negative safe integer target version, exactly from + 1. */
  to: number
  /** Non-empty package export path, such as `.` or `./migration`. */
  export: string
  /** Non-empty named export of the migration implementation. */
  migration: string
  /** Non-empty named export of the source version codec. */
  sourceCodec: string
  /** Non-empty named export of the target version codec. */
  targetCodec: string
  /** Non-empty named export of the target header validator. */
  targetHeaderValidator: string
  /** Non-empty named export of the target version restorer. */
  targetRestorer: string
}

/**
 * Metadata generated and read by the launcher's module fallback proxies.
 * @internal
 */
export interface DshModuleFallbackManifest {
  /** Package export subpaths mapped to resolved target file URLs. */
  targets: Record<string, string>
}
