// @vitest-environment jsdom
/** Permission UI distinguishes missing privileges, uncertainty, and application consent. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CuaApplicationId, CuaApplicationState, CuaSystemPermissionState } from '../src/access-types.ts'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PermissionPanel, PermissionSetup, PermissionToast, type PermissionPanelProps } from '../src/client/PermissionPanel.tsx'
import type { PermissionView } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const value: CuaApplicationState & { system: CuaSystemPermissionState } = { system: { accessibility: false, screenRecording: true,
  helper: { pid: 9, path: '/native/helper' }, parent: { pid: 8, path: '/host/node' } },
allowedApps: [], blockedApps: [], settingsNamespace: 'cua', persistentAvailable: true }

function observe(value: CuaApplicationState & { system: CuaSystemPermissionState }) {
  return { system: { value: value.system, busy: false, error: null },
    applications: { value, busy: false, error: null }, icons: { value: {}, busy: false, error: null }, busy: false }
}

function fixture() {
  const state = createSnapshotStore<PermissionView>({
    runtime: { value: { persistent: false, writable: true }, busy: false, error: null },
    system: { value: null, busy: true, error: null }, applications: { value: null, busy: true, error: null },
    icons: { value: null, busy: true, error: null }, busy: true, changing: false, toast: null,
  })
  const preset = createSnapshotStore<ConfigFormSnapshot<{ default: string; selectedDefault?: string }>>({
    status: 'ready', value: { default: 'standard', selectedDefault: 'ptc' },
    base: {}, user: {}, revision: 1, writable: true,
  })
  const refresh = vi.fn()
  const props = { useCuaPermissions: bindSnapshotSelector(state), t: makeTranslate(en),
    setPersistentPtc: vi.fn(async () => true),
    useCuaDefaultPreset: bindSnapshotSelector(preset), setPtcDefault: vi.fn(async () => true),
    refresh, request: vi.fn(), openSettings: vi.fn(), revoke: vi.fn(),
    retryApproval: vi.fn(), dismissToast: vi.fn(),
  } satisfies PermissionPanelProps
  return { state, preset, props,
    publish(patch: Partial<PermissionView>) { act(() => { state.set({ ...state.getSnapshot(), ...patch }) }) },
  }
}

it('requests only a missing privilege and leaves OS attribution to the system prompt', () => {
  const f = fixture()
  const shown = render(<PermissionPanel {...f.props} />)
  expect(f.props.refresh).toHaveBeenCalledOnce()
  f.publish({ ...observe(value) })
  fireEvent.click(screen.getByRole('button', { name: en.request }))
  expect(f.props.request).toHaveBeenCalledWith('accessibility')
  expect(screen.queryByRole('button', { name: en.settings })).toBeNull()
  const allowed = screen.getByRole('button', { name: en.granted })
  expect(allowed.getAttribute('title')).toBe(en.settings)
  fireEvent.click(allowed)
  expect(f.props.openSettings.mock.calls).toEqual([['screenRecording']])
  fireEvent.focus(window)
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
  shown.unmount()
  fireEvent.focus(window)
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
})

it.each([en, zh])('changes the default from the detail page and retains a refused write for retry', async (dictionary) => {
  const f = fixture()
  f.preset.set({ ...f.preset.getSnapshot(), value: { default: 'standard' } })
  f.publish({ ...observe(value) })
  render(<PermissionPanel {...f.props} t={makeTranslate(dictionary)} />)
  const group = screen.getByRole('group', { name: dictionary.defaultTitle })
  expect(within(group).getByText(dictionary.defaultBody)).toBeTruthy()
  expect(f.props.setPtcDefault).not.toHaveBeenCalled()
  const write = Promise.withResolvers<boolean>()
  f.props.setPtcDefault.mockReturnValueOnce(write.promise)
  fireEvent.click(within(group).getByRole('button', { name: dictionary.defaultConfirm }))
  expect(within(group).getByRole('button', { name: dictionary.defaultConfirm }).hasAttribute('disabled')).toBe(true)
  await act(async () => { write.resolve(false); await write.promise })
  expect(screen.getByRole('alert').textContent).toBe(dictionary.defaultNotSaved)
  fireEvent.click(within(group).getByRole('button', { name: dictionary.defaultConfirm }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(f.props.setPtcDefault).toHaveBeenCalledTimes(2)
  act(() => { f.preset.set({ ...f.preset.getSnapshot(), value: { default: 'standard', selectedDefault: 'ptc' } }) })
  expect(within(group).getByRole('button', { name: dictionary.defaultSet }).hasAttribute('disabled')).toBe(true)
})

it('dismisses activation when permissions are ready without changing the default', () => {
  const f = fixture(), onDismiss = vi.fn()
  f.preset.set({ ...f.preset.getSnapshot(), value: { default: 'standard', selectedDefault: 'minimal' } })
  f.publish({ ...observe({ ...value, system: { ...value.system, accessibility: true } }) })
  render(<PermissionSetup {...f.props} onDismiss={onDismiss} onOpenDetails={vi.fn()} />)
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.props.setPtcDefault).not.toHaveBeenCalled()
})

it.each([new Error('offline'), 'offline'])('reports a failed default-mode request on the detail page', async (error) => {
  const f = fixture()
  f.preset.set({ ...f.preset.getSnapshot(), value: { default: 'standard' } })
  f.props.setPtcDefault.mockRejectedValueOnce(error)
  render(<PermissionPanel {...f.props} />)
  fireEvent.click(screen.getByRole('button', { name: en.defaultConfirm }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('offline') })
})

it('waits for the settings document and recognizes PTC as the deployment default', () => {
  const f = fixture()
  f.preset.set({ ...f.preset.getSnapshot(), status: 'loading', value: undefined })
  render(<PermissionPanel {...f.props} />)
  expect(screen.queryByRole('button', { name: en.defaultConfirm })).toBeNull()
  act(() => { f.preset.set({ ...f.preset.getSnapshot(), status: 'ready', value: { default: 'ptc' } }) })
  expect(screen.getByRole('button', { name: en.defaultSet }).hasAttribute('disabled')).toBe(true)
  expect(f.props.setPtcDefault).not.toHaveBeenCalled()
})

it.each(['unavailable', 'ready'] as const)('explains why the %s settings document cannot change the default', (status) => {
  const f = fixture()
  f.preset.set({ ...f.preset.getSnapshot(), status, writable: false,
    value: status === 'ready' ? { default: 'standard' } : undefined })
  render(<PermissionPanel {...f.props} />)
  expect(screen.getByRole('alert').textContent).toBe(status === 'ready' ? en.defaultReadOnly : en.defaultUnavailable)
  expect(screen.getByRole('button', { name: en.defaultConfirm }).hasAttribute('disabled')).toBe(true)
  expect(f.props.setPtcDefault).not.toHaveBeenCalled()
})

it('shows query failures as unknown while retaining previously displayed apps', () => {
  const f = fixture(), app = { id: 'a'.repeat(64) as CuaApplicationId, name: 'Fixture', executablePath: '/fixture/app' }
  render(<PermissionPanel {...f.props} />)
  f.publish({ ...observe({ ...value, allowedApps: [app] }), system: { value: value.system, busy: false, error: 'offline' }, busy: false })
  expect(screen.getAllByRole('button', { name: en.revoke })).toHaveLength(1)
  expect(screen.getAllByText(en.unknown)).toHaveLength(2)
  expect(screen.queryByText(en.granted)).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('offline')
  fireEvent.click(screen.getAllByRole('button', { name: en.revoke })[0]!)
  expect(f.props.revoke).toHaveBeenCalledWith(app.id)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
  f.publish({ system: { ...f.state.getSnapshot().system, busy: true }, busy: true })
  expect(screen.getByRole('button', { name: en.retry }).hasAttribute('disabled')).toBe(true)
  f.publish({ system: { ...f.state.getSnapshot().system, busy: false, error: null }, busy: false })
  expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
  f.publish(observe(value))
  expect(screen.getByText(en.noApps)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.revoke })).toBeNull()
})

it('keeps unknown initial status distinct from a confirmed missing privilege in Chinese', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} t={makeTranslate(zh)} />)
  f.publish({ system: { ...f.state.getSnapshot().system, busy: false, error: 'connection lost' }, busy: false })
  expect(screen.queryByText(zh.granted)).toBeNull()
  expect(screen.queryByRole('button', { name: zh.request })).toBeNull()
  f.publish({ ...observe({ ...value, system: { ...value.system, accessibility: true, screenRecording: false } }) })
  fireEvent.click(screen.getByRole('button', { name: zh.request }))
  expect(f.props.request).toHaveBeenCalledWith('screenRecording')
})

it('offers setup after inspection, permits dismissal, and dismisses once both privileges are observed', () => {
  const f = fixture(), onDismiss = vi.fn(), onOpenDetails = vi.fn()
  render(<PermissionSetup {...f.props} onDismiss={onDismiss} onOpenDetails={onOpenDetails} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  f.publish({ ...observe(value) })
  const dialog = screen.getByRole('dialog', { name: en.setupTitle })
  fireEvent.click(within(dialog).getByRole('button', { name: en.openSetup }))
  expect(onOpenDetails).toHaveBeenCalledOnce()
  fireEvent.click(within(dialog).getByRole('button', { name: en.later }))
  expect(onDismiss).toHaveBeenCalledOnce()
  f.publish({ ...observe({ ...value, system: { ...value.system, accessibility: true } }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onDismiss).toHaveBeenCalledTimes(2)
})

it('offers the details page when permission inspection fails', () => {
  const f = fixture()
  render(<PermissionSetup {...f.props} onDismiss={vi.fn()} onOpenDetails={vi.fn()} />)
  f.publish({ system: { ...f.state.getSnapshot().system, busy: false, error: 'offline' }, busy: false })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(en.setupQueryFailed)).toBeTruthy()
  expect(screen.queryByText(en.setupBody)).toBeNull()
})

it('exposes a new-request action for a blocked application without calling grant or revoke', () => {
  const f = fixture(), app = { id: 'a'.repeat(64) as CuaApplicationId, name: 'Fixture', executablePath: '/fixture/app' }
  render(<PermissionPanel {...f.props} />)
  f.publish({ ...observe({ ...value, blockedApps: [app] }) })
  expect(screen.queryByText(en.noApps)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.retryApproval }))
  expect(f.props.retryApproval).toHaveBeenCalledWith(app.id)
  expect(f.props.revoke).not.toHaveBeenCalled()
  expect(f.props.request).not.toHaveBeenCalled()
})

it('renders action outcomes outside the permission page and clears finished toasts', async () => {
  vi.useFakeTimers()
  const f = fixture()
  render(<PermissionToast {...f.props} />)
  expect(screen.queryByRole('alert')).toBeNull()
  f.publish({ toast: { id: 1, kind: 'revoked' } })
  expect(screen.getByRole('alert').textContent).toBe(en.revoked)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(f.props.dismissToast).toHaveBeenCalledOnce()
  f.publish({ toast: { id: 2, kind: 'failed', message: 'write refused' } })
  expect(screen.getByRole('alert').textContent).toContain('write refused')
})

it('keeps permission guidance open while a fresh observation is pending', () => {
  const f = fixture()
  render(<PermissionSetup {...f.props} onDismiss={vi.fn()} onOpenDetails={vi.fn()} />)
  f.publish({ ...observe(value) })
  const dialog = screen.getByRole('dialog')
  f.publish({ system: { ...f.state.getSnapshot().system, busy: true }, busy: true })
  expect(screen.getByRole('dialog')).toBe(dialog)
})

it('shows application icons and names while keeping the executable path in the tooltip', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} />)
  f.publish({ ...observe({ ...value, allowedApps: [{ id: 'a'.repeat(64) as CuaApplicationId,
    name: 'Calculator', executablePath: '/Applications/Calculator.app/Contents/MacOS/Calculator' }] }),
  icons: { value: { '/Applications/Calculator.app/Contents/MacOS/Calculator': 'data:image/png;base64,aWNvbg==' }, busy: false, error: null }, busy: false })
  expect(screen.getByText('Calculator')).toBeTruthy()
  expect(screen.queryByText('/Applications/Calculator.app/Contents/MacOS/Calculator')).toBeNull()
  const identity = screen.getByTitle('/Applications/Calculator.app/Contents/MacOS/Calculator')
  expect(identity.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
})

it.each([en, zh])('shows four requirements with the target application beside each system permission', (dictionary) => {
  const f = fixture()
  render(<PermissionPanel {...f.props} t={makeTranslate(dictionary)} />)
  const application = { name: 'Visual Studio Code.app', path: '/Applications/Visual Studio Code.app', icon: 'data:image/png;base64,aWNvbg==' }
  f.publish({ ...observe({ ...value, system: { ...value.system, parent: { pid: 1, path: '/sbin/launchd' }, launchApplication: application } }) })
  const requirements = screen.getByRole('region', { name: dictionary.title })
  expect(within(requirements).getAllByRole('group')).toHaveLength(4)
  expect(screen.getByRole('region', { name: dictionary.applicationsTitle })).toBeTruthy()
  const accessibility = within(requirements).getByRole('group', { name: dictionary.accessibility })
  expect(within(accessibility).getByText(application.name)).toBeTruthy()
  expect(accessibility.textContent).toContain(dictionary.accessibilityPermission.replace('{application}', application.name))
  expect(accessibility.querySelector('img')?.getAttribute('src')).toBe(application.icon)
  const recording = within(requirements).getByRole('group', { name: dictionary.screenRecording })
  expect(within(recording).getByText(application.name)).toBeTruthy()
  expect(recording.textContent).toContain(dictionary.screenRecordingPermission.replace('{application}', application.name))
  expect(within(requirements).getByText(dictionary.permissionHint)).toBeTruthy()
  f.publish({ system: { ...f.state.getSnapshot().system, error: 'offline' } })
  expect(screen.queryByText(application.name)).toBeNull()
  expect(within(requirements).getByText(dictionary.permissionHint)).toBeTruthy()
})

it('names the authorization target even when its icon is unavailable', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} />)
  f.publish({ ...observe({ ...value, system: { ...value.system,
    launchApplication: { name: 'iTerm.app', path: '/Applications/iTerm.app' } } }) })
  const accessibility = screen.getByRole('group', { name: en.accessibility })
  expect(within(accessibility).getByText('iTerm.app')).toBeTruthy()
  expect(accessibility.querySelector('img')).toBeNull()
})

it('waits for the first current observation instead of opening setup with a stale error', () => {
  const f = fixture()
  render(<PermissionSetup {...f.props} onDismiss={vi.fn()} onOpenDetails={vi.fn()} />)
  f.publish({ system: { ...f.state.getSnapshot().system, busy: true, error: 'provider is reloading' }, busy: true })
  expect(screen.queryByRole('dialog')).toBeNull()
  f.publish({ ...observe(value) })
  expect(screen.getByRole('dialog', { name: en.setupTitle })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})


it('keeps permission management guidance after both permissions are granted', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} />)
  f.publish({ ...observe({ ...value, system: { ...value.system, accessibility: true, screenRecording: true } }) })
  expect(screen.getAllByText(en.granted)).toHaveLength(2)
  expect(screen.getByText(en.permissionHint)).toBeTruthy()
})


it('keeps all four requirements visible before the first permission response', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} />)
  const requirements = screen.getByRole('region', { name: en.title })
  expect(within(requirements).getAllByRole('group')).toHaveLength(4)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: en.request })).toBeNull()
  for (const permission of [en.accessibility, en.screenRecording]) expect(within(screen.getByRole('group', { name: permission })).queryByRole('button')).toBeNull()
})

it('keeps content mounted and disables actions while management changes are pending', () => {
  const f = fixture()
  f.publish({ ...observe(value), system: { value: value.system, busy: false, error: 'provider is reloading' }, busy: false })
  f.publish({ changing: true })
  const view = render(<PermissionPanel {...f.props} />)
  const requirements = screen.getByRole('region', { name: en.title })
  expect(within(requirements).getAllByRole('group')).toHaveLength(4)
  expect(screen.getByRole('alert').textContent).toContain('provider is reloading')
  expect(within(screen.getByRole('group', { name: en.accessibility })).getByRole('button', { name: en.unknown }).hasAttribute('disabled')).toBe(true)
  fireEvent.focus(window)
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
  f.publish({ system: { ...f.state.getSnapshot().system, busy: true, error: null }, busy: true })
  f.publish({ changing: false })
  view.rerender(<PermissionPanel {...f.props} />)
  expect(screen.getByRole('region', { name: en.title })).toBe(requirements)
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
  f.publish({ system: { ...f.state.getSnapshot().system, busy: false }, busy: false })
  expect(screen.getByRole('button', { name: en.request }).hasAttribute('disabled')).toBe(false)
})

it('fills application names, system permissions, and icons as their observations arrive', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} />)
  const requirements = screen.getByRole('region', { name: en.title })
  const access = screen.getByRole('region', { name: en.applicationsTitle })
  const app = { id: 'a'.repeat(64) as CuaApplicationId, name: 'Calculator', executablePath: '/Applications/Calculator.app' }
  f.publish({ applications: { value: { ...value, allowedApps: [app] }, busy: false, error: null } })
  expect(within(access).getByText(app.name)).toBeTruthy()
  expect(within(access).getByRole('button', { name: en.revoke }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByText(en.granted)).toBeNull()
  const identity = within(access).getByTitle(app.executablePath)
  expect(identity.querySelector('img')).toBeNull()
  const placeholder = identity.querySelector('[aria-hidden]')!
  expect(placeholder).toBeTruthy()
  f.publish({ system: { value: value.system, busy: false, error: null } })
  expect(within(requirements).getByText(en.granted)).toBeTruthy()
  expect(within(requirements).getByRole('button', { name: en.request }).hasAttribute('disabled')).toBe(false)
  expect(within(access).getByTitle(app.executablePath)).toBe(identity)
  expect(identity.querySelector('[aria-hidden]')).toBe(placeholder)
  f.publish({ icons: { value: { [app.executablePath]: 'data:image/png;base64,aWNvbg==' }, busy: false, error: null } })
  expect(identity.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
  expect(identity.querySelector('[aria-hidden]')).toBeNull()
  expect(screen.getByRole('region', { name: en.title })).toBe(requirements)
})

it.each(['applications', 'icons'] as const)('contains a failed %s query in the application section', (key) => {
  const f = fixture()
  f.publish({ ...observe(value), [key]: { value: null, busy: false, error: 'offline' } })
  const view = render(<PermissionPanel {...f.props} />)
  const requirements = screen.getByRole('region', { name: en.title })
  const access = screen.getByRole('region', { name: en.applicationsTitle })
  expect(within(requirements).getByText(en.granted)).toBeTruthy()
  expect(within(requirements).queryByRole('alert')).toBeNull()
  expect(within(access).getByRole('alert').textContent).toContain('offline')
  fireEvent.click(within(access).getByRole('button', { name: en.retry }))
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
  f.publish({ changing: true })
  view.rerender(<PermissionPanel {...f.props} />)
  expect(within(access).getByRole('alert').textContent).toContain('offline')
})

it('finishes activation guidance without waiting for application icons', () => {
  const f = fixture(), onDismiss = vi.fn()
  render(<PermissionSetup {...f.props} onDismiss={onDismiss} onOpenDetails={vi.fn()} />)
  f.publish({ system: { value: { ...value.system, accessibility: true }, busy: false, error: null } })
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.state.getSnapshot().icons.busy).toBe(true)
})

it.each([en, zh])('saves persistent PTC only from its own row and retains failures for retry', async (dictionary) => {
  const f = fixture()
  render(<PermissionPanel {...f.props} t={makeTranslate(dictionary)} />)
  const row = screen.getByRole('group', { name: dictionary.persistentTitle })
  expect(f.props.setPersistentPtc).not.toHaveBeenCalled()
  const write = Promise.withResolvers<boolean>()
  f.props.setPersistentPtc.mockReturnValueOnce(write.promise)
  fireEvent.click(within(row).getByRole('button', { name: dictionary.persistentConfirm }))
  expect(within(row).getByRole('button').hasAttribute('disabled')).toBe(true)
  await act(async () => { write.resolve(false); await write.promise })
  expect(within(row).getByRole('alert').textContent).toBe(dictionary.persistentNotSaved)
  fireEvent.click(within(row).getByRole('button'))
  await waitFor(() => { expect(within(row).queryByRole('alert')).toBeNull() })
  f.publish({ runtime: { value: { persistent: true, writable: true }, busy: false, error: null } })
  expect(within(row).getByRole('button', { name: dictionary.persistentSet }).hasAttribute('disabled')).toBe(true)
  expect(f.props.setPtcDefault).not.toHaveBeenCalled()
})

it('loads the runtime setting independently and reports unavailable and read-only configurations', () => {
  const f = fixture()
  f.publish({ runtime: { value: null, busy: true, error: null } })
  render(<PermissionPanel {...f.props} />)
  const row = screen.getByRole('group', { name: en.persistentTitle })
  expect(within(row).queryByRole('button')).toBeNull()
  expect(screen.getByRole('button', { name: en.defaultSet })).toBeTruthy()
  f.publish({ runtime: { value: null, busy: false, error: 'offline' } })
  expect(within(row).getByRole('alert').textContent).toBe(en.persistentUnavailable)
  f.publish({ runtime: { value: { persistent: false, writable: false }, busy: false, error: null } })
  expect(within(row).getByRole('alert').textContent).toBe(en.persistentReadOnly)
  expect(within(row).getByRole('button').hasAttribute('disabled')).toBe(true)
  expect(f.props.setPersistentPtc).not.toHaveBeenCalled()
})


it('retains uncertainty and the diagnostic until a refresh succeeds', () => {
  const f = fixture()
  f.publish(observe(value))
  render(<PermissionPanel {...f.props} />)
  f.publish({ system: { value: value.system, busy: true, error: 'stale error' }, busy: true })
  for (const button of screen.getAllByRole('button', { name: en.unknown })) expect(button.hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('alert').textContent).toContain('stale error')
})


it('retains a known read-only configuration and query failure throughout management and refresh', () => {
  const f = fixture()
  f.preset.set({ ...f.preset.getSnapshot(), value: { default: 'standard' }, writable: false })
  f.publish({ ...observe(value), runtime: { value: { persistent: false, writable: false }, busy: false, error: null },
    applications: { value, busy: false, error: 'offline' } })
  const view = render(<PermissionPanel {...f.props} />)
  const readonly = screen.getByText(en.persistentReadOnly)
  const defaultReadonly = screen.getByText(en.defaultReadOnly)
  act(() => { f.preset.set({ ...f.preset.getSnapshot(), status: 'loading' }) })
  const query = screen.getByText(en.applicationsFailed.replace('{message}', 'offline'))
  f.publish({ changing: true, busy: true,
    runtime: { ...f.state.getSnapshot().runtime, busy: true },
    applications: { ...f.state.getSnapshot().applications, busy: true } })
  expect(screen.getByText(en.persistentReadOnly)).toBe(readonly)
  expect(screen.getByText(en.defaultReadOnly)).toBe(defaultReadonly)
  expect(screen.getByText(en.applicationsFailed.replace('{message}', 'offline'))).toBe(query)
  view.unmount()
  expect(f.state.getSnapshot().changing).toBe(true)
})
