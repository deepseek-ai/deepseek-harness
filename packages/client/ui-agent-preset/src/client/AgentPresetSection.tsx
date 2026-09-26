/** Preset selection settings: the roster, its default, mode help, a read-only view of each composition, and the Creator-mode entry. */
import type { ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button, IconBrowseOutlineRegular, IconPlusOutlineRegular, Modal, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentPresetSectionState } from './section-store.ts'
import { isBuiltInPreset, presetDisplayText } from './locales.ts'
import { PresetGuideDialog, presetGuide, trapPresetReaderTab, type PresetGuidePage } from './PresetGuideDialog.tsx'
import css from './AgentPresetSection.module.css'

/** Settings actions and their shared controller state. */
export interface AgentPresetSectionInjected {
  hooks: {
    agentPresetSection: SnapshotStore<AgentPresetSectionState>
    /** Shared Developer tools preference; off hides every selection action. */
    developerTools: ObservableSnapshot<boolean>
  }
  /** Stage the `cordis` preset and start a Creator-mode task; absent without a conversation flow. */
  startCreatorDraft?: () => void
  load: () => Promise<void>
  /** Open one preset's declared composition in the read-only viewer. */
  view: (id: string) => Promise<void>
  /** Close the read-only viewer. */
  closeView: () => void
  makeDefault: (id: string) => Promise<void>
}
/** Props assembled by the settings renderer. */
export type AgentPresetSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.agentPreset'> & InjectFace<AgentPresetSectionInjected>

function CardDescription({ text }: { text: string }): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    /* v8 ignore next -- the ref is attached before layout effects run. */
    if (el === null) return
    const measure = () => { setTruncated(el.scrollHeight > el.clientHeight) }
    measure()
    // Card width follows the settings pane, which resizes with the window.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [text])
  return (
    // Capped near the card's own width: the default half-viewport bubble would
    // spill a description out of the settings dialog and across the app behind it.
    <Tooltip label={text} side="bottom" delayMs={400} disabled={!truncated} maxWidth={360}>
      {/* The empty title stops the card body's native tooltip from climbing to
        this span: a cut-off description answers with one bubble, not two. */}
      <span ref={ref} className={css.cardDesc} title="">{text}</span>
    </Tooltip>
  )
}

/** Render the roster with its default, mode help, composition viewer, and the guidance to Creator mode.
 * @param props Settings actions, snapshot hooks and localized text.
 * @returns The preset settings section.
 */
