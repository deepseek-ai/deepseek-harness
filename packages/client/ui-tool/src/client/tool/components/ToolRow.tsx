import { memo, useCallback, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  CodeBlock, DiffBlock, DisclosureRow, IconInspectOutlineRegular, ReadBlock, SearchBlock,
  TerminalBlock, TextShimmer, WebBlock,
  diffTotals,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenFileOptions, UseDisclosure } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CHAT_DIFF_MAX_LINES, type DiffCardModel } from '../models/diff-card-model.ts'
import { CHAT_READ_MAX_LINES, type ReadCardModel } from '../models/read-card-model.ts'
import type { ImageCardModel } from '../models/image-card-model.ts'
import { CHAT_SEARCH_MAX_LINES, type SearchCardModel } from '../models/search-card-model.ts'
import {
  localizeTerminalCardModel, terminalBlockLabels, type TerminalCardModel,
} from '../models/terminal-card-model.ts'
import {
  codeToolbarLabels, diffBlockLabels, readBlockLabels, searchBlockLabels, webBlockLabels,
} from '../models/primitive-labels.ts'
import type { AskQuestionCardModel } from '../models/ask-question-card-model.ts'
import {
  formatToolBody, type ToolRowState, type ToolRowVariant,
} from '../models/tool-call-model.ts'
import type { WebCardModelProps } from '../models/web-card-model.ts'
import { AskQuestionCard } from './AskQuestionCard.tsx'
import { ToolDetails, type ToolDetailsModel } from './ToolDetails.tsx'
import css from './ToolRow.module.css'

export interface ToolRowProps {
  /** Subscribe here, where the row owns its expanded body. */
  useDisclosure: UseDisclosure
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
  /** Read-only fields/list card derived from a successful recorded result. */
  details?: ToolDetailsModel | null | undefined
  state: ToolRowState
  /**
   * Filesystem path from tool args; when set with onOpenFile, the summary
   * renders as a hover-underline link that opens the host default app.
   */
  filePath?: string | undefined
  /** 1-based line the call was about; absent = open the file at its beginning. */
  filePathLine?: number | undefined
  /** Open the path (already cwd-resolved), landing on `filePathLine` when given. */
  onOpenFile?: ((path: string, options?: OpenFileOptions) => void) | undefined
  /** Safe http(s) URL from tool args; when set, the summary renders as a link that opens it in a new tab. */
  href?: string | undefined
  /**
   * Jump to this call in the trajectory view: a hover-revealed Inspect pill
   * over the expanded body. Absent = no affordance.
   */
  inspect?: (() => void) | undefined
}

/** Keep a summary link click from toggling the row; the browser still follows the link. */
function stopLinkClick(event: MouseEvent<HTMLAnchorElement>): void {
  event.stopPropagation()
}

/** Visually hidden run-state label for color-only running and settlement cues. */
function stateStatus(state: ToolRowState, t: TranslateNS<'conversation'>): string | null {
  switch (state) {
    case 'preparing': return t('row.preparing')
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    case 'stopped': return t('row.stopped')
    default: return null
  }
}

/**
 * Render one localized tool summary and lazily mounted result card.
 * Preparation retains the icon, title, and optional tool-name summary without disclosure.
 * @param props - tool state, summary, output, and navigation callbacks.
 * @returns the tool disclosure.
 */
