/** Decorative occupant for the task-manager sidebar entry. */
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the clock glyph at the size the sidebar asks for; the sidebar owns
 * its accessible navigation label. The glyph is the row's direct icon child,
 * as on every other panel row: an inline wrapper makes it the baseline of a
 * line box inside the row's glyph slot, which lifts it above the label.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative clock icon.
 */
export function TaskManagerIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconClockOutlineRegular size={size} />
}
