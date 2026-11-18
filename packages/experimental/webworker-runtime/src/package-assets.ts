/**
 * Package assets for the preview page. A Client bundle names each image as a
 * document-relative reference, `plugins/<package>/assets/<path>`, and resolves
 * it through the module loader's synchronous `require.asset`. The page of the
 * Worker preview cannot request such a URL itself, so the Worker hands it every
 * asset the image holds in one archive and the page maps each reference to a
 * Blob URL before any bundle runs.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/package-assets
 */
import { join } from './module-system/posix-path.ts'
import type { MemoryVfs } from './storage/memory.ts'
import { packTar, parseTar } from './storage/tar.ts'
import type { VfsDirent } from './storage/types.ts'

/** Media type of each asset extension the Client build emits. */
const ASSET_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
])

/** Entries of one directory. */
function entriesOf(vfs: MemoryVfs, directory: string): VfsDirent[] {
  return vfs.readdirSync(directory, { withFileTypes: true })
}

/** Files under one directory, as `/`-separated paths relative to it. */
function filesBelow(vfs: MemoryVfs, directory: string, prefix = ''): string[] {
  return entriesOf(vfs, directory).flatMap(entry => entry.isDirectory()
    ? filesBelow(vfs, join(directory, entry.name), `${prefix}${entry.name}/`)
    : entry.isFile() ? [`${prefix}${entry.name}`] : [])
}

/** Installed package directories under `node_modules`, scoped ones included. */
function packageDirectories(vfs: MemoryVfs, modules: string): string[] {
  if (!vfs.existsSync(modules)) return []
  return entriesOf(vfs, modules).filter(entry => entry.isDirectory()).flatMap(entry =>
    entry.name.startsWith('@')
      ? entriesOf(vfs, join(modules, entry.name)).filter(scoped => scoped.isDirectory())
        .map(scoped => join(modules, entry.name, scoped.name))
      : [join(modules, entry.name)])
}

/**
 * Archive every file a package of the image publishes through `"./assets/*": "./lib/assets/*"`.
 * @param vfs - Mounted image filesystem.
 * @param root - Image root holding `node_modules`.
 * @returns An uncompressed tar whose entries are named `plugins/<package>/assets/<path>` with the path unencoded,
 * so every name fits the ustar limits the base image already met.
 */
export function packPackageAssets(vfs: MemoryVfs, root: string): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  for (const directory of packageDirectories(vfs, join(root, 'node_modules'))) {
    const manifestPath = join(directory, 'package.json')
    if (!vfs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(vfs.readFileSync(manifestPath, 'utf8') as string) as { name?: unknown; exports?: Record<string, unknown> }
    // The export target client-modules and the Client build require of an asset-publishing package.
    if (typeof manifest.name !== 'string' || manifest.exports?.['./assets/*'] !== './lib/assets/*') continue
    const assets = join(directory, 'lib', 'assets')
    if (!vfs.existsSync(assets)) continue
    for (const path of filesBelow(vfs, assets)) {
      files[`plugins/${manifest.name}/assets/${path}`] = vfs.readFileSync(join(assets, path)) as Uint8Array
    }
  }
  return packTar(files)
}

/**
 * Map each archived package asset to a Blob URL kept for the page's lifetime.
 * @param archive - Archive from {@link packPackageAssets}.
 * @returns The synchronous resolver behind `require.asset`: the Blob URL of a
 * reference the image holds, otherwise the reference itself, which then fails as an unserved image.
 */
export function packageAssetResolver(archive: Uint8Array): (reference: string) => string {
  const urls = new Map<string, string>()
  for (const entry of parseTar(archive)) {
    const [, name, path] = /^plugins\/((?:@[^/]+\/)?[^/]+)\/assets\/(.+)$/u.exec(entry.name) ?? []
    if (name === undefined || path === undefined) continue
    // The same per-segment encoding the Client build writes into each reference.
    const encoded = path.split('/')
      .map(segment => encodeURIComponent(segment).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    const reference = `plugins/${name}/assets/${encoded.join('/')}`
    const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
    // A copy detaches the Blob from the archive buffer the entry views.
    urls.set(reference, URL.createObjectURL(new Blob([new Uint8Array(entry.bytes)], { type: ASSET_MEDIA_TYPES.get(extension) ?? '' })))
  }
  return reference => urls.get(reference) ?? reference
}
