// @vitest-environment jsdom
/**
 * The custom servers section lists the MCP server rows, its page edits, tests, and removes one server, and its add
 * action asks for a new server's form.
 */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { AddServerAction, type AddServerActionProps } from '../src/client/AddServerAction.tsx'
import { CustomServersSection, type CustomServersSectionProps, type CustomServersView } from '../src/client/CustomServersSection.tsx'
import type { CustomServer, CustomServersState, ProbeState } from '../src/client/custom-servers-store.ts'
import { en, type ConnectorsLocaleKey } from '../src/client/locales.ts'
import { ServerDetail } from '../src/client/ServerDetail.tsx'
import { emptyDraft, type ServerDraft } from '../src/server-form.ts'
import type { CustomServerStatus } from '../src/types.ts'

afterEach(cleanup)

const t = ((key: ConnectorsLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replaceAll(`{${name}}`, value), en[key])) as CustomServersSectionProps['t']

const READY: CustomServersState = { status: 'ready', revision: 'r1', servers: [], saving: false, failure: undefined, probes: {} }
const DOCS: Readonly<Record<string, JsonValue>> = {
  serverName: 'docs', transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {}, oauth: { credentialKey: 'mcp-client/docs' },
  startupTimeoutMs: 5000,
}
const WIKI: Readonly<Record<string, JsonValue>> = { ...DOCS, serverName: 'wiki', oauth: { credentialKey: 'mcp-client/wiki' } }
const FILES: Readonly<Record<string, JsonValue>> = { serverName: 'files', transport: 'stdio', command: 'npx', args: [], env: {} }
const ON: CustomServerStatus = { state: 'on' }
const OFF: CustomServerStatus = { state: 'off' }
const REFUSED: CustomServerStatus = { state: 'failed', error: 'connection refused' }

const server = (name: string, raw: CustomServer['raw'], status: CustomServerStatus = ON, inherited = false): CustomServer =>
  ({ id: `mcp-server-${name}`, name, raw, inherited, ...status })

/** The Connectors tab's part: it owns the view and passes it with its change. */
function Tab({ input, initial }: { input: CustomServersSectionProps; initial: CustomServersView }) {
  const [view, setView] = useState<CustomServersView>(initial)
  return <CustomServersSection {...input} view={view} setView={setView} />
}

function renderSection(state: Partial<CustomServersState>, initial: CustomServersView = { kind: 'list' }) {
  const store = createSnapshotStore<CustomServersState>({ ...READY, ...state })
  const actions = {
    ensure: vi.fn(), retry: vi.fn(), save: vi.fn(async (_draft: ServerDraft, _id?: string) => true),
    remove: vi.fn(), setEnabled: vi.fn(), probe: vi.fn(), dismissFailure: vi.fn(),
  }
  const renderFactorySlot = vi.fn((_name: string, input: { account: string; presentation: 'section' | 'status' }) =>
    <div data-account={input.account} data-presentation={input.presentation} />)
  const input = {
    t, ...actions, renderFactorySlot, useCustomServers: bindSnapshotSelector(store), view: initial, setView: () => {},
  } as CustomServersSectionProps
  const view = render(<Tab input={input} initial={initial} />)
  const set = (next: Partial<CustomServersState>): void => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) }
  return { actions, renderFactorySlot, view, set }
}

const item = (name: string): HTMLElement => document.querySelector(`[data-custom-server="${name}"]`) as HTMLElement
const page = (): HTMLElement | null => document.querySelector('[data-custom-server-page]')
const openSettings = (name: string): void => {
  fireEvent.click(within(item(name)).getByRole('button', { name: t('custom.settingsLabel', { name }) }))
}
const risk = (): HTMLElement => screen.getByRole('dialog', { name: en['stdio.title'] })