export function AgentPresetSection({
  useAgentPresetSection, load, view, closeView, makeDefault, startCreatorDraft,
  close: closeSettings, useDeveloperTools, t,
}: AgentPresetSectionProps) {
  const state = useAgentPresetSection(value => value)
  const developerTools = useDeveloperTools(enabled => enabled)
  const [guide, setGuide] = useState<{
    content: NonNullable<ReturnType<typeof presetGuide>>
    page: PresetGuidePage
  } | null>(null)
  const viewTrigger = useRef<HTMLButtonElement | null>(null)
  const closeViewOnUnmount = useRef(closeView)
  useEffect(() => { void load() }, [load])
  useLayoutEffect(() => { closeViewOnUnmount.current = closeView }, [closeView])
  useEffect(() => () => { closeViewOnUnmount.current() }, [])
  const closeViewer = () => { closeView(); viewTrigger.current?.focus() }
  const viewed = state.view
  const viewedRow = viewed === null ? undefined : state.rows.find(row => row.id === viewed.id)
  const viewedTitle = viewed === null ? '' : viewedRow === undefined ? viewed.title : presetDisplayText(viewedRow, t).name
  // Creator mode authors presets in conversation; it needs the flow to land a
  // session in and the self-referential preset on the roster.
  const creator = startCreatorDraft !== undefined && state.rows.some(row => row.id === 'cordis') ? startCreatorDraft : undefined
  /* The custom group is where a preset of one's own appears, so its entry
     stays on screen even while the group is empty. */
  const creatorButton = creator === undefined
    ? null
    : (
      <button
        type="button"
        className={css.creatorButton}
        disabled={!developerTools || state.saving}
        title={developerTools ? undefined : t('enableDevToolsToCreate')}
        onClick={() => { creator(); closeSettings() }}
      >
        <IconPlusOutlineRegular size={14} />
        {t('creatorDraft')}
      </button>
    )
  return <section className={css.section}>
    <h2 className={css.title}>{t('nav')}</h2>
    <p className={css.intro}>{t('sectionIntro')}</p>
    {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}
    {([true, false] as const).map((builtIn) => {
      const rows = state.rows.filter(row => isBuiltInPreset(row) === builtIn)
      const entry = builtIn ? null : creatorButton
      if (rows.length === 0 && entry === null) return null
      return <section key={String(builtIn)} className={css.group}>
        <h3 className={css.groupHead}>{t(builtIn ? 'builtInGroup' : 'customGroup')}</h3>
        {rows.length === 0 ? null : <ul className={css.cards}>
          {rows.map((row) => {
            const display = presetDisplayText(row, t)
            const help = presetGuide(row.id, builtIn ? 'system' : 'user')
            const selectionAction = row.broken !== undefined ? t('brokenBadge')
              : row.isDefault ? t('inUse')
                : t(developerTools ? 'setDefault' : 'enableDevToolsToSetDefault')
            return <li key={row.id} data-agent-preset-id={row.id} className={[
              css.card, row.broken === undefined ? undefined : css.cardBroken,
              row.isDefault ? css.cardActive : undefined,
              !developerTools && row.broken === undefined && !row.isDefault ? css.cardSelectionDisabled : undefined,
            ].filter(Boolean).join(' ')}>
              <button type="button" className={css.cardMain} aria-pressed={row.isDefault}
                disabled={row.isDefault || (row.broken === undefined && (!developerTools || state.saving))}
                aria-disabled={row.broken !== undefined} aria-label={`${selectionAction}: ${display.name}`} title={selectionAction}
                onClick={() => { if (row.broken === undefined) void makeDefault(row.id) }}>
                <span className={css.cardHead}>
                  <span className={css.cardIdentity}>
                    <span className={css.cardName} title={display.name}>{display.name}</span>
                    {row.broken === undefined ? null : <span className={css.brokenBadge}>
                      {t('brokenBadge')}<span className={css.brokenTip} aria-hidden="true">{row.broken}</span>
                    </span>}
                    <Tag tone={row.isDefault ? 'solid' : 'outline'}>
                      {row.isDefault ? t('inUse') : t(builtIn ? 'builtInGroup' : 'customGroup')}
                    </Tag>
                  </span>
                  <code className={css.cardId} title={row.id}>{row.id}</code>
                </span>
                <CardDescription text={display.description ?? t('noDescription')} />
                {row.broken === undefined ? null : <span className={css.cardBrokenReason} role="alert">{row.broken}</span>}
              </button>
              <div className={css.cardFoot}>
                {help === undefined ? null : <div className={css.cardHelp}>
                  <Button variant="ghost" className={css.helpButton} aria-label={`${t('modeExplanation')}: ${display.name}`}
                    onClick={() => { setGuide({ content: help, page: 'explanation' }) }}>{t('modeExplanation')}</Button>
                  <Button variant="ghost" className={css.helpButton} aria-label={`${t('howToUse')}: ${display.name}`}
                    onClick={() => { setGuide({ content: help, page: 'usage' }) }}>{t('howToUse')}</Button>
                </div>}
                {/* Reading the declaration is the one thing this page offers
                  beyond choosing: a broken preset's YAML is also where its
                  diagnostic points, so the viewer stays available for it. */}
                <button type="button" className={css.iconButton} data-tip={t('view')} aria-label={`${t('view')}: ${display.name}`}
                  onClick={(event) => { viewTrigger.current = event.currentTarget; void view(row.id) }}>
                  <IconBrowseOutlineRegular />
                </button>
              </div>
            </li>
          })}
        </ul>}
        {entry}
      </section>
    })}
    {guide === null ? null : <PresetGuideDialog guide={guide.content} initialPage={guide.page} t={t} onClose={() => { setGuide(null) }} />}
    <Modal open={viewed !== null} onClose={closeViewer} closeLabel={t('close')}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closeViewer()
        } else trapPresetReaderTab(event)
      }}
      title={viewed === null ? '' : `${t('view')} · ${viewedTitle}`} className={css.dialog as string}
      footer={<Button variant="outline" autoFocus onClick={closeViewer}>{t('close')}</Button>}>
      {viewed === null ? null : <pre className={css.viewerCode}>{viewed.content}</pre>}
    </Modal>
  </section>
}
