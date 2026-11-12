// @vitest-environment jsdom

import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamModePane, TeamModeToggle, type TeamModePaneProps, type TeamModeToggleProps } from '../src/client/TeamModeToggle.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

afterEach(cleanup)

type TestProps = TeamModePaneProps & TeamModeToggleProps

function props(enabled: boolean | undefined, selectTeamMode = vi.fn(async () => null as string | null), child?: 'addressed' | 'listed', requestedModel: boolean | 'loading' = false): TestProps {
  return {
    sessionId: brandString<SessionId>('root'),
    useSession: (select: (value: { subagent: object | null }) => unknown) => select({ subagent: child === 'addressed' ? {} : null }),
    useSessions: (select: (value: { byId: object }) => unknown) => select({ byId: child === 'listed' ? { root: { origin: 'subagent' } } : {} }),
    useProjection: (key: string) => key === 'modelSelection'
      ? requestedModel === 'loading' ? undefined : { lastUsed: requestedModel ? { provider: 'mock', model: 'mock' } : null, next: { provider: 'mock', model: 'mock' } }
      : enabled === undefined ? undefined : { enabled, tasks: [] },
    locked: false, openPane: vi.fn(), dismiss: vi.fn(), reportFailure: vi.fn(),
    selectTeamMode, requestDisableConfirmation: vi.fn(),
    t: makeTranslate(zh),
  } as TestProps
}

it.each(Object.entries({ zh, en, ja, es, fr, de, ru, pt }).flatMap(([locale, dictionary]) =>
  [false, true].map(enabled => ({ locale, dictionary, enabled })),
))('opens Team settings from the $locale summary without changing mode (enabled: $enabled)', ({ locale, dictionary, enabled }) => {
  const input = props(enabled)
  render(<TeamModeToggle {...input} t={makeTranslate(dictionary)} />)
  const summary = screen.getByRole('menuitem', { name: new RegExp(dictionary['command.title']) })
  expect(summary.textContent).toBe(dictionary['command.title'] + dictionary[enabled ? 'mode.on' : 'mode.off'])
  if (locale === 'zh') expect(summary.textContent).toBe(`智能体团队协作${enabled ? '开启' : '关闭'}`)
  expect(summary.getAttribute('data-model-menu-pane')).toBe('agent-team')
  expect(screen.queryByRole('switch')).toBeNull()
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  expect(screen.queryByText(dictionary['mode.description'])).toBeNull()
  fireEvent.click(summary)
  expect(input.openPane).toHaveBeenCalledExactlyOnceWith({ key: 'agent-team', title: dictionary['command.title'] })
  expect(input.selectTeamMode).not.toHaveBeenCalled()
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
  expect(input.dismiss).not.toHaveBeenCalled()
})

it('keeps summary state projection-owned and blocks navigation while locked', () => {
  const input = props(false)
  const view = render(<TeamModeToggle {...input} />)
  expect(screen.getByText('关闭')).toBeTruthy()
  const lockedInput = props(true)
  view.rerender(<TeamModeToggle {...lockedInput} locked />)
  expect(screen.getByText('开启')).toBeTruthy()
  const summary = screen.getByRole('menuitem')
  expect(summary.hasAttribute('disabled')).toBe(true)
  fireEvent.click(summary)
  expect(lockedInput.openPane).not.toHaveBeenCalled()
})

it('allows reading settings from the summary while model history loads', () => {
  const input = props(false, undefined, undefined, 'loading')
  render(<TeamModeToggle {...input} />)
  fireEvent.click(screen.getByRole('menuitem'))
  expect(input.openPane).toHaveBeenCalledOnce()
  expect(input.selectTeamMode).not.toHaveBeenCalled()
})

it.each([false, true])('blocks repeated writes while waiting for persisted mode (enabled: %s)', async (enabled) => {
  const pending = Promise.withResolvers<string | null>()
  onTestFinished(async () => { await act(async () => { pending.resolve(null) }) })
  const select = vi.fn(() => pending.promise)
  const view = render(<TeamModePane {...props(enabled, select)} />)
  const toggle = screen.getByRole('switch', { name: '开启智能体团队协作' })
  toggle.focus()
  fireEvent.click(toggle)
  expect(select).toHaveBeenCalledExactlyOnceWith(!enabled)
  expect(toggle.getAttribute('aria-checked')).toBe(String(enabled))
  expect(toggle.hasAttribute('disabled')).toBe(true)
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(select).toHaveBeenCalledTimes(1)
  await act(async () => { pending.resolve(null) })
  expect(toggle.getAttribute('aria-checked')).toBe(String(enabled))
  expect(toggle.hasAttribute('disabled')).toBe(false)
  view.rerender(<TeamModePane {...props(!enabled, select)} />)
  expect(toggle.getAttribute('aria-checked')).toBe(String(!enabled))
})

