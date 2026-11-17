/** Projection of the section list's registrations into the titles the panel draws. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPanelSectionEntry } from './slots.ts'

const SECTION_SLOT = 'conversation.session.panel.section'

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
 * Observable section roster: recomputed when the section list's ledger or
 * the active locale changes, and identity-stable between changes.
 * @param ctx - client context whose slot registry and locale the roster follows.
 * @returns the section source.
 */
export function sectionSource(ctx: ClientContext): ObservableSnapshot<readonly SessionPanelSectionEntry[]> {
  let version = -1
  let revision = -1
  let sections: readonly SessionPanelSectionEntry[] = []
  return {
    getSnapshot: () => {
      const nextVersion = ctx.slots.getVersion(SECTION_SLOT)
      const nextRevision = ctx.locale.getSnapshot().revision
      if (nextVersion !== version || nextRevision !== revision) {
        const reportOnce = version !== nextVersion
        version = nextVersion
        revision = nextRevision
        sections = projectSections(ctx.slots.entriesOfSlot(SECTION_SLOT), (message) => {
          if (reportOnce) console.error(message)
        })
      }
      return sections
    },
    subscribe: (listener) => {
      const offLedger = ctx.slots.subscribe(SECTION_SLOT, listener)
      const offLocale = ctx.locale.subscribe(listener)
      return () => {
        offLedger()
        offLocale()
      }
    },
  }
}
