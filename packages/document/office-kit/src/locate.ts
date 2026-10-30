/** Locate LibreOffice Kit, its CLI, and its engine packages from the consumer's Kit installation without module hooks. */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate an engine package manifest for Kit.
 * @param name - Engine package name requested by Kit.
 * @returns Absolute path of the package's `package.json`.
 * @throws An error with code `MODULE_NOT_FOUND` when the package is absent.
 */
export type EnginePackageResolver = (name: string) => string

/**
 * Locate the Kit entry the consumer imports, normally
 * `() => import.meta.resolve('@deepseek-ai/libreoffice-kit')` written in the consuming module.
 * @returns The Kit entry as a file URL string or `URL`.
 * @throws When the consumer cannot resolve Kit; the resolver treats every thrown value as an absent Kit.
 */
export type KitEntryLookup = () => string | URL

/**
 * Kit module location for a consumer that imports Kit at run time.
 * `available` carries the Kit entry file URL for a dynamic `import()` and an engine resolver anchored at that entry;
 * `missing` carries the lookup failure.
 */
export type KitModuleResolution =
  | { readonly kind: 'available'; readonly entry: string; readonly resolveEnginePackage: EnginePackageResolver }
  | { readonly kind: 'missing'; readonly error: unknown }

/** Kit CLI configuration; an omitted path uses the current process or the consumer's Kit installation. */
export interface KitCliOptions {
  /** Absolute standalone Node executable; defaults to `process.execPath` outside Electron. */
  readonly node?: string
  /** Absolute Kit CLI entry; `false` disables CLI access, and omission uses the `./cli` export of the Kit found by `lookupKitEntry`. */
  readonly cli?: string | false
  /**
   * Absolute directory restricting automatic Kit discovery; omission leaves discovery unrestricted.
   * Both the Kit entry and CLI must resolve inside this directory after realpath. The first `.asar` segment
   * in each path, including a root ending in `.asar`, maps to `.asar.unpacked` before realpath.
   * An unavailable directory or an escaping path returns `missing`. Explicit `cli` paths bypass this check.
   */
  readonly root?: string
  /** Consumer's Kit lookup, called only when `cli` is omitted. */
  readonly lookupKitEntry: KitEntryLookup
}

/**
 * Kit CLI availability. `disabled` follows `cli: false`; `missing` means automatic discovery failed or violated `root`,
 * carrying the failure; `available` carries absolute existing files for Node and the CLI entry.
 */
export type KitCliResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'missing'; readonly error: unknown }
  | { readonly kind: 'available'; readonly node: string; readonly cli: string }

/**
 * Locate Kit for a consumer that loads it with a dynamic `import()`.
 * @param lookupKitEntry - Consumer's Kit lookup; anchoring at the consumer, not this library, selects the installation the consumer uses.
 * @returns `available` with the entry file URL and an engine resolver created by {@link createEnginePackageResolver},
 * or `missing` when the lookup throws.
 * @throws Node's error if a returned entry cannot be used by `createRequire`.
 */
export function resolveKitModule(lookupKitEntry: KitEntryLookup): KitModuleResolution {
  const located = lookupEntry(lookupKitEntry)
  if (located.kind === 'missing') return located
  return { kind: 'available', entry: located.entry, resolveEnginePackage: createEnginePackageResolver(located.entry) }
}

/**
 * Resolve the Node executable and Kit CLI entry used for Kit commands.
 * Automatic CLI paths map to the physical ASAR-unpacked copy; explicit `cli` paths stay unchanged.
 * Every call reads the filesystem, so a later call observes installed or removed files.
 * @param options - Configured paths, optional discovery root, and the consumer's Kit lookup.
 * @returns `disabled` for `cli: false`, `missing` when automatic discovery fails or violates `root`, otherwise `available`.
 * @throws When `root` is relative; in Electron when `node` is omitted, because `process.execPath` is the application binary;
 * when `node`, a configured `cli`, or the CLI entry of a found Kit is not an absolute existing file;
 * and Node's error if the found Kit has no `./cli` export.
 */
