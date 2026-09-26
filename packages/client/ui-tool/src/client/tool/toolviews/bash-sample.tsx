import { memo, useCallback, useMemo, type KeyboardEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import clsx from 'clsx'
import {
  IconApiOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconInspectOutlineRegular,
  TerminalBlock, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import {
  isSettledPersistentShellCall,
  isSpilledShellCall,
  localizeTerminalCardModel,
  terminalBlockLabels,
  terminalCardModel,
  terminalFailed,
} from '../models/terminal-card-model.ts'
import { formatToolBody, toolRowModel, toolTitleKey, type ToolRowState } from '../models/tool-call-model.ts'
import { PreparingToolRow } from '../components/PreparingToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'
import css from './bash-sample.module.css'

type BashRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const BASH_ICON = <IconApiOutlineRegular size={14} />

/** Visually hidden status for the color-only running sweep and error tone. */
function stateStatus(state: ToolRowState, t: BashRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('bash.running')
    case 'error': return t('bash.failed')
    case 'stopped': return t('bash.stopped')
    default: return null
  }
}

/**
 * Render expandable Bash output with an accessible lifecycle label.
 * @param props - tool call, Session sources, locale, and inspection callback.
 * @returns the Bash output row.
 */
export const BashRow = memo(function BashRow(props: BashRowProps) {
  if (props.phase === 'preparing') return <PreparingToolRow {...props}
    icon={BASH_ICON} title={props.t(toolTitleKey(props.toolName))} />
  return <StartedBashRow {...props} />
})

const StartedBashRow = memo(function StartedBashRow({ toolName, block, sessionId, useSessions, inspect, useDisclosure, t }: Exclude<BashRowProps, { phase: 'preparing' }>) {
  const model = useMemo(() => toolRowModel(toolName, block), [toolName, block])
  // An omitted shell workdir is the session workspace; relative values resolve
  // against it before reaching the terminal primitive.
  const cwd = useSessions(list => list.byId[sessionId]?.cwd)
  const terminalModel = useMemo(() => terminalCardModel(block, cwd), [block, cwd])
  const terminal = useMemo(() => terminalModel === null ? null : localizeTerminalCardModel(terminalModel, t), [terminalModel, t])
  const labels = useMemo(() => terminalBlockLabels(t), [t])
  // A failing exit status is the terminal card's own error signal (the call
  // itself settles isError:false), surfaced through the row's error summary.
  const state = model.state === 'ok' && terminalModel !== null && terminalFailed(terminalModel)
    ? 'error'
    : model.state
  const status = stateStatus(state, t)
  const { expanded, toggle: toggleExpand } = useDisclosure()
  // Failures, persistent-shell results, and spill previews use a generic body;
  // background acknowledgements and malformed calls remain collapsed.
  const genericBody = terminal === null
    && (model.state === 'error' || isSettledPersistentShellCall(block) || isSpilledShellCall(block))
    && (model.bodyRaw !== null || model.output !== null)
  const expandable = terminal !== null || genericBody
  const open = expanded && expandable
  const body = useMemo(
    () => open && genericBody && model.bodyRaw !== null
      ? formatToolBody(model.variant, model.bodyRaw)
      : null,
    [genericBody, model.bodyRaw, model.variant, open],
  )
  const normalSummary = terminal?.description ?? model.summary
  const settlementLine = state === 'error'
    ? model.errorSummary ?? normalSummary
    : state === 'stopped' ? t('bash.stopped') : null
  const running = state === 'running'
  const toggleFromKeyboard = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }, [expandable, toggleExpand])
  const leading = open
    ? <IconChevronUpOutlineRegular className={css.chevron} />
    : expandable
      ? (
        <>
          <span className={css.iconIdle}>{BASH_ICON}</span>
          <IconChevronDownOutlineRegular className={clsx(css.chevron, css.chevronHover)} />
        </>
      )
      : BASH_ICON
  return (
    <div className={css.card}>
      <div
        className={css.root}
        data-sample="bash"
        data-variant="bash"
        data-state={state}
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? toggleExpand : undefined}
        onKeyDown={expandable ? toggleFromKeyboard : undefined}
      >
        <span className={css.leading}>{leading}</span>
        {status !== null && <span className={css.visuallyHidden}>{status}</span>}
        <TextShimmer className={css.title} active={running}>{t(model.titleKey)}</TextShimmer>
        <span className={css.sep} aria-hidden />
        <span className={clsx(
          css.summary,
          state === 'error' && css.errorSummary,
          state === 'stopped' && css.stoppedSummary,
        )}>
          <TextShimmer active={running}>{settlementLine ?? normalSummary}</TextShimmer>
        </span>
      </div>
      {open && (
        <div className={css.bodyWrap}>
          {terminal !== null
            ? (
              <TerminalBlock
                {...terminal.card}
                maxLines={Infinity}
                labels={labels}
                className={css.terminal}
              />
            )
            : (
              <div className={css.ioCard}>
                {body !== null && (
                  <div className={css.ioSection}>
                    <span className={css.ioLabel}>{t('row.input')}</span>
                    <span className={css.ioText}>{body}</span>
                  </div>
                )}
                {body !== null && model.output !== null && (
                  <span className={css.ioDivider} aria-hidden />
                )}
                {model.output !== null && (
                  <div className={css.ioSection}>
                    <span className={css.ioLabel}>{t('row.output')}</span>
                    <span className={css.ioText} data-error={state === 'error' || undefined}>
                      {model.output}
                    </span>
                  </div>
                )}
              </div>
            )}
          {inspect !== undefined && (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              <IconInspectOutlineRegular />
              {t('row.inspect')}
            </button>
          )}
        </div>
      )}
    </div>
  )
})

/** Registers the standalone Bash conversation-row sample. */
export const bashToolviewSample = {
  name: 'bash-toolview-sample',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'bash', locale: NS }, BashRow))
  },
}
