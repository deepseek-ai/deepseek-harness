/** Read-only help stays local to Settings and never changes the selected preset. */
import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCloseOutlineRegular, IconListPenOutlineRegular, MarkdownText, Modal, SegmentedTabs, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSettingsKey } from './locales.ts'
import css from './PresetGuideDialog.module.css'

export type PresetGuidePage = 'explanation' | 'usage'

/** Locale references for one known, shipped preset. */
interface PresetGuide {
  name: AgentPresetSettingsKey
  intro: AgentPresetSettingsKey
  explanation: AgentPresetSettingsKey
  usage: AgentPresetSettingsKey
}

const guides = new Map<string, PresetGuide>([
  ['standard', { name: 'presetStandardName', intro: 'guideStandardIntro', explanation: 'guideStandardExplanation', usage: 'guideStandardUsage' }],
  ['ptc', { name: 'presetPtcName', intro: 'guidePtcIntro', explanation: 'guidePtcExplanation', usage: 'guidePtcUsage' }],
  ['minimal', { name: 'presetMinimalName', intro: 'guideMinimalIntro', explanation: 'guideMinimalExplanation', usage: 'guideMinimalUsage' }],
  ['cordis', { name: 'presetCordisName', intro: 'guideCordisIntro', explanation: 'guideCordisExplanation', usage: 'guideCordisUsage' }],
])

/**
 * Look up help only for known, shipped presets.
 * @param id - preset identifier from the roster.
 * @param trust - roster source; custom presets own their capability claims.
 * @returns the shipped guide, or undefined for unknown and custom presets.
 */
export function presetGuide(id: string, trust: string): PresetGuide | undefined {
  return trust === 'system' ? guides.get(id) : undefined
}

/** Keep keyboard focus inside a preset reader while Tab moves through its controls.
 * @param event Keyboard event from the active reader.
 */
export function trapPresetReaderTab(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'Tab') return
  const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]',
  )).filter(element => !element.closest('[hidden]'))
  const first = targets[0]
  const last = targets[targets.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

/** Curated usage dictionaries contain only level-three example sections. */
function GuideUsage({ text, t }: {
  text: string
  t: TranslateNS<'settings.agentPreset'>
}): ReactNode {
  const labels = {
    code: { copyLabel: t('guideCopy'), copiedLabel: t('guideCopied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
    footnotes: t('guideFootnotes'),
  }
  return text.split(/(?=^### )/m).map((section) => {
    const headingEnd = section.indexOf('\n')
    const title = section.slice(4, headingEnd)
    return (
      <section key={title} className={css.guideExample}>
        <div className={css.guideExampleHeader}>
          <h3>{title}</h3>
          <Tag tone="neutral" className={css.guideExampleTag}>
            <IconListPenOutlineRegular size={12} />
            {t('guideExampleTask')}
          </Tag>
        </div>
        <MarkdownText text={section.slice(headingEnd + 1)} labels={labels} />
      </section>
    )
  })
}

/**
 * Open read-only help without changing the selected preset.
 * @param props - localized guide, initial page, and close callback.
 * @returns the modal reader with independent scroll positions for each page.
 */
export function PresetGuideDialog({ guide, initialPage, t, onClose }: {
  guide: PresetGuide
  initialPage: PresetGuidePage
  t: TranslateNS<'settings.agentPreset'>
  onClose: () => void
}): ReactNode {
  const [page, setPage] = useState(initialPage)
  const guideId = useId()
  const content = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    content.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [])

  // This reader sits above Settings. Keep keyboard navigation in the reader,
  // and let Escape dismiss only this layer before returning to its trigger.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else trapPresetReaderTab(event)
  }

  return (
    <Modal open headless onClose={onClose} title={t(guide.name)} className={css.guideDialog as string}>
      <div ref={content} className={css.guideLayout} role="presentation" onKeyDownCapture={onKeyDown}>
        <div className={css.guideHeader}>
          <div className={css.guideTitleRow}>
            <h2 className={css.guideTitle}>{t(guide.name)}</h2>
            <Button variant="ghost" className={css.guideClose} aria-label={t('close')} onClick={onClose}>
              <IconCloseOutlineRegular size={18} />
            </Button>
          </div>
          <p className={css.guideIntro}>{t(guide.intro)}</p>
        </div>
        <SegmentedTabs<PresetGuidePage>
          className={css.guideTabs}
          label={t('guideSections')}
          value={page}
          onChange={setPage}
          items={[
            { value: 'explanation', label: t('modeExplanation'), id: `${guideId}-explanation-tab`, panelId: `${guideId}-explanation-panel` },
            { value: 'usage', label: t('howToUse'), id: `${guideId}-usage-tab`, panelId: `${guideId}-usage-panel` },
          ]}
        />
        {(['explanation', 'usage'] as const).map(section => (
          <div
            key={section}
            id={`${guideId}-${section}-panel`}
            role="tabpanel"
            aria-labelledby={`${guideId}-${section}-tab`}
            className={css.guidePanel}
            data-guide-page={section}
            hidden={page !== section}
            tabIndex={0}
          >
            {section === 'usage'
              ? <GuideUsage text={t(guide.usage)} t={t} />
              : (
                <MarkdownText
                  text={t(guide.explanation)}
                  labels={{
                    code: { copyLabel: t('guideCopy'), copiedLabel: t('guideCopied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
                    footnotes: t('guideFootnotes'),
                  }}
                />
              )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
