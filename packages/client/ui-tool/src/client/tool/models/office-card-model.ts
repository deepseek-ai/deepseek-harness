/** Pure Office row derivation from the tool name, frozen call slice, and settled result. @module */
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { abbreviateHomePath, isAbsoluteWorkspacePath, relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import { recordedAbsolutePath } from './recorded-path.ts'
import type { ToolCallBlock } from './tool-call-model.ts'

type OfficeTitleKey = Extract<LocaleKeysOf<'conversation'>, 'tool.title.officeRender' | 'tool.title.officeConvert'
  | 'tool.title.officeRecalculate' | 'tool.title.generic'>

const TITLE_KEYS: Readonly<Record<string, OfficeTitleKey>> = {
  office_render: 'tool.title.officeRender',
  office_convert: 'tool.title.officeConvert',
  office_recalculate: 'tool.title.officeRecalculate',
}

/** The Office row's tool title, path summary, and openable input. */
export interface OfficeRowModel {
  titleKey: OfficeTitleKey
  /** Input, plus the output format of a conversion or recalculation; empty until the input argument completes. */
  summary: string
  /** Recorded absolute input path, or an absolute input argument while running. */
  filePath: string | undefined
}

function completeText(block: ToolCallBlock, key: string): string | undefined {
  const value = block.args.complete(key) ? block.args.text(key) : undefined
  // Decoding text can discover an invalid escape and make complete() false.
  return value !== undefined && value !== '' && block.args.complete(key) ? value : undefined
}

/**
 * Derive an Office row from wire values.
 * @param toolName - wire tool name used for the title and format summary.
 * @param block - preparing, running, or settled Office block.
 * @param cwd - Session workspace root used to shorten paths.
 * @param home - Host account home shown as `~`.
 * @returns the row title, summary, and openable path.
 */
export function officeRowModel(toolName: string, block: ToolCallBlock, cwd?: string, home?: string): OfficeRowModel {
  const titleKey = TITLE_KEYS[toolName] ?? 'tool.title.generic'
  const input = completeText(block, 'input')
  const format = toolName === 'office_render' ? undefined : completeText(block, 'format')
  const short = (path: string): string => abbreviateHomePath(relativizeToCwd(path, cwd), home)
  const summary = input === undefined ? '' : format === undefined ? short(input) : `${short(input)} → ${format}`
  const recorded = 'kind' in block ? recordedAbsolutePath(block.meta, 'path') : undefined
  const filePath = recorded ?? (input !== undefined && isAbsoluteWorkspacePath(input) ? input : undefined)
  return { titleKey, summary, filePath }
}
