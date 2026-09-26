/** Read-only `cordis_define` card with Host and Client source tabs. */

import { useId, useState } from 'react'
import {
  CodeBlock, DisclosureRow, IconCodeOutlineRegular, IconInspectOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { cordisDefineCard, type CordisToolState } from './card-model.ts'
import type { CordisCardFace } from './slots.ts'
import { cordisVisibleStatus, type CordisVisibleStatus } from './status.ts'
import type { CordisKey } from './locales.ts'
import css from './CordisDefineRow.module.css'
import { CordisPreparingRow } from './CordisPreparingRow.tsx'

/** Full card props composed by the keyed Tool slot. */
export type CordisDefineRowProps = ToolCallViewProps & InjectFace<CordisCardFace> & PropsLocale<'cordis'>

type CardReading = CordisVisibleStatus | 'removed'
type SourceTab = 'client' | 'host'

const READING_LABELS = {
  idle: 'status.idle',
  'client-pending': 'status.clientPending',
  running: 'status.running',
  removed: 'status.removed',
} as const satisfies Record<CardReading, CordisKey>

function stateStatus(state: CordisToolState): CordisKey | null {
  switch (state) {
    case 'running': return 'a11y.defining'
    case 'error': return 'a11y.failed'
    case 'stopped': return 'a11y.stopped'
    default: return null
  }
}

/** Render one immutable Package definition. */
export function CordisDefineRow(props: CordisDefineRowProps) {
  if (props.phase === 'preparing') return <CordisPreparingRow {...props}
    icon={<IconCodeOutlineRegular size={14} />} title={props.t('row.defineTitle')}
    className={css.card} rowClassName={css.row} titleClassName={css.title} />
  return <StartedCordisDefineRow {...props} />
}

function StartedCordisDefineRow({
  callId, block, inspect, useInventory, useLoaded, t,
}: Exclude<CordisDefineRowProps, { phase: 'preparing' }>) {
  const card = cordisDefineCard(block)
  const inventory = useInventory(snapshot => snapshot)
  const loaded = useLoaded(snapshot => snapshot)
  const [expanded, setExpanded] = useState(false)
  const [selectedSource, setSelectedSource] = useState<SourceTab>(card.clientCode !== null ? 'client' : 'host')
  const sourcePanelId = useId()

  const row = card.pluginId === null
    ? undefined
    : inventory.rows.find(candidate => candidate.pluginId === card.pluginId)
  const reading: CardReading = card.pluginId !== null && inventory.removed.has(card.pluginId)
    ? 'removed'
    : row !== undefined && card.packageId !== null
      ? cordisVisibleStatus(row, card.packageId, loaded)
      : 'idle'
  const name = card.name ?? callId
  const expandable = card.hostCode !== null || card.clientCode !== null || card.output !== null
  const open = expanded && expandable
  const a11yState = stateStatus(card.state)
  const hasSource = card.clientCode !== null || card.hostCode !== null
  const activeSource: SourceTab = selectedSource === 'client' && card.clientCode !== null
    ? 'client'
    : selectedSource === 'host' && card.hostCode !== null
      ? 'host'
      : card.clientCode !== null ? 'client' : 'host'
  const activeCode = activeSource === 'client' ? card.clientCode : card.hostCode

  return (
    <div
      className={css.card}
      data-tool="cordis_define"
      data-state={card.state}
      data-terminal={reading === 'removed' || undefined}
      data-cordis-plugin-id={card.pluginId ?? undefined}
      data-cordis-package-id={card.packageId ?? undefined}
      data-cordis-status={reading}
    >
      {a11yState !== null && <span className={css.visuallyHidden}>{t(a11yState)}</span>}
      <DisclosureRow
        rowClassName={css.row}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconCodeOutlineRegular size={14} />}
        title={t('row.defineTitle')}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={card.errorSummary === null ? css.name : css.errorSummary}>
              {card.errorSummary ?? name}
            </span>
            {card.errorSummary === null && (
              <span className={css.purpose}>{card.purpose ?? t('purpose.missing')}</span>
            )}
            {card.pluginId !== null && (
              <span className={css.readout}>
                <span className={css.statusLabel}>{t(READING_LABELS[reading])}</span>
              </span>
            )}
          </>
        )}
      >
        <div className={css.bodyWrap}>
          {hasSource && activeCode !== null && (
            <section className={css.sourceCard}>
              <div className={css.sourceTabs} role="tablist" aria-label={t('body.source')}>
                {(['client', 'host'] as const).map((source) => {
                  const available = source === 'client' ? card.clientCode !== null : card.hostCode !== null
                  return (
                    <button
                      key={source}
                      id={`${sourcePanelId}-${source}`}
                      type="button"
                      role="tab"
                      aria-controls={sourcePanelId}
                      aria-selected={activeSource === source}
                      className={activeSource === source ? `${css.sourceTab} ${css.sourceTabActive}` : css.sourceTab}
                      disabled={!available}
                      onClick={() => { setSelectedSource(source) }}
                    >
                      {t(source === 'client' ? 'body.clientCode' : 'body.hostCode')}
                    </button>
                  )
                })}
              </div>
              <div
                id={sourcePanelId}
                className={css.sourcePanel}
                role="tabpanel"
                aria-labelledby={`${sourcePanelId}-${activeSource}`}
              >
                <CodeBlock
                  toolbarLabels={{ codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') }}
                  code={activeCode}
                  lang="javascript"
                  copyLabel={t('body.copy')}
                  copiedLabel={t('body.copied')}
                  className={css.sourceCode}
                />
              </div>
            </section>
          )}
          {card.output !== null && (
            <section className={css.codeSection}>
              <div className={css.sectionLabel}>{t('body.output')}</div>
              <pre className={css.output} data-error={card.state === 'error' || undefined}>{card.output}</pre>
            </section>
          )}
          {card.pluginId !== null && <div className={css.panelHint}>{t('panel.hint')}</div>}
          {inspect !== undefined && (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              <IconInspectOutlineRegular />
              {t('action.inspect')}
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