export function resolveKitCli(options: KitCliOptions): KitCliResolution {
  if (options.root !== undefined && !isAbsolute(options.root)) throw new Error('LibreOffice Kit: root must be an absolute directory')
  if (options.cli === false) return { kind: 'disabled' }
  if (options.node === undefined && process.versions.electron !== undefined) {
    throw new Error('LibreOffice Kit: packaged applications must supply a standalone Node executable')
  }
  const node = assertFile(options.node ?? process.execPath)
  if (options.cli !== undefined) return { kind: 'available', node, cli: assertFile(options.cli) }
  const located = lookupEntry(options.lookupKitEntry)
  if (located.kind === 'missing') return located
  let root: string | undefined
  if (options.root !== undefined) {
    try {
      root = realpathSync(unpackedPath(options.root))
      assertWithinRoot(unpackedPath(fileURLToPath(located.entry)), root)
    } catch (error) {
      return { kind: 'missing', error }
    }
  }
  const cli = unpackedPath(createRequire(located.entry).resolve('@deepseek-ai/libreoffice-kit/cli'))
  if (root !== undefined) {
    try { assertWithinRoot(cli, root) } catch (error) { return { kind: 'missing', error } }
  }
  return { kind: 'available', node, cli: assertFile(cli) }
}

/**
 * Anchor engine resolution to the Kit entry actually used by the consumer, not this package's installation.
 * Each returned callback retains its own Node resolver and installs no module hooks.
 * @param kitEntry - Absolute Kit entry path or file URL, normally the consumer's `import.meta.resolve('@deepseek-ai/libreoffice-kit')`.
 * @returns A callback for Kit's `resolveEnginePackage` option. Native paths map the first ASAR segment to its unpacked copy;
 * WASM and paths outside archives stay unchanged. Kit validates the returned manifest and required engine assets.
 * @throws Node's error if `kitEntry` cannot be used by `createRequire`.
 * On invocation, the callback preserves Node errors for absent packages and other resolution failures.
 * An installed package with an unresolvable manifest throws an incomplete-installation Error with the Node error as its cause,
 * preventing engine fallback. Filesystem inspection errors propagate unchanged.
 */
export function createEnginePackageResolver(kitEntry: string | URL): EnginePackageResolver {
  const fromKit = createRequire(kitEntry)
  return (name) => {
    let manifest: string
    try {
      manifest = fromKit.resolve(`${name}/package.json`)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
        const installed = (fromKit.resolve.paths(name) ?? []).some(directory =>
          lstatSync(join(directory, name), { throwIfNoEntry: false }) !== undefined,
        )
        if (installed) throw new Error(`Installed LibreOfficeKit package is incomplete: ${name}. Reinstall the package.`, { cause: error })
      }
      throw error
    }
    return name === '@deepseek-ai/libreoffice-kit-wasm' ? manifest : unpackedPath(manifest)
  }
}

type EntryLookup = { readonly kind: 'found'; readonly entry: string } | { readonly kind: 'missing'; readonly error: unknown }

function lookupEntry(lookupKitEntry: KitEntryLookup): EntryLookup {
  let entry: string | URL
  try {
    entry = lookupKitEntry()
  } catch (error) {
    return { kind: 'missing', error }
  }
  return { kind: 'found', entry: typeof entry === 'string' ? entry : entry.href }
}

function assertFile(path: string): string {
  if (!isAbsolute(path) || statSync(path, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`LibreOffice Kit: expected an absolute executable file: ${path}`)
  }
  return path
}

function assertWithinRoot(path: string, root: string): void {
  const resolved = realpathSync(path)
  const fromRoot = relative(root, resolved)
  if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`LibreOffice Kit: resolved path is outside root ${root}: ${resolved}`)
  }
}

/**
 * Map an ASAR path to its physical unpacked copy for standalone processes.
 * @param path - Filesystem path, including paths with Windows separators.
 * @returns The path with its first `.asar` segment replaced by `.asar.unpacked`; already-unpacked paths stay unchanged.
 */
export function unpackedPath(path: string): string {
  return path.replace(/\.asar(?=[\\/]|$)/, '.asar.unpacked')
}
