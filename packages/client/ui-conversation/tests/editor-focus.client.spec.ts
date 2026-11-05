// @vitest-environment jsdom
/** Composer selection survives focus transfers and background editor reconciliation. */
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import { expect, it, onTestFinished, vi } from 'vitest'
import { $getRoot, $getSelection, $isRangeSelection, SELECTION_CHANGE_COMMAND, UNDO_COMMAND } from 'lexical'
import { DraftEditorRuntime } from '../src/client/input/editor/runtime.ts'
import { focusDraftEditor, installDraftKeyboardDismissal } from '../src/client/input/editor/view-binding.ts'

function fixture(start = 1, end = 4) {
  // jsdom has no Range geometry; these cases observe selection and focus, not scrolling.
  const geometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  onTestFinished(() => {
    if (geometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    else Object.defineProperty(Range.prototype, 'getBoundingClientRect', geometry)
  })
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  root.tabIndex = 0
  const card = document.createElement('div')
  card.tabIndex = -1
  card.append(root)
  const outside = document.createElement('button')
  document.body.append(card, outside)
  onTestFinished(() => { card.remove(); outside.remove() })
  // jsdom collapses document Selection on every focus(); Chromium retains the
  // editor range here. Keep native focus events and activeElement changes.
  for (const element of [root, outside]) {
    const focus = element.focus.bind(element)
    const mocked = vi.spyOn(element, 'focus').mockImplementation((options) => {
      const selection = document.getSelection()!
      const range = selection.rangeCount === 0 ? undefined : selection.getRangeAt(0).cloneRange()
      focus(options)
      if (range !== undefined) {
        selection.removeAllRanges()
        selection.addRange(range)
      }
    })
    onTestFinished(() => { mocked.mockRestore() })
  }
  const onUpdate = vi.fn()
  const runtime: DraftEditorRuntime = new DraftEditorRuntime({
    onUpdate: () => { runtime.refreshProjection(); onUpdate() },
    quoteLabels: () => ({ remove: 'Remove quote' }),
    openReference: () => false,
    lexicon: () => new Map(), resolveLexicon: () => undefined,
  })
  const dispose = runtime.register()
  const { editor } = runtime
  onTestFinished(() => { dispose(); editor.setRootElement(null) })
  editor.setRootElement(root)
  runtime.setDraft('alpha beta')
  root.focus()
  editor.update(() => { $getRoot().getAllTextNodes()[0]!.select(start, end) }, { discrete: true })
  const selection = () => editor.getEditorState().read(() => {
    const selected = $getSelection()
    if (!$isRangeSelection(selected)) throw new Error('Expected a Composer range selection')
    return { anchorKey: selected.anchor.key, anchor: selected.anchor.offset,
      focusKey: selected.focus.key, focus: selected.focus.offset, text: selected.getTextContent() }
  })
  const domSelection = () => {
    const selected = document.getSelection()!
    return { anchorNode: selected.anchorNode, anchor: selected.anchorOffset,
      focusNode: selected.focusNode, focus: selected.focusOffset, text: selected.toString() }
  }
  const focusComposer = () => {
    const reveal = vi.fn()
    outside.addEventListener('click', () => { focusDraftEditor(editor, reveal) }, { once: true })
    outside.click()
    editor.read(() => {})
    return reveal
  }
  return { runtime, editor, root, card, outside, onUpdate, dispose, selection, domSelection, focusComposer }
}

it.each([
  ['range', 1, 4], ['caret', 3, 3],
] as const)('retains the %s while another control owns focus', (_kind, start, end) => {
  const f = fixture(start, end)
  const internal = f.selection()
  const dom = f.domSelection()
  expect(internal).toMatchObject({ anchor: start, focus: end })
  expect(dom).toMatchObject({ anchor: start, focus: end })

  f.outside.focus()
  f.editor.read(() => {})
  expect(document.activeElement).toBe(f.outside)
  expect(f.selection()).toEqual(internal)
  expect(f.domSelection()).toEqual(dom)

  f.editor.update(() => { $getRoot().getFirstDescendant()!.markDirty() }, { discrete: true })
  expect(document.activeElement).toBe(f.outside)
  expect(f.selection()).toEqual(internal)
  expect(f.domSelection()).toEqual(dom)

  f.editor.update(() => {
    const selected = $getSelection()
    if (!$isRangeSelection(selected)) throw new Error('Expected a Composer range selection')
    selected.dirty = true
    f.editor.dispatchCommand(SELECTION_CHANGE_COMMAND, undefined)
  }, { discrete: true })
  expect(document.activeElement).toBe(f.outside)
  expect(f.selection()).toEqual(internal)
  expect(f.domSelection()).toEqual(dom)
})

it('keeps background insertion and undo outside the editor until focus is explicitly restored', () => {
  const f = fixture()
  const selected = f.selection()
  f.outside.focus()
  f.editor.read(() => {})

  f.runtime.paste('X')
  expect(f.root.textContent).toBe('aXa beta')
  expect(f.selection()).toMatchObject({ anchor: 2, focus: 2 })
  expect(document.activeElement).toBe(f.outside)
  f.editor.dispatchCommand(UNDO_COMMAND, undefined)
  f.editor.read(() => {})
  expect(f.root.textContent).toBe('alpha beta')
  expect(f.selection()).toEqual(selected)
  expect(document.activeElement).toBe(f.outside)

  const reveal = f.focusComposer()
  expect(document.activeElement).toBe(f.root)
  expect(f.domSelection()).toMatchObject({ anchor: 1, focus: 4, text: 'lph' })
  expect(f.selection()).toEqual(selected)
  expect(reveal).toHaveBeenCalledOnce()
})

it('restores a pending selection when blur and explicit focus share one update batch', () => {
  const f = fixture()
  f.editor.update(() => {
    const text = $getRoot().getAllTextNodes()[0]!
    text.markDirty()
    text.select(6, 6)
  })
  f.outside.focus()
  const reveal = f.focusComposer()
  expect(document.activeElement).toBe(f.root)
  expect(f.selection()).toMatchObject({ anchor: 6, focus: 6 })
  expect(f.domSelection()).toMatchObject({ anchor: 6, focus: 6, text: '' })
  expect(reveal).toHaveBeenCalledOnce()
})

it('hands mobile submission focus to the composer without stealing focus from another control', async () => {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1')
  onTestFinished(() => { userAgent.mockRestore() })
  vi.resetModules()
  const detection = await import('@deepseek-ai/dsh-client-ui-primitives/src/focus.ts')
  const device = vi.spyOn(uiPrimitives, 'isMobileDevice').mockImplementation(detection.isMobileDevice)
  onTestFinished(() => { device.mockRestore() })
  const f = fixture()
  const dispose = installDraftKeyboardDismissal(f.editor, { current: f.card })
  onTestFinished(dispose)

  f.runtime.clearCommittedDraft(() => null)
  expect(f.root.textContent).toBe('')
  expect(document.activeElement).toBe(f.card)

  f.runtime.setDraft('next draft')
  f.outside.focus()
  f.runtime.clearCommittedDraft(() => null)
  expect(document.activeElement).toBe(f.outside)
})

it('retains mobile focus for a newer draft suffix and removes dismissal with the view', async () => {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1')
  onTestFinished(() => { userAgent.mockRestore() })
  vi.resetModules()
  const detection = await import('@deepseek-ai/dsh-client-ui-primitives/src/focus.ts')
  const device = vi.spyOn(uiPrimitives, 'isMobileDevice').mockImplementation(detection.isMobileDevice)
  onTestFinished(() => { device.mockRestore() })
  const f = fixture()
  const dispose = installDraftKeyboardDismissal(f.editor, { current: f.card })
  onTestFinished(dispose)

  f.runtime.clearCommittedDraft(() => 6)
  expect(f.root.textContent).toBe('beta')
  expect(document.activeElement).toBe(f.root)

  dispose()
  f.runtime.clearCommittedDraft(() => null)
  expect(f.root.textContent).toBe('')
  expect(document.activeElement).toBe(f.root)
})

it('removes focus preservation and update subscriptions when registration is disposed', () => {
  const f = fixture()
  f.dispose()
  expect(f.editor.getRootElement()).toBeNull()
  f.onUpdate.mockClear()
  f.editor.setRootElement(f.root)
  f.root.focus()
  f.editor.update(() => { $getRoot().getAllTextNodes()[0]!.select(1, 4) }, { discrete: true })
  f.outside.focus()
  f.editor.update(() => { $getRoot().getFirstDescendant()!.markDirty() }, { discrete: true })
  expect(document.activeElement).toBe(f.root)
  expect(f.onUpdate).not.toHaveBeenCalled()
})
