/**
 * Two-step command chip deletion. A character deletion whose direction
 * reaches the command chip from a collapsed caret first selects the chip; the
 * next deletion in that direction removes it. Deletions arrive as the
 * character-deletion command (Backspace, Delete, and the platform shortcuts
 * the engine maps to them) or as a deletion input event, which some platforms
 * apply without that command. A key that produces no character deletion, a
 * click, blur, or a caret that no longer touches the chip clears the
 * selection. The selected state is presentation on the chip's host and the
 * root element; the editor selection stays a collapsed range beside the chip,
 * so typing and arrows keep their plain-text behavior.
 */
import type { LexicalEditor, NodeKey } from 'lexical'
import {
  $getAdjacentNode, $getSelection, $isRangeSelection, BEFORE_INPUT_COMMAND, BLUR_COMMAND, CLICK_COMMAND,
  COMMAND_PRIORITY_CRITICAL, COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, KEY_DOWN_COMMAND,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'
import { $isCommandChipNode } from './command-chip-node.tsx'
import type { CommandChipNode } from './command-chip-node.tsx'

/**
 * Keys that never clear a selected chip by themselves: bare modifiers, and
 * IME or virtual-keyboard keys whose deletion arrives later as an input event.
 */
const PASSIVE_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'Unidentified', 'Process'])

/** The chip a collapsed caret deletes next in one direction, or null. */
function $commandChipBesideCaret(isBackward: boolean): CommandChipNode | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
  const node = $getAdjacentNode(selection.focus, isBackward)
  return $isCommandChipNode(node) ? node : null
}

/** Deletion direction of an input event type; null for other input. */
function deletionDirection(inputType: string): boolean | null {
  if (inputType === 'deleteContentBackward') return true
  if (inputType === 'deleteContentForward') return false
  return null
}

/**
 * Register two-step deletion for the command chip.
 * @param editor - the shell-owned editor.
 * @returns the unregister disposer, which also clears a selected chip.
 */
export function registerCommandChipSelection(editor: LexicalEditor): () => void {
  let selected: { readonly key: NodeKey; readonly isBackward: boolean } | null = null
  /** A keydown with a selected chip whose dispatch has produced no character deletion yet. */
  let keyWithoutDeletion = false
  const paint = (next: typeof selected): void => {
    if (selected !== null && selected.key !== next?.key) {
      editor.getElementByKey(selected.key)?.removeAttribute('data-selected')
    }
    selected = next
    if (next !== null) editor.getElementByKey(next.key)?.setAttribute('data-selected', '')
    editor.getRootElement()?.toggleAttribute('data-composer-chip-selected', next !== null)
  }
  const clear = (): false => {
    if (selected !== null) paint(null)
    return false
  }
  /**
   * Decide one character deletion.
   * @param isBackward - deletion direction.
   * @param clearOnPass - whether letting the deletion run clears the selection here;
   * an input event leaves it for the deletion that follows.
   * @returns true when the deletion only selected the chip and must be consumed.
   */
  const $decide = (isBackward: boolean, clearOnPass: boolean): boolean => {
    keyWithoutDeletion = false
    const chip = $commandChipBesideCaret(isBackward)
    if (chip === null) return clear()
    if (selected?.key === chip.getKey() && selected.isBackward === isBackward) return clearOnPass ? clear() : false
    paint({ key: chip.getKey(), isBackward })
    return true
  }
  return mergeRegister(
    editor.registerCommand(BEFORE_INPUT_COMMAND, (event) => {
      const isBackward = deletionDirection(event.inputType)
      if (isBackward === null || !$decide(isBackward, false)) return false
      event.preventDefault()
      return true
    }, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(DELETE_CHARACTER_COMMAND, isBackward => $decide(isBackward, true), COMMAND_PRIORITY_HIGH),
    editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
      if (selected === null || PASSIVE_KEYS.has(event.key)) return false
      // Key bindings dispatch their deletion synchronously inside this
      // keydown, so the microtask sees whether the key deleted anything.
      keyWithoutDeletion = true
      queueMicrotask(() => {
        if (!keyWithoutDeletion) return
        keyWithoutDeletion = false
        clear()
      })
      return false
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(CLICK_COMMAND, clear, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(BLUR_COMMAND, clear, COMMAND_PRIORITY_CRITICAL),
    editor.registerUpdateListener(({ editorState }) => {
      const current = selected
      if (current === null) return
      const touching = editorState.read(() => $commandChipBesideCaret(current.isBackward)?.getKey() === current.key)
      // A restore can remount the chip's host element; repaint keeps the mark on it.
      paint(touching ? current : null)
    }),
    () => { paint(null) },
  )
}
