/** General Settings renders registered groups with shared headings and cards. */
import { useId } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import css from './GeneralSection.module.css'

/** Winning group identities and resolved labels, in display order. */
export interface GeneralSectionInjected {
  hooks: { groups: ObservableSnapshot<readonly { id: string; label: string }[]> }
}

/** Page owner, localized title, group ledger snapshot, and group renderer. */
export type GeneralSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.general.group'> &
  PropsLocale<'settings'> & InjectFace<GeneralSectionInjected>

/**
 * Render the registered groups with uniform title, card, and spacing treatments.
 * @param props - page title, ordered group identities, and authorized group renderer.
 * @returns the General Settings page.
 */
export function GeneralSection({ renderSlot, useGroups, t }: GeneralSectionComponentProps) {
  const groups = useGroups(value => value)
  const headingId = useId()
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('general.nav')}</h2>
      {groups.map((group) => {
        const id = `${headingId}-${encodeURIComponent(group.id)}`
        return (
          <section key={group.id} className={css.group} aria-labelledby={id}>
            <h3 id={id} className={css.groupTitle}>{group.label}</h3>
            <div className={css.card}>
              {renderSlot('settings.general.group', {}, { only: group.id })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
