// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamModeToggle, type TeamModeToggleProps } from '../src/client/TeamModeToggle.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function props(enabled: boolean | undefined, selectTeamMode = vi.fn(async () => null as string | null), child?: 'addressed' | 'listed', requestedModel: boolean | 'loading' = false): TeamModeToggleProps {
  return {
    sessionId: SessionId('root'),
    useSession: (select: (value: { subagent: object | null }) => unknown) => select({ subagent: child === 'addressed' ? {} : null }),
    useSessions: (select: (value: { byId: object }) => unknown) => select({ byId: child === 'listed' ? { root: { origin: 'subagent' } } : {} }),
    useProjection: (key: string) => key === 'modelSelection'
      ? requestedModel === 'loading' ? undefined : { lastUsed: requestedModel ? { provider: 'mock', model: 'mock' } : null, next: { provider: 'mock', model: 'mock' } }
      : enabled === undefined ? undefined : { enabled, tasks: [] },
    locked: false, dismiss: vi.fn(), reportFailure: vi.fn(), selectTeamMode, requestDisableConfirmation: vi.fn(),
    t: makeTranslate(zh),
  } as TeamModeToggleProps
}

it('renders only available mode and waits for persisted state before displaying a new selection', async () => {
  let finish!: (result: string | null) => void
  const select = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve }))
  const view = render(<TeamModeToggle {...props(undefined, select)} />)
  expect(screen.queryByRole('switch')).toBeNull()
  view.rerender(<TeamModeToggle {...props(false, select)} />)
  const toggle = screen.getByRole('switch', { name: '启用智能体团队协作' })
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

it.each(Object.entries({ zh, en, ja, es, fr, de, ru, pt }).flatMap(([locale, dictionary]) =>
  [false, true].map(locked => ({ locale, dictionary, locked })),
))('opens the $locale explanation without changing Team mode (locked: $locked)', ({ dictionary, locked }) => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  const input = props(false)
  render(<TeamModeToggle {...input} locked={locked} t={makeTranslate(dictionary)} />)
  const info = screen.getByRole('button', { name: dictionary['mode.infoLabel'] })
  expect(info.hasAttribute('disabled')).toBe(false)
  fireEvent.click(info)
  const tooltip = screen.getByRole('tooltip', { hidden: true })
  expect(tooltip.textContent).toBe(dictionary['mode.description'])
  expect(info.getAttribute('aria-describedby')).toBe(tooltip.id)
  expect(document.body.contains(tooltip)).toBe(true)
  expect(input.selectTeamMode).not.toHaveBeenCalled()
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  fireEvent.keyDown(info, { key: 'Escape' })
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  fireEvent.click(info)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  expect(input.selectTeamMode).not.toHaveBeenCalled()
})

it('requests confirmation before disabling after a recorded model request', () => {
  const input = props(true, undefined, undefined, true)
  render(<TeamModeToggle {...input} />)
  fireEvent.click(screen.getByRole('switch'))
  expect(input.dismiss).toHaveBeenCalledOnce()
  expect(input.dismiss).toHaveBeenCalledBefore(vi.mocked(input.requestDisableConfirmation))
  expect(input.requestDisableConfirmation).toHaveBeenCalledOnce()
  expect(input.selectTeamMode).not.toHaveBeenCalled()
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

it.each([false, true])('enables directly regardless of model history (requested: %s)', async (requested) => {
  const input = props(false, undefined, undefined, requested)
  render(<TeamModeToggle {...input} />)
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(input.selectTeamMode).toHaveBeenCalledWith(true)
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
})

it('disables directly when a model is selected but no request has been recorded', async () => {
  const input = props(true)
  render(<TeamModeToggle {...input} />)
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(input.selectTeamMode).toHaveBeenCalledWith(false)
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
})

it('waits for model history before allowing the switch to change', () => {
  const input = props(true, undefined, undefined, 'loading')
  render(<TeamModeToggle {...input} />)
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('switch'))
  expect(input.selectTeamMode).not.toHaveBeenCalled()
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
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
