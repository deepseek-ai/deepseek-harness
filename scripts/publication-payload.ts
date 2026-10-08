/** Publication payload policy shared by static manifests and packed tarballs. */

/**
 * Whether a package manifest exports generated Host-for-Client metadata.
 * @param manifest - parsed package manifest to inspect.
 * @returns whether the canonical `./remote` export pair is present.
 */
export function hasTypertRemoteNavigation(manifest: unknown): boolean {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const exportsField = (manifest as Record<string, unknown>).exports
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
  const remote = (exportsField as Record<string, unknown>)['./remote']
  if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) return false
  const entry = remote as Record<string, unknown>
  return entry.types === './lib/typert.remote-client.d.ts'
    && entry.default === './lib/typert.remote-client.js'
}

/** Normalize a package manifest path or npm tarball member to its payload-relative path. */
function payloadPath(file: string): string {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  return normalized.startsWith('package/') ? normalized.slice('package/'.length) : normalized
}

/**
 * Whether a package payload path exposes JavaScript map intermediates. A
 * declaration map pairs with the source and the declaration a consumer
 * reaches; a JavaScript map describes bundler output that no published entry
 * pairs with, so no payload publishes one.
 * @param file - manifest path or tarball member to classify.
 * @returns whether publishing this path is forbidden.
 */
export function isForbiddenPublicationFile(file: string): boolean {
  return payloadPath(file).endsWith('.js.map')
}

/**
 * Reject bundled JavaScript map members in a packed npm tarball.
 * @param files - tarball members to validate.
 * @param context - tarball identity named in the failure.
 */
export function validateTarballPayload(files: readonly string[], context: string): void {
  for (const file of files) {
    if (isForbiddenPublicationFile(file)) throw new Error(`${context} publishes JavaScript map ${file}`)
  }
}
