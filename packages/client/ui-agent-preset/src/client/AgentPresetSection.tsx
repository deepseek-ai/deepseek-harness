/**
 * Agent-presets settings section: the roster as cards, a copy dialog as the
 * only way a preset is created, and a read-only viewer over the shipped
 * compositions.
 *
 * The browser edits no composition text — a shipped preset opens read-only to
 * be READ (it is the known-good composition a copy starts from), and a custom
 * preset is edited in its own files, which is what the location action leads
 * to. Deleting a preset leaves running sessions alone: a composition is
 * mounted once at session creation and nothing re-reads the file.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconBrowseOutline16, IconCopyOutline16, IconFolderOpenOutline16, IconPlusOutline16, IconTrashOutline16, Modal, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { draftBlocker, type AgentPresetSectionState } from './section-store.ts'
import { presetDisplayText, type AgentPresetSettingsKey } from './locales.ts'
import css from './AgentPresetSection.module.css'

/** Registration-side business face for the management section. */
export interface AgentPresetSectionInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useAgentPresetSection. */
    agentPresetSection: SnapshotStore<AgentPresetSectionState>
  }
  /** Read the roster; called once when the section first renders. */
  load: () => Promise<void>
  /** Open one shipped preset's composition in the read-only viewer. */
  view: (id: string) => Promise<void>
  /** Close the read-only viewer. */
  closeView: () => void
  /** Open the copy dialog over one preset. */
  beginCopy: (from: string) => void
  /** Close the copy dialog, discarding the draft. */
  cancelCopy: () => void
  /** Name the preset the copy creates. */
  setCopyId: (id: string) => void
  /** Name the copy's display name. */
  setCopyName: (name: string) => void
  /** Submit the copy. */
  confirmCopy: () => Promise<void>
  /** Open one preset's directory, or reveal its path where there is no desktop. */
  openLocation: (id: string) => Promise<void>
  /**
   * Stage the self-referential preset and start a new session on it — the
   * guided way to author a preset, beside copying. Absent when the surface
   * is composed without the conversation flow to land the session in.
   */
  startCreatorDraft?: () => void
  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete: (id: string | null) => void
  /** Delete the preset awaiting confirmation. */
  remove: () => Promise<void>
  /** Make one preset the default for sessions created later. */
  makeDefault: (id: string) => Promise<void>
}

/** Full component props. */
export type AgentPresetSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetSectionInjected>

/** Copy-dialog sub-view props: the draft plus the actions that mutate it. */
interface CopyDialogProps {
  state: AgentPresetSectionState
  t: (key: AgentPresetSettingsKey) => string
  actions: Pick<AgentPresetSectionInjected,
    'cancelCopy' | 'confirmCopy' | 'setCopyId' | 'setCopyName'>
}

