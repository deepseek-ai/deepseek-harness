// Office toolview links target the input, not the temporary output. Rows show the
// result's text blocks; rendered page images reach the model but are not displayed.

import { extractTextContent } from '@deepseek-ai/dsh-llm/message'
import { IconBrowseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import { toolFileInject } from '../file-menu.ts'
import { officeRowModel } from '../models/office-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import type { ReadFamilyRowProps } from './read-family-row.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/** Office file row props: the runtime share, file actions, and locale seat. */
export type OfficeRowProps = ReadFamilyRowProps

/**
 * Show an Office call with input-path navigation and its result text.
 * @param props - tool call, file actions, and locale seat.
 * @returns the Office result row.
 */
export function OfficeRow({
  toolName, block, cwd, home, openFile, resolveFilePath, sessionId, inspect, useDisclosure, useContextMenu, t,
}: OfficeRowProps) {
  const { getTriggerProps } = useContextMenu()
  const office = officeRowModel(toolName, block, cwd, home)
  const row = toolRowModel(toolName, block, cwd, home)
  // Image blocks flatten to JSON attachment references, so a settled result with only images shows no body.
  const output = 'kind' in block
    ? extractTextContent(block.content, { separator: '\n' }) || null
    : row.output
  const path = office.filePath
  return (
    <ToolRow
      fileContextMenuProps={getTriggerProps(path === undefined ? undefined : () => ({
        kind: 'file', value: { sessionId, path: resolveFilePath(path) },
      }))}
      useDisclosure={useDisclosure}
      t={t}
      variant="read"
      toolName={toolName}
      icon={<IconBrowseOutlineRegular size={14} />}
      title={t(office.titleKey)}
      summary={office.summary}
      bodyRaw={null}
      output={output}
      errorSummary={row.errorSummary}
      state={row.state}
      filePath={path}
      onOpenFile={openFile}
      inspect={inspect}
    />
  )
}

/** Office tool names; the `office_*` names are the earlier names, kept so calls in older Sessions keep the Office row. */
const OFFICE_TOOL_NAMES = [
  'document_render', 'document_convert', 'document_recalculate', 'office_render', 'office_convert', 'office_recalculate',
] as const

/** Registers the Office toolviews under the current and earlier tool names. */
export const officeToolview = {
  name: 'office-toolview',
  inject: ['slots', 'sessions'],
  /**
   * Register Office rows into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      for (const key of OFFICE_TOOL_NAMES) {
        yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS, inject: toolFileInject(ctx) }, OfficeRow)
      }
    })
  },
}
