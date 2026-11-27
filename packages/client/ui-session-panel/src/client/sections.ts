/** Projection of the section list's registrations into the titles the panel draws, in the reader's order. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { SessionPanelSectionEntry } from './slots.ts'

const SECTION_SLOT = 'conversation.session.panel.section'

/** Id of the built-in Environment section, which always shows first and cannot be moved. */
export const ENVIRONMENT_SECTION_ID = 'environment'

/** localStorage key of the section order the reader chose: section ids, first to last. */
export const SECTION_ORDER_STORAGE_KEY = 'dsh.sessionPanel.sectionOrder'

/**
 * Project live section registrations in display order. A registration
 * without a label cannot be titled; it is reported and left out.
 * @param entries - shadowing winners of the section list in ledger order.
 * @param report - receives one message per unlabeled registration.
 * @returns sections ordered by ascending `order`, then registration order.
 */
export function projectSections(
  entries: readonly StoredEntry[], report: (message: string) => void,
): readonly SessionPanelSectionEntry[] {
  const rows: (SessionPanelSectionEntry & { readonly order: number })[] = []
  for (const entry of entries) {
    /* v8 ignore next -- list registration validates id at load. */
    const id = entry.options.id ?? ''
    const label = resolveSlotLabel(entry.options.label)
    if (label === undefined || label === '') {
      report(`ui-session-panel: section "${id}" from ${entry.registrant ?? 'an unknown registrant'} has no label and is not shown`)
      continue
    }
    rows.push({ id, label, order: entry.options.order ?? 0 })
  }
  return rows.sort((a, b) => a.order - b.order).map(({ id, label }) => ({ id, label }))
}

/**
 * Put sections in the order the reader chose, after the Environment section,
 * which always comes first. The other sections the choice names come in its
 * order; one it does not name, such as one registered since, follows the
 * section it follows among them in the registered order, or leads them when
 * nothing precedes it there. Ids the choice names that no section has are
 * ignored, as is the place the choice gives Environment.
 * @param sections - sections in registered order.
 * @param preferred - section ids in the reader's order.
 * @returns the sections in display order; the same array when that is the registered order's.
 */
export function orderSections(
  sections: readonly SessionPanelSectionEntry[], preferred: readonly string[],
): readonly SessionPanelSectionEntry[] {
  const environment = sections.find(section => section.id === ENVIRONMENT_SECTION_ID)
  const rest = environment === undefined ? sections : sections.filter(section => section !== environment)
  const byId = new Map(rest.map(section => [section.id, section]))
  const ordered = [...new Set(preferred)].flatMap(id => byId.get(id) ?? [])
  if (ordered.length === 0) return environment === undefined || sections[0] === environment ? sections : [environment, ...rest]
  const named = new Set(ordered)
  let anchor: SessionPanelSectionEntry | undefined
  for (const section of rest) {
    if (!named.has(section)) ordered.splice(anchor === undefined ? 0 : ordered.indexOf(anchor) + 1, 0, section)
    anchor = section
  }
  return environment === undefined ? ordered : [environment, ...ordered]
}

/** The section roster the panel draws, and the reader's reordering of it. */
export interface SectionSource extends ObservableSnapshot<readonly SessionPanelSectionEntry[]> {
  /**
   * Move a section beside another and persist the resulting order of every
   * live section. No effect when either id is not a live section, both are
   * the same one, or the section to move is Environment.
   * @param id - section to move.
   * @param target - section it lands beside.
   * @param placement - the side of the target it lands on; a section always lands after Environment.
   */
  readonly move: (id: string, target: string, placement: 'before' | 'after') => void
}

/**
 * Observable section roster in the reader's order: recomputed when the
 * section list's ledger, the active locale, or the stored order changes, and
 * identity-stable between changes. A stored value that is not a list of
 * strings counts as no choice.
 * @param ctx - client context whose slot registry and locale the roster follows.
 * @returns the section source.
 */
export function sectionSource(ctx: ClientContext): SectionSource {
  const stored = createSnapshotStore<unknown>([], { persist: { name: SECTION_ORDER_STORAGE_KEY } })
  let version = -1
  let revision = -1
  let choice: unknown
  let sections: readonly SessionPanelSectionEntry[] = []
  const getSnapshot = (): readonly SessionPanelSectionEntry[] => {
    const nextVersion = ctx.slots.getVersion(SECTION_SLOT)
    const nextRevision = ctx.locale.getSnapshot().revision
    const nextChoice = stored.getSnapshot()
    if (nextVersion !== version || nextRevision !== revision || nextChoice !== choice) {
      const reportOnce = version !== nextVersion
      version = nextVersion
      revision = nextRevision
      choice = nextChoice
      const preferred = Array.isArray(nextChoice) ? nextChoice.filter((id): id is string => typeof id === 'string') : []
      sections = orderSections(projectSections(ctx.slots.entriesOfSlot(SECTION_SLOT), (message) => {
        if (reportOnce) console.error(message)
      }), preferred)
    }
    return sections
  }
  return {
    getSnapshot,
    subscribe: (listener) => {
      const offs = [ctx.slots.subscribe(SECTION_SLOT, listener), ctx.locale.subscribe(listener), stored.subscribe(listener)]
      return () => {
        for (const off of offs) off()
      }
    },
    move: (id, target, placement) => {
      const ids = getSnapshot().map(section => section.id)
      if (id === target || id === ENVIRONMENT_SECTION_ID || !ids.includes(id) || !ids.includes(target)) return
      const rest = ids.filter(other => other !== id)
      rest.splice(rest.indexOf(target) + (placement === 'after' || target === ENVIRONMENT_SECTION_ID ? 1 : 0), 0, id)
      stored.set(rest)
    },
  }
}
