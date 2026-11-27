import type { ReactNode } from 'react'
import { ICON_MEDIUM_STROKE, ICON_REGULAR_STROKE } from './icons/index.tsx'
import type { IconProps } from './icons/props.ts'
import {
  BrowseOutlineArtwork, ChatLinesOutlineArtwork, FolderCloseArtwork,
} from './icons/shared-artwork.tsx'

/** Reference domains with distinct composer and transcript glyphs. */
export type ReferenceIconKind = 'session' | 'file' | 'folder'

/** Props shared by inline reference glyphs. */
export interface ReferenceIconProps extends IconProps {
  kind: ReferenceIconKind
}

interface WeightedReferenceIconProps extends ReferenceIconProps {
  strokeWidth: number
}

/**
 * Render the icon that identifies one inline reference domain.
 * @param props - Reference kind, optional size, and optional CSS class.
 * @returns The corresponding decorative current-color SVG glyph.
 */
function ReferenceIconArtwork({ kind, size = 16, className, strokeWidth }: WeightedReferenceIconProps): ReactNode {
  switch (kind) {
    case 'session': return <ChatLinesOutlineArtwork size={size} className={className} strokeWidth={strokeWidth} />
    case 'file': return <BrowseOutlineArtwork size={size} className={className} strokeWidth={strokeWidth} />
    case 'folder': return <FolderCloseArtwork size={size} className={className} strokeWidth={strokeWidth} />
  }
}

/**
 * Render a regular one-pixel reference icon.
 * @param props - Reference kind, size, and optional class.
 * @returns The regular decorative reference glyph.
 */
export function ReferenceIconRegular(props: ReferenceIconProps): ReactNode {
  return <ReferenceIconArtwork {...props} strokeWidth={ICON_REGULAR_STROKE} />
}

/**
 * Render a medium 1.3px reference icon.
 * @param props - Reference kind, size, and optional class.
 * @returns The medium decorative reference glyph.
 */
export function ReferenceIconMedium(props: ReferenceIconProps): ReactNode {
  return <ReferenceIconArtwork {...props} strokeWidth={ICON_MEDIUM_STROKE} />
}
