/** Present call status and expandable durable result text. */
import { useState } from 'react'
import { DisclosureRow, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './PresentRow.module.css'

type PresentRowProps = ToolCallViewProps & PropsLocale<typeof NS>

/** Raw arguments can be partial while a call is streaming. */
function fileNames(raw: string): string {
  let args: unknown
  try { args = JSON.parse(raw) }
  catch { return raw } // Truncated tool JSON remains visible until the call completes.
  if (typeof args !== 'object' || args === null || !('files' in args) || !Array.isArray(args.files)) return raw
  return args.files.flatMap((file: unknown) =>
    typeof file === 'object' && file !== null && 'path' in file && typeof file.path === 'string'
      ? [file.path] : [],
  ).join(', ')
}

/**
 * Render a present call using its recorded arguments and result.
 * @param props - tool call and localized status copy.
 * @returns a status row with a result disclosure.
 */
export function PresentRow({ block, inspect, t }: PresentRowProps) {
  const settled = 'kind' in block
  const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
  const args = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const output = settled ? block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item)).join('\n') : ''
  const details = output || (settled && block.error ? `${block.error.name}: ${block.error.code}` : '')
  const [expanded, setExpanded] = useState(false)
  return <div data-tool="present" data-state={state}>
    <DisclosureRow title={t('row.title')}
      icon={<StateDot state={state === 'running' ? 'ongoing' : state === 'ok' ? 'done' : state === 'stopped' ? 'warning' : 'error'} />}
      open={expanded && details !== ''} expandable={details !== ''} expandOnRowClick keepContentWhenOpen
      onToggle={() => { setExpanded(value => !value) }}
      collapsedContent={<span className={css.summary}><span>{t(`row.${state}`)}</span><span className={css.paths}>{fileNames(args)}</span></span>}>
      <pre className={css.output}>{details}</pre>
      {inspect && <button type="button" className={css.inspect} onClick={inspect}>{t('row.inspect')}</button>}
    </DisclosureRow>
  </div>
}
