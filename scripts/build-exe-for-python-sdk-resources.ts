/** Copy SDK runtime products while preserving relocatable resource links. */
import { chmod, copyFile, cp, rm, stat } from 'node:fs/promises'

/**
 * Replace one executable or resource directory in the Python development carrier.
 * @param source - Built product with any relative links contained in its resource tree.
 * @param destination - Product path inside the prepared carrier directory.
 * @returns Resolves after copying the product and retaining its executable permissions.
 */
export async function syncPythonRuntimeProduct(source: string, destination: string): Promise<void> {
  const entry = await stat(source)
  if (entry.isDirectory()) {
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, { recursive: true, verbatimSymlinks: true })
  } else await copyFile(source, destination)
  await chmod(destination, entry.mode & 0o777)
}
