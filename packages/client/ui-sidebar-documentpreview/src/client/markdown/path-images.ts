/** Local Markdown image destinations served by the authenticated file route. */
import { fileMediaUrl, isAbsoluteWorkspacePath, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'

/**
 * Build a file URL, resolving relative destinations beside the previewed file.
 * @param base - document base URI, including any deployment prefix.
 * @param documentPath - absolute source path reported by the Host, when available.
 * @param destination - authored Markdown image URL; query and fragment are not filename components.
 * @returns a Web or Desktop file URL, or undefined for unsupported or malformed destinations.
 */
export function markdownImageUrl(base: string, documentPath: string | undefined, destination: string): string | undefined {
  const suffix = destination.search(/[?#]/u)
  let path: string
  try {
    path = decodeURIComponent(suffix === -1 ? destination : destination.slice(0, suffix))
  } catch (_error) {
    // Malformed percent escapes do not identify a local file.
    return undefined
  }
  if (path.length === 0) return undefined
  const windowsDrive = /^[a-z]:[/\\]/iu.test(path)
  if (!windowsDrive && /^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined
  if (!isAbsoluteWorkspacePath(path)) {
    if (documentPath === undefined) return undefined
    path = pathPartsOf(documentPath).directory + path
  }
  return fileMediaUrl(base, path)
}
