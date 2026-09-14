// @vitest-environment jsdom
/** Composer clicks use the owning Lexical node while selection gestures remain editable. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { ReferenceChipNode } from '../src/client/input/editor/chip-node.tsx'
import { TextRefNode } from '../src/client/input/editor/text-ref.ts'
import { registerReferenceActivation } from '../src/client/input/editor/reference-activation.ts'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function bench() {
  const editor = createEditor({ nodes: [ReferenceChipNode, TextRefNode], onError: (error) => { throw error } })
  const root = document.createElement('div')
  root.contentEditable = 'true'
  document.body.append(root)
  editor.setRootElement(root)
  cleanups.push(() => { editor.setRootElement(null); root.remove() })
  cleanups.push(registerPlainText(editor))
  const open = vi.fn(() => true)
  const off = registerReferenceActivation(editor, open)
  cleanups.push(off)
  let chip!: ReferenceChipNode
  let text!: TextRefNode
  editor.update(() => {
    chip = new ReferenceChipNode({ source: 'reference', ref: '@a.md', label: 'a.md', appearance: 'file', clipboardText: '@a.md' })
    text = new TextRefNode('/review')
    $getRoot().append($createParagraphNode().append(chip, $createTextNode(' '), text))
  }, { discrete: true })
  const click = (key: string, detail = 1) => {
    const target = editor.getElementByKey(key)!
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
  }
  return { editor, root, chip, text, open, click, off }
}

describe('reference activation', () => {
  it('opens chip and editable skill references without changing draft content', () => {
    const { editor, chip, text, open, click, off } = bench()
    click(chip.getKey())
    expect(open).toHaveBeenLastCalledWith('reference', { ref: '@a.md', appearance: 'file' })
    click(text.getKey())
    expect(open).toHaveBeenLastCalledWith(undefined, { ref: '/review' })
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('@a.md /review')
    off()
    click(text.getKey())
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('opens once in a double-click sequence and leaves selections, invalid chips, and ordinary text to the editor', () => {
    const { editor, root, chip, text, open, click } = bench()
    click(text.getKey(), 1)
    click(text.getKey(), 2)
    expect(open).toHaveBeenCalledTimes(1)
    open.mockClear()
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    editor.update(() => { text.select(0, 3) }, { discrete: true })
    click(text.getKey())
    editor.update(() => { text.select(0, 0); chip.setInvalid(true) }, { discrete: true })
    click(chip.getKey())
    expect(open).not.toHaveBeenCalled()
  })
})