function CopyDialog({ state, t, actions }: CopyDialogProps): ReactNode {
  const draft = state.copy
  const blocker = draft === null ? undefined : draftBlocker(draft, state.rows)
  const message = draft === null ? null : draft.error ?? (blocker === undefined ? null : t(blocker))
  const source = draft === null ? undefined : state.rows.find(row => row.id === draft.from)
  const sourceTitle = source === undefined ? draft?.fromTitle : presetDisplayText(source, t).name
  return (
    <Modal
      open={draft !== null}
      onClose={() => { actions.cancelCopy() }}
      title={draft === null ? t('copyTitle') : `${t('copyTitle')} · ${t('copyOf')} ${sourceTitle}`}
      closeLabel={t('close')}
      description={t('copyIntro')}
      className={css.dialog as string}
      footer={(
        <>
          <Button
            variant="outline"
            disabled={draft?.saving === true}
            onClick={() => { actions.cancelCopy() }}
          >
            {t('cancel')}
          </Button>
          <Button
            disabled={draft === null || draft.saving || blocker !== undefined}
            onClick={() => { void actions.confirmCopy() }}
          >
            {draft?.saving === true ? t('creating') : t('create')}
          </Button>
        </>
      )}
    >
      {draft === null
        ? null
        : (
          <div className={css.dialogFields}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('presetId')}</span>
              <input
                className={css.input}
                value={draft.id}
                autoFocus
                spellCheck={false}
                placeholder={t('presetIdPlaceholder')}
                onChange={(event) => { actions.setCopyId(event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('displayName')}</span>
              <input
                className={css.input}
                value={draft.name}
                spellCheck={false}
                placeholder={t('displayNamePlaceholder')}
                onChange={(event) => { actions.setCopyName(event.target.value) }}
              />
            </label>
            {message === null ? null : <p className={css.error} role="alert">{message}</p>}
          </div>
        )}
    </Modal>
  )
}

/**
 * Render one card's description, clamped by CSS and offered in full on hover.
 * The tooltip is attached only while the text is actually cut off, so a short
 * description does not answer a hover with a bubble repeating the card.
 * @param props.text - the description as rendered, already localized.
 * @returns the description element, tooltip-anchored while it overflows.
 */
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

/**
 * Render the Agent presets section content column.
 * @param props - composed slot props.
 * @returns the section, or null when the deployment composes no presets.
 */
export function AgentPresetSection(props: AgentPresetSectionProps): ReactNode {
  const { useAgentPresetSection, t, load } = props
  const state = useAgentPresetSection(snapshot => snapshot)
  const viewedId = state.view?.id
  const viewedRow = viewedId === undefined ? undefined : state.rows.find(row => row.id === viewedId)
  const viewedTitle = state.view === null
    ? ''
    : viewedRow === undefined ? state.view.title : presetDisplayText(viewedRow, t).name

  useEffect(() => {
    void load()
  }, [load])

  // A deployment that composes no presets has nothing to manage: every
  // session shares the host composition and the page would be an empty list.
  if (state.status === 'unavailable') return null
  if (state.status === 'error') {
    /* v8 ignore next -- an error status always carries text; the fallback satisfies the nullable type */
    const detail = state.error ?? ''
    return (
      <div className={css.section}>
        <p className={css.error} role="alert">{`${t('error')} ${detail}`}</p>
        <button type="button" className={css.secondaryButton} onClick={() => { void load() }}>
          {t('retry')}
        </button>
      </div>
    )
  }

  /* The guided alternative to copying: the self-referential preset can
     read this very composition and author a new one in conversation.
     Offered only where that preset is actually on the roster and a
     session can be landed; without a writable root the draft could
     never be discovered, so the reason rides the disabled button. */
  const creatorButton = props.startCreatorDraft !== undefined && state.rows.some(row => row.id === 'cordis')
    ? (
      <button
        type="button"
        className={css.creatorButton}
        disabled={!state.authorable}
        title={state.authorable ? undefined : t('duplicateUnavailable')}
        onClick={() => {
          props.startCreatorDraft?.()
          props.close()
        }}
      >
        <IconPlusOutline16 size={14} />
        {t('creatorDraft')}
      </button>
    )
    : null

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      {state.error === null ? null : <p className={css.error} role="alert">{state.error}</p>}
      {([['system', t('builtInGroup')], ['user', t('customGroup')]] as const).map(([trust, heading]) => {
        const group = state.rows
          .filter(row => row.trust === trust)
          .map(row => ({ row, text: presetDisplayText(row, t) }))
        // The custom group is where a preset of one's own will appear, so it
        // stays on screen even while empty: heading plus the creator entry.
        const tail = trust === 'user' ? creatorButton : null
        if (group.length === 0 && tail === null) return null
        return (
          <section key={trust} className={css.group}>
            <h3 className={css.groupHead}>{heading}</h3>
            {group.length === 0 ? null : (
              <ul className={css.cards}>
                {group.map(({ row, text }) => (
                  <li
                    key={row.id}
                    className={row.broken !== undefined
                      ? `${css.card} ${css.cardBroken}`
                      : row.isDefault ? `${css.card} ${css.cardActive}` : css.card}
                  >
                    {/* The card body IS the control: picking a preset is the
                      common act, so it should not hide behind a small button.
                      The action row sits outside it — nesting buttons is
                      invalid, and these act on the card rather than select it.
                      A broken preset cannot compose a session, so its body
                      refuses the pick; the reason rides the badge rather than
                      the card face, which stays the preset's own
                      description. */}
                    <button
                      type="button"
                      className={css.cardMain}
                      aria-pressed={row.isDefault}
                      // Broken says so through `aria-disabled` rather than
                      // `disabled`, which would take the card out of the tab
                      // order. With the reason moved onto the badge, that is
                      // the only way anyone without a pointer reaches it.
                      disabled={row.isDefault}
                      aria-disabled={row.broken !== undefined}
                      // Without this the name is the whole card read aloud —
                      // title, badge, description, id.
                      aria-label={`${row.broken !== undefined ? t('brokenBadge') : row.isDefault ? t('inUse') : t('setDefault')}: ${text.name}`}
                      // The reason rides the badge, not the whole card: two
                      // tooltips over one target would race, and the card's
                      // own label answers what clicking it would do.
                      title={row.broken !== undefined ? t('brokenBadge') : row.isDefault ? t('inUse') : t('setDefault')}
                      onClick={() => {
                        if (row.broken !== undefined) return
                        void props.makeDefault(row.id)
                      }}
                    >
                      <span className={css.cardHead}>
                        <span className={css.cardName}>{text.name}</span>
                        {row.broken !== undefined
                          ? (
                            <span className={css.brokenBadge}>
                              {t('brokenBadge')}
                              {/* Pointer-only, hence `aria-hidden`: the same
                                reason reaches assistive technology through the
                                alert below, and a second copy inside the card's
                                own text would be read out twice. */}
                              <span className={css.brokenTip} aria-hidden="true">{row.broken}</span>
                            </span>
                          )
                          : null}
                        <Tag>
                          {row.trust === 'user' ? t('userTrust') : t('builtIn')}
                        </Tag>
                        {row.isDefault ? <Tag tone="solid" className={css.inUse}>{t('inUse')}</Tag> : null}
                      </span>
                      <CardDescription text={text.description ?? t('noDescription')} />
                      {/* Visually hidden, deliberately: the pointer path is the
                        badge's tooltip, and a disabled card body is out of the
                        tab order, so this is the only reading a screen reader
                        or a keyboard-only user gets. */}
                      {row.broken === undefined
                        ? null
                        : <span className={css.cardBrokenReason} role="alert">{row.broken}</span>}
                      <code className={css.cardId}>{row.id}</code>
                    </button>
                    <div className={css.cardFoot}>
                      {/* Shipped presets are the compositions a copy starts
                        from, so READING one is the point; a custom preset is
                        edited in its files instead, which the location action
                        leads to. A broken shipped preset has no readable
                        composition to offer, so its viewer is withheld; a
                        broken custom one keeps the location action — the
                        files are where it gets fixed. */}
                      {row.trust === 'system'
                        ? row.broken === undefined
                          ? (
                            <button
                              type="button"
                              className={css.iconButton}
                              data-tip={t('view')}
                              aria-label={`${t('view')}: ${text.name}`}
                              onClick={() => { void props.view(row.id) }}
                            >
                              <IconBrowseOutline16 />
                            </button>
                          )
                          : null
                        : (
                          <button
                            type="button"
                            className={css.iconButton}
                            data-tip={state.hasDocument ? t('openLocation') : t('showLocation')}
                            aria-label={`${state.hasDocument ? t('openLocation') : t('showLocation')}: ${text.name}`}
                            onClick={() => { void props.openLocation(row.id) }}
                          >
                            <IconFolderOpenOutline16 />
                          </button>
                        )}
                      <button
                        type="button"
                        className={css.iconButton}
                        disabled={!state.authorable || row.broken !== undefined}
                        data-tip={row.broken !== undefined
                          ? t('brokenNoCopy')
                          : state.authorable ? t('duplicate') : t('duplicateUnavailable')}
                        aria-label={`${t('duplicate')}: ${text.name}`}
                        onClick={() => { props.beginCopy(row.id) }}
                      >
                        <IconCopyOutline16 />
                      </button>
                      {row.trust === 'user'
                        ? (
                          <button
                            type="button"
                            className={`${css.iconButton} ${css.iconDanger}`}
                            data-tip={t('delete')}
                            aria-label={`${t('delete')}: ${text.name}`}
                            onClick={() => { props.confirmDelete(row.id) }}
                          >
                            <IconTrashOutline16 />
                          </button>
                        )
                        : null}
                    </div>
                    {state.revealedPaths[row.id] === undefined
                      ? null
                      : (
                        <p className={css.revealedPath}>
                          <span className={css.revealedPathLabel}>{t('revealedPathLabel')}</span>
                          <code>{state.revealedPaths[row.id]}</code>
                        </p>
                      )}
                  </li>
                ))}
              </ul>
            )}
            {tail}
          </section>
        )
      })}
      <CopyDialog
        state={state}
        t={t}
        actions={{
          cancelCopy: props.cancelCopy,
          confirmCopy: props.confirmCopy,
          setCopyId: props.setCopyId,
          setCopyName: props.setCopyName,
        }}
      />
      <Modal
        open={state.view !== null}
        onClose={() => { props.closeView() }}
        title={state.view === null ? '' : `${t('view')} · ${viewedTitle}`}
        closeLabel={t('close')}
        description={t('composition')}
        className={css.dialog as string}
        footer={(
          <Button variant="outline" autoFocus onClick={() => { props.closeView() }}>
            {t('close')}
          </Button>
        )}
      >
        {state.view === null
          ? null
          : <pre className={css.viewerCode}>{state.view.content}</pre>}
      </Modal>
      <Modal
        open={state.pendingDelete !== null}
        onClose={() => { props.confirmDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={t('deleteDescription')}
        className={css.deleteDialog as string}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={state.deleting}
              onClick={() => { props.confirmDelete(null) }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={state.deleting}
              onClick={() => { void props.remove() }}
            >
              {state.deleting ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      />
    </div>
  )
}
