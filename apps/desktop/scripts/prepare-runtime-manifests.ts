/** Apply electron-builder's dependency metadata cleanup before sealing runtime bytes. */
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// electron-builder omits declarations for its internal manifest transformer.
const { createTransformer } = createRequire(import.meta.url)('app-builder-lib/out/fileTransformer.js') as {
  createTransformer: (root: string, config: object, extraMetadata: undefined) =>
  (path: string) => Promise<string | undefined> | null
}

/**
 * Materialize the same manifest bytes electron-builder will put in the archive.
 * @param root Prepared application dependency tree.
 * @returns Resolves after dependency manifests are ready for integrity inventory.
 */
export async function prepareRuntimeManifests(root: string): Promise<void> {
  const transform = createTransformer(root, {}, undefined)
  const modules = join(root, 'node_modules')
  for (const entry of await readdir(modules, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name !== 'package.json') continue
    const path = join(entry.parentPath, entry.name)
    const transformed = await transform(path)
    if (transformed != null) await writeFile(path, transformed)
  }
}
