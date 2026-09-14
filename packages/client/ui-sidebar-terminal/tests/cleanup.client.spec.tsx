// @vitest-environment jsdom
/** Cleanup errors remain reachable after the terminal tab has disappeared. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TerminalCloseFailure } from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WebTerminalId } from '@deepseek-ai/dsh-api-terminal-controller/types'
import { TerminalCleanup } from '../src/client/TerminalCleanup.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

type CleanupProps = Parameters<typeof TerminalCleanup>[0]
const unusedHook = (): never => { throw new Error('Terminal cleanup does not consume global hooks') }
const standard: Omit<CleanupProps, 'useCloseFailures' | 'retryClose' | 't'> = {
  useSessions: unusedHook, useSessionPendingInteraction: unusedHook, usePanelInfo: unusedHook,
  useWorkspaces: unusedHook, useResource: unusedHook,
}

it('stays absent for ordinary closes and offers a retry only after cleanup fails', () => {
  let failures: readonly TerminalCloseFailure[] = []
  const retryClose = vi.fn<CleanupProps['retryClose']>()
  const useCloseFailures: CleanupProps['useCloseFailures'] = selector => selector(failures)
  const props: CleanupProps = { ...standard, useCloseFailures, retryClose, t: makeTranslate(en) }
  const view = render(<TerminalCleanup {...props} />)
  expect(view.container.childElementCount).toBe(0)
  failures = [{ id: 'terminal' as WebTerminalId, title: 'Build', message: 'Host unavailable' }]
  view.rerender(<TerminalCleanup {...props} />)
  expect(view.getByRole('alert').textContent).toContain('Terminal “Build” could not be ended: Host unavailable')
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  expect(retryClose).toHaveBeenCalledWith('terminal')
  failures = []
  view.rerender(<TerminalCleanup {...props} />)
  expect(view.container.childElementCount).toBe(0)
})

it('keeps cleanup failures separate and retries the terminal selected by the user', () => {
  const failures: readonly TerminalCloseFailure[] = [
    { id: 'build' as WebTerminalId, title: 'Build', message: 'Host unavailable' },
    { id: 'tests' as WebTerminalId, title: 'Tests', message: 'Process did not exit' },
  ]
  const retryClose = vi.fn<CleanupProps['retryClose']>()
  const useCloseFailures: CleanupProps['useCloseFailures'] = selector => selector(failures)
  const props: CleanupProps = { ...standard, useCloseFailures, retryClose, t: makeTranslate(en) }
  const view = render(<TerminalCleanup {...props} />)
  const notices = view.getAllByRole('alert')
  expect(notices.map(notice => notice.textContent)).toEqual([
    'Terminal “Build” could not be ended: Host unavailableRetry',
    'Terminal “Tests” could not be ended: Process did not exitRetry',
  ])
  fireEvent.click(within(notices[1]!).getByRole('button', { name: en.retry }))
  expect(retryClose).toHaveBeenCalledExactlyOnceWith('tests')
})
