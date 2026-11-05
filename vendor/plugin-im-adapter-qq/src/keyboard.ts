/**
 * QQ custom keyboards: `<button>` → {@link QqKeyboardButton} and the 5 × 5 grid layout of the hoisted
 * buttons. Only the markdown mode with `keyboard: true` registers buttons (`QQBot.keyboardEnabled`); everywhere else
 * the core fallback renders them as text.
 *
 * Mapping (QQ keyboard docs; style values per `api.ts`):
 * - `type=link` → `action.type 0`, `data = href`; `type=action` → `action.type 1`, `data = id[:data]` (the encoding the
 * decoder reads back), button `id = attrs.id`; `type=input` → `action.type 2`, `data = text`,
 * `enter = send`.
 * - `permission.type 2` (everyone); `unsupport_tips` (required by the platform) carries the full label.
 * - theme: default → 0 (grey), info → 1 (blue), success → 4 (blue fill), warning/danger → 3 (red text).
 * - Labels longer than 10 characters are truncated (`moved`, reason `qq-label-truncated`); disabled buttons and
 * buttons beyond 5 rows × 5 become their text fallback and are reported `dropped`.
 *
 * @module @deepseek-ai/cordis-plugin-im-adapter-qq/keyboard
 */

import type { Element, Theme } from '@deepseek-ai/satori-element'
import { INTERACTION_DROPPED, type RenderContext, type RenderReport } from '@deepseek-ai/cordis-plugin-im-core'
import type { QqKeyboard, QqKeyboardButton, QqKeyboardRow } from './api.ts'
import type { ButtonNode, QqNode, QqTypes } from './modes/shared.ts'

export const KEYBOARD_ROWS = 5
export const KEYBOARD_COLUMNS = 5
export const LABEL_LIMIT = 10

const STYLE: Record<Theme, number> = { default: 0, info: 1, success: 4, warning: 3, danger: 3 }

/** Shorten a label to the platform limit (code points, not UTF-16 units). */
export function truncateLabel(label: string, limit = LABEL_LIMIT): string {
  const chars = [...label]
  return chars.length <= limit ? label : `${chars.slice(0, limit - 1).join('')}…`
}

/**
 * Build the keyboard button of one `<button>`.
 *
 * @param el - the button.
 * @param label - its visible text.
 */
export function keyboardButton(el: Element<'button'>, label: string): QqKeyboardButton {
  const attrs = el.attrs
  const shown = truncateLabel(label)
  const button: QqKeyboardButton = {
    render_data: { label: shown, visited_label: shown, style: STYLE[attrs.theme ?? 'default'] ?? 0 },
    action: { type: 0, permission: { type: 2 }, data: '', unsupport_tips: `${label}（当前 QQ 版本不支持此按钮）` },
  }
  const action = button.action!
  switch (attrs.type) {
    case 'link':
      action.type = 0
      action.data = attrs.href
      break
    case 'input':
      action.type = 2
      action.data = attrs.text
      action.enter = attrs.send ?? false
      break
    case 'action':
      button.id = attrs.id
      action.type = 1
      action.data = attrs.data === undefined ? attrs.id : `${attrs.id}:${attrs.data}`
      break
  }
  return button
}

/**
 * Handler of `<button>` in the markdown mode with a keyboard: a {@link ButtonNode} hoisted by `assemble`, or — for a
 * disabled button, which QQ cannot show — its text.
 *
 * @param el - the button.
 * @param ctx - render context.
 * @param linkText - how the mode writes a link as text (linkPolicy).
 */
export function buttonNode(
  el: Element<'button'>,
  ctx: RenderContext<QqTypes>,
  linkText: (label: string, href: string) => string,
  escape: (text: string) => string,
): QqNode[] {
  const attrs = el.attrs
  const raw = ctx.text(el.children).trim()
  const label = raw || (attrs.type === 'link' ? attrs.href : attrs.type === 'input' ? attrs.text : attrs.id)
  const path = ctx.stableId(el)
  const fallback = attrs.type === 'link'
    ? linkText(label, attrs.href)
    : attrs.type === 'input'
      ? (label === attrs.text ? `\`${attrs.text}\`` : `${escape(label)} \`${attrs.text}\``)
      : `[${escape(label)}]`
  if (attrs.disabled) {
    ctx.report.dropped.push({ what: `button:${attrs.type === 'action' ? attrs.id : label}`, reason: 'qq-button-disabled' })
    return [fallback]
  }
  if ([...label].length > LABEL_LIMIT) ctx.report.moved.push({ tag: 'button', reason: 'qq-label-truncated', path })
  ctx.report.moved.push({ tag: 'button', reason: 'qq-keyboard', path })
  return [{ kind: 'button', button: keyboardButton(el, label), row: '', fallback, path }]
}

/** Handler of `<button-group>`: its buttons share a keyboard row (wrapped at 5). */
export function buttonGroupNodes(el: Element<'button-group'>, ctx: RenderContext<QqTypes>): QqNode[] {
  const row = ctx.stableId(el)
  return ctx.render(el.children).map(node =>
    typeof node === 'object' && node.kind === 'button' ? { ...node, row } : node)
}

/**
 * Lay the hoisted buttons out in rows: a new row per group (loose buttons share one), wrapping at 5 columns; what
 * does not fit into 5 rows is reported `dropped` and returned as text.
 *
 * Each row is a `{"buttons": […]}` object because that is the wire shape the platform accepts (`content.rows[].buttons`).
 */
export function layoutKeyboard(buttons: readonly ButtonNode[], report: RenderReport): { keyboard?: QqKeyboard; overflow: string[] } {
  const rows: QqKeyboardRow[] = []
  const overflow: string[] = []
  let key: string | undefined
  for (const node of buttons) {
    let row = rows[rows.length - 1]
    if (!row || key !== node.row || row.buttons.length >= KEYBOARD_COLUMNS) {
      if (rows.length >= KEYBOARD_ROWS) {
        overflow.push(node.fallback)
        const what = node.button.id ?? node.button.render_data?.label ?? 'button'
        report.dropped.push({ what: `button:${what}`, reason: node.button.action?.type === 1 ? INTERACTION_DROPPED : 'qq-keyboard-full' })
        continue
      }
      row = { buttons: [] }
      rows.push(row)
    }
    key = node.row
    row.buttons.push(node.button)
  }
  return rows.length ? { keyboard: { content: { rows } }, overflow } : { overflow }
}
