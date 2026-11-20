/** Committed system sections and pending compaction recovery folded from the Session log. */

import { z } from 'zod'
import type { SystemMessage, TextBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Effective instructions contributed by one source. */
export interface CommittedSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** Committed system instructions recovered from the Session log. */
export interface SectionAdmissions {
  readonly sections: readonly CommittedSection[]
  readonly complete: boolean
  /** Whether a compaction or a system message without `source.sections` still requires a full reset. */
  readonly needsRebuild: boolean
}

const stateSchema: z.ZodType<SectionAdmissions> = z.object({
  sections: z.array(z.object({ name: z.string(), order: z.number(), text: z.string() })),
  complete: z.boolean(),
  needsRebuild: z.boolean(),
})

function emptyState(): SectionAdmissions {
  return { sections: [], complete: false, needsRebuild: false }
}

function textAt(message: SystemMessage, index: number): string {
  // Session validates persisted indices; same-process writers construct text-only records.
  return (message.content[index] as TextBlock).text
}

function apply(state: SectionAdmissions, event: SessionEvent): SectionAdmissions {
  // Optional producers extend the event map; this fold only needs their event name.
  const eventType: string = event.type
  if (eventType === 'compaction/summary') {
    return state.needsRebuild ? state : { ...state, needsRebuild: true }
  }
  if (event.type !== 'system/message') return state

  const message = event.data.message
  const source = message.source
  // Earlier releases, format migrations, and importers write whole prompts or placeholders without sections.
  if (source.sections === undefined) return { sections: [], complete: false, needsRebuild: true }
  if (!source.reset && source.sections.length === 0) return state
  const sections = new Map((source.reset ? [] : state.sections).map(section => [section.name, section]))
  for (const section of source.sections) {
    if (section.state === 'retired') sections.delete(section.name)
    else {
      sections.set(section.name, { name: section.name, order: section.order, text: textAt(message, section.contentIndex) })
    }
  }
  return {
    sections: [...sections.values()],
    complete: source.complete === true,
    // Only the reset that ends a rebuild is written while one is pending.
    needsRebuild: source.reset ? false : state.needsRebuild,
  }
}

/** Host-only effective sections, owned by the system-prompt service. */
export const sectionAdmissionsDefinition: ProjectionDefinition<'systemSections', SectionAdmissions> = {
  key: 'systemSections',
  stateVersion: 4,
  stateSchema,
  init: emptyState,
  apply,
}
