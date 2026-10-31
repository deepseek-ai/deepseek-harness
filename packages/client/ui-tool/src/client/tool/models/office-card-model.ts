/** Pure `office` row derivation from the frozen call slice and settled result. @module */
import type { LocaleKeysOf } from '@deepseek-ai/dsh-client-ui-slots'
import { abbreviateHomePath, isAbsoluteWorkspacePath, relativizeToCwd } from '@deepseek-ai/dsh-util-workspace-path'
import { fullyRendered, imageReferences, type ImageCardModel } from './image-card-model.ts'
import { recordedAbsolutePath } from './recorded-path.ts'
import type { ToolCallBlock } from './tool-call-model.ts'

type OfficeTitleKey = Extract<LocaleKeysOf<'conversation'>, 'tool.title.renderDocument' | 'tool.title.convertDocument'
  | 'tool.title.recalculateWorkbook' | 'tool.title.generic'>

const TITLE_KEYS: Readonly<Record<string, OfficeTitleKey>> = {
  render: 'tool.title.renderDocument',
  convert: 'tool.title.convertDocument',
  recalculate: 'tool.title.recalculateWorkbook',
}

/** The `office` row's operation title, path summary, openable input, and rendered images. */
export interface OfficeRowModel {
  titleKey: OfficeTitleKey
  /** Input, plus the output format of a conversion or recalculation; empty until the input argument completes. */
  summary: string
  /** Recorded absolute input path, or an absolute input argument while running. */
  filePath: string | undefined
  /** Rendered images of a successful render; null for every other state. */
  image: ImageCardModel | null
}

function completeText(block: ToolCallBlock, key: string): string | undefined {
  const value = block.args.complete(key) ? block.args.text(key) : undefined
  // Decoding text can discover an invalid escape and make complete() false.
  return value !== undefined && value !== '' && block.args.complete(key) ? value : undefined
}

/**
 * Derive the `office` row from wire values, declining malformed images to the text output.
 * @param block - preparing, running, or settled `office` block.
 * @param cwd - Session workspace root used to shorten paths.
 * @param home - Host account home shown as `~`.
 * @returns the row title, summary, openable path, and optional image card.
 */
export function officeRowModel(block: ToolCallBlock, cwd?: string, home?: string): OfficeRowModel {
  const operation = completeText(block, 'operation')
  const titleKey = (operation === undefined ? undefined : TITLE_KEYS[operation]) ?? 'tool.title.generic'
  const input = completeText(block, 'input')
  const format = operation === 'render' ? undefined : completeText(block, 'format')
  const short = (path: string): string => abbreviateHomePath(relativizeToCwd(path, cwd), home)
  const summary = input === undefined ? '' : format === undefined ? short(input) : `${short(input)} → ${format}`
  const settled = 'kind' in block
  const recorded = settled ? recordedAbsolutePath(block.meta, 'path') : undefined
  const filePath = recorded ?? (input !== undefined && isAbsoluteWorkspacePath(input) ? input : undefined)
  let image: ImageCardModel | null = null
  if (settled && !block.isError && operation === 'render' && recorded !== undefined && fullyRendered(block.content)) {
    const refs = imageReferences(block.content)
    const texts = block.content.flatMap(part => part.type === 'text' ? [part.text] : [])
    if (refs !== null) image = { path: recorded, images: refs.map(attachment => ({ attachment })), extraText: texts.length === 0 ? null : texts.join('\n') }
  }
  return { titleKey, summary, filePath, image }
}
