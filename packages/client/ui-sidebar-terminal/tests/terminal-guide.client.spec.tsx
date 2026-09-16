// @vitest-environment jsdom
/** Guide shell discovery, direct launch and cancellation stay within the entry lifetime. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TerminalLaunchShells } from '@deepseek-ai/dsh-api-terminal-controller/client'
import { TerminalGuide, type TerminalGuideProps } from '../src/client/TerminalGuide.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const choices: TerminalLaunchShells = {
  shells: [{ name: 'bash', path: '/bin/bash', args: ['-i'] }, { name: 'zsh', path: '/bin/zsh', args: ['-i'] }],
  selectedShell: '/bin/zsh',
}

function mount(description: string | undefined = en.description) {
  const loadShells = vi.fn<TerminalGuideProps['loadShells']>(async () => choices)
  const selectShell = vi.fn()
  const openTab = vi.fn()
  // The fixture supplies only the guide's consumed owner and framework shares.
  const props = {
    entryId: 'new', kind: 'terminal', title: en.new, description, t: makeTranslate(en),
    useTabInfo: () => ({ tab: { actions: { openTab } } }), loadShells, selectShell,
  } as unknown as TerminalGuideProps
  const view = render(<TerminalGuide {...props} />)
  const open = () => fireEvent.click(view.getByRole('button', { name: en.shell }))
  return { view, props, open, loadShells, selectShell, openTab }
}

it('opens the default shell from the main button without querying a menu', () => {
  const h = mount()
  fireEvent.click(h.view.getByRole('button', { name: /^New terminal/u }))
  expect(h.openTab).toHaveBeenCalledExactlyOnceWith('terminal', { replaceTab: true })
  expect(h.loadShells).not.toHaveBeenCalled()
  expect(h.view.container.querySelector('button button')).toBeNull()
})

it('loads on demand, remembers a selected shell before opening, and cancels on menu dismissal', async () => {
  const h = mount()
  h.open()
  await h.view.findByRole('menuitem', { name: 'zsh' })
  const signal = h.loadShells.mock.calls[0]![0]
  h.selectShell.mockImplementation(() => { expect(h.openTab).not.toHaveBeenCalled() })
  fireEvent.click(h.view.getByRole('menuitem', { name: 'bash' }))
  expect(h.selectShell).toHaveBeenCalledExactlyOnceWith('/bin/bash')
  expect(h.openTab).toHaveBeenCalledExactlyOnceWith('terminal', { replaceTab: true, params: { shellPath: '/bin/bash' } })
  expect(signal.aborted).toBe(true)
  h.open()
  await h.view.findByRole('menuitem', { name: 'bash' })
  fireEvent.keyDown(h.view.getByRole('menu'), { key: 'Escape' })
  expect(h.view.queryByRole('menu')).toBeNull()
  expect(h.loadShells.mock.calls[1]![0].aborted).toBe(true)
})

it.each([new Error('offline'), 'offline'])('offers an in-place retry after discovery fails: %s', async (error) => {
  const h = mount()
  h.loadShells.mockRejectedValueOnce(error)
  h.open()
  await h.view.findByText('Terminal error: offline')
  fireEvent.click(h.view.getByRole('menuitem', { name: en.retry }))
  await h.view.findByRole('menuitem', { name: 'bash' })
  expect(h.loadShells).toHaveBeenCalledTimes(2)
  expect(h.openTab).not.toHaveBeenCalled()
})

it('shows empty discovery without opening a terminal and supports title-only cards', async () => {
  const h = mount()
  const { description: _description, ...titleOnly } = h.props
  h.view.rerender(<TerminalGuide {...titleOnly} />)
  h.loadShells.mockResolvedValue({ shells: [], selectedShell: undefined })
  h.open()
  await h.view.findByText(en.shellEmpty)
  expect(h.view.queryByText(en.description)).toBeNull()
  expect(h.openTab).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)('ignores a late %s after a loading entry unmounts', async (outcome) => {
  const h = mount()
  const pending = Promise.withResolvers<TerminalLaunchShells>()
  h.loadShells.mockReturnValue(pending.promise)
  h.open()
  expect(h.view.getByText(en.shellLoading)).toBeDefined()
  const signal = h.loadShells.mock.calls[0]![0]
  h.view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => {
    if (outcome === 'resolve') pending.resolve(choices)
    else pending.reject(new Error('late failure'))
    await pending.promise.catch((_lateDiscoveryFailure: unknown) => {
      /* The cancelled entry consumes the rejection without publishing it. */
    })
  })
  expect(h.openTab).not.toHaveBeenCalled()
})
