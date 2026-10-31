// office toolview registrant. Claiming the `office` key replaces the generic row
// for every office call, so the row covers preparing, running, failed, written-file,
// and rendered results. A successful render shows its images through the Tool-owned
// `tool.call.office.images` slot; every other state keeps the flattened text output.

import { useCallback } from 'react'
import { IconBrowseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import { toolFileInject } from '../file-menu.ts'
import type { ToolImagesOwnerProps } from '../../contract/slots.ts'
import { officeRowModel } from '../models/office-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReadFamilyRowProps } from './read-family-row.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/** office row props: the runtime share, the declared image child slot, and the locale seat. */
export type OfficeRowProps = ReadFamilyRowProps & PropsRenderSlots<'tool.call.office.images'>

/** office row: operation title, input path summary, and the rendered images as its card body. */
export function OfficeRow(props: OfficeRowProps) {
  const { toolName, block, cwd, home, openFile, resolveFilePath, sessionId, inspect, useDisclosure, renderSlot, loadImage, t } = props
  const { getTriggerProps } = props.useContextMenu()
  const row = toolRowModel(toolName, block, cwd, home)
  const office = officeRowModel(block, cwd, home)
  const path = office.filePath
  const renderImages = useCallback((owner: ToolImagesOwnerProps) => renderSlot('tool.call.office.images', owner), [renderSlot])
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

/** Registers the office tool's conversation row with its image gallery child slot. */
export const officeToolview = {
  name: 'office-toolview',
  inject: ['slots', 'sessions'],
  /**
   * Register the office row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({
        name: 'tool.call.toolview',
        key: 'office',
        locale: NS,
        inject: toolFileInject(ctx),
        children: { 'tool.call.office.images': { kind: 'single', scope: 'session' } },
      }, OfficeRow))
  },
}
