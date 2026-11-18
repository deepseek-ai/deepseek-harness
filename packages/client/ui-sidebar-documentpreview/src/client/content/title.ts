/** The content tab's title and file icon, shared by its body header and its chip. */
import type { FileTypeKind } from '@deepseek-ai/dsh-client-ui-primitives'
/** File icon categories by exact media-type essence. */
const MEDIA_TYPE_ICONS: Readonly<Record<string, FileTypeKind>> = {
  'text/markdown': 'markdown',
  'text/html': 'html',
  'text/csv': 'excel',
  'application/pdf': 'pdf',
}

/** File icon categories by media-type top-level type. */
const TOP_LEVEL_ICONS: Readonly<Record<string, FileTypeKind>> = {
  image: 'image',
  video: 'video',
}

/**
 * The file icon category for a media type; parameters and case are ignored.
 * @param mediaType - content media type, or `undefined` before the content loads.
 * @returns the matching category, or `other`.
 */
export function iconKindOf(mediaType: string | undefined): FileTypeKind {
  if (mediaType === undefined) return 'other'
  const parameters = mediaType.indexOf(';')
  const essence = (parameters === -1 ? mediaType : mediaType.slice(0, parameters)).trim().toLowerCase()
  const slash = essence.indexOf('/')
  return MEDIA_TYPE_ICONS[essence] ?? TOP_LEVEL_ICONS[slash === -1 ? essence : essence.slice(0, slash)] ?? 'other'
}