describe('CustomServersSection', () => {
  it('asks for the servers once mounted and shows nothing while the profile cannot hold custom servers', () => {
    const { actions, view } = renderSection({ status: 'unavailable' })
    expect(actions.ensure).toHaveBeenCalledOnce()
    expect(view.container.innerHTML).toBe('')
  })

  it('reports a failed read with a retry, and an empty list once read', () => {
    const { actions, set } = renderSection({ status: 'error' })
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: en.retry }))
    expect(actions.retry).toHaveBeenCalledOnce()
    expect(screen.queryByText(en['custom.empty'])).toBeNull()
    set({ status: 'ready' })
    expect(screen.getByText(en['custom.empty'])).toBeTruthy()
  })

  it('lists each server with its target, why it did not start, the account status of an OAuth server that is on, its settings, and its switch', () => {
    const { actions, renderFactorySlot } = renderSection({
      servers: [
        server('docs', DOCS), server('files', FILES, OFF), server('odd', undefined),
        server('base', { serverName: 'base', transport: 'streamable-http', url: 5 }, ON, true),
        server('wiki', WIKI, REFUSED), server('late', { ...DOCS, serverName: 'late' }, OFF),
      ],
      probes: { docs: { status: 'passed', tools: 3, truncated: false } },
    })
    expect(within(item('docs')).getByText('https://docs.example/mcp')).toBeTruthy()
    expect(within(item('files')).getByText('npx')).toBeTruthy()
    expect(within(item('odd')).getByText(en['custom.unreadable'])).toBeTruthy()
    expect(within(item('wiki')).getByText(t('custom.failed', { message: 'connection refused' }))).toBeTruthy()
    expect(item('docs').textContent).toBe('docshttps://docs.example/mcp')
    expect(renderFactorySlot.mock.calls).toEqual([['connector.account', { account: 'mcp:docs', presentation: 'status' }]])
    expect(item('docs').querySelector('[data-account="mcp:docs"]')).not.toBeNull()
    expect(within(item('docs')).queryByRole('button', { name: en['custom.probe'] })).toBeNull()
    expect(within(item('docs')).queryByRole('button', { name: en['custom.remove'] })).toBeNull()

    expect(within(item('odd')).getByRole('button', { name: t('custom.settingsLabel', { name: 'odd' }) })).toHaveProperty('disabled', true)
    expect(within(item('odd')).getByRole('switch')).toHaveProperty('disabled', true)
    // The settings button is an icon; keyboard focus shows its name.
    const settings = within(item('docs')).getByRole('button', { name: t('custom.settingsLabel', { name: 'docs' }) })
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(settings)
    expect(screen.getByRole('tooltip').textContent).toBe(en['custom.settings'])
    fireEvent.blur(settings)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(within(item('files')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(within(item('wiki')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(item('docs')).getByRole('switch', { name: t('custom.enableLabel', { name: 'docs' }) }))
    expect(actions.setEnabled).toHaveBeenCalledWith('mcp-server-docs', false)
  })

  it('switches a remote server on and any server off at once, and a local command on only after its risk confirmation', () => {
    const { actions } = renderSection({
      servers: [server('files', FILES, OFF), server('wiki', WIKI, OFF), server('tools', { ...FILES, serverName: 'tools' })],
    })
    fireEvent.click(within(item('wiki')).getByRole('switch'))
    expect(actions.setEnabled).toHaveBeenLastCalledWith('mcp-server-wiki', true)
    fireEvent.click(within(item('tools')).getByRole('switch'))
    expect(actions.setEnabled).toHaveBeenLastCalledWith('mcp-server-tools', false)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(within(item('files')).getByRole('switch'))
    expect(within(risk()).getByText(t('stdio.enableBody', { command: 'npx' }))).toBeTruthy()
    expect(within(risk()).getByRole('button', { name: en['stdio.enableConfirm'] })).toHaveProperty('disabled', true)
    fireEvent.click(within(risk()).getByRole('checkbox', { name: en['stdio.acknowledge'] }))
    fireEvent.click(within(risk()).getByRole('button', { name: en['form.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.setEnabled).toHaveBeenCalledTimes(2)

    fireEvent.click(within(item('files')).getByRole('switch'))
    expect(within(risk()).getByRole('button', { name: en['stdio.enableConfirm'] })).toHaveProperty('disabled', true)
    fireEvent.click(within(risk()).getByRole('checkbox', { name: en['stdio.acknowledge'] }))
    fireEvent.click(within(risk()).getByRole('button', { name: en['stdio.enableConfirm'] }))
    expect(actions.setEnabled).toHaveBeenLastCalledWith('mcp-server-files', true)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a conflicting or refused change until it is dismissed', () => {
    const { actions, set } = renderSection({ failure: { kind: 'conflict', message: 'stale' } })
    expect(screen.getByRole('alert').textContent).toContain(en['custom.conflict'])
    set({ failure: { kind: 'refused', message: 'the server row is gone' } })
    expect(screen.getByRole('alert').textContent).toContain(t('custom.refused', { message: 'the server row is gone' }))
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: en.close }))
    expect(actions.dismissFailure).toHaveBeenCalledOnce()
  })

  it('adds a server on the page of a new server, which stays open until the save succeeds and offers no test or removal', async () => {
    const { actions } = renderSection({ servers: [server('docs', DOCS)] }, { kind: 'new' })
    const added = page()!
    expect(within(added).getByRole('heading', { name: en['form.addTitle'] })).toBeTruthy()
    expect(document.querySelector('[data-custom-server]')).toBeNull()
    expect(within(added).queryByRole('button', { name: en['custom.probe'] })).toBeNull()
    expect(within(added).queryByRole('button', { name: en['custom.remove'] })).toBeNull()
    fireEvent.change(within(added).getByRole('textbox', { name: en['form.name'] }), { target: { value: 'docs' } })
    fireEvent.change(within(added).getByRole('textbox', { name: en['form.url'] }), { target: { value: 'https://wiki.example/mcp' } })
    fireEvent.click(within(added).getByRole('button', { name: en['form.save'] }))
    expect(within(added).getByRole('alert').textContent).toBe(en['problem.name-taken'])
    expect(actions.save).not.toHaveBeenCalled()

    fireEvent.change(within(added).getByRole('textbox', { name: en['form.name'] }), { target: { value: 'wiki' } })
    actions.save.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(within(added).getByRole('button', { name: en['form.save'] })) })
    expect(actions.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'wiki', transport: 'streamable-http', url: 'https://wiki.example/mcp', auth: 'none' }), undefined,
    )
    expect(page()).not.toBeNull()
    await act(async () => { fireEvent.click(within(added).getByRole('button', { name: en['form.save'] })) })
    expect(page()).toBeNull()
    expect(item('docs')).not.toBeNull()
  })

  it('edits a server on its page with its account section and saves the form\'s draft under the row\'s id', async () => {
    const { actions, renderFactorySlot } = renderSection({ servers: [server('docs', DOCS), server('wiki', WIKI)] })
    openSettings('docs')
    const edited = page()!
    expect(within(edited).getByRole('heading', { name: t('form.editTitle', { name: 'docs' }) })).toBeTruthy()
    expect(renderFactorySlot).toHaveBeenLastCalledWith('connector.account', { account: 'mcp:docs', presentation: 'section' })
    expect(edited.querySelector('[data-presentation="section"]')).not.toBeNull()
    expect(within(edited).getByRole('textbox', { name: en['form.name'] })).toHaveProperty('disabled', true)
    expect(within(edited).getByRole('tab', { name: en['form.authOAuth'] }).getAttribute('aria-selected')).toBe('true')
    await act(async () => { fireEvent.click(within(edited).getByRole('button', { name: en['form.save'] })) })
    expect(actions.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'docs', url: 'https://docs.example/mcp', auth: 'oauth' }), 'mcp-server-docs',
    )
    expect(page()).toBeNull()
  })

  it('tests a server that is on from its page and shows the latest result', () => {
    const { actions, set } = renderSection({ servers: [server('files', FILES)], probes: { files: { status: 'running' } } })
    openSettings('files')
    const files = page()!
    expect(within(files).getByText(en['custom.probing'])).toBeTruthy()
    expect(within(files).getByRole('button', { name: en['custom.probe'] })).toHaveProperty('disabled', true)
    expect(files.querySelector('[data-account]')).toBeNull()
    set({ probes: { files: { status: 'failed', message: 'refused' } } })
    expect(within(files).getByText(t('custom.probeFailed', { message: 'refused' }))).toBeTruthy()
    fireEvent.click(within(files).getByRole('button', { name: en['custom.probe'] }))
    expect(actions.probe).toHaveBeenCalledWith('files')
  })

  it.each([
    ['is switched off', OFF],
    ['did not start', REFUSED],
  ])('offers no account, test, or earlier result on the page of a server that %s', (_case, status) => {
    const { renderFactorySlot } = renderSection(
      { servers: [server('docs', DOCS, status)], probes: { docs: { status: 'passed', tools: 3, truncated: false } } },
      { kind: 'server', id: 'mcp-server-docs' },
    )
    const stopped = page()!
    expect(renderFactorySlot).not.toHaveBeenCalled()
    expect(stopped.querySelector('[data-account]')).toBeNull()
    expect(within(stopped).queryByRole('button', { name: en['custom.probe'] })).toBeNull()
    expect(within(stopped).queryByText(t('custom.probePassed', { count: '3' }))).toBeNull()
    expect(within(stopped).queryByText(t('custom.failed', { message: 'connection refused' })) !== null).toBe(status.state === 'failed')
    expect(within(stopped).getByRole('button', { name: en['custom.remove'] })).toBeTruthy()
  })

  it('removes a server from its page only after its confirmation, then returns to the list', () => {
    renderSection({ servers: [server('files', FILES), server('base', DOCS, ON, true)] })
    openSettings('base')
    expect(within(page()!).queryByRole('button', { name: en['custom.remove'] })).toBeNull()
    cleanup()
    const { actions } = renderSection({ servers: [server('files', FILES)] }, { kind: 'server', id: 'mcp-server-files' })
    const removal = (): HTMLElement => within(page()!).getByRole('button', { name: en['custom.remove'] })
    fireEvent.click(removal())
    const confirm = screen.getByRole('dialog', { name: t('custom.removeTitle', { name: 'files' }) })
    expect(within(confirm).getByText(en['custom.removeBody'])).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: en['form.cancel'] }))
    expect(actions.remove).not.toHaveBeenCalled()
    fireEvent.click(removal())
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['custom.remove'] }))
    expect(actions.remove).toHaveBeenCalledWith('mcp-server-files')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(page()).toBeNull()
  })

  it('waits for a list before a named page, and says in the page\'s place that its server is gone or that the form cannot read it', () => {
    const { set } = renderSection({ status: 'loading' }, { kind: 'server', id: 'mcp-server-docs' })
    expect(page()).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    set({ status: 'ready', servers: [server('docs', DOCS)] })
    expect(page()).not.toBeNull()
    set({ servers: [server('docs', undefined)] })
    expect(page()).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(en['custom.gone'])
    expect(document.querySelector('[data-custom-server]')).toBeNull()
    set({ servers: [server('docs', DOCS)] })
    expect(page()).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    set({ servers: [] })
    expect(page()).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(en['custom.gone'])
    set({ status: 'error' })
    expect(within(screen.getByRole('alert')).getByRole('button', { name: en.retry })).toBeTruthy()
    expect(screen.queryByText(en['custom.gone'])).toBeNull()
  })
})