it.each(['returned', 'error', 'string'])('reports rejected mode writes through the menu host (%s)', async (failure) => {
  const input = props(false, vi.fn(async () => {
    if (failure === 'error') throw new Error('offline')
    if (failure === 'string') throw 'offline'
    return 'offline'
  }))
  render(<TeamModePane {...input} />)
  const toggle = screen.getByRole('switch')
  toggle.focus()
  await act(async () => { fireEvent.click(toggle) })
  expect(input.reportFailure).toHaveBeenCalledWith(expect.stringContaining('offline'))
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false)
})

it.each(Object.entries({ zh, en, ja, es, fr, de, ru, pt }).flatMap(([locale, dictionary]) =>
  [false, true].map(locked => ({ locale, dictionary, locked })),
))('shows the full $locale explanation in the settings pane (locked: $locked)', ({ dictionary, locked }) => {
  const input = props(false)
  render(<TeamModePane {...input} locked={locked} t={makeTranslate(dictionary)} />)
  const description = screen.getByText(dictionary['mode.description'], { exact: true })
  expect(description.tagName).toBe('P')
  expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  const toggle = screen.getByRole('switch', { name: dictionary['mode.label'], description: dictionary['mode.description'] })
  expect(document.activeElement === toggle).toBe(!locked)
  expect(toggle.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(toggle.hasAttribute('disabled')).toBe(locked)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(input.selectTeamMode).not.toHaveBeenCalled()
})

it('dismisses the menu before requesting disable confirmation after a recorded model request', () => {
  const input = props(true, undefined, undefined, true)
  render(<TeamModePane {...input} />)
  fireEvent.click(screen.getByRole('switch'))
  expect(input.dismiss).toHaveBeenCalledOnce()
  expect(input.dismiss).toHaveBeenCalledBefore(vi.mocked(input.requestDisableConfirmation))
  expect(input.requestDisableConfirmation).toHaveBeenCalledOnce()
  expect(input.selectTeamMode).not.toHaveBeenCalled()
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})

it.each([false, true])('enables directly regardless of model history (requested: %s)', async (requested) => {
  const input = props(false, undefined, undefined, requested)
  render(<TeamModePane {...input} />)
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(input.selectTeamMode).toHaveBeenCalledWith(true)
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
  expect(input.dismiss).not.toHaveBeenCalled()
})

it('disables directly when a model is selected but no request has been recorded', async () => {
  const input = props(true)
  render(<TeamModePane {...input} />)
  await act(async () => { fireEvent.click(screen.getByRole('switch')) })
  expect(input.selectTeamMode).toHaveBeenCalledWith(false)
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
  expect(input.dismiss).not.toHaveBeenCalled()
})

it('waits for model history before allowing the settings switch to change', () => {
  const input = props(true, undefined, undefined, 'loading')
  render(<TeamModePane {...input} />)
  expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('switch'))
  expect(input.selectTeamMode).not.toHaveBeenCalled()
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
})

it.each([
  { name: 'summary', Component: TeamModeToggle },
  { name: 'settings pane', Component: TeamModePane },
])('hides the $name until the Team projection is available', ({ Component }) => {
  const { container } = render(<Component {...props(undefined)} />)
  expect(container.textContent).toBe('')
  expect(screen.queryByRole('menuitem')).toBeNull()
  expect(screen.queryByRole('switch')).toBeNull()
})

it.each([
  { name: 'summary', Component: TeamModeToggle },
  { name: 'settings pane', Component: TeamModePane },
].flatMap(entry => (['addressed', 'listed'] as const).map(child => ({ ...entry, child }))))(
  'hides the $name on a $child child Session', ({ Component, child }) => {
    const input = props(false, undefined, child)
    const useProjection = vi.fn((): never => { throw new Error('Child must not read Team mode') })
    const { container } = render(<Component {...input} useProjection={useProjection} />)
    expect(container.textContent).toBe('')
    expect(useProjection).not.toHaveBeenCalled()
    expect(input.selectTeamMode).not.toHaveBeenCalled()
    expect(input.openPane).not.toHaveBeenCalled()
  },
)
