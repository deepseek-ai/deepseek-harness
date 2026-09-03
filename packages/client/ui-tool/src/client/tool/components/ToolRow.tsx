import { useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  CodeBlock, DiffBlock, DisclosureRow, IconInspectOutline12, ReadBlock, SearchBlock, StateDot, TerminalBlock, WebBlock,
  diffTotals,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_DIFF_MAX_LINES, type DiffCardModel } from '../models/diff-card-model.ts'
import { CHAT_READ_MAX_LINES, type ReadCardModel } from '../models/read-card-model.ts'
import type { ImageCardModel } from '../models/image-card-model.ts'
import { CHAT_SEARCH_MAX_LINES, type SearchCardModel } from '../models/search-card-model.ts'
import {
  localizeTerminalCardModel, terminalBlockLabels, type TerminalCardModel,
} from '../models/terminal-card-model.ts'
import {
  diffBlockLabels, readBlockLabels, searchBlockLabels, webBlockLabels,
} from '../models/primitive-labels.ts'
import type { AskQuestionCardModel } from '../models/ask-question-card-model.ts'
import {
  formatToolBody, type ToolRowState, type ToolRowVariant,
} from '../models/tool-call-model.ts'
import type { WebCardModelProps } from '../models/web-card-model.ts'
import { AskQuestionCard } from './AskQuestionCard.tsx'
import css from './ToolRow.module.css'

export interface ToolRowProps {
  t: TranslateNS<'conversation'>
  variant: ToolRowVariant
  /** Wire tool name for tool-owned styling layered over the generic variant. */
  toolName?: string | undefined
  icon: ReactNode
  title: string
  summary: string
  /**
   * Trailing summary fragment rendered outside the ellipsized summary text, so
   * a narrow row clips the summary before this. For a fragment whose whole
   * value is surviving that clip — the todo row's parallel-active count.
   * null/absent = the summary is the whole collapsed content. Dropped on an
   * error row, whose collapsed summary is the failure line instead.
   */
  summarySuffix?: string | null | undefined
  /** Original argument JSON formatted only while the row is expanded. */
  bodyRaw?: string | null | undefined
  /** Flattened result text for the expanded Output section; null/absent = no output section. */
  output?: string | null | undefined
  /** Ask-user transcript card; card fields are mutually exclusive and replace text sections. */
  askQuestion?: AskQuestionCardModel | null | undefined
  /** Error first line shown as the collapsed summary on an error row; null/absent = keep `summary`. */
  errorSummary?: string | null | undefined
  /** Terminal card; card fields are mutually exclusive and replace text sections. */
  terminal?: TerminalCardModel | null | undefined
  diff?: DiffCardModel | null | undefined
  read?: ReadCardModel | null | undefined
  /**
   * Image-card material for a call whose result is an image (derived by
   * `imageCardModel`). Rendered through the `tool.call.images` slot, so the
   * tool layer never imports an attachment implementation nor handles URL
   * authorization.
   */
  image?: ImageCardModel | null | undefined
  /**
   * Dispatch the image gallery through the tool-owned `tool.call.images`
   * slot, supplied by the toolview that owns this row together with the
   * session-authorized loader.
   */
  renderSlot?: PropsRenderSlots<'tool.call.images'>['renderSlot'] | undefined
  /** Session-authorized image URL loader for the gallery slot. */
  loadImage?: MessageImageLoader | undefined
  search?: SearchCardModel | null | undefined
  web?: WebCardModelProps | null | undefined
  state: ToolRowState
  /**
   * Filesystem path from tool args; when set with onOpenFile, the summary
   * renders as a hover-underline link that opens the host default app.
   */
  filePath?: string | undefined
  /** Open the path with the host OS default application (already cwd-resolved). */
  onOpenFile?: ((path: string) => void) | undefined
  /**
   * Jump to this call in the trajectory view: a hover-revealed Inspect pill
   * over the expanded body. Absent = no affordance.
   */
  inspect?: (() => void) | undefined
}

