// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createDocumentPortal } from '../src/client/document-portal.tsx'
import { documentViewport } from '../src/client/document-viewport.ts'

afterEach(cleanup)

it('does not subscribe an inert document to the execution window', () => {
  const source = documentViewport(document.implementation.createHTMLDocument())
  const listener = vi.fn()
  const stop = source.subscribe(listener)
  try {
    fireEvent.resize(window)
    expect(listener).not.toHaveBeenCalled()
  } finally { stop() }
})

it('keeps portaled content mounted when its nearest package boundary changes, including to an empty boundary', () => {
  const Portal = createDocumentPortal(document)
  function Source({ owner }: { owner?: string }) {
    return <div data-plugin="outer"><section data-plugin={owner}><Portal><input aria-label="Draft" /></Portal></section></div>
  }
  const view = render(<Source />)
  const input = view.getByRole('textbox')
  expect(view.container.contains(input)).toBe(false)
  expect(input.closest('[data-plugin]')?.getAttribute('data-plugin')).toBe('outer')
  fireEvent.change(input, { target: { value: 'retained draft' } })
  for (const owner of ['inner', '']) {
    view.rerender(<Source owner={owner} />)
    expect(view.getByDisplayValue('retained draft')).toBe(input)
    expect(input.closest('[data-plugin]')?.getAttribute('data-plugin')).toBe(owner)
  }
  expect(document.body.hasAttribute('data-plugin')).toBe(false)
})

it('owns each native listener even when portals share their callback, and replaces callbacks on commit', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  try {
    const page = frame.contentDocument!
    const Portal = createDocumentPortal(page)
    const first = vi.fn()
    const changed = vi.fn()
    const capture = vi.fn()
    const view = render(<><Portal key="a" onKeyDown={first} onKeyDownCapture={capture} /><Portal key="b" onKeyDown={first} /></>)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(first).not.toHaveBeenCalled()
    fireEvent.keyDown(page.body, { key: 'Escape' })
    expect(first).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledOnce()
    view.rerender(<><Portal key="b" onKeyDown={first} /></>)
    fireEvent.keyDown(page.body, { key: 'Escape' })
    expect(first).toHaveBeenCalledTimes(3)
    expect(capture).toHaveBeenCalledOnce()
    view.rerender(<><Portal key="b" onKeyDown={changed} /></>)
    fireEvent.keyDown(page.body, { key: 'Escape' })
    expect(first).toHaveBeenCalledTimes(3)
    expect(changed).toHaveBeenCalledOnce()
    view.unmount()
    fireEvent.keyDown(page.body, { key: 'Escape' })
    expect(changed).toHaveBeenCalledOnce()
  } finally {
    cleanup()
    frame.remove()
  }
})

it('reads fresh viewport dimensions without subscribers and detaches from the window it subscribed to', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  try {
    const page = frame.contentWindow!
    const root = page.document.documentElement
    let width = 800, height = 600
    Object.defineProperties(root, { clientWidth: { get: () => width }, clientHeight: { get: () => height } })
    const source = documentViewport(page.document)
    const initial = source.getSnapshot()
    expect(initial).toEqual({ width: 800, height: 600 })
    expect(source.getSnapshot()).toBe(initial)
    const listener = vi.fn()
    const stop = source.subscribe(listener)
    fireEvent.resize(window)
    expect(listener).not.toHaveBeenCalled()
    height = 460
    fireEvent.resize(page)
    expect(listener).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toEqual({ width: 800, height: 460 })
    stop()
    width = 740
    fireEvent.resize(page)
    expect(listener).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).toEqual({ width: 740, height: 460 })
  } finally {
    frame.remove()
  }
})