function renderAction(status: CustomServersState['status']) {
  const store = createSnapshotStore<CustomServersState>({ ...READY, status })
  const setView = vi.fn()
  const props = { t, setView, useCustomServers: bindSnapshotSelector(store) } as AddServerActionProps
  const view = render(<AddServerAction {...props} />)
  const set = (next: CustomServersState['status']): void => { act(() => { store.set({ ...READY, status: next }) }) }
  return { setView, view, set }
}

describe('AddServerAction', () => {
  it('asks the tab for the form of a new server, before the servers are read as well', () => {
    const { setView, set } = renderAction('idle')
    fireEvent.click(screen.getByRole('button', { name: en['custom.add'] }))
    expect(setView).toHaveBeenCalledExactlyOnceWith({ kind: 'new' })
    set('ready')
    expect(screen.getByRole('button', { name: en['custom.add'] })).toBeTruthy()
  })

  it('shows nothing while the profile cannot hold custom servers', () => {
    const { view, set } = renderAction('unavailable')
    expect(view.container.innerHTML).toBe('')
    set('ready')
    expect(screen.getByRole('button', { name: en['custom.add'] })).toBeTruthy()
  })
})

interface PageChange {
  /** The saved server's status; a new server has none. */
  readonly status?: CustomServerStatus
  /** The saved server's entry; a new server has none. */
  readonly entry?: Readonly<Record<string, JsonValue>>
  readonly taken?: readonly string[]
  readonly saving?: boolean
  readonly probe?: ProbeState
  readonly withActions?: boolean
}