function leadingFor(state: ToolRowState, icon: ReactNode): ReactNode {
  switch (state) {
    case 'error': return <StateDot state="error" />
    case 'stopped': return <StateDot state="warning" />
    default: return icon
  }
}

/** Visually hidden run-state label: the StateDot and the CSS sweep are both
 *  aria-hidden / colour-only, so assistive technology needs this text to know a
 *  row is running, failed, or interrupted. null in the ok state (the icon and
 *  summary already describe a settled row). */
function stateStatus(state: ToolRowState, t: TranslateNS<'conversation'>): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

export function ToolRow({
  t,
  variant,
  toolName,
  icon,
  title,
  summary,
  summarySuffix,
  bodyRaw,
  output,
  askQuestion,
  errorSummary,
  terminal,
  diff,
  read,
  image,
  renderSlot,
  loadImage,
  search,
  web,
  state,
  filePath,
  onOpenFile,
  inspect,
}: ToolRowProps) {
  const [expanded, setExpanded] = useState(false)
  const terminalLabels = useMemo(() => terminalBlockLabels(t), [t])
  const diffLabels = useMemo(() => diffBlockLabels(t), [t])
  const readLabels = useMemo(() => readBlockLabels(t), [t])
  const searchLabels = useMemo(() => searchBlockLabels(t), [t])
  const webLabels = useMemo(() => webBlockLabels(t), [t])
  const terminalBody = terminal === undefined || terminal === null
    ? null
    : localizeTerminalCardModel(terminal, t)
  const diffBody = diff ?? null
  const readBody = read ?? null
  const imageBody = image !== undefined && image !== null && renderSlot !== undefined && loadImage !== undefined
    ? image
    : null
  const searchBody = search ?? null
  const webBody = web ?? null
  const askQuestionBody = askQuestion ?? null
  const outputText = output ?? null
  const card = askQuestionBody ?? terminalBody ?? diffBody ?? readBody ?? imageBody ?? searchBody ?? webBody
  const expandable = bodyRaw != null || outputText !== null || card !== null
  const open = expanded && expandable
  const bodyText = useMemo(
    () => open && card === null && bodyRaw != null ? formatToolBody(variant, bodyRaw) : null,
    [bodyRaw, card, open, variant],
  )
  const status = stateStatus(state, t)
  // A failure must replace, not supplement, the normal summary.
  const failureLine = state === 'error' ? errorSummary ?? null : null
  const summaryText = failureLine ?? terminalBody?.description ?? summary
  // A diff row's collapsed line carries the card's +/- totals (the same
  // numbers the expanded footer prints) so the change size reads without
  // expanding; an explicit summarySuffix (none today on diff rows) wins.
  const diffStat = useMemo(() => {
    if (diffBody === null) return null
    const { added, removed } = diffTotals(diffBody.card.diffs)
    return `+${added} -${removed}`
  }, [diffBody])
  const suffix = failureLine === null ? summarySuffix ?? diffStat : null
  const fileLink = filePath !== undefined && onOpenFile !== undefined && failureLine === null
  const toggleExpand = () => {
    setExpanded(v => !v)
  }
  const openFile = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (filePath !== undefined) onOpenFile?.(filePath)
  }
  // Keep Enter/Space on the focused path link from bubbling to the row's
  // keydown handler, which would preventDefault() the key and toggle expand
  // instead of activating the link — the keyboard analogue of openFile's
  // stopPropagation. The native button still fires its own onClick from the key.
  const fileLinkKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }
  // The code variant's program renders through CodeBlock (shiki), so only its
  // output joins the IN/OUT card; every other variant's input does too.
  const cardBody = variant === 'code' ? null : bodyText
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      {status !== null && <span className={css.visuallyHidden}>{status}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={leadingFor(state, icon)}
        title={title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggleExpand}
        collapsedContent={summaryText !== '' && (
          /* An empty summary drops the separator with it (a row that is only
             its title shows no trailing dot). */
          <>
            <span className={css.sep} aria-hidden />
            {fileLink ? (
              <button
                type="button"
                className={css.fileLink}
                onClick={openFile}
                onKeyDown={fileLinkKeyDown}
              >
                {summaryText}
              </button>
            ) : (
              <span
                className={clsx(css.summary, failureLine !== null && css.errorSummary)}
              >
                {summaryText}
              </span>
            )}
            {suffix !== null && (
              <span className={clsx(css.summarySuffix, suffix === diffStat && css.diffStat)}>{suffix}</span>
            )}
          </>
        )}
      >
        <div className={css.bodyWrap}>
          {askQuestionBody !== null
            ? <AskQuestionCard card={askQuestionBody} />
            : terminalBody !== null
              ? (
                <TerminalBlock
                  {...terminalBody.card}
                  maxLines={Infinity}
                  labels={terminalLabels}
                  className={css.terminalBody}
                />
              )
              : diffBody !== null
                ? <DiffBlock {...diffBody.card} labels={diffLabels} maxLines={CHAT_DIFF_MAX_LINES} className={css.diffBody} />
                : readBody !== null
                  ? <ReadBlock {...readBody} labels={readLabels} maxLines={CHAT_READ_MAX_LINES} className={css.readBody} />
                  : imageBody !== null
                    ? (
                      /* Label, gallery, then the result's OWN envelope text. The text
                         comes from the image card model (which reads the result's text
                         block), never from the row's flattened output: an image read's
                         content is [text envelope, image block] and flattening
                         JSON.stringifies the image block, printing the raw attachment
                         object under the picture. It is not redundant either — the
                         attachment slot can render nothing, and then this line is the
                         only evidence an image was returned. */
                      <div className={css.imageBody}>
                        <div className={css.imageLabel}>{imageBody.label}</div>
                        {renderSlot !== undefined && loadImage !== undefined && renderSlot('tool.call.images', {
                          images: imageBody.images,
                          loadImage,
                          align: 'start',
                        })}
                        <div className={css.imageMeta}>{imageBody.text}</div>
                      </div>
                    )
                    : searchBody !== null
                      ? (
                        <>
                          <SearchBlock
                            {...searchBody.card}
                            labels={searchLabels}
                            maxLines={CHAT_SEARCH_MAX_LINES}
                            className={css.searchBody}
                          />
                          {/* A capped search's recovery locator lives only in the result
                          text; show it below the card so the dropped rows survive. */}
                          {searchBody.recovery !== undefined && (
                            <div className={css.searchRecovery}>{searchBody.recovery}</div>
                          )}
                        </>
                      )
                      : webBody !== null
                        ? <WebBlock {...webBody} labels={webLabels} className={css.webBody} />
                        : (
                          <>
                            {variant === 'code' && bodyText !== null && (
                              <div className={css.bodyScroll}>
                                <CodeBlock code={bodyText} lang="typescript" copyLabel={t('copy')} copiedLabel={t('copied')} className={css.codeBody} />
                              </div>
                            )}
                            {(cardBody !== null || outputText !== null) && (
                              <div className={css.ioCard}>
                                {cardBody !== null && (
                                  <div className={css.ioSection}>
                                    <span className={css.ioLabel}>{t('row.input')}</span>
                                    <span className={css.ioText}>{cardBody}</span>
                                  </div>
                                )}
                                {cardBody !== null && outputText !== null && (
                                  <span className={css.ioDivider} aria-hidden />
                                )}
                                {outputText !== null && (
                                  <div className={css.ioSection}>
                                    <span className={css.ioLabel}>{t('row.output')}</span>
                                    <span className={css.ioText} data-error={state === 'error' || undefined}>
                                      {outputText}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
          {inspect !== undefined && (
            <button
              type="button"
              className={css.inspectButton}
              onClick={inspect}
            >
              <IconInspectOutline12 />
              {t('row.inspect')}
            </button>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
