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
 * The shipped guide is a muted compass over the pinned entry capsules every
 * registered type contributed, centred in the body, with no heading, as a
 * browser start page shows its doors without a caption. While at most four
 * capsules are visible, a capsule with a description shows it under the title;
 * a longer list drops every description to stay light. A More card follows
 * while `sidebar.right.tab.guide.actions` has registrations.
 * Picking one opens that type as a page
 * in this tab's place, so the guide is a doorway rather than a page that stays
 * open.
 */
import { useState } from 'react'
import { Menu, ShortcutKeys } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ShortcutCatalogEntry } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  ChainRenderOpts, HookContextOf, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightGuideActionsOwnerProps } from '../../contract/slots.ts'
import type { SidebarRightGuideBox } from '../../tab-registry.ts'
import { CompassGlyph, CubeGlyph } from './GuideTitle.tsx'
import { GuideMoreIcon } from './GuideMoreIcon.tsx'
import { FIXED_GUIDE_KIND, guideEntryId } from './guide-pins.ts'
import css from './GuideBody.module.css'

/** What the guide body needs from its host beyond the framework shares. */
export interface GuideInjected {
  /** The registry's guide entries in `order`; observable, so a type registering later appears. */
  readonly hooks: {
    readonly shortcuts: ObservableSnapshot<readonly ShortcutCatalogEntry[]>
    readonly guideEntries: ObservableSnapshot<readonly SidebarRightGuideBox[]>
    /** Unpinned `kind:id` card ids held in memory until plugin reload. */
    readonly entryPins: ObservableSnapshot<readonly string[]>
    /** Whether `sidebar.right.tab.guide.actions` has registrations. */
    readonly entryActions: ObservableSnapshot<boolean>
  }
  /**
   * Show or unpin one guide card; cards of kind `files` are ignored.
   * @param id - `kind:id` card id.
   * @param pinned - Whether the card shows on the guide.
   */
  readonly setPinned: (id: string, pinned: boolean) => void
}

/** The guide body's composed props: the tab it draws, its chain child, and the entries. */
export type GuideBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.guide' | 'sidebar.right.tab.guide.entry' | 'sidebar.right.tab.guide.actions'>
  & InjectFace<GuideInjected> & PropsLocale<'sidebarRight'>

/** Entry count past which the guide drops the capsules' descriptions to stay light. */
const MAX_DESCRIBED_ENTRIES = 4

/** One entry capsule: the contributing type's glyph and title, and its description while the guide is short. */
function EntryBox({ entry, described, onPick, shortcut }: {
  shortcut: ShortcutCatalogEntry | undefined
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
      aria-keyshortcuts={shortcut?.aria}
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
      {shortcut !== undefined && shortcut.keys.length > 0 && <ShortcutKeys keys={shortcut.keys} />}
    </button>
  )
}

type GuideMoreMenuProps =
  Omit<SidebarRightGuideActionsOwnerProps, 'onDismiss'>
  & Pick<GuideBodyProps, 'renderSlot'>
  & { readonly label: string }

/** The guide's More card; its menu rows come from `sidebar.right.tab.guide.actions` and span at least the card width. */
function GuideMoreMenu({ label, entries, onOpen, onPinnedChange, renderSlot }: GuideMoreMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus minWidthFromAnchor align="end"
      className={css.moreAnchor} listClassName={css.moreMenu}
      anchor={(
        <button type="button" className={css.entry} aria-label={label} aria-haspopup="menu" aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}>
          <span className={css.entryIcon}><GuideMoreIcon /></span>
          <span className={css.entryText}><span className={css.entryTitle}>{label}</span></span>
        </button>
      )}>
      {renderSlot('sidebar.right.tab.guide.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

/** The shipped guide: the tab's own compass over the doors out of the column. */
function ShippedGuide({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className={css.guide} data-sidebar-right-guide>
      <span className={css.hero} aria-hidden="true"><CompassGlyph size={56} /></span>
      {children}
    </div>
  )
}

/** The guide tab's body, replaceable through its chain child. */
export function GuideBody({
  useTabInfo, useGuideEntries, renderSlot, renderSlotChain, useShortcuts, useEntryPins, useEntryActions, setPinned, t,
}: GuideBodyProps): ReactNode {
  const shortcuts = useShortcuts(entries => entries)
  const { tab } = useTabInfo()
  const entries = useGuideEntries(entries => entries)
  const unpinned = useEntryPins(ids => ids)
  const hasEntryActions = useEntryActions(registered => registered)
  // A new page replaces the guide; a page already in its pane is revealed, and the guide then closes itself.
  const open = (kind: string): void => {
    tab.actions.openTab(kind, { replaceTab: true })
    tab.actions.close()
  }
  const visibleEntries = entries.filter(entry => entry.kind === FIXED_GUIDE_KIND || !unpinned.includes(guideEntryId(entry)))
  const options = {
    hookContext: useTabInfo,
    fallback: (
      <ShippedGuide>{visibleEntries.map((entry) => {
        const described = visibleEntries.length <= MAX_DESCRIBED_ENTRIES
        const description = described ? entry.description?.() : undefined
        return <div key={JSON.stringify([entry.providerId, entry.id])} className={css.entryCell}>
          {renderSlot('sidebar.right.tab.guide.entry', {
            entryId: entry.id, kind: entry.kind, title: entry.title(),
            ...description === undefined ? {} : { description },
          }, {
            entryKey: entry.providerId, hookContext: useTabInfo,
            fallback: <EntryBox entry={entry} described={described} shortcut={shortcuts.find(shortcut => shortcut.id === entry.commandId)}
              onPick={(selected) => { open(selected.kind) }} />,
          })}
        </div>
      })}
      {hasEntryActions && (
        <GuideMoreMenu
          label={t('tab.guide.more')}
          entries={entries.filter(entry => entry.kind !== FIXED_GUIDE_KIND)
            .map(entry => ({ id: guideEntryId(entry), label: entry.title(), pinned: !unpinned.includes(guideEntryId(entry)) }))}
          onOpen={(id) => {
            const entry = entries.find(candidate => guideEntryId(candidate) === id)
            if (entry !== undefined) open(entry.kind)
          }}
          onPinnedChange={setPinned}
          renderSlot={renderSlot}
        />
      )}
      </ShippedGuide>
    ),
  } satisfies ChainRenderOpts & { hookContext: HookContextOf<'sidebar.right.tab.guide'> }
  return renderSlotChain('sidebar.right.tab.guide', {}, options)
}
