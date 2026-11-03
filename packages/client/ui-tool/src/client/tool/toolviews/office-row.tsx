// Office toolview links target the input, not the temporary output. Only office_render
// owns an image slot; conversion and recalculation retain flattened result text.

import { useCallback } from 'react'
import { IconBrowseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { ContextMenuBindings } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { toolFileInject } from '../file-menu.ts'
import type { ToolImagesOwnerProps } from '../../contract/slots.ts'
import { officeRowModel, type OfficeRowModel } from '../models/office-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow, type ToolRowProps } from '../components/ToolRow.tsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadFamilyRowProps } from './read-family-row.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/** Office file row props: the runtime share, file actions, and locale seat. */
export type OfficeRowProps = ReadFamilyRowProps

/** Office render row props include its declared image child slot. */
export type OfficeRenderRowProps = OfficeRowProps & PropsRenderSlots<'tool.call.office_render.images'>

/**
 * Show conversion or recalculation output with input-path navigation.
 * @param props - tool call, file actions, and locale seat.
 * @returns the file result row.
 */
export function OfficeRow(props: OfficeRowProps) {
  const { getTriggerProps } = props.useContextMenu()
  return officeRow(props, officeRowModel(props.toolName, props.block, props.cwd, props.home), getTriggerProps)
}

/**
 * Show successful renders through the render tool's gallery slot.
 * @param props - tool call, file actions, locale seat, and image child renderer.
 * @returns the render result row.
 */
export function OfficeRenderRow(props: OfficeRenderRowProps) {
  const { getTriggerProps } = props.useContextMenu()
  const { renderSlot } = props
  const renderImages = useCallback((owner: ToolImagesOwnerProps) => renderSlot('tool.call.office_render.images', owner), [renderSlot])
  return officeRow(props, officeRowModel(props.toolName, props.block, props.cwd, props.home), getTriggerProps, renderImages)
}

function officeRow(
  { toolName, block, cwd, home, openFile, resolveFilePath, sessionId, inspect, useDisclosure, loadImage, t }: OfficeRowProps,
  office: OfficeRowModel,
  getTriggerProps: ContextMenuBindings['getTriggerProps'],
  renderImages?: ToolRowProps['renderImages'],
) {
  const row = toolRowModel(toolName, block, cwd, home)
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
      output={row.output}
      errorSummary={row.errorSummary}
      image={office.image}
      renderImages={renderImages}
      loadImage={loadImage}
      state={row.state}
      filePath={path}
      onOpenFile={openFile}
      inspect={inspect}
    />
  )
}

/** Registers the three Office toolviews; only rendering owns an image gallery child slot. */
export const officeToolview = {
  name: 'office-toolview',
  inject: ['slots', 'sessions'],
  /**
   * Register Office rows into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'office_render',
        locale: NS,
        inject: toolFileInject(ctx),
        children: { 'tool.call.office_render.images': { kind: 'single', scope: 'session' } },
      }, OfficeRenderRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'office_convert', locale: NS, inject: toolFileInject(ctx) }, OfficeRow)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'office_recalculate', locale: NS, inject: toolFileInject(ctx) }, OfficeRow)
    })
  },
}
