import { useId } from 'react'
import type { ReactNode } from 'react'
import type { IconProps } from './icons/props.ts'
import type { CodeFileType } from './code-file-types.ts'
import { CODE_FILE_ARTWORK, CODE_FILE_ICON_ID_TOKEN } from './code-file-icon-artwork.ts'

/**
 * Render one full-color square code-file glyph from the embedded icon set.
 * @param props - Detailed code type, optional size, and optional CSS class.
 * @returns The selected decorative SVG with its identifying palette intact.
 */
export function CodeFileIcon({ type, size = 20, className }: IconProps & { readonly type: CodeFileType }): ReactNode {
  const instanceId = `dsh-code-icon-${useId().replaceAll(':', '')}`
  const artwork = CODE_FILE_ARTWORK[type].replaceAll(CODE_FILE_ICON_ID_TOKEN, instanceId)
  // Package tests reject unsafe markup and invalid local references in this
  // static table. Per-instance ids keep gradients and clip paths independent.
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: artwork }}
    />
  )
}
