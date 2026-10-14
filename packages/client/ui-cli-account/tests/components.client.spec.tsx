// @vitest-environment jsdom
/** The section, tag, activation prompt, confirmation, and notice render a plugin's display phase with the copy it translates. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CliAccountActivation, CliAccountBadge, CliAccountConfirm, CliAccountSection, CliAccountToast,
  type CliAccountBadgeSubject, type CliAccountKey, type CliAccountPhase, type CliAccountSectionProps,
} from '../src/index.ts'

afterEach(cleanup)

const PACKAGE = '@acme/fixture'

const copy: Record<CliAccountKey | 'notice.connected' | 'notice.action-failed', string> = {
  'section.title': 'Fixture account',
  hint: 'Shared with the terminal.',
  close: 'Close',
  'action.cancel': 'Cancel',
  'action.connect': 'Connect',
  'activation.title': 'Connect Fixture',
  'activation.body': 'The plugin is on.',
  'activation.later': 'Later',
  'failure.details': 'Diagnostic: {details}',
  'failure.exitCode': 'exit {code}',
  'badge.connecting': 'Tag connecting',
  'badge.connected': 'Tag connected',
  'badge.disconnected': 'Tag disconnected',
  'badge.unavailable': 'Tag unavailable',
  'badge.stopped': 'Tag stopped',
  'status.checking': 'Checking',
  'status.connected': 'Connected',
  'status.disconnected': 'Not connected',
  'status.unavailable': 'Cannot confirm',
  'status.stopped': 'Not running',
  'notice.connected': 'Fixture connected',
  'notice.action-failed': 'Try again',
}
const t = makeTranslate(copy)
const button = (name: string) => screen.getByRole('button', { name })

function section(props: Partial<CliAccountSectionProps> = {}) {
  return <CliAccountSection t={t} packageName={PACKAGE} phase="disconnected" busy={false} linked actions={[]} {...props} />
}

it('labels each phase from the shared copy unless the plugin passes a step', () => {
  const { container, rerender } = render(section())
  expect(screen.getByText('Fixture account')).toBeTruthy()
  expect(screen.getByText('Not connected')).toBeTruthy()
  expect(screen.getByText('Shared with the terminal.')).toBeTruthy()
  expect(container.querySelector('[data-cli-account="disconnected"][data-cli-account-package="@acme/fixture"]')).toBeTruthy()
  rerender(section({ phase: 'connecting' }))
  expect(screen.getByText('Checking')).toBeTruthy()
  rerender(section({ phase: 'connecting', status: 'Step 1' }))
  expect(screen.getByText('Step 1')).toBeTruthy()
})

it('renders the plugin buttons, detail, notes, and children, and disables buttons while acting or offline', () => {
  const connect = vi.fn()
  const replace = vi.fn()
  const props: Partial<CliAccountSectionProps> = {
    actions: [{ label: 'Link', onClick: connect, variant: 'primary' }, { label: 'Retry', onClick: vi.fn() }],
    detail: 'Link an app first.',
    notes: [{ text: 'App: cli_a', action: { label: 'Change', onClick: replace, variant: 'ghost' } }, { text: 'Plain note' }],
    children: <span>child</span>,
  }
  const { rerender } = render(section(props))
  expect(screen.getByText('Link an app first.')).toBeTruthy()
  expect(screen.getByText('Plain note')).toBeTruthy()
  expect(screen.getByText('child')).toBeTruthy()
  fireEvent.click(button('Link'))
  fireEvent.click(button('Change'))
  expect(connect).toHaveBeenCalledOnce()
  expect(replace).toHaveBeenCalledOnce()

  const disabled = (): boolean[] => screen.getAllByRole('button').map(element => (element as HTMLButtonElement).disabled)
  rerender(section({ ...props, busy: true }))
  expect(disabled()).toEqual([true, true, true])
  rerender(section({ ...props, linked: false }))
  expect(disabled()).toEqual([true, true, true])
  rerender(section({ ...props, linked: false, phase: 'stopped' }))
  expect(disabled()).toEqual([false, false, false])
})

it.each<[string, CliAccountSectionProps['failure'], string]>([
  ['the failed command, exit code, and plugin details', { text: 'Failed.', command: { command: 'login', exitCode: 3 }, details: ['internal', undefined, 'sdk_error'] }, 'Failed. Diagnostic: login · exit 3 · internal · sdk_error'],
  ['a command that produced no exit', { text: 'Failed.', command: { command: 'status', exitCode: null } }, 'Failed. Diagnostic: status'],
  ['a failure without a command', { text: 'Failed.', command: undefined }, 'Failed.'],
])('reports %s', (_name, failure, expected) => {
  render(section({ failure }))
  expect(screen.getByRole('alert').textContent).toBe(expected)
})

it('tags only the enabled bundle with a settled phase', () => {
  const pkg = (name: string, enabled = true) => ({ name, enabled })
  const badge = (subject: CliAccountBadgeSubject, phase: CliAccountPhase = 'connected') =>
    <CliAccountBadge t={t} subject={subject} packageName={PACKAGE} phase={phase} />
  const { rerender } = render(badge({ kind: 'bundle', pkg: pkg(PACKAGE) }))
  expect(screen.getByText('Tag connected')).toBeTruthy()
  rerender(badge({ kind: 'bundle', pkg: pkg(PACKAGE) }, 'unavailable'))
  expect(screen.getByText('Tag unavailable')).toBeTruthy()
  rerender(badge({ kind: 'row', pkg: pkg(PACKAGE) }))
  expect(screen.getByText('Tag connected')).toBeTruthy()
  const hidden: CliAccountBadgeSubject[] = [
    { kind: 'bundle', pkg: pkg(PACKAGE, false) },
    { kind: 'bundle', pkg: pkg('@acme/other') },
    { kind: 'item' },
  ]
  for (const subject of hidden) {
    rerender(badge(subject))
    expect(document.body.textContent).toBe('')
  }
  rerender(badge({ kind: 'bundle', pkg: pkg(PACKAGE) }, 'checking'))
  expect(document.body.textContent).toBe('')
})

it('prompts to connect only while disconnected and steps aside once the phase settles elsewhere', () => {
  const onDismiss = vi.fn()
  const onConnect = vi.fn()
  const prompt = (phase: CliAccountPhase) => <CliAccountActivation t={t} phase={phase} onDismiss={onDismiss} onConnect={onConnect} />
  const { rerender } = render(prompt('checking'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onDismiss).not.toHaveBeenCalled()
  rerender(prompt('disconnected'))
  expect(screen.getByRole('dialog', { name: 'Connect Fixture' })).toBeTruthy()
  expect(screen.getByText('The plugin is on.')).toBeTruthy()
  fireEvent.click(button('Connect'))
  expect(onConnect).toHaveBeenCalledOnce()
  fireEvent.click(button('Later'))
  expect(onDismiss).toHaveBeenCalledOnce()
  rerender(prompt('connected'))
  expect(onDismiss).toHaveBeenCalledTimes(2)
})

it('confirms an action only after the user accepts it', () => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()
  render(<CliAccountConfirm t={t} open title="Sign out?" body="This signs out the terminal too." confirm="Sign out" onClose={onClose} onConfirm={onConfirm} />)
  expect(screen.getByText('This signs out the terminal too.')).toBeTruthy()
  fireEvent.click(button('Cancel'))
  expect(onConfirm).not.toHaveBeenCalled()
  fireEvent.click(button('Sign out'))
  expect(onClose).toHaveBeenCalledTimes(2)
  expect(onConfirm).toHaveBeenCalledOnce()
})

it('shows the latest notice with the success or failure tone', () => {
  const onDone = vi.fn()
  const { rerender } = render(<CliAccountToast<'connected'> t={t} notice={undefined} onDone={onDone} />)
  expect(document.body.textContent).toBe('')
  rerender(<CliAccountToast<'connected'> t={t} notice={{ seq: 1, kind: 'connected' }} onDone={onDone} />)
  expect(screen.getByText('Fixture connected')).toBeTruthy()
  rerender(<CliAccountToast<'connected'> t={t} notice={{ seq: 2, kind: 'action-failed' }} onDone={onDone} />)
  expect(screen.getByText('Try again')).toBeTruthy()
})
