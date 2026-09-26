// @vitest-environment jsdom
import './control-row-dom.ts'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { observeControlRow } from '../src/client/skeleton/control-row-layout.ts'

afterEach(() => { document.body.replaceChildren() })

function fixture() {
  const row = document.createElement('div')
  row.style.padding = '2px 8px 6px'
  row.style.columnGap = '12px'
  const tools = document.createElement('div')
  const trailing = document.createElement('div')
  const label = document.createElement('span')
  label.textContent = 'Long model'
  trailing.append(label)
  row.append(tools, trailing)
  document.body.append(row)
  const sizes = { row: 400, tools: 180, trailing: 220 }
  row.getBoundingClientRect = () => new DOMRect(0, 0, sizes.row, 36)
  tools.getBoundingClientRect = () => new DOMRect(0, 0, tools.hidden ? 0 : sizes.tools, 28)
  trailing.getBoundingClientRect = () => new DOMRect(0, 0,
    row.hasAttribute('data-model-compact') ? 70 : sizes.trailing, 28)
  const observe = vi.fn()
  const disconnect = vi.fn()
  let resized: () => void = () => {}
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe = observe
    disconnect = disconnect
  })
  const dispose = observeControlRow(row)
  onTestFinished(dispose)
  return { row, tools, label, sizes, observe, disconnect, dispose, resize: () => { resized() } }
}

describe('composer control row measurement', () => {
  it('collapses on expanded demand and remains stable across resize deliveries', () => {
    const { row, sizes, observe, resize } = fixture()
    expect(observe).toHaveBeenCalledTimes(3)
    expect(row.hasAttribute('data-model-compact')).toBe(true)
    for (let i = 0; i < 3; i++) {
      resize()
      expect(row.hasAttribute('data-model-compact')).toBe(true)
    }
    sizes.row = 428
    resize()
    expect(row.hasAttribute('data-model-compact')).toBe(false)
    sizes.row -= 0.25
    resize()
    expect(row.hasAttribute('data-model-compact')).toBe(true)
  })

  it('remeasures changed text while collapsed without a row resize', async () => {
    const { row, label, sizes } = fixture()
    sizes.trailing = 100
    label.firstChild!.textContent = 'Short'
    await Promise.resolve()
    expect(row.hasAttribute('data-model-compact')).toBe(false)
    sizes.trailing = 250
    label.replaceChildren('Another long model')
    await Promise.resolve()
    expect(row.hasAttribute('data-model-compact')).toBe(true)
  })

  it('accounts for inserted controls and hidden groups', async () => {
    const { row, tools, sizes } = fixture()
    tools.hidden = true
    await Promise.resolve()
    expect(row.hasAttribute('data-model-compact')).toBe(false)
    tools.hidden = false
    await Promise.resolve()
    expect(row.hasAttribute('data-model-compact')).toBe(true)
    sizes.tools = 100
    tools.append(document.createElement('button'))
    await Promise.resolve()
    expect(row.hasAttribute('data-model-compact')).toBe(false)
  })

  it('remeasures after font loading and disconnects all notifications', async () => {
    const { row, label, sizes, disconnect, dispose } = fixture()
    sizes.trailing = 100
    document.fonts.dispatchEvent(new Event('loadingdone'))
    expect(row.hasAttribute('data-model-compact')).toBe(false)
    dispose()
    expect(disconnect).toHaveBeenCalledOnce()
    sizes.trailing = 300
    label.replaceChildren('Unobserved model')
    document.fonts.dispatchEvent(new Event('loadingdone'))
    await Promise.resolve()
    expect(row.hasAttribute('data-model-compact')).toBe(false)
  })
})
