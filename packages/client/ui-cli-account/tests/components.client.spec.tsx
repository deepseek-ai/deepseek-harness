// @vitest-environment jsdom
/** The section, tag, activation prompt, confirmation, and notice render a plugin's display with the copy it translates. */
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CliAccountActivation, CliAccountActivationEntry, CliAccountBadge, CliAccountBadgeEntry, CliAccountSection, CliAccountSectionEntry,
  CliAccountToast, CliAccountToastEntry, type CliAccountBadgeSubject, type CliAccountSectionProps,
} from '../src/client/components.tsx'
import type {
  AnyCliAccountView, CliAccountDisplay, CliAccountKey, CliAccountPage, CliAccountPhase, CliAccountSnapshot,
} from '../src/client/types.ts'

afterEach(cleanup)

const PACKAGE = '@acme/fixture'

const copy: Record<CliAccountKey, string> = {
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
  'notice.action-failed': 'Try again',
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
}
const t = makeTranslate(copy)
const button = (name: string) => screen.getByRole('button', { name })

function section(props: Partial<CliAccountSectionProps> = {}) {
  return <CliAccountSection t={t} packageName={PACKAGE} phase="disconnected" busy={false} linked {...props} />
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

it('renders the plugin buttons, detail, and notes, and disables buttons while acting or offline', () => {
  const connect = vi.fn()
  const replace = vi.fn()
  const props: Partial<CliAccountSectionProps> = {
    actions: [{ label: 'Link', onClick: connect, variant: 'primary' }, { label: 'Retry', onClick: vi.fn() }],
    detail: 'Link an app first.',
    notes: [{ text: 'App: cli_a', action: { label: 'Change', onClick: replace, variant: 'ghost' } }, { text: 'Plain note' }],
  }
  const { rerender } = render(section(props))
  expect(screen.getByText('Link an app first.')).toBeTruthy()
  expect(screen.getByText('Plain note')).toBeTruthy()
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

it('asks before an action that changes the account outside DSH and runs it only after the user accepts', () => {
  const signOut = vi.fn()
  const replace = vi.fn()
  render(section({
    phase: 'connected',
    actions: [{ label: 'Sign out', onClick: signOut, confirm: { title: 'Sign out?', body: 'This signs out the terminal too.', label: 'Sign out now' } }],
    notes: [{ text: 'App: cli_a', action: { label: 'Change', onClick: replace, confirm: { title: 'Change app?', body: 'Link another app.', label: 'Change app' } } }],
  }))
  fireEvent.click(button('Sign out'))
  expect(screen.getByRole('dialog', { name: 'Sign out?' })).toBeTruthy()
  expect(screen.getByText('This signs out the terminal too.')).toBeTruthy()
  fireEvent.click(button('Cancel'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(signOut).not.toHaveBeenCalled()
  fireEvent.click(button('Sign out'))
  fireEvent.click(button('Sign out now'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(signOut).toHaveBeenCalledOnce()
  fireEvent.click(button('Change'))
  fireEvent.click(button('Change app'))
  expect(replace).toHaveBeenCalledOnce()
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

it('shows the latest notice with the plugin copy or the shared failure copy', () => {
  const onDone = vi.fn()
  const notices = { connect: () => 'Fixture connected' }
  const toast = (notice: Parameters<typeof CliAccountToast>[0]['notice']) =>
    <CliAccountToast t={t} notice={notice} notices={notices} onDone={onDone} />
  const { rerender } = render(toast(undefined))
  expect(document.body.textContent).toBe('')
  rerender(toast({ seq: 1, kind: 'succeeded', operation: 'connect' }))
  expect(screen.getByText('Fixture connected')).toBeTruthy()
  rerender(toast({ seq: 2, kind: 'action-failed' }))
  expect(screen.getByText('Try again')).toBeTruthy()
  rerender(toast({ seq: 3, kind: 'succeeded', operation: 'check' }))
  expect(document.body.textContent).toBe('')
})

function face(snapshot: Partial<CliAccountSnapshot<AnyCliAccountView>>, display: CliAccountDisplay) {
  const current: CliAccountSnapshot<AnyCliAccountView> = {
    view: undefined, linked: true, stopped: false, busy: false, notice: undefined, ...snapshot,
  }
  const page: CliAccountPage = { start: vi.fn(), cancel: vi.fn(), openAuthorization: vi.fn(), retry: vi.fn() }
  const present = vi.fn((_snapshot: CliAccountSnapshot<AnyCliAccountView>, _page: CliAccountPage) => display)
  return {
    useCliAccount: <R,>(selector: (value: CliAccountSnapshot<AnyCliAccountView>) => R): R => selector(current),
    packageName: PACKAGE, page, present, notices: { connect: () => 'Fixture connected' }, dismissNotice: vi.fn(), t,
  }
}

it('renders the section from the registration presenter with the page state', () => {
  const props = face({ busy: true }, { phase: 'connected', detail: 'Signed in as Ada.', actions: [{ label: 'Check', onClick: vi.fn() }] })
  render(<CliAccountSectionEntry {...props} />)
  expect(props.present).toHaveBeenCalledWith(expect.objectContaining({ busy: true }), props.page)
  expect(screen.getByText('Signed in as Ada.')).toBeTruthy()
  expect((button('Check') as HTMLButtonElement).disabled).toBe(true)
})

it('tags the bundle with the presenter phase', () => {
  const props = face({}, { phase: 'unavailable' })
  const subject = { kind: 'bundle', pkg: { name: PACKAGE, installed: true, availability: 'profile', official: false, enabled: true, rows: [] } } as const
  render(<CliAccountBadgeEntry {...{ ...props, subject } as ComponentProps<typeof CliAccountBadgeEntry>} />)
  expect(screen.getByText('Tag unavailable')).toBeTruthy()
})

it('connects from the prompt through the first primary action that asks nothing', () => {
  const ask = vi.fn()
  const connect = vi.fn()
  const onOpenDetails = vi.fn()
  const props = face({}, {
    phase: 'disconnected',
    actions: [
      { label: 'Retry', onClick: vi.fn() },
      { label: 'Reset', onClick: ask, variant: 'primary', confirm: { title: 'Reset?', body: 'Resets the CLI.', label: 'Reset' } },
      { label: 'Link app', onClick: connect, variant: 'primary' },
    ],
  })
  const prompt = (face: typeof props) =>
    <CliAccountActivationEntry {...{ ...face, onDismiss: vi.fn(), onOpenDetails } as ComponentProps<typeof CliAccountActivationEntry>} />
  const { rerender } = render(prompt(props))
  fireEvent.click(button('Connect'))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  expect(connect).toHaveBeenCalledOnce()
  expect(ask).not.toHaveBeenCalled()

  const bare = face({}, { phase: 'disconnected' })
  rerender(prompt(bare))
  fireEvent.click(button('Connect'))
  expect(onOpenDetails).toHaveBeenCalledTimes(2)
})

it('shows the registration notice', () => {
  const props = face({ notice: { seq: 1, kind: 'succeeded', operation: 'connect' } }, { phase: 'connected' })
  render(<CliAccountToastEntry {...props} />)
  expect(screen.getByText('Fixture connected')).toBeTruthy()
})
