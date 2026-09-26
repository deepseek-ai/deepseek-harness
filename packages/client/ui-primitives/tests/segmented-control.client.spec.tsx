// @vitest-environment jsdom
/** The segmented control is a tablist whose selection the owner holds. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

type Mode = 'catalog' | 'custom' | 'import'

const OPTIONS: ReadonlyArray<{ value: Mode; label: string; disabled?: boolean; title?: string }> = [
  { value: 'catalog', label: 'Catalog' },
  { value: 'custom', label: 'Custom' },
  { value: 'import', label: 'Import' },
]

function mount(value: Mode, extra: {
  options?: typeof OPTIONS
  className?: string
  disabled?: boolean
} = {}) {
  const onChange = vi.fn<(next: Mode) => void>()
  const view = render(
    <SegmentedControl
      id="add"
      label="Add mode"
      value={value}
      options={extra.options ?? OPTIONS}
      onChange={onChange}
      {...extra.className === undefined ? {} : { className: extra.className }}
      {...extra.disabled === undefined ? {} : { disabled: extra.disabled }}
    />,
  )
  return { view, onChange }
}

function tab(name: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('tab', { name })
}

describe('SegmentedControl', () => {
  it('exposes a named tablist with one tab per option and the owner-held selection', () => {
    mount('custom')
    const list = screen.getByRole('tablist', { name: 'Add mode' })
    expect(list.querySelectorAll('[role="tab"]')).toHaveLength(3)
    expect(tab('Catalog').getAttribute('aria-selected')).toBe('false')
    expect(tab('Custom').getAttribute('aria-selected')).toBe('true')
    expect(tab('Import').getAttribute('aria-selected')).toBe('false')
  })

  it('reports the clicked option and stays silent on the one already selected', () => {
    const { onChange } = mount('catalog')
    fireEvent.click(tab('Custom'))
    expect(onChange).toHaveBeenCalledWith('custom')
    onChange.mockClear()
    fireEvent.click(tab('Catalog'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses a disabled option and carries its lock reason as the hover title', () => {
    const { onChange } = mount('catalog', {
      options: [OPTIONS[0]!, { value: 'custom', label: 'Custom', disabled: true, title: 'No protocol is mounted' }],
    })
    const locked = tab('Custom')
    expect(locked.disabled).toBe(true)
    expect(locked.getAttribute('title')).toBe('No protocol is mounted')
    fireEvent.click(locked)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps only the selected tab in the tab sequence', () => {
    mount('custom')
    expect(tab('Catalog').tabIndex).toBe(-1)
    expect(tab('Custom').tabIndex).toBe(0)
    expect(tab('Import').tabIndex).toBe(-1)
  })

  it('moves the selection with the arrow keys, wrapping at either end', () => {
    const { onChange } = mount('import')
    fireEvent.keyDown(tab('Import'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('catalog')
    fireEvent.keyDown(tab('Import'), { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('custom')
  })

  it('jumps to the first and last enabled options with Home and End, skipping disabled ones', () => {
    const { onChange } = mount('custom', {
      options: [
        { value: 'catalog', label: 'Catalog', disabled: true },
        OPTIONS[1]!,
        { value: 'import', label: 'Import', disabled: true },
      ],
    })
    fireEvent.keyDown(tab('Custom'), { key: 'Home' })
    fireEvent.keyDown(tab('Custom'), { key: 'End' })
    fireEvent.keyDown(tab('Custom'), { key: 'ArrowRight' })
    // Every enabled neighbour is the selected one itself, so nothing changes.
    expect(onChange).not.toHaveBeenCalled()
  })

  it('lands Home and End on the first and last enabled options, not the first and last options', () => {
    const { onChange } = mount('import', {
      options: [{ value: 'catalog', label: 'Catalog', disabled: true }, OPTIONS[1]!, OPTIONS[2]!],
    })
    fireEvent.keyDown(tab('Import'), { key: 'Home' })
    expect(onChange).toHaveBeenLastCalledWith('custom')
    onChange.mockClear()
    fireEvent.keyDown(tab('Import'), { key: 'End' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('skips disabled options while walking with the arrow keys', () => {
    const { onChange } = mount('catalog', {
      options: [OPTIONS[0]!, { value: 'custom', label: 'Custom', disabled: true }, OPTIONS[2]!],
    })
    fireEvent.keyDown(tab('Catalog'), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('import')
    fireEvent.keyDown(tab('Catalog'), { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('import')
  })

  it('moves keyboard focus onto the newly selected tab once the owner adopts it', () => {
    const { view, onChange } = mount('catalog')
    tab('Catalog').focus()
    fireEvent.keyDown(tab('Catalog'), { key: 'ArrowRight' })
    view.rerender(
      <SegmentedControl id="add" label="Add mode" value="custom" options={OPTIONS} onChange={onChange} />,
    )
    expect(document.activeElement).toBe(tab('Custom'))
  })

  it('leaves unrelated keys alone', () => {
    const { onChange } = mount('catalog')
    fireEvent.keyDown(tab('Catalog'), { key: 'Enter' })
    fireEvent.keyDown(tab('Catalog'), { key: 'a' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('places the sliding indicator by selected index and option count', () => {
    mount('import')
    const list = screen.getByRole('tablist')
    expect(list.style.getPropertyValue('--dsh-segment-count')).toBe('3')
    expect(list.style.getPropertyValue('--dsh-segment-index')).toBe('2')
  })

  it('keeps a caller class alongside its own so a render site can place it', () => {
    mount('catalog', { className: 'placed' })
    const list = screen.getByRole('tablist')
    expect(list.classList.contains('placed')).toBe(true)
    expect(list.classList.length).toBeGreaterThan(1)
  })

  it('names each tab and the panel it controls from the owner id, so panels can point back', () => {
    mount('catalog')
    const catalog = tab('Catalog')
    expect(catalog.id).toBe('add-catalog')
    expect(catalog.getAttribute('aria-controls')).toBe('add-catalog-panel')
    expect(tab('Import').getAttribute('aria-controls')).toBe('add-import-panel')
  })

  it('locks every segment while the owner reports the control disabled', () => {
    // A disabled button is unfocusable, so the walk keys cannot originate on
    // one; the click path is what a pointer can still reach.
    const { onChange } = mount('catalog', { disabled: true })
    for (const name of ['Catalog', 'Custom', 'Import']) expect(tab(name).disabled).toBe(true)
    fireEvent.click(tab('Custom'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('never submits a surrounding form', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => { event.preventDefault() })
    render(
      <form onSubmit={onSubmit}>
        <SegmentedControl id="add" label="Add mode" value="catalog" options={OPTIONS} onChange={() => {}} />
      </form>,
    )
    fireEvent.click(tab('Custom'))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
