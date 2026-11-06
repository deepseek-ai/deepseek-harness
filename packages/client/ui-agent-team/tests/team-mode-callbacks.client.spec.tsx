// @vitest-environment jsdom

import { isValidElement, type ComponentProps, type FunctionComponent } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamModePage, TeamModeToggle, type TeamModePageProps, type TeamModeToggleProps } from '../src/client/TeamModeToggle.tsx'
import { zh } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return {
    ...actual,
    // Deliver callbacks even when the native control would suppress activation.
    Switch: (props: ComponentProps<typeof Switch>) => (
      <button type="button" role="switch" aria-label={props.label} aria-checked={props.checked}
        aria-disabled={props.disabled} onClick={() => { props.onChange(!props.checked) }} />
    ),
  }
})

afterEach(cleanup)

type TestProps = TeamModePageProps & TeamModeToggleProps

function props(locked = false, loading = false): TestProps {
  return {
    sessionId: SessionId('root'),
    useSession: (select: (value: { subagent: null }) => unknown) => select({ subagent: null }),
    useSessions: (select: (value: { byId: object }) => unknown) => select({ byId: {} }),
    useProjection: (key: string) => key === 'modelSelection'
      ? loading ? undefined : { lastUsed: null, next: { provider: 'mock', model: 'mock' } }
      : { enabled: false, tasks: [] },
    locked, openPage: vi.fn(), dismiss: vi.fn(), reportFailure: vi.fn(),
    selectTeamMode: vi.fn(async () => null), requestDisableConfirmation: vi.fn(),
    t: makeTranslate(zh),
  } as TestProps
}

it('does not navigate when a locked summary callback is delivered', () => {
  const input = props(true)
  const root = TeamModeToggle(input)
  if (!isValidElement<TeamModeToggleProps>(root) || typeof root.type !== 'function') throw new Error('Expected the root summary component')
  // The summary is a pure component; invoke its callback without native disabled-button filtering.
  const summary = (root.type as FunctionComponent<TeamModeToggleProps>)(root.props)
  if (!isValidElement<{ disabled: boolean; onClick: () => void }>(summary)) throw new Error('Expected the summary button')
  expect(summary.props.disabled).toBe(true)
  summary.props.onClick()
  expect(input.openPage).not.toHaveBeenCalled()
  expect(input.selectTeamMode).not.toHaveBeenCalled()
})

it.each([
  { name: 'locked', locked: true, loading: false },
  { name: 'model history loading', locked: false, loading: true },
])('does not save when a settings callback is delivered while $name', ({ locked, loading }) => {
  const input = props(locked, loading)
  render(<TeamModePage {...input} />)
  const toggle = screen.getByRole('switch')
  expect(toggle.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(toggle)
  expect(input.selectTeamMode).not.toHaveBeenCalled()
  expect(input.requestDisableConfirmation).not.toHaveBeenCalled()
  expect(input.dismiss).not.toHaveBeenCalled()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
})

it('keeps one pending save when the settings callback is delivered repeatedly', async () => {
  const pending = Promise.withResolvers<string | null>()
  onTestFinished(async () => { await act(async () => { pending.resolve(null) }) })
  const input = props()
  const selectTeamMode = vi.fn(() => pending.promise)
  render(<TeamModePage {...input} selectTeamMode={selectTeamMode} />)
  const toggle = screen.getByRole('switch')
  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(toggle)
  expect(selectTeamMode).toHaveBeenCalledExactlyOnceWith(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  await act(async () => { pending.resolve(null) })
  expect(toggle.getAttribute('aria-disabled')).toBe('false')
  expect(input.reportFailure).not.toHaveBeenCalled()
})