export const ToolRow = memo(function ToolRow({
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
  details,
  state,
  filePath,
  filePathLine,
  onOpenFile,
  href,
  inspect,
  useDisclosure,
}: ToolRowProps) {
  const { expanded, toggle: toggleExpand } = useDisclosure()
  const terminalLabels = useMemo(() => terminalBlockLabels(t), [t])
  const diffLabels = useMemo(() => diffBlockLabels(t), [t])
  const readLabels = useMemo(() => readBlockLabels(t), [t])
  const searchLabels = useMemo(() => searchBlockLabels(t), [t])
  const webLabels = useMemo(() => webBlockLabels(t), [t])
  const terminalBody = useMemo(() => terminal === undefined || terminal === null
    ? null
    : localizeTerminalCardModel(terminal, t), [terminal, t])
  const diffBody = diff ?? null
  const readBody = read ?? null
  const imageBody = image !== undefined && image !== null && renderSlot !== undefined && loadImage !== undefined
    ? image
    : null
  const searchBody = search ?? null
  const webBody = web ?? null
  const askQuestionBody = askQuestion ?? null
  const detailsBody = details ?? null
  const inputRaw = bodyRaw ?? null
  const outputText = output ?? null
  const card = askQuestionBody ?? terminalBody ?? diffBody ?? readBody ?? imageBody ?? searchBody ?? webBody ?? detailsBody
  const expandable = state !== 'preparing' && (inputRaw !== null || outputText !== null || card !== null)
  const open = expanded && expandable
  const bodyText = useMemo(
    () => open && card === null && inputRaw !== null ? formatToolBody(variant, inputRaw) : null,
    [card, inputRaw, open, variant],
  )
  const status = stateStatus(state, t)
  const running = state === 'running' || state === 'preparing'
  const normalSummary = terminalBody?.description ?? (open ? detailsBody?.expandedSummary ?? summary : summary)
  // A failure keeps its first result line when available and otherwise turns
  // the ordinary summary red. An interruption turns the tool-owned summary
  // amber while retaining the business icon and hidden state announcement.
  const failureLine = state === 'error' ? errorSummary ?? normalSummary : null
  const summaryText = failureLine ?? normalSummary
  // The tool row keeps the diff's +/- totals visible while its body is collapsed.
  // An explicit summarySuffix overrides the diff totals.
  const diffStat = useMemo(() => {
    if (diffBody === null) return null
    const { added, removed } = diffTotals(diffBody.card.diffs)
    return `+${added} -${removed}`
  }, [diffBody])
  const settledWithCue = state === 'error' || state === 'stopped'
  const suffix = settledWithCue ? null : summarySuffix ?? diffStat
  const openFile = useMemo(() => filePath !== undefined && onOpenFile !== undefined && !settledWithCue
    ? (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (filePathLine === undefined) onOpenFile(filePath)
      else onOpenFile(filePath, { line: filePathLine })
    }
    : undefined, [filePath, filePathLine, onOpenFile, settledWithCue])
  const linkHref = settledWithCue ? undefined : href
  // Keep Enter/Space on the focused path or URL link from bubbling to the row's
  // keydown handler, which would preventDefault() the key and toggle expand
  // instead of activating the link — the keyboard analogue of the click
  // handlers' stopPropagation. Enter activates both links and Space activates
  // the path button; Space on a URL link does nothing.
  const summaryLinkKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
  }, [])
  // The code variant's program renders through CodeBlock (shiki), so only its
  // output joins the IN/OUT card; every other variant's input does too.
  const cardBody = variant === 'code' ? null : bodyText
  const collapsedContent = useMemo(() => summaryText !== '' && (
    /* An empty summary drops the separator with it (a row that is only
       its title shows no trailing dot). */
    <>
      <span className={css.sep} aria-hidden />
      {openFile !== undefined ? (
        <button
          type="button"
          className={css.fileLink}
          onClick={openFile}
          onKeyDown={summaryLinkKeyDown}
        >
          <TextShimmer active={running}>{summaryText}</TextShimmer>
        </button>
      ) : linkHref !== undefined ? (
        <a
          className={css.fileLink}
          href={linkHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stopLinkClick}
          onKeyDown={summaryLinkKeyDown}
        >
          <TextShimmer active={running}>{summaryText}</TextShimmer>
        </a>
      ) : (
        <span
          className={clsx(
            css.summary,
            state === 'error' && css.errorSummary,
            state === 'stopped' && css.stoppedSummary,
          )}
        >
          <TextShimmer active={running}>{summaryText}</TextShimmer>
        </span>
      )}
      {suffix !== null && (
        <TextShimmer className={clsx(css.summarySuffix, suffix === diffStat && css.diffStat)} active={running}>{suffix}</TextShimmer>
      )}
    </>
  ), [diffStat, summaryLinkKeyDown, linkHref, openFile, running, state, suffix, summaryText])
  const expandedContent = useMemo(() => open ? (
    <div className={clsx(css.bodyWrap, detailsBody !== null && css.detailsBodyWrap)}>
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
                    : detailsBody !== null
                      ? <ToolDetails model={detailsBody} hasInspect={inspect !== undefined} t={t} onOpenFile={onOpenFile} />
                      : (
                        <>
                          {variant === 'code' && bodyText !== null && (
                            <div className={css.bodyScroll}>
                              <CodeBlock code={bodyText} lang="typescript" copyLabel={t('copy')} copiedLabel={t('copied')}
                                toolbarLabels={codeToolbarLabels(t)} className={css.codeBody} />
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
          <IconInspectOutlineRegular />
          {t('row.inspect')}
        </button>
      )}
    </div>
  ) : undefined, [
    open, detailsBody, askQuestionBody, terminalBody, terminalLabels, diffBody, diffLabels, readBody, readLabels,
    imageBody, renderSlot, loadImage, searchBody, searchLabels, webBody, webLabels, inspect, t, onOpenFile,
    variant, bodyText, cardBody, outputText, state,
  ])
  return (
    <div className={css.root} data-variant={variant} data-tool={toolName} data-state={state}>
      {status !== null && <span className={css.visuallyHidden}>{status}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={icon}
        title={title}
        running={running}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={toggleExpand}
        collapsedContent={collapsedContent}
      >
        {expandedContent}
      </DisclosureRow>
    </div>
  )
})
