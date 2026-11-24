/**
 * The QQ modes, built from the bot config: `text` always, `markdown` with buttons when
 * `QQBot.keyboardEnabled`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/modes
 */

import type { QQConfig } from '../config.ts'
import { createMarkdownMode } from './markdown.ts'
import type { QqModeSettings } from './shared.ts'
import { createTextMode } from './text.ts'

export * from './shared.ts'
export { createTextMode, linkFallback } from './text.ts'
export { createMarkdownMode } from './markdown.ts'

/**
 * Build both modes.
 *
 * @param config - the bot config.
 * @param keyboard - whether buttons go to the keyboard (`QQBot.keyboardEnabled`).
 */
export function createQQModes(config: Pick<QQConfig, 'linkPolicy' | 'passive'>, keyboard: boolean) {
  const parts = Math.max(config.passive.groupReplies, config.passive.c2cReplies)
  const base: Omit<QqModeSettings, 'markdown' | 'keyboard'> = { linkPolicy: config.linkPolicy, parts }
  return {
    text: createTextMode({ ...base, markdown: false, keyboard: false }),
    markdown: createMarkdownMode({ ...base, markdown: true, keyboard }),
  }
}
