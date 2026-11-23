// @vitest-environment jsdom
/** The custom servers section lists the manager's Settings servers, and its page edits, tests, and removes one entry. */
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CustomServersSection, type CustomServersSectionProps, type CustomServersView } from '../src/client/CustomServersSection.tsx'
import type { CustomServer, CustomServersState, ProbeState } from '../src/client/custom-servers-store.ts'
import { en, type ConnectorsLocaleKey } from '../src/client/locales.ts'
import { ServerDetail } from '../src/client/ServerDetail.tsx'
import { emptyDraft, type ServerDraft } from '../src/server-form.ts'

afterEach(cleanup)

const t = ((key: ConnectorsLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce<string>((text, [name, value]) => text.replaceAll(`{${name}}`, value), en[key])) as CustomServersSectionProps['t']

const READY: CustomServersState = { status: 'ready', writable: true, revision: 1, servers: [], saving: false, failure: undefined, probes: {} }
const DOCS: Readonly<Record<string, JsonValue>> = {
  transport: 'streamable-http', url: 'https://docs.example/mcp', headers: {}, oauth: { credentialKey: 'mcp-client/docs' }, timeoutMs: 5,
}
const FILES: Readonly<Record<string, JsonValue>> = { transport: 'stdio', command: 'npx', args: [], env: {}, enabled: false }

const server = (name: string, raw: CustomServer['raw'], inherited = false): CustomServer => ({ name, raw, inherited })

/** The Connectors tab's part: it owns the view and passes it with its change. */
function Tab({ input, initial }: { input: CustomServersSectionProps; initial: CustomServersView }) {
  const [view, setView] = useState<CustomServersView>(initial)
  return <CustomServersSection {...input} view={view} setView={setView} />
}

function renderSection(state: Partial<CustomServersState>, initial: CustomServersView = { kind: 'list' }) {
  const store = createSnapshotStore<CustomServersState>({ ...READY, ...state })
  const actions = {
    ensure: vi.fn(), retry: vi.fn(), save: vi.fn(async (_draft: ServerDraft) => true),
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

describe('CustomServersSection', () => {
  it('asks for the servers once mounted and shows nothing while the manager is unavailable', () => {
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

  it('lists each server with its target, an enabled OAuth server\'s account status, its settings, and its switch', () => {
    const { actions, renderFactorySlot } = renderSection({
      servers: [server('docs', DOCS), server('files', FILES), server('odd', undefined), server('base', { transport: 'streamable-http', url: 5 }, true)],
      probes: { docs: { status: 'passed', tools: 3, truncated: false } },
    })
    expect(within(item('docs')).getByText('https://docs.example/mcp')).toBeTruthy()
    expect(within(item('files')).getByText('npx')).toBeTruthy()
    expect(within(item('odd')).getByText(en['custom.unreadable'])).toBeTruthy()
    expect(within(item('docs')).queryByText(t('custom.probePassed', { count: '3' }))).toBeNull()
    expect(renderFactorySlot.mock.calls).toEqual([['connector.account', { account: 'mcp:docs', presentation: 'status' }]])
    expect(item('docs').querySelector('[data-account="mcp:docs"]')).not.toBeNull()
    expect(within(item('docs')).queryByRole('button', { name: en['custom.probe'] })).toBeNull()
    expect(within(item('docs')).queryByRole('button', { name: en['custom.remove'] })).toBeNull()

    expect(within(item('odd')).getByRole('button', { name: t('custom.settingsLabel', { name: 'odd' }) })).toHaveProperty('disabled', true)
    expect(within(item('docs')).getByRole('button', { name: t('custom.settingsLabel', { name: 'docs' }) }).textContent).toBe(en['custom.settings'])
    expect(within(item('files')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(within(item('docs')).getByRole('switch', { name: t('custom.enableLabel', { name: 'docs' }) }))
    expect(actions.setEnabled).toHaveBeenCalledWith('docs', false)
  })

  it('disables every change in a read-only profile', () => {
    renderSection({ writable: false, servers: [server('docs', DOCS)] })
    expect(screen.getByRole('button', { name: en['custom.add'] })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: t('custom.settingsLabel', { name: 'docs' }) })).toHaveProperty('disabled', true)
    expect(screen.getByRole('switch')).toHaveProperty('disabled', true)
  })

  it('reports a conflicting or refused change until it is dismissed', () => {
    const { actions, set } = renderSection({ failure: { kind: 'conflict', message: 'stale' } })
    expect(screen.getByRole('alert').textContent).toContain(en['custom.conflict'])
    set({ failure: { kind: 'refused', message: 'read-only profile' } })
    expect(screen.getByRole('alert').textContent).toContain(t('custom.refused', { message: 'read-only profile' }))
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: en.close }))
    expect(actions.dismissFailure).toHaveBeenCalledOnce()
  })

  it('adds a server on the page its list button opens, which stays open until the save succeeds and offers no test or removal', async () => {
    const { actions } = renderSection({ servers: [server('docs', DOCS)] })
    expect(page()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['custom.add'] }))
    const added = page()!
    expect(within(added).getByRole('heading', { name: en['form.addTitle'] })).toBeTruthy()
    expect(document.querySelector('[data-custom-server]')).toBeNull()
    expect(within(added).queryByRole('button', { name: en['custom.probe'] })).toBeNull()
    expect(within(added).queryByRole('button', { name: en['custom.remove'] })).toBeNull()
    fireEvent.change(within(added).getByRole('textbox', { name: en['form.name'] }), { target: { value: 'wiki' } })
    fireEvent.change(within(added).getByRole('textbox', { name: en['form.url'] }), { target: { value: 'https://wiki.example/mcp' } })
    actions.save.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(within(added).getByRole('button', { name: en['form.save'] })) })
    expect(actions.save.mock.calls[0]![0]).toMatchObject({ name: 'wiki', transport: 'streamable-http', url: 'https://wiki.example/mcp', auth: 'none' })
    expect(page()).not.toBeNull()
    await act(async () => { fireEvent.click(within(added).getByRole('button', { name: en['form.save'] })) })
    expect(page()).toBeNull()
    expect(item('docs')).not.toBeNull()
  })

  it('edits a server on its page with its account section and saves the form\'s draft', async () => {
    const { actions, renderFactorySlot } = renderSection({ servers: [server('docs', DOCS)] })
    openSettings('docs')
    const edited = page()!
    expect(within(edited).getByRole('heading', { name: t('form.editTitle', { name: 'docs' }) })).toBeTruthy()
    expect(renderFactorySlot).toHaveBeenLastCalledWith('connector.account', { account: 'mcp:docs', presentation: 'section' })
    expect(edited.querySelector('[data-presentation="section"]')).not.toBeNull()
    expect(within(edited).getByRole('textbox', { name: en['form.name'] })).toHaveProperty('disabled', true)
    expect(within(edited).getByRole('tab', { name: en['form.authOAuth'] }).getAttribute('aria-selected')).toBe('true')
    await act(async () => { fireEvent.click(within(edited).getByRole('button', { name: en['form.save'] })) })
    expect(actions.save.mock.calls[0]![0]).toMatchObject({ name: 'docs', url: 'https://docs.example/mcp', auth: 'oauth' })
    expect(page()).toBeNull()
  })

  it('tests the saved entry from its page and shows the latest result', () => {
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

  it('removes a server from its page only after its confirmation, then returns to the list', () => {
    renderSection({ servers: [server('files', FILES), server('base', DOCS, true)] })
    openSettings('base')
    expect(within(page()!).queryByRole('button', { name: en['custom.remove'] })).toBeNull()
    cleanup()
    const { actions } = renderSection({ servers: [server('files', FILES)] }, { kind: 'server', name: 'files' })
    const removal = (): HTMLElement => within(page()!).getByRole('button', { name: en['custom.remove'] })
    fireEvent.click(removal())
    const confirm = screen.getByRole('dialog', { name: t('custom.removeTitle', { name: 'files' }) })
    expect(within(confirm).getByText(en['custom.removeBody'])).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: en['form.cancel'] }))
    fireEvent.click(removal())
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(actions.remove).not.toHaveBeenCalled()
    fireEvent.click(removal())
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['custom.remove'] }))
    expect(actions.remove).toHaveBeenCalledWith('files')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(page()).toBeNull()
  })

  it('offers no removal on the page of a read-only profile', () => {
    renderSection({ writable: false, servers: [server('files', FILES)] }, { kind: 'server', name: 'files' })
    expect(within(page()!).queryByRole('button', { name: en['custom.remove'] })).toBeNull()
  })

  it('waits for the read before showing a named page, and closes the page of a server that is gone or unreadable', () => {
    const { set } = renderSection({ status: 'loading' }, { kind: 'server', name: 'docs' })
    expect(page()).toBeNull()
    expect(document.querySelector('[data-custom-servers]')).toBeNull()
    set({ status: 'ready', servers: [server('docs', DOCS)] })
    expect(page()).not.toBeNull()
    set({ servers: [server('docs', undefined)] })
    expect(page()).toBeNull()
    expect(within(item('docs')).getByText(en['custom.unreadable'])).toBeTruthy()
  })
})

