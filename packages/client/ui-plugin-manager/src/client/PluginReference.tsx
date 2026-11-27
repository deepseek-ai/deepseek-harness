/** Read-only plugin reference chip in sent user text. */
import type { ReactNode } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PluginArtworkDefault, Tag } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type {} from './plugin-reference.ts'
import css from './PluginReference.module.css'

/**
 * Render one plugin reference as a neutral capsule with the plugin artwork.
 * @param props - resolved mention data and the original wire spelling.
 * @returns the inline plugin chip.
 */
export function PluginReference({ node, raw }: UserTextNodeProps<'plugin'>): ReactNode {
  return (
    <span className={css.chip} title={raw}>
      <Tag tone="neutral">
        <span className={css.content}>
          <PluginArtworkDefault size={14} />
          <span>{node.data.label}</span>
        </span>
      </Tag>
    </span>
  )
}