function renderPage(initial: ServerDraft, change: PageChange = {}) {
  const onSave = vi.fn(), onProbe = vi.fn(), onDelete = vi.fn()
  const { status, entry, taken = [], saving = false, probe, withActions = false } = change
  render(<ServerDetail initial={initial} status={status} entry={entry} taken={taken} saving={saving} t={t}
    account={<div data-account-section />} probe={probe} onProbe={withActions ? onProbe : undefined}
    onDelete={withActions ? onDelete : undefined} onSave={onSave} />)
  const root = page()!
  return { onSave, onProbe, onDelete, root, save: () => { fireEvent.click(within(root).getByRole('button', { name: en['form.save'] })) } }
}

const typeInto = (scope: HTMLElement, name: string, value: string): void => {
  fireEvent.change(within(scope).getByRole('textbox', { name }), { target: { value } })
}

const REMOTE: ServerDraft = { ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp' }
const LOCAL: ServerDraft = { ...emptyDraft(), name: 'files', transport: 'stdio', command: 'npx' }

describe('ServerDetail', () => {
  it('shows the problems only after a save attempt, against the names it is given', () => {
    const form = renderPage({ ...emptyDraft(), name: 'docs' }, { taken: ['docs'] })
    expect(within(form.root).queryByRole('alert')).toBeNull()
    form.save()
    expect(within(form.root).getByRole('alert').textContent).toBe(en['problem.name-taken'] + en['problem.url-invalid'])
    expect(form.onSave).not.toHaveBeenCalled()
    cleanup()
    const edit = renderPage(REMOTE, { status: ON, taken: ['wiki'] })
    edit.save()
    expect(edit.onSave).toHaveBeenCalledOnce()
  })

  it('limits the name of an OAuth server only while its saved entry names no grant', () => {
    const draft: ServerDraft = { ...REMOTE, name: 'Docs_1', auth: 'oauth' }
    const kept = renderPage(draft, { status: ON, entry: { oauth: { credentialKey: 'mcp-client/team-docs' } } })
    kept.save()
    expect(kept.onSave).toHaveBeenCalledOnce()
    cleanup()
    const named = renderPage(draft, { status: ON, entry: {} })
    named.save()
    expect(within(named.root).getByRole('alert').textContent).toBe(en['problem.name-oauth'])
    expect(named.onSave).not.toHaveBeenCalled()
  })

  it('offers the token or OAuth fields for the chosen authentication and keeps a stored token unless replaced', () => {
    const form = renderPage({ ...REMOTE, auth: 'token', tokenRef: 'MCP_DOCS_TOKEN' })
    const token = form.root.querySelector('input[type="password"]') as HTMLInputElement
    expect(token.placeholder).toBe(en['form.storedSecret'])
    fireEvent.change(token, { target: { value: 'n3w' } })
    fireEvent.click(within(form.root).getByRole('tab', { name: en['form.authOAuth'] }))
    typeInto(form.root, en['form.clientId'], 'app')
    typeInto(form.root, en['form.scope'], 'read')
    form.save()
    expect(form.onSave).toHaveBeenCalledWith(expect.objectContaining({ auth: 'oauth', token: 'n3w', clientId: 'app', scope: 'read' }))
    fireEvent.click(within(form.root).getByRole('tab', { name: en['form.authToken'] }))
    expect((form.root.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('n3w')
    fireEvent.click(within(form.root).getByRole('tab', { name: en['form.authNone'] }))
    expect(form.root.querySelector('input[type="password"]')).toBeNull()
    cleanup()
    const fresh = renderPage({ ...emptyDraft(), name: 'wiki', url: 'https://wiki.example/mcp' })
    fireEvent.click(within(fresh.root).getByRole('tab', { name: en['form.authToken'] }))
    expect(fresh.root.querySelector('input[type="password"]')).toHaveProperty('placeholder', '')
  })

  it('edits header rows, including a secret row whose stored value stays unless replaced', () => {
    const form = renderPage({ ...REMOTE, headers: [{ key: 'X-Key', value: '', secret: true, ref: 'MCP_DOCS_HEADER_X_KEY' }] })
    const headers = within(form.root).getByRole('group', { name: en['form.headers'] })
    expect(within(headers).getByLabelText(en['form.rowValue'])).toHaveProperty('placeholder', en['form.storedSecret'])
    fireEvent.click(within(headers).getByRole('button', { name: en['form.addHeader'] }))
    const keys = within(headers).getAllByRole('textbox', { name: en['form.rowKey'] })
    fireEvent.change(keys[1]!, { target: { value: 'X-Team' } })
    const values = within(headers).getAllByLabelText(en['form.rowValue'])
    fireEvent.change(values[1]!, { target: { value: 'core' } })
    expect(values[1]).toHaveProperty('placeholder', en['form.rowValue'])
    fireEvent.click(within(headers).getAllByRole('checkbox', { name: en['form.rowSecret'] })[0]!)
    form.save()
    expect(form.onSave).toHaveBeenLastCalledWith(expect.objectContaining({
      headers: [{ key: 'X-Key', value: '', secret: false, ref: undefined }, { key: 'X-Team', value: 'core', secret: false }],
    }))
    fireEvent.click(within(headers).getAllByRole('button', { name: en['form.removeRow'] })[0]!)
    expect(within(headers).getAllByRole('textbox', { name: en['form.rowKey'] })).toHaveLength(1)
  })

  it('keeps the inputs of the rows below a removed header or argument row', () => {
    const remote = renderPage({ ...REMOTE, headers: [{ key: 'X-A', value: '1', secret: false }, { key: 'X-B', value: '2', secret: false }] })
    const headers = within(remote.root).getByRole('group', { name: en['form.headers'] })
    const below = within(headers).getAllByRole('textbox', { name: en['form.rowKey'] })[1]!
    fireEvent.click(within(headers).getAllByRole('button', { name: en['form.removeRow'] })[0]!)
    expect(within(headers).getByRole('textbox', { name: en['form.rowKey'] })).toBe(below)
    expect(below).toHaveProperty('value', 'X-B')
    cleanup()

    const local = renderPage({ ...LOCAL, args: ['--root', '/srv'] })
    const args = within(local.root).getByRole('group', { name: en['form.args'] })
    const last = within(args).getByRole('textbox', { name: t('form.argLabel', { index: '2' }) })
    fireEvent.click(within(args).getAllByRole('button', { name: en['form.removeRow'] })[0]!)
    expect(within(args).getByRole('textbox', { name: t('form.argLabel', { index: '1' }) })).toBe(last)
    expect(last).toHaveProperty('value', '/srv')
  })

  it('confirms a new local command before saving it, with one row per argument', () => {
    const form = renderPage({ ...emptyDraft(), name: 'files' })
    fireEvent.click(within(form.root).getByRole('tab', { name: en['form.stdio'] }))
    typeInto(form.root, en['form.command'], ' npx files-server ')
    const args = within(form.root).getByRole('group', { name: en['form.args'] })
    fireEvent.click(within(args).getByRole('button', { name: en['form.addArg'] }))
    fireEvent.click(within(args).getByRole('button', { name: en['form.addArg'] }))
    fireEvent.click(within(args).getByRole('button', { name: en['form.addArg'] }))
    typeInto(args, t('form.argLabel', { index: '1' }), '--root')
    typeInto(args, t('form.argLabel', { index: '2' }), '/srv')
    fireEvent.click(within(args).getAllByRole('button', { name: en['form.removeRow'] })[2]!)
    typeInto(form.root, en['form.cwd'], '/srv')
    const env = within(form.root).getByRole('group', { name: en['form.env'] })
    fireEvent.click(within(env).getByRole('button', { name: en['form.addEnv'] }))
    fireEvent.change(within(env).getByRole('textbox', { name: en['form.rowKey'] }), { target: { value: 'MODE' } })
    form.save()
    expect(within(risk()).getByText(t('stdio.body', { command: 'npx files-server' }))).toBeTruthy()
    expect(within(risk()).getByRole('button', { name: en['stdio.confirm'] })).toHaveProperty('disabled', true)
    fireEvent.click(within(risk()).getByRole('button', { name: en['form.cancel'] }))
    expect(screen.queryByRole('dialog', { name: en['stdio.title'] })).toBeNull()
    expect(form.onSave).not.toHaveBeenCalled()

    form.save()
    fireEvent.click(within(risk()).getByRole('checkbox', { name: en['stdio.acknowledge'] }))
    fireEvent.click(within(risk()).getByRole('button', { name: en['stdio.confirm'] }))
    expect(form.onSave).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'stdio', command: ' npx files-server ', args: ['--root', '/srv'], cwd: '/srv', env: [{ key: 'MODE', value: '', secret: false }],
    }))
  })

  it('saves the local command of a server that is switched off without the confirmation', () => {
    const form = renderPage(LOCAL, { status: OFF })
    form.save()
    expect(screen.queryByRole('dialog', { name: en['stdio.title'] })).toBeNull()
    expect(form.onSave).toHaveBeenCalledOnce()
  })

  it.each([
    ['is on', ON],
    ['did not start', REFUSED],
  ])('confirms the local command of a server that %s before saving it', (_case, status) => {
    const form = renderPage(LOCAL, { status })
    form.save()
    expect(within(risk()).getByText(t('stdio.body', { command: 'npx' }))).toBeTruthy()
    expect(form.onSave).not.toHaveBeenCalled()
  })

  it('says why a server did not start', () => {
    const failed = renderPage(REMOTE, { status: REFUSED })
    expect(within(failed.root).getByText(t('custom.failed', { message: 'connection refused' }))).toBeTruthy()
    cleanup()
    const running = renderPage(REMOTE, { status: ON })
    expect(running.root.textContent).not.toContain('connection refused')
  })

  it('shows the account section and the latest test, tests only an unchanged draft, and removes after its confirmation', () => {
    const form = renderPage(REMOTE, { status: ON, withActions: true, probe: { status: 'passed', tools: 2, truncated: false } })
    expect(form.root.querySelector('[data-account-section]')).not.toBeNull()
    expect(within(form.root).getByText(t('custom.probePassed', { count: '2' }))).toBeTruthy()
    const test = within(form.root).getByRole('button', { name: en['custom.probe'] })
    fireEvent.click(test)
    expect(form.onProbe).toHaveBeenCalledOnce()
    typeInto(form.root, en['form.url'], 'https://docs.example/v2')
    expect(test).toHaveProperty('disabled', true)

    const removal = (): HTMLElement => within(form.root).getByRole('button', { name: en['custom.remove'] })
    fireEvent.click(removal())
    const confirm = screen.getByRole('dialog', { name: t('custom.removeTitle', { name: 'docs' }) })
    expect(within(confirm).getByText(en['custom.removeBody'])).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: en['form.cancel'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(removal())
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(form.onDelete).not.toHaveBeenCalled()
    fireEvent.click(removal())
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['custom.remove'] }))
    expect(form.onDelete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps Save unavailable while a save runs', () => {
    const form = renderPage(REMOTE, { saving: true })
    expect(within(form.root).getByRole('button', { name: en['form.save'] })).toHaveProperty('disabled', true)
  })
})