interface PageChange {
  readonly isNew?: boolean
  readonly taken?: readonly string[]
  readonly saving?: boolean
  readonly probe?: ProbeState
  readonly withActions?: boolean
}

function renderPage(initial: ServerDraft, change: PageChange = {}) {
  const onSave = vi.fn(), onProbe = vi.fn(), onDelete = vi.fn()
  const { isNew = true, taken = [], saving = false, probe, withActions = false } = change
  render(<ServerDetail initial={initial} isNew={isNew} taken={taken} saving={saving} t={t} account={<div data-account-section />}
    probe={probe} onProbe={withActions ? onProbe : undefined} onDelete={withActions ? onDelete : undefined} onSave={onSave} />)
  const root = page()!
  return { onSave, onProbe, onDelete, root, save: () => { fireEvent.click(within(root).getByRole('button', { name: en['form.save'] })) } }
}

const typeInto = (scope: HTMLElement, name: string, value: string): void => {
  fireEvent.change(within(scope).getByRole('textbox', { name }), { target: { value } })
}

describe('ServerDetail', () => {
  it('shows the problems only after a save attempt, against the other servers’ names', () => {
    const form = renderPage({ ...emptyDraft(), name: 'docs' }, { taken: ['docs'] })
    expect(within(form.root).queryByRole('alert')).toBeNull()
    form.save()
    expect(within(form.root).getByRole('alert').textContent).toBe(en['problem.name-taken'] + en['problem.url-invalid'])
    expect(form.onSave).not.toHaveBeenCalled()
    cleanup()
    const edit = renderPage({ ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp' }, { isNew: false, taken: ['docs'] })
    edit.save()
    expect(edit.onSave).toHaveBeenCalledOnce()
  })

  it('offers the token or OAuth fields for the chosen authentication and keeps a stored token unless replaced', () => {
    const form = renderPage({ ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp', auth: 'token', tokenRef: 'MCP_DOCS_TOKEN' })
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
    const form = renderPage({
      ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp',
      headers: [{ key: 'X-Key', value: '', secret: true, ref: 'MCP_DOCS_HEADER_X_KEY' }],
    })
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

  it('confirms an enabled local command before saving it, with one row per argument', () => {
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
    const risk = screen.getByRole('dialog', { name: en['stdio.title'] })
    expect(within(risk).getByText(t('stdio.body', { command: 'npx files-server' }))).toBeTruthy()
    const run = within(risk).getByRole('button', { name: en['stdio.confirm'] }) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    fireEvent.click(within(risk).getByRole('button', { name: en['form.cancel'] }))
    expect(screen.queryByRole('dialog', { name: en['stdio.title'] })).toBeNull()
    expect(form.onSave).not.toHaveBeenCalled()

    form.save()
    fireEvent.click(within(screen.getByRole('dialog', { name: en['stdio.title'] })).getByRole('checkbox', { name: en['stdio.acknowledge'] }))
    fireEvent.click(within(screen.getByRole('dialog', { name: en['stdio.title'] })).getByRole('button', { name: en['stdio.confirm'] }))
    expect(form.onSave).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'stdio', command: ' npx files-server ', args: ['--root', '/srv'], cwd: '/srv', env: [{ key: 'MODE', value: '', secret: false }],
    }))
  })

  it('saves a disabled local command without the confirmation', () => {
    const form = renderPage({ ...emptyDraft(), name: 'files', transport: 'stdio', command: 'npx', enabled: false }, { isNew: false })
    form.save()
    expect(screen.queryByRole('dialog', { name: en['stdio.title'] })).toBeNull()
    expect(form.onSave).toHaveBeenCalledOnce()
  })

  it('shows the account section and the latest test, tests only an unchanged draft, and offers removal', () => {
    const draft = { ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp' }
    const form = renderPage(draft, { isNew: false, withActions: true, probe: { status: 'passed', tools: 2, truncated: false } })
    expect(form.root.querySelector('[data-account-section]')).not.toBeNull()
    expect(within(form.root).getByText(t('custom.probePassed', { count: '2' }))).toBeTruthy()
    const test = within(form.root).getByRole('button', { name: en['custom.probe'] })
    fireEvent.click(test)
    expect(form.onProbe).toHaveBeenCalledOnce()
    typeInto(form.root, en['form.url'], 'https://docs.example/v2')
    expect(test).toHaveProperty('disabled', true)
    fireEvent.click(within(form.root).getByRole('button', { name: en['custom.remove'] }))
    expect(form.onDelete).toHaveBeenCalledOnce()
  })

  it('keeps Save unavailable while a save runs', () => {
    const form = renderPage({ ...emptyDraft(), name: 'docs', url: 'https://docs.example/mcp' }, { saving: true })
    expect(within(form.root).getByRole('button', { name: en['form.save'] })).toHaveProperty('disabled', true)
  })
})
