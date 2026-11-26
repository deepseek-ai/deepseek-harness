// @vitest-environment jsdom
/** Model rows fold to text, and dragging a folded row reorders one provider's list with its row state. */
import { useState } from 'react'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekModelsEditor } from '../src/client/DeepSeekModelsEditor.tsx'
import type { DeepSeekModelDraft } from '../src/client/DeepSeekModelsEditor.tsx'
import { ModelListEditor } from '../src/client/ModelListEditor.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Editor(props: {
  family: 'deepseek' | 'pi-ai'
  initial: DeepSeekModelDraft[]
  changed: (models: DeepSeekModelDraft[]) => void
  disabled?: boolean
}) {
  const [models, setModels] = useState(props.initial)
  const shared = {
    models, disabled: props.disabled === true, overridden: true, attempt: 0,
    t: (key: keyof typeof en) => en[key],
    onChange: (next: DeepSeekModelDraft[]): void => { props.changed(next); setModels(next) },
    onReset: (): void => { setModels(props.initial) },
  }
  return props.family === 'deepseek'
    ? <DeepSeekModelsEditor {...shared} defaultContextWindow={undefined} defaultMaxTokens={undefined} />
    : <ModelListEditor
      {...shared} probe={{ settingsNs: 'llm-pi-ai' }} onBusyChange={() => {}}
      operations={{ discoverModels: vi.fn(), storeCredential: vi.fn(), removeCredential: vi.fn(), writeSettings: vi.fn() }}
    />
}

/** The disclosure button of the row at a one-based position. */
function toggle(position: number, root: HTMLElement = document.body): HTMLButtonElement {
  return within(root).getByRole('button', { name: `${en.modelAdvanced} ${String(position)}` })
}

/** The row at a one-based position: the drag source while folded, and a drop target in either state. */
function entry(position: number, root: HTMLElement = document.body): HTMLElement {
  const row = toggle(position, root).closest('[data-row-key]')
  if (!(row instanceof HTMLElement)) throw new Error('Model row is missing')
  return row
}

function transfer() {
  return {
    setData: vi.fn(), effectAllowed: '', dropEffect: '',
    setDragImage: vi.fn<(image: HTMLElement, x: number, y: number) => void>(),
  }
}

/** jsdom's DragEvent fallback drops pointer coordinates from event options. */
function fireDrag(target: HTMLElement, kind: 'dragOver' | 'drop', clientY: number, dataTransfer: ReturnType<typeof transfer>) {
  const event = kind === 'dragOver' ? createEvent.dragOver(target) : createEvent.drop(target)
  Object.defineProperties(event, { clientY: { value: clientY }, dataTransfer: { value: dataTransfer } })
  fireEvent(target, event)
}

/** Drag one row and release it on the upper or lower half of another. */
function dragTo(source: HTMLElement, destination: HTMLElement, half: 'before' | 'after') {
  vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 200, 40))
  const dataTransfer = transfer()
  fireEvent.dragStart(source, { dataTransfer })
  fireDrag(destination, 'drop', half === 'before' ? 110 : 130, dataTransfer)
  fireEvent.dragEnd(source)
}

function leave(target: HTMLElement, relatedTarget: Node | null = null) {
  const event = createEvent.dragLeave(target)
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget })
  fireEvent(target, event)
}

