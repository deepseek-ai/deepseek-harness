import { useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconInspectOutlineRegular, IconSkillOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StartedToolCallViewProps, ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SkillRow.module.css'

/** Skill row lifecycle derived solely from the durable call slice. */
type SkillRowState = 'running' | 'ok' | 'error' | 'stopped'

type SkillRowProps = ToolCallViewProps & PropsLocale<'skill'>

/** Compact, replay-stable view model for the dedicated row. */
interface SkillRowModel {
  readonly name: string
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: SkillRowState
}

/** First physical line for the collapsed error summary and malformed-args fallback. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** Skill names are the only call argument the compact row presents. */
function skillName(argsRaw: string, callId: string): string {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed === 'object' && parsed !== null) {
      const name = (parsed as Record<string, unknown>).name
      if (typeof name === 'string' && name !== '') return firstLine(name)
    }
  } catch {
    // Streaming can expose a truncated JSON prefix; its first line is still
    // more useful than replacing the call with an unrelated catalog lookup.
  }
  return argsRaw === '' ? callId : firstLine(argsRaw)
}

/** Flatten durable result blocks under the generic Tool-row text contract.
 *  Keep aligned with ui-tool's models/tool-call-model.ts `resultText`. */
function resultText(block: StartedToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`)
  }
  return parts.join('\n') || null
}

/** Derive display state without consulting the live skill catalog. */
function skillRowModel(block: StartedToolCallViewProps['block']): SkillRowModel {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: SkillRowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = resultText(block)
  return {
    name: skillName(argsRaw, block.callId),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/** Leading disclosure slot: state icon at rest, chevron on hover or while open. */
function disclosureLeading(open: boolean, expandable: boolean): ReactNode {
  if (open) return <IconChevronDownOutlineRegular className={css.chevron} />
  const icon = <IconSkillOutlineRegular size={14} />
  if (!expandable) return icon
  return (
    <>
      <span className={css.iconIdle}>{icon}</span>
      <IconChevronDownOutlineRegular className={`${css.chevron} ${css.chevronHover}`} />
    </>
  )
}

/** Visually hidden state copy for the color-only running sweep and error tone. */
function stateStatus(state: SkillRowState, t: SkillRowProps['t']): string | null {
  switch (state) {
    case 'running': return t('row.running')
    case 'error': return t('row.failed')
    default: return null
  }
}

/**
 * Render one `skill` tool call as an accent summary and instructions disclosure.
 * @param props - keyed toolview payload plus the skill locale seat.
 * @returns the dedicated skill row.
 */
export function SkillRow(props: SkillRowProps) {
  if (props.phase === 'preparing') return <div className={css.card} data-tool="skill" data-state="preparing">
    <div className={css.row}>
      <span className={css.leading}><IconSkillOutlineRegular size={14} /></span>
      <span className={css.visuallyHidden}>{props.t('row.preparing')}</span>
      <span className={css.title}>{props.t('row.title')}</span>
    </div>
  </div>
  return <StartedSkillRow {...props} />
}

function StartedSkillRow({ block, inspect, t }: Exclude<SkillRowProps, { phase: 'preparing' }>) {
  const model = skillRowModel(block)
  const [expanded, setExpanded] = useState(false)
  const expandable = model.output !== null
  const open = expanded && expandable
  const status = stateStatus(model.state, t)
  const summary = model.state === 'stopped' ? t('row.stopped') : model.errorSummary ?? model.name
  const toggleExpand = (): void => {
    setExpanded(value => !value)
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggleExpand()
  }
  const disclosureProps = expandable ? {
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': open,
    onClick: toggleExpand,
    onKeyDown: toggleFromKeyboard,
  } : {}
  const leading = disclosureLeading(open, expandable)
  return (
    <div className={css.card} data-tool="skill" data-state={model.state}>
      <div
        className={css.row}
        data-expandable={expandable || undefined}
        {...disclosureProps}
      >
        <span className={css.leading}>{leading}</span>
        {status !== null ? <span className={css.visuallyHidden}>{status}</span> : null}
        <span className={css.title}>{t('row.title')}</span>
        <span className={css.separator} aria-hidden />
        <span className={`${css.summary}${
          model.state === 'error' ? ` ${css.errorSummary}`
            : model.state === 'stopped' ? ` ${css.stoppedSummary}` : ''
        }`}>
          {summary}
        </span>
      </div>
      {open ? (
        <div className={css.bodyWrap}>
          <section className={css.instructionsCard} aria-label={t('row.instructions')}>
            <div className={css.instructionsHeader}>{t('row.instructions')}</div>
            <pre className={css.instructions} data-error={model.state === 'error' || undefined}>{model.output}</pre>
          </section>
          {inspect !== undefined ? (
            <button type="button" className={css.inspectButton} onClick={inspect}>
              <IconInspectOutlineRegular />
              {t('row.inspect')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
