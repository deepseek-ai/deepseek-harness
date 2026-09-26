/** Stable React identities for the two grouping reference kinds. */
import type { RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/**
 * Identify a rendering position independently of presentation mode.
 * @param entry - mode-independent rendering reference.
 * @returns its collision-free React key.
 */
export function chatRenderKey(entry: RenderEntry): string {
  switch (entry.kind) {
    case 'node': return JSON.stringify(['node', entry.key, entry.groupPart ?? null])
    case 'group': return JSON.stringify(['group', entry.key])
    default: return assertNever(entry)
  }
}
