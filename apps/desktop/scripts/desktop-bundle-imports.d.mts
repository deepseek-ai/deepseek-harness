import type { Rolldown } from 'tsdown'

/** Bare specifiers one Desktop bundle may leave for the runtime to resolve. */
export interface BundleImportPolicy {
  /** Package names present at runtime, matched by package name so subpaths pass. */
  readonly packages: ReadonlySet<string>
  /**
   * Whether Node builtins resolve at runtime: true for the Electron main
   * process; false for sandboxed preloads, whose `require` polyfill offers only
   * the modules listed in `packages`.
   */
  readonly nodeBuiltins: boolean
}

/**
 * Package name of a bare import specifier.
 * @param specifier - Bare specifier as rolldown reports it, such as `@scope/name/subpath`.
 * @returns The package name without its subpath.
 */
export function importPackageName(specifier: string): string

/**
 * Whether a module id rolldown reports is a bare specifier, i.e. an import the
 * bundle leaves external. Bundled modules carry absolute ids; virtual modules
 * start with `\0`.
 * @param id - Module id from `importedIds` or `dynamicallyImportedIds`.
 * @returns True for a bare specifier.
 */
export function isBareSpecifier(id: string): boolean

/**
 * Bare imports the packaged application cannot resolve.
 * @param imports - External specifiers a module imports statically, dynamically, or through `require()`.
 * @param policy - What this bundle may leave external.
 * @returns Offending specifiers in import order, each once.
 */
export function unpackagedImports(imports: readonly string[], policy: BundleImportPolicy): string[]

/**
 * Rolldown plugin that fails a bundle whose external imports the packaged
 * application cannot resolve. The failure names the importing module and every
 * offending specifier, and no output is written.
 * @param policy - What this bundle may leave external.
 * @returns The plugin.
 */
export function packagedImportsPlugin(policy: BundleImportPolicy): Rolldown.Plugin
