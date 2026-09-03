// Shared assembly for the read-family toolview rows (`read`, `read_image`).
//
// Both rows are the same single-file card row: the browse icon in the shared
// ToolRow chrome, the args-derived summary as an openable host path, no args body
// (the path link is the only args interaction), and one result-side card as the
// collapsed-by-default body. Only which card material they carry differs, so the
// row assembly lives here once instead of being copied per tool.

import type { ReactNode } from 'react'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow, type ToolRowProps } from '../components/ToolRow.tsx'

/** Full row props of a read-family toolview: the runtime share plus its locale seat. */
export type ReadFamilyRowProps = ToolCallViewProps & { t: ToolRowProps['t'] }

/** read_image row props: the runtime share, the declared image child slot, and the locale seat. */
export type ReadImageRowProps = ReadFamilyRowProps & PropsRenderSlots<'tool.call.images'>

/**
 * The card material one read-family row contributes: exactly the ToolRow card
 * props that row owns. `read` supplies `read`; `read_image` supplies `image`
 * together with the slot dispatcher and loader that draw it.
 */
export type ReadFamilyCard = Pick<ToolRowProps, 'read' | 'image' | 'renderSlot' | 'loadImage'>

/**
 * Compose a read-family row: the shared chrome and model-derived fields, plus the
 * caller's card material.
 * @param props - the toolview runtime share and locale seat.
 * @param card - the card props this row owns.
 * @returns the assembled ToolRow.
 */
export function readFamilyRow(
  { toolName, block, cwd, home, openFile, inspect, t }: ReadFamilyRowProps,
  card: ReadFamilyCard,
): ReactNode {
  const model = toolRowModel(toolName, block, cwd, home)
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconBrowseOutline16 size={14} />}
      title={t(model.titleKey)}
      summary={model.summary}
      bodyRaw={null}
      output={model.output}
      errorSummary={model.errorSummary}
      {...card}
      state={model.state}
      filePath={model.filePath}
      onOpenFile={openFile}
      inspect={inspect}
    />
  )
}
