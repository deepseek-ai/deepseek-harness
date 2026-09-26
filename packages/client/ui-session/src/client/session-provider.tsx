/** Session-owned rendering semantics for the standard SessionProvider seat. */
import type { ReactNode } from 'react'
import type {
  SessionAreaProps, StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the selected Session body or its empty branch.
 * @param binding - current Session scope binding.
 * @param props - standard Session area render props.
 * @returns the selected Session subtree.
 */
export function renderSessionArea(
  binding: StandardSourceBinding,
  { empty, children }: SessionAreaProps,
): ReactNode {
  if (binding.key === undefined) return <>{empty?.() ?? null}</>
  return <>{children}</>
}
