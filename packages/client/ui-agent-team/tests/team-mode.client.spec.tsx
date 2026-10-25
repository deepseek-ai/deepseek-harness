// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamModeToggle, type TeamModeToggleProps } from '../src/client/TeamModeToggle.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function props(enabled: boolean | undefined, selectTeamMode = vi.fn(async () => null as string | null), child?: 'addressed' | 'listed'): TeamModeToggleProps {
  return {
    sessionId: SessionId('root'),
    useSession: (select: (value: { subagent: object | null }) => unknown) => select({ subagent: child === 'addressed' ? {} : null }),
    useSessions: (select: (value: { byId: object }) => unknown) => select({ byId: child === 'listed' ? { root: { origin: 'subagent' } } : {} }),
    useProjection: () => enabled === undefined ? undefined : { enabled, tasks: [] },
    locked: false, reportFailure: vi.fn(), selectTeamMode,
    t: makeTranslate(zh),
  } as TeamModeToggleProps
}

it('renders only available mode and waits for persisted state before displaying a new selection', async () => {
  let finish!: (result: string | null) => void
  const select = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve }))
  const view = render(<TeamModeToggle {...props(undefined, select)} />)
  expect(screen.queryByRole('switch')).toBeNull()
  view.rerender(<TeamModeToggle {...props(false, select)} />)
  const toggle = screen.getByRole('switch', { name: zh['mode.label'] })
  fireEvent.click(toggle)
  expect(select).toHaveBeenCalledWith(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(toggle.hasAttribute('disabled')).toBe(true)
  await act(async () => { finish(null) })
  view.rerender(<TeamModeToggle {...props(true, select)} />)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
})

it.each(['returned', 'error', 'string'])('reports rejected mode writes through the menu host (%s)', async (failure) => {
  const p = props(false, vi.fn(async () => {
    if (failure === 'error') throw new Error('offline')
    if (failure === 'string') throw 'offline'
    return 'offline'
  }))
  render(<TeamModeToggle {...p} />)
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(p.reportFailure).toHaveBeenCalledWith(expect.stringContaining('offline'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})

it('disables selection while the Session is locked', () => {
  render(<TeamModeToggle {...props(false)} locked />)
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
})

it.each(['addressed', 'listed'] as const)('hides the switch on a child Session (%s)', (source) => {
  const input = props(false, undefined, source)
  const useProjection = vi.fn((): never => { throw new Error('Child must not read Team mode') })
  render(<TeamModeToggle {...input} useProjection={useProjection} />)
  expect(screen.queryByRole('switch')).toBeNull()
  expect(useProjection).not.toHaveBeenCalled()
  expect(input.selectTeamMode).not.toHaveBeenCalled()
})
