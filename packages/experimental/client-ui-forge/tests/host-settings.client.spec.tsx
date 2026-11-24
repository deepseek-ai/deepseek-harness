// @vitest-environment jsdom
/** A provider row's host page: the list with each host's sign-in state, staged additions and removals, and one save. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { HostSettings, type HostForge, type HostSettingsProps } from '../src/client/HostSettings.tsx'
import { HostSettingsForm, type HostSettings as HostSettingsFields } from '../src/client/host-settings-form.ts'
import type { HostSignIn } from '../src/client/host-sign-in.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const COMMAND = 'glab auth login --hostname gitlab.example.com'

interface MountOptions {
  readonly forge?: HostForge
  readonly view?: 'page' | 'summary'
  readonly hosts?: string[]
  readonly taken?: readonly string[]
  readonly writable?: boolean
  readonly signIn?: readonly (readonly [string, HostSignIn])[]
  /** Leave the row's form unserved. */
  readonly unserved?: boolean
}

/** Render the page of a row that serves `hosts` over a real staged form, with the sign-in states and every face call recorded. */
function mount(options: MountOptions = {}) {
  const scope = stubConfigForm<HostSettingsFields>()
  const hosts = options.hosts ?? ['gitlab.com']
  if (options.unserved !== true) {
    scope.publish({ status: 'ready', value: { hosts }, base: { hosts: ['gitlab.com'] }, user: {}, writable: options.writable ?? true, revision: 2 })
  }
  const form = new HostSettingsForm(scope.scope, () => options.taken ?? [])
  const { hooks, ...actions } = form.inject()
  const signIn = createSnapshotStore<ReadonlyMap<string, HostSignIn>>(new Map(options.signIn ?? []))
  const checkSignIn = vi.fn<HostSettingsProps['checkSignIn']>()
  const copyCommand = vi.fn<HostSettingsProps['copyCommand']>()
  const props = {
    view: options.view ?? 'page', forge: options.forge ?? 'gitlab', ...actions,
    add: vi.fn(actions.add), remove: vi.fn(actions.remove), save: vi.fn(actions.save), discard: vi.fn(actions.discard),
    useHostForm: bindSnapshotSelector(hooks.hostForm), useSignIn: bindSnapshotSelector(signIn), checkSignIn, copyCommand, t,
  } as HostSettingsProps
  const view = render(<HostSettings {...props} />)
  const row = (host: string): HTMLElement => {
    const element = view.container.querySelector(`[data-forge-host="${host}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`no row for ${host}`)
    return element
  }
  const input = (): HTMLInputElement => {
    const element = view.getByRole('textbox', { name: 'Host to add' })
    if (!(element instanceof HTMLInputElement)) throw new Error('no field for the host to add')
    return element
  }
  const type = (text: string): void => { fireEvent.change(input(), { target: { value: text } }) }
  return { view, scope, form, props, signIn, checkSignIn, copyCommand, row, input, type }
}

describe('HostSettings', () => {
  it('names the list in the summary view without reading sign-in state', () => {
    const m = mount({ view: 'summary' })
    try {
      expect(m.view.container.textContent).toBe('Hosts')
      expect(m.checkSignIn).not.toHaveBeenCalled()
    } finally { m.form.dispose() }
  })

  it('says the settings are unavailable while the Host does not serve the row, and reads no sign-in state', () => {
    const m = mount({ unserved: true })
    try {
      expect(m.view.getByRole('status').textContent).toBe('Host settings are unavailable.')
      expect(m.view.queryByRole('list')).toBeNull()
      expect(m.checkSignIn).not.toHaveBeenCalled()
    } finally { m.form.dispose() }
  })

  it('lists each saved host with its sign-in state, the command to copy, or why it could not be checked', () => {
    const m = mount({
      hosts: ['gitlab.com', 'gitlab.example.com', 'quiet.example.com', 'down.example.com', 'silent.example.com', 'new.example.com'],
      signIn: [
        ['gitlab.com', { state: 'ready', message: null, signIn: null }],
        ['gitlab.example.com', { state: 'unauthenticated', message: 'not signed in', signIn: { command: COMMAND } }],
        ['quiet.example.com', { state: 'unauthenticated', message: 'the token expired', signIn: null }],
        ['down.example.com', { state: 'unavailable', message: 'glab: connection timed out', signIn: null }],
        ['silent.example.com', { state: 'unavailable', message: '', signIn: null }],
      ],
    })
    try {
      expect(within(m.view.getByRole('list', { name: 'Hosts' })).getAllByRole('listitem')).toHaveLength(6)
      expect(m.row('gitlab.com').textContent).toBe('gitlab.comSigned in')
      expect(m.row('gitlab.com').querySelector('[data-state="ready"] [data-state="done"]')).not.toBeNull()
      expect(m.row('gitlab.example.com').textContent).toBe(`gitlab.example.comNot signed in${COMMAND}Copy`)
      expect(m.row('quiet.example.com').textContent).toBe('quiet.example.comNot signed inthe token expired')
      expect(m.row('down.example.com').textContent).toBe('down.example.comCan\'t checkglab: connection timed out')
      expect(m.row('silent.example.com').textContent).toBe('silent.example.comCan\'t check')
      expect(m.row('new.example.com').textContent).toBe('new.example.comChecking…')

      fireEvent.click(within(m.row('gitlab.example.com')).getByRole('button', { name: 'Copy sign-in command' }))
      expect(m.copyCommand).toHaveBeenCalledWith(COMMAND)
    } finally { m.form.dispose() }
  })

  it('reads sign-in state when shown, when the window regains focus, and after the saved hosts change, until it is left', () => {
    const m = mount()
    try {
      expect(m.checkSignIn.mock.calls).toEqual([[['gitlab.com'], false]])
      fireEvent.focus(window)
      expect(m.checkSignIn).toHaveBeenCalledTimes(2)

      act(() => { m.signIn.set(new Map([['gitlab.com', { state: 'ready', message: null, signIn: null }]])) })
      expect(m.row('gitlab.com').textContent).toBe('gitlab.comSigned in')
      expect(m.checkSignIn).toHaveBeenCalledTimes(2)
      act(() => { m.scope.publish({ value: { hosts: ['gitlab.com', 'gitlab.example.com'] } }) })
      expect(m.checkSignIn).toHaveBeenLastCalledWith(['gitlab.com', 'gitlab.example.com'], false)
      expect(m.checkSignIn).toHaveBeenCalledTimes(3)

      fireEvent.click(m.view.getByRole('button', { name: 'Check sign-in again' }))
      expect(m.checkSignIn).toHaveBeenLastCalledWith(['gitlab.com', 'gitlab.example.com'], true)

      m.view.unmount()
      fireEvent.focus(window)
      expect(m.checkSignIn).toHaveBeenCalledTimes(4)
      expect(m.props.discard).toHaveBeenCalledOnce()
    } finally { m.form.dispose() }
  })

  it('stages a typed host from the Add button or Enter, marks it as not saved, and writes the list on save', async () => {
    const m = mount()
    try {
      const add = m.view.getByRole('button', { name: 'Add' })
      expect(add).toHaveProperty('disabled', true)
      expect(m.input().placeholder).toBe('gitlab.example.com')
      expect(m.view.getByText('MR links and Git remotes on these hosts are recognized. After adding a host, sign in to it with glab in a terminal.')).toBeTruthy()

      m.type('https://gitlab.example.com/group/app/-/merge_requests/2')
      fireEvent.click(add)
      expect(m.input().value).toBe('')
      expect(m.row('gitlab.example.com').textContent).toBe('gitlab.example.comNot saved')

      m.type('git.corp.example')
      fireEvent.keyDown(m.input(), { key: 'a' })
      fireEvent.keyDown(m.input(), { key: 'Enter', isComposing: true })
      expect(m.props.add).toHaveBeenCalledOnce()
      fireEvent.keyDown(m.input(), { key: 'Enter' })
      expect(m.row('git.corp.example').textContent).toBe('git.corp.exampleNot saved')

      fireEvent.click(m.view.getByRole('button', { name: 'Save' }))
      await vi.waitFor(() => {
        expect(m.scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['hosts'], value: ['gitlab.com', 'gitlab.example.com', 'git.corp.example'] }], 2)
      })
    } finally { m.form.dispose() }
  })

  it.each([
    ['gitlab', 'a b', 'Enter a host name such as gitlab.example.com'],
    ['gitlab', 'GitLab.com', 'gitlab.com is already in the list'],
    ['gitlab', 'github.com', 'The GitHub component already uses github.com'],
    ['github', 'github.com', 'The GitLab component already uses github.com'],
  ] as const)('on the %s page, refuses %j below the field until the text changes', (forge, text, message) => {
    const m = mount({ forge, taken: ['github.com'] })
    try {
      m.type(text)
      fireEvent.click(m.view.getByRole('button', { name: 'Add' }))

      expect(m.view.getByRole('alert').textContent).toBe(message)
      expect(m.input().getAttribute('aria-invalid')).toBe('true')
      expect(m.input().getAttribute('aria-describedby')).toBe(m.view.getByRole('alert').id)
      expect(m.input().value).toBe(text)

      m.type(`${text}x`)
      expect(m.view.queryByRole('alert')).toBeNull()
      expect(m.input().getAttribute('aria-invalid')).toBeNull()
    } finally { m.form.dispose() }
  })

  it('names pull requests and gh on the GitHub page', () => {
    const m = mount({ forge: 'github', hosts: ['github.com'] })
    try {
      expect(m.input().placeholder).toBe('github.example.com')
      expect(m.view.getByText('PR links and Git remotes on these hosts are recognized. After adding a host, sign in to it with gh in a terminal.')).toBeTruthy()
    } finally { m.form.dispose() }
  })

  it('removes a host from the staged list, but not the last one', () => {
    const m = mount({ hosts: ['gitlab.com', 'gitlab.example.com'] })
    try {
      const remove = (host: string): HTMLElement => within(m.row(host)).getByRole('button', { name: `Remove ${host}` })
      expect(remove('gitlab.com').getAttribute('aria-disabled')).toBeNull()

      fireEvent.click(remove('gitlab.com'))
      expect(m.props.remove).toHaveBeenCalledWith('gitlab.com')
      expect(m.view.container.querySelector('[data-forge-host="gitlab.com"]')).toBeNull()

      expect(remove('gitlab.example.com').getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(remove('gitlab.example.com'))
      expect(m.props.remove).toHaveBeenCalledOnce()
      expect(m.row('gitlab.example.com')).toBeTruthy()
    } finally { m.form.dispose() }
  })

  it('disables every edit while the document is read-only', () => {
    const m = mount({ hosts: ['gitlab.com', 'gitlab.example.com'], writable: false })
    try {
      expect(m.view.getByText('This deployment stores settings read-only.')).toBeTruthy()
      expect(m.input()).toHaveProperty('disabled', true)
      expect(m.view.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true)
      expect(within(m.row('gitlab.com')).getByRole('button', { name: 'Remove gitlab.com' })).toHaveProperty('disabled', true)
      expect(m.view.getByRole('button', { name: 'Check sign-in again' })).toHaveProperty('disabled', false)
    } finally { m.form.dispose() }
  })
})
