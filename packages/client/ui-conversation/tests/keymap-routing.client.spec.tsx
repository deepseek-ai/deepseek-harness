// @vitest-environment jsdom
/**
 * Keymap routing at the DOM boundary: synthetic keydowns on the
 * contenteditable reach the registered composer commands (the jsdom lane's
 * gesture entry, below the full component bench).
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type { LexicalEditor } from 'lexical'
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, createEditor } from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { registerComposerKeymap } from '../src/client/input/editor/keymap.ts'
import { $createQuoteNode, QuoteNode } from '../src/client/input/editor/QuoteNode.tsx'

describe('keymap keydown routing', () => {
  it('clears composition presentation on root swaps and unregisters pending callbacks', async () => {
    const editor = createEditor({ namespace: 'composition-root', onError: (e) => { throw e } })
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(first, second)
    onTestFinished(() => {
      editor.setRootElement(null)
      first.remove()
      second.remove()
    })
    editor.setRootElement(first)
    const unregister = registerComposerKeymap(editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {},
      canSubmit: () => false, submit: () => {}, intakeFiles: () => {}, pasteText: () => {},
    })
    onTestFinished(unregister)
    fireEvent.compositionStart(first)
    expect(first.hasAttribute('data-composer-composing')).toBe(true)
    editor.setRootElement(second)
    expect(first.hasAttribute('data-composer-composing')).toBe(false)
    expect(second.hasAttribute('data-composer-composing')).toBe(false)
    fireEvent.compositionStart(first)
    expect(first.hasAttribute('data-composer-composing')).toBe(false)
    fireEvent.compositionStart(second)
    expect(second.hasAttribute('data-composer-composing')).toBe(true)
    fireEvent.compositionEnd(second, { data: '' })
    unregister()
    await Promise.resolve()
    expect(second.hasAttribute('data-composer-composing')).toBe(false)
    fireEvent.compositionStart(second)
    expect(second.hasAttribute('data-composer-composing')).toBe(false)
  })

  it('routes Enter to the keymap submit handler', () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    const submit = vi.fn()
    registerComposerKeymap(editor, {
      arbitrate: () => 'pass',
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit,
      intakeFiles: () => {},
      pasteText: () => {},
    })
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith(false)
    fireEvent.keyDown(root, { key: 'Enter', metaKey: true })
    expect(submit).toHaveBeenCalledWith(true)
  })

  it.each([
    { altKey: true },
    { altKey: true, metaKey: true },
    { altKey: true, ctrlKey: true },
    { ctrlKey: true, metaKey: true },
    { shiftKey: true, metaKey: true },
    { shiftKey: true, ctrlKey: true },
    { shiftKey: true, altKey: true },
  ])('leaves modified Enter %j available to application commands', async (modifiers) => {
    const editor = createEditor({ namespace: 'modified-enter', onError: (error) => { throw error } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    onTestFinished(() => { editor.setRootElement(null); root.remove() })
    editor.setRootElement(root)
    onTestFinished(registerPlainText(editor))
    const submit = vi.fn()
    const arbitrate = vi.fn(() => 'pass' as const)
    onTestFinished(registerComposerKeymap(editor, {
      arbitrate, space: () => false, dismissPopup: () => {}, canSubmit: () => true,
      submit, intakeFiles: () => {}, pasteText: () => {},
    }))
    editor.update(() => {
      const paragraph = $createParagraphNode().append($createTextNode('unsent draft'))
      $getRoot().append(paragraph)
      paragraph.selectEnd()
    }, { discrete: true })
    const applicationKeydown = vi.fn()
    document.addEventListener('keydown', applicationKeydown)
    onTestFinished(() => { document.removeEventListener('keydown', applicationKeydown) })

    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifiers })
    root.dispatchEvent(event)
    await Promise.resolve()

    expect(submit).not.toHaveBeenCalled()
    expect(arbitrate).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(applicationKeydown).toHaveBeenCalledOnce()
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('unsent draft')
  })

  it('routes Tab through arbitration and passes when unconsumed', () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    const arbitrate = vi.fn<(key: string, composing: boolean) => 'consumed' | 'pick-highlighted' | 'pass'>()
      .mockReturnValueOnce('consumed')
      .mockReturnValueOnce('pick-highlighted')
      .mockReturnValue('pass')
    registerComposerKeymap(editor, {
      arbitrate,
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit: () => {},
      intakeFiles: () => {},
      pasteText: () => {},
    })
    const consumed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(arbitrate).toHaveBeenCalledWith('tab', false)
    expect(consumed).toBe(false) // consumed: preventDefault fired
    const picked = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(picked).toBe(false) // picked: the completion replaces native traversal
    const passed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(passed).toBe(true) // pass: the browser keeps native focus traversal

    // Shift+Tab is the menu's exit key, never its settle key.
    fireEvent.keyDown(root, { key: 'Tab', keyCode: 9, shiftKey: true })
    expect(arbitrate).toHaveBeenLastCalledWith('tabBack', false)
  })

  describe('Home and End', () => {
    function lineBoundaryBench(platform: string) {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'platform')
      Object.defineProperty(navigator, 'platform', { configurable: true, value: platform })
      // jsdom has no Selection.modify; the browser performs the caret movement.
      const modify = vi.fn()
      Object.defineProperty(Selection.prototype, 'modify', { configurable: true, value: modify })
      onTestFinished(() => {
        if (descriptor === undefined) Reflect.deleteProperty(navigator, 'platform')
        else Object.defineProperty(navigator, 'platform', descriptor)
        Reflect.deleteProperty(Selection.prototype, 'modify')
      })
      const editor = createEditor({ namespace: 'line-boundary', nodes: [QuoteNode], onError: (error) => { throw error } })
      const root = document.createElement('div')
      root.contentEditable = 'true'
      document.body.appendChild(root)
      onTestFinished(() => { editor.setRootElement(null); root.remove() })
      editor.setRootElement(root)
      onTestFinished(registerPlainText(editor))
      onTestFinished(registerComposerKeymap(editor, {
        arbitrate: () => 'pass', space: () => false, dismissPopup: () => {}, canSubmit: () => true,
        submit: () => {}, intakeFiles: () => {}, pasteText: () => {},
      }))
      return { editor, root, modify }
    }

    /** A draft line that starts with a quote, with both carets before the quote. */
    function caretBeforeLeadingQuote(editor: LexicalEditor, root: HTMLElement): void {
      editor.update(() => {
        const paragraph = $createParagraphNode()
        paragraph.append($createQuoteNode('quoted source', { remove: 'Remove quote' }), $createTextNode(' follow-up'))
        $getRoot().append(paragraph)
        paragraph.select(0, 0)
      }, { discrete: true })
      document.getSelection()!.collapse(root.firstChild, 0)
    }

    const caret = (editor: LexicalEditor): string | null => editor.read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null
      const node = selection.focus.getNode()
      return `${selection.focus.type === 'element' ? node.getType() : node.getTextContent()}@${String(selection.focus.offset)}`
    })

    it.each([
      { key: 'Home', shiftKey: false, alter: 'move', direction: 'backward' },
      { key: 'End', shiftKey: false, alter: 'move', direction: 'forward' },
      { key: 'Home', shiftKey: true, alter: 'extend', direction: 'backward' },
      { key: 'End', shiftKey: true, alter: 'extend', direction: 'forward' },
    ])('moves to the line boundary on Apple platforms: $key, shift $shiftKey', ({ key, shiftKey, alter, direction }) => {
      const { root, modify } = lineBoundaryBench('MacIntel')
      expect(fireEvent.keyDown(root, { key, shiftKey })).toBe(false) // default prevented: no document scroll
      expect(modify).toHaveBeenCalledExactlyOnceWith(alter, direction, 'lineboundary')
    })

    it.each([
      { platform: 'Win32', init: { key: 'Home' } },
      { platform: 'MacIntel', init: { key: 'End', metaKey: true } },
      { platform: 'MacIntel', init: { key: 'Home', ctrlKey: true } },
      { platform: 'MacIntel', init: { key: 'End', altKey: true } },
      { platform: 'MacIntel', init: { key: 'Home', keyCode: 229 } },
      { platform: 'MacIntel', init: { key: 'ArrowLeft' } },
    ])('leaves $init on $platform to the browser', ({ platform, init }) => {
      const { root, modify } = lineBoundaryBench(platform)
      expect(fireEvent.keyDown(root, init)).toBe(true)
      expect(modify).not.toHaveBeenCalled()
    })

    it('moves End from before a line-leading quote to the end of its hard line', () => {
      const { editor, root, modify } = lineBoundaryBench('MacIntel')
      caretBeforeLeadingQuote(editor, root)
      expect(fireEvent.keyDown(root, { key: 'End' })).toBe(false)
      expect(modify).not.toHaveBeenCalled()
      expect(caret(editor)).toBe('paragraph@2')
    })

    it('extends Shift+End from before a line-leading quote through the browser', () => {
      const { editor, root, modify } = lineBoundaryBench('MacIntel')
      caretBeforeLeadingQuote(editor, root)
      expect(fireEvent.keyDown(root, { key: 'End', shiftKey: true })).toBe(false)
      expect(modify).toHaveBeenCalledExactlyOnceWith('extend', 'forward', 'lineboundary')
      expect(caret(editor)).toBe('paragraph@0')
    })
  })
})
