/** Card-aware output body for the selected Tool call in details. */
import { DiffBlock, ReadBlock, SearchBlock, TerminalBlock, WebBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolDetailsProps } from '../contract/slots.ts'
import { diffCardModel } from './models/diff-card-model.ts'
import { readCardModel } from './models/read-card-model.ts'
import { searchCardModel } from './models/search-card-model.ts'
import {
  localizeTerminalCardModel, terminalBlockLabels, terminalCardModel,
} from './models/terminal-card-model.ts'
import {
  diffBlockLabels, readBlockLabels, searchBlockLabels, webBlockLabels,
} from './models/primitive-labels.ts'
import { resultText } from './models/tool-call-model.ts'
import { webCardModel } from './models/web-card-model.ts'
import css from './ToolDetails.module.css'

/**
 * Render the selected Tool call's structured output when its raw fields form a
 * supported card, otherwise preserve the flattened result text.
 * @param props - selected call slice, workspace root, host home, and locale seat.
 * @returns the details output body.
 */
export function ToolDetails({
  block, cwd, useHostInfo, t,
}: Pick<ToolDetailsProps, 'block' | 'cwd' | 'useHostInfo' | 't'>) {
  const home = useHostInfo(info => info.home)
  const terminalModel = terminalCardModel(block, cwd)
  if (terminalModel !== null) {
    const terminal = localizeTerminalCardModel(terminalModel, t)
    return (
      <>
        {terminal.description !== undefined ? (
          <div className={css.description}>{terminal.description}</div>
        ) : null}
        <TerminalBlock {...terminal.card} labels={terminalBlockLabels(t)} className={css.cardBody} />
      </>
    )
  }
  const read = readCardModel(block, cwd, home)
  if (read !== null) return <ReadBlock {...read} labels={readBlockLabels(t)} className={css.read} />
  const diff = diffCardModel(block)
  if (diff !== null) return <DiffBlock {...diff.card} labels={diffBlockLabels(t)} className={css.cardBody} />
  const search = searchCardModel(block)
  if (search !== null) {
    return (
      <>
        <SearchBlock {...search.card} labels={searchBlockLabels(t)} className={css.cardBody} />
        {search.recovery !== undefined ? <div className={css.recovery}>{search.recovery}</div> : null}
      </>
    )
  }
  const web = webCardModel(block)
  if (web !== null) {
    const body = 'kind' in block ? resultText(block) : ''
    return (
      <>
        <WebBlock {...web} labels={webBlockLabels(t)} className={css.web} />
        {body !== '' ? <pre className={css.code}>{body}</pre> : null}
      </>
    )
  }
  if (!('kind' in block)) return <div className={css.empty}>{t('details.running')}</div>
  return (
    <pre className={css.code} data-error={block.isError || undefined}>
      {resultText(block)}
    </pre>
  )
}
