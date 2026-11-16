/** Built-in Environment section: one shared title over the rows other plugins register. */
import type { ReactNode } from 'react'
import type { EnvironmentSectionProps } from './slots.ts'

/**
 * Render the Environment rows with the section's owner values. The rows render
 * straight into the section body, so a section without rows renders nothing
 * and the panel hides it.
 * @param props - the section's owner values and child renderer.
 * @returns the row outlet.
 */
export function EnvironmentSection({ presentation, dismissOverlay, renderSlot }: EnvironmentSectionProps): ReactNode {
  return renderSlot('conversation.session.panel.environment.row', { presentation, dismissOverlay })
}