describe.each(['deepseek', 'pi-ai'] as const)('%s model ordering', (family) => {
  it('shows a folded row as its model ID and display name without fields', () => {
    render(<Editor family={family} initial={[{ id: 'first', name: 'First' }, {}]} changed={vi.fn()} />)
    expect(toggle(1).getAttribute('aria-expanded')).toBe('false')
    expect(within(entry(1)).queryByRole('textbox')).toBeNull()
    expect(within(entry(1)).getByText('first').dataset.unnamed).toBeUndefined()
    expect(within(entry(1)).getByText('First')).toBeDefined()
    expect(within(entry(2)).queryByRole('textbox')).toBeNull()
    expect(within(entry(2)).getByText(en.modelId).dataset.unnamed).toBe('true')
    expect(entry(2).textContent).toBe(en.modelId)
  })

  it('unfolds a row from its text or its disclosure and keeps focus on the disclosure when folding', () => {
    const changed = vi.fn()
    render(<Editor family={family} initial={[{ id: 'first', name: 'First' }]} changed={changed} />)
    fireEvent.click(within(entry(1)).getByText('First'))
    expect(toggle(1).getAttribute('aria-expanded')).toBe('true')
    expect(within(entry(1)).queryByText('first')).toBeNull()
    const controls = [...entry(1).querySelectorAll('input, button')].slice(0, 4)
    expect(controls.map(control => control.getAttribute('aria-label'))).toEqual([
      `${en.modelId} 1`, `${en.modelName} 1`, `${en.modelAdvanced} 1`, `${en.removeModel} 1`,
    ])
    const identity = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)
    const name = screen.getByLabelText<HTMLInputElement>(`${en.modelName} 1`)
    expect([identity.value, name.value]).toEqual(['first', 'First'])

    fireEvent.change(name, { target: { value: 'Renamed' } })
    expect(changed).toHaveBeenLastCalledWith([{ id: 'first', name: 'Renamed' }])
    fireEvent.change(name, { target: { value: '' } })
    expect(changed).toHaveBeenLastCalledWith([{ id: 'first' }])
    fireEvent.change(identity, { target: { value: 'second' } })
    fireEvent.blur(identity)
    expect(changed).toHaveBeenLastCalledWith([{ id: 'second' }])

    act(() => { name.focus() })
    fireEvent.click(toggle(1))
    expect(toggle(1).getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle(1))
    expect(entry(1).textContent).toBe('second')
    fireEvent.click(toggle(1))
    expect(toggle(1).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`).value).toBe('second')
  })

  it('moves a folded model with its hidden fields and unfinished capacity text to the drop position', () => {
    const first = { id: 'first', name: 'First', contextWindow: 4096, input: ['image'], hidden: { preserved: true } }
    const second = { id: 'second', maxTokens: 1024 }
    const third = { id: 'third' }
    const changed = vi.fn()
    render(<Editor family={family} initial={[first, second, third]} changed={changed} />)
    const source = entry(1)
    const destination = entry(3)
    fireEvent.click(toggle(1))
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: 'unfinished' } })
    fireEvent.change(screen.getByLabelText(`${en.maxTokens} 1`), { target: { value: '2000' } })
    fireEvent.blur(screen.getByLabelText(`${en.contextWindow} 1`))
    fireEvent.blur(screen.getByLabelText(`${en.maxTokens} 1`))
    fireEvent.click(toggle(1))
    changed.mockClear()

    const dataTransfer = transfer()
    fireEvent.dragStart(source, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.setData).toHaveBeenCalledExactlyOnceWith('application/x-dsh-model-order', '1')
    fireEvent.dragOver(destination, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')
    expect(changed).not.toHaveBeenCalled()
    fireEvent.drop(destination, { dataTransfer })
    fireEvent.dragEnd(source)

    expect(changed).toHaveBeenCalledExactlyOnceWith([
      second, third, { ...first, contextWindow: Number.NaN, maxTokens: 2000 },
    ])
    expect(entry(3)).toBe(source)
    expect(toggle(3).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle(3))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 3`).value).toBe('unfinished')
    // Leaving a field respells a readable count in the DeepSeek catalog only; unreadable text stays in both.
    expect(screen.getByLabelText<HTMLInputElement>(`${en.maxTokens} 3`).value).toBe(family === 'deepseek' ? '2K' : '2000')
    expect(screen.queryByLabelText(`${en.contextWindow} 1`)).toBeNull()
    expect(first.contextWindow).toBe(4096)
  })

  it('keeps an unfolded row\'s fields and unfinished capacity text when a row is dropped beside it', () => {
    const first = { id: 'first' }
    const third = { id: 'third' }
    const changed = vi.fn()
    render(<Editor family={family} initial={[first, { id: 'second' }, third]} changed={changed} />)
    fireEvent.click(toggle(2))
    const identity = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 2`)
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 2`), { target: { value: 'unfinished' } })
    changed.mockClear()

    dragTo(entry(3), entry(2), 'before')

    expect(changed).toHaveBeenCalledExactlyOnceWith([first, third, { id: 'second', contextWindow: Number.NaN }])
    expect(screen.getByLabelText(`${en.modelId} 3`)).toBe(identity)
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 3`).value).toBe('unfinished')
    expect(toggle(2).getAttribute('aria-expanded')).toBe('false')
    expect(entry(2).textContent).toBe('third')
  })

  it('marks and inserts before or after a row, ignoring adjacent insertions that keep the order', () => {
    const changed = vi.fn()
    render(<Editor family={family} initial={[{ id: 'first' }, { id: 'second' }, { id: 'third' }]} changed={changed} />)
    const source = entry(3)
    const destination = entry(1)
    vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 200, 40))
    const dataTransfer = transfer()
    fireEvent.dragStart(source, { dataTransfer })
    expect(source.dataset.dragging).toBe('true')
    fireDrag(source, 'dragOver', 0, dataTransfer)
    expect(source.dataset.dropTarget).toBeUndefined()
    fireDrag(destination, 'dragOver', 110, dataTransfer)
    expect(destination.dataset.dropTarget).toBe('before')
    fireDrag(destination, 'dragOver', 130, dataTransfer)
    expect(destination.dataset.dropTarget).toBe('after')
    fireDrag(destination, 'dragOver', 130, dataTransfer)
    fireDrag(destination, 'drop', 110, dataTransfer)
    fireEvent.dragEnd(source)
    expect(changed).toHaveBeenCalledExactlyOnceWith([{ id: 'third' }, { id: 'first' }, { id: 'second' }])
    expect(destination.dataset.dropTarget).toBeUndefined()
    expect(source.dataset.dragging).toBeUndefined()
    expect(entry(1)).toBe(source)
    changed.mockClear()

    const adjacent = entry(2)
    vi.spyOn(adjacent, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 200, 40))
    fireEvent.dragStart(source, { dataTransfer })
    fireDrag(adjacent, 'drop', 110, dataTransfer)
    fireEvent.dragEnd(source)
    fireEvent.dragStart(adjacent, { dataTransfer })
    fireDrag(source, 'drop', 0, dataTransfer)
    fireEvent.dragEnd(adjacent)
    expect(changed).not.toHaveBeenCalled()
  })

  it('previews the folded row it drags and cleans the preview up at drag end or unmount', () => {
    const view = render(<Editor family={family} initial={[{ id: 'first', name: 'First' }]} changed={vi.fn()} />)
    const source = entry(1)
    expect(source.getAttribute('draggable')).toBe('true')
    const dataTransfer = transfer()
    fireEvent.dragStart(source, { dataTransfer })
    const preview = dataTransfer.setDragImage.mock.calls[0]![0]
    expect(preview.inert).toBe(true)
    expect(preview.getAttribute('aria-hidden')).toBe('true')
    expect(preview.querySelector('[data-row-key]')).toBeNull()
    expect(preview.textContent).toBe('first First')
    expect(within(preview).getByLabelText(`${en.modelAdvanced} 1`).tabIndex).toBe(-1)
    fireEvent.dragEnd(source)
    expect(preview.isConnected).toBe(false)
    fireEvent.dragEnd(source)
    fireEvent.dragStart(source, { dataTransfer })
    const nextPreview = dataTransfer.setDragImage.mock.calls[1]![0]
    view.unmount()
    expect(nextPreview.isConnected).toBe(false)
  })

  it('marks a row that can be dragged with a hidden six-dot mark, and no other row', () => {
    const models = [{ id: 'first' }, { id: 'second' }]
    const view = render(<Editor family={family} initial={models} changed={vi.fn()} />)
    const mark = (position: number) => entry(position).querySelector('[data-icon^="dsw-icon-drag-dots-fill"]')
    expect(mark(1)?.parentElement?.getAttribute('aria-hidden')).toBe('true')
    // The mark names nothing: the row's text stays the model alone.
    expect(entry(1).textContent).toBe('first')

    fireEvent.click(toggle(1))
    expect(mark(1)).toBeNull()
    expect(mark(2)).not.toBeNull()

    view.rerender(<Editor family={family} initial={models} changed={vi.fn()} disabled />)
    expect(mark(2)).toBeNull()
  })

  it('does not drag an unfolded row, which still accepts a dropped row', () => {
    const changed = vi.fn()
    render(<Editor family={family} initial={[{ id: 'first' }, { id: 'second' }]} changed={changed} />)
    const unfolded = entry(1)
    const folded = entry(2)
    fireEvent.click(toggle(1))
    expect(unfolded.getAttribute('draggable')).toBeNull()
    const dataTransfer = transfer()
    fireEvent.dragStart(unfolded, { dataTransfer })
    fireEvent.dragOver(folded, { dataTransfer })
    expect(folded.dataset.dropTarget).toBeUndefined()
    fireEvent.drop(folded, { dataTransfer })
    fireEvent.dragEnd(unfolded)
    expect(dataTransfer.setData).not.toHaveBeenCalled()
    expect(dataTransfer.setDragImage).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()

    dragTo(folded, unfolded, 'before')
    expect(changed).toHaveBeenCalledExactlyOnceWith([{ id: 'second' }, { id: 'first' }])
    expect(toggle(2).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle(2))
    expect(unfolded.getAttribute('draggable')).toBe('true')
  })

  it('keeps canceled, same-row, foreign, and disabled drops from changing the draft', () => {
    const changed = vi.fn()
    const initial = [{ id: 'first' }, { id: 'second' }]
    const view = render(<Editor family={family} initial={initial} changed={changed} />)
    const source = entry(1)
    const destination = entry(2)
    const dataTransfer = transfer()
    fireEvent.drop(destination, { dataTransfer })
    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.drop(source, { dataTransfer })
    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(destination, { dataTransfer })
    fireEvent.dragEnd(source)
    fireEvent.drop(destination, { dataTransfer })
    expect(changed).not.toHaveBeenCalled()

    view.rerender(<Editor family={family} initial={initial} changed={changed} disabled />)
    expect(source.getAttribute('draggable')).toBeNull()
    const refused = transfer()
    fireEvent.dragStart(source, { dataTransfer: refused })
    fireEvent.dragOver(destination, { dataTransfer: refused })
    expect(destination.dataset.dropTarget).toBeUndefined()
    fireEvent.drop(destination, { dataTransfer: refused })
    fireEvent.dragEnd(source)
    expect(refused.setData).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it('clears an outside insertion marker without clearing another row or an internal transition', () => {
    const changed = vi.fn()
    render(<Editor family={family} initial={[{ id: 'first' }, { id: 'second' }, { id: 'third' }]} changed={changed} />)
    const source = entry(1)
    const second = entry(2)
    const third = entry(3)
    const dataTransfer = transfer()
    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(second, { dataTransfer })
    leave(second, second.querySelector('button'))
    expect(second.dataset.dropTarget).toBe('after')
    fireEvent.dragOver(third, { dataTransfer })
    leave(second, third)
    expect(third.dataset.dropTarget).toBe('after')
    leave(third, document.body)
    expect(third.dataset.dropTarget).toBeUndefined()
    fireEvent.dragOver(second, { dataTransfer })
    leave(second)
    expect(second.dataset.dropTarget).toBeUndefined()
    fireEvent.dragEnd(source)
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps the animated list mounted when its last row is removed', () => {
    render(<Editor family={family} initial={[{ id: 'first' }]} changed={vi.fn()} />)
    const list = entry(1).parentElement!
    fireEvent.click(screen.getByRole('button', { name: `${en.removeModel} 1` }))
    expect(list.isConnected).toBe(true)
    expect(list.querySelector('[data-row-key]')).toBeNull()
    // Only the DeepSeek catalog explains an empty list; a hand-declared pi-ai route has nothing to inherit.
    expect(screen.queryByText(en.modelsEmpty) !== null).toBe(family === 'deepseek')
    expect(screen.queryByText(en.modelsInherited)).toBeNull()
  })

  it('keeps blank rows distinct through editing, moves, removal, and addition', () => {
    render(<Editor family={family} initial={[{ id: '' }, { id: '' }]} changed={vi.fn()} />)
    expect(toggle(1).getAttribute('aria-expanded')).toBe('false')
    const blank = entry(2)
    fireEvent.click(toggle(1))
    const first = screen.getByLabelText<HTMLInputElement>(`${en.modelId} 1`)
    first.focus()
    fireEvent.change(first, { target: { value: 'renamed' } })
    expect(document.activeElement).toBe(first)
    dragTo(blank, entry(1), 'before')
    expect(screen.getByLabelText(`${en.modelId} 2`)).toBe(first)
    expect(entry(1)).toBe(blank)
    fireEvent.click(screen.getByRole('button', { name: `${en.removeModel} 1` }))
    expect(screen.getByLabelText(`${en.modelId} 1`)).toBe(first)

    fireEvent.click(screen.getByRole('button', { name: en.addModel }))
    const added = entry(2)
    expect(added).not.toBe(blank)
    expect(toggle(2).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText<HTMLInputElement>(`${en.modelId} 2`).value).toBe('')
    fireEvent.click(toggle(2))
    dragTo(added, entry(1), 'before')
    expect(entry(1)).toBe(added)
    expect(screen.getByLabelText(`${en.modelId} 2`)).toBe(first)
  })

  it('restores inherited order with every row folded and clears row drafts when defaults are restored', () => {
    render(<Editor family={family} initial={[{ id: 'first' }, { id: 'second' }]} changed={vi.fn()} />)
    fireEvent.click(toggle(1))
    fireEvent.change(screen.getByLabelText(`${en.contextWindow} 1`), { target: { value: 'bad' } })
    dragTo(entry(2), entry(1), 'before')
    expect(entry(1).textContent).toBe('second')
    fireEvent.click(screen.getByRole('button', { name: `${en.removeModel} 1` }))
    fireEvent.click(screen.getByRole('button', { name: en.resetModels }))
    expect([entry(1).textContent, entry(2).textContent]).toEqual(['first', 'second'])
    expect(screen.queryByLabelText(`${en.contextWindow} 1`)).toBeNull()
    fireEvent.click(toggle(1))
    expect(screen.getByLabelText<HTMLInputElement>(`${en.contextWindow} 1`).value).toBe('')
  })
})

it('does not accept another provider editor\'s dragged model', () => {
  const firstChanged = vi.fn()
  const secondChanged = vi.fn()
  const first = render(<Editor family="pi-ai" initial={[{ id: 'a' }, { id: 'b' }]} changed={firstChanged} />)
  const second = render(<Editor family="deepseek" initial={[{ id: 'c' }, { id: 'd' }]} changed={secondChanged} />)
  const source = entry(1, first.container)
  const destination = entry(2, second.container)
  const dataTransfer = transfer()
  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(destination, { dataTransfer })
  expect(destination.dataset.dropTarget).toBeUndefined()
  fireEvent.drop(destination, { dataTransfer })
  fireEvent.dragEnd(source)
  expect(firstChanged).not.toHaveBeenCalled()
  expect(secondChanged).not.toHaveBeenCalled()
})
