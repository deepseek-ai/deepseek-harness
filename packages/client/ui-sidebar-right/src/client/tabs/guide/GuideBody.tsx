/**
 * The guide tab's body: a chain host, and the guide it falls back to.
 *
 * The chain is the replacement seam. A product with its own idea of what an
 * empty sidebar should say registers into `sidebar.right.tab.guide`, and its entry
 * takes the whole body; with no entry, or with every entry declining, the guide
 * below renders. The shipped guide is the owner's fallback rather than a chain
 * entry of its own, so there is always exactly one body and the shipped one
 * cannot be outvoted by accident.
 *
 * The shipped guide is a muted compass over the entry capsules every
 * registered type contributed, centred in the body, and nothing else — no
 * heading, as a browser start page shows its doors without a caption. While
 * at most four entries are listed, a capsule with a description shows it
 * under the title; a longer list drops every description to stay light.
 * Picking one opens that type as a page
 * in this tab's place, so the guide is a doorway rather than a page that stays
 * open.
 */
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChainRenderOpts, HookContextOf, InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightGuideBox } from '../../tab-registry.ts'
import { CompassGlyph, CubeGlyph } from './GuideTitle.tsx'
import css from './GuideBody.module.css'

/** What the guide body needs from its host beyond the framework shares. */
export interface GuideInjected {
  /** The registry's guide entries in `order`; observable, so a type registering later appears. */
  readonly hooks: { readonly guideEntries: ObservableSnapshot<readonly SidebarRightGuideBox[]> }
}

/** The guide body's composed props: the tab it draws, its chain child, and the entries. */
export type GuideBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.guide'>
  & InjectFace<GuideInjected>

/** Entry count past which the guide drops the capsules' descriptions to stay light. */
const MAX_DESCRIBED_ENTRIES = 4

/** One entry capsule: the contributing type's glyph and title, and its description while the guide is short. */
function EntryBox({ entry, described, onPick }: {
  entry: SidebarRightGuideBox
  described: boolean
  onPick: (entry: SidebarRightGuideBox) => void
}): ReactNode {
  const Icon = entry.icon ?? CubeGlyph
  const description = described ? entry.description?.() : undefined
  return (
    <button
      type="button"
      className={css.entry}
      data-sidebar-right-guide-entry={entry.kind}
      onClick={() => { onPick(entry) }}
    >
      {/* The glyph rides the capsule's height: 22 beside a bare title, 26 beside two lines. */}
      <span className={css.entryIcon}>
        <Icon size={description === undefined ? 22 : 26} className={entry.icon === undefined ? css.placeholderInk : undefined} />
      </span>
      <span className={css.entryText}>
        <span className={css.entryTitle}>{entry.title()}</span>
        {description !== undefined && <span className={css.entryDescription}>{description}</span>}
      </span>
    </button>
  )
}

/** The shipped guide: the tab's own compass over the doors out of the column. */
function ShippedGuide({ entries, onPick }: {
  entries: readonly SidebarRightGuideBox[]
  onPick: (entry: SidebarRightGuideBox) => void
}): ReactNode {
  return (
    <div className={css.guide} data-sidebar-right-guide>
      <span className={css.hero} aria-hidden="true"><CompassGlyph size={56} /></span>
      {/* Keyed by position in the ordered list: one type may contribute several capsules, and `order` is not unique. */}
      {entries.map((entry, index) => (
        <EntryBox key={`${entry.kind}:${index}`} entry={entry} described={entries.length <= MAX_DESCRIBED_ENTRIES} onPick={onPick} />
      ))}
    </div>
  )
}

/** The guide tab's body, replaceable through its chain child. */
export function GuideBody({ useTabInfo, useGuideEntries, renderSlotChain }: GuideBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const entries = useGuideEntries(entries => entries)
  const options = {
    hookContext: useTabInfo,
    fallback: (
      <ShippedGuide entries={entries}
        onPick={(entry) => { tab.actions.openTab(entry.kind, { replaceTab: true }) }} />
    ),
  } satisfies ChainRenderOpts & { hookContext: HookContextOf<'sidebar.right.tab.guide'> }
  return renderSlotChain('sidebar.right.tab.guide', {}, options)
}
