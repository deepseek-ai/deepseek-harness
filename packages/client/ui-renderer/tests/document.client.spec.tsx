// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { StrictMode, useEffect, useLayoutEffect, useRef } from 'react'
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
  // Document-wide rules for body-level layers address the marked wrapper's children.
  expect(input.parentElement?.matches('body > [data-document-portal]')).toBe(true)
  expect(input.closest('[data-plugin]')?.getAttribute('data-plugin')).toBe('outer')
  fireEvent.change(input, { target: { value: 'retained draft' } })
  input.focus()
  for (const owner of ['inner', '']) {
    view.rerender(<Source owner={owner} />)
    expect(view.getByDisplayValue('retained draft')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect(input.closest('[data-plugin]')?.getAttribute('data-plugin')).toBe(owner)
  }
  expect(document.body.hasAttribute('data-plugin')).toBe(false)
})

it('mounts content in the commit that renders the portal, attached and scoped before layout effects', () => {
  const Portal = createDocumentPortal(document)
  const layout = vi.fn<(owner: string | null | undefined, attached: boolean) => void>()
  const opened = vi.fn<(panel: HTMLDivElement | null) => void>()
  function Probe() {
    const own = useRef<HTMLSpanElement>(null)
    useLayoutEffect(() => {
      const element = own.current!
      layout(element.closest('[data-plugin]')?.getAttribute('data-plugin'), document.body.contains(element))
    }, [])
    return <span ref={own} />
  }
  function Caller({ open }: { open: boolean }) {
    const panel = useRef<HTMLDivElement>(null)
    useEffect(() => { if (open) opened(panel.current) }, [open])
    return <section data-plugin="source">{open && <Portal><div ref={panel} role="dialog"><Probe /></div></Portal>}</section>
  }
  const view = render(<Caller open={false} />)
  expect(view.queryByRole('dialog')).toBeNull()
  view.rerender(<Caller open />)
  expect(layout.mock.calls).toEqual([['source', true]])
  expect(opened).toHaveBeenCalledOnce()
  expect(opened.mock.calls[0]![0]).toBe(view.getByRole('dialog'))
})

it('removes its wrapper from the body when the portal unmounts', () => {
  const Portal = createDocumentPortal(document)
  const view = render(<Portal><p>Layer</p></Portal>)
  expect(document.body.querySelectorAll(':scope > [data-document-portal]')).toHaveLength(1)
  view.rerender(<></>)
  expect(document.body.querySelector(':scope > [data-document-portal]')).toBeNull()
  view.rerender(<Portal><p>Layer</p></Portal>)
  view.unmount()
  expect(document.body.querySelector(':scope > [data-document-portal]')).toBeNull()
})

it('follows the source package marker on each render, including gaining and losing one', () => {
  const Portal = createDocumentPortal(document)
  function Source({ owner }: { owner?: string }) {
    return <div data-plugin={owner}><Portal><p>Layer</p></Portal></div>
  }
  const view = render(<Source />)
  const wrapper = view.getByText('Layer').parentElement!
  expect(wrapper.matches('body > [data-document-portal]')).toBe(true)
  expect(wrapper.hasAttribute('data-plugin')).toBe(false)
  view.rerender(<Source owner="first" />)
  expect(view.getByText('Layer').parentElement).toBe(wrapper)
  expect(wrapper.getAttribute('data-plugin')).toBe('first')
  view.rerender(<Source />)
  expect(wrapper.hasAttribute('data-plugin')).toBe(false)
  expect(document.body.querySelectorAll(':scope > [data-document-portal]')).toHaveLength(1)
})

it('keeps content in the body through StrictMode effect replay', () => {
  const Portal = createDocumentPortal(document)
  const view = render(<StrictMode><div data-plugin="strict"><Portal><p>Layer</p></Portal></div></StrictMode>)
  const content = view.getByText('Layer')
  expect(document.body.contains(content)).toBe(true)
  expect(content.closest('[data-plugin]')?.getAttribute('data-plugin')).toBe('strict')
  expect(document.body.querySelectorAll(':scope > [data-document-portal]')).toHaveLength(1)
  act(() => { view.rerender(<StrictMode><div data-plugin="strict"><Portal><p>Layer</p></Portal></div></StrictMode>) })
  expect(document.body.contains(view.getByText('Layer'))).toBe(true)
  view.unmount()
  expect(document.body.querySelector(':scope > [data-document-portal]')).toBeNull()
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
