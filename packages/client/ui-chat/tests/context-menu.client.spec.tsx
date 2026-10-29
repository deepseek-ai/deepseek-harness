// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

it('leaves undeclared plugin links alone and binds only explicitly rendered Markdown targets', () => {
  const open = vi.fn()
  const custom = vi.fn()
  const view = render(<MarkdownDelegateProvider getTriggerProps={contextMenuHook(open)().getTriggerProps} openFile={() => {}}>
    <a href="https://example.com/plugin">Plugin link</a>
    <MarkdownText text="[File](docs/file.ts#L42)" labels={{ code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }} />
    <button {...contextMenuHook(custom)().getTriggerProps({ kind: 'pluginDocument', id: 'one' })}>Plugin target</button>
  </MarkdownDelegateProvider>)
  expect(fireEvent.contextMenu(view.getByRole('link', { name: 'Plugin link' }))).toBe(true)
  expect(open).not.toHaveBeenCalled()
  const file = view.getByRole('button', { name: 'File' })
  fireEvent.contextMenu(file, { clientX: 40, clientY: 50 })
  expect(open).toHaveBeenLastCalledWith({ kind: 'file', path: 'docs/file.ts', line: 42 }, { x: 40, y: 50 })
  file.getBoundingClientRect = () => new DOMRect(30, 40, 100, 20)
  fireEvent.keyDown(file, { key: 'F10', shiftKey: true })
  expect(open).toHaveBeenLastCalledWith({ kind: 'file', path: 'docs/file.ts', line: 42 }, { x: 30, y: 60 })
  expect(document.activeElement).toBe(file)
  fireEvent.contextMenu(view.getByRole('button', { name: 'Plugin target' }), { clientX: 70, clientY: 80 })
  expect(custom).toHaveBeenCalledExactlyOnceWith({ kind: 'pluginDocument', id: 'one' }, { x: 70, y: 80 })
  expect(open).toHaveBeenCalledTimes(2)
})
