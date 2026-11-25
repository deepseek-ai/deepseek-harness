// @vitest-environment jsdom
/** Permission UI distinguishes missing privileges, uncertainty, and application consent. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CuaApplicationId, CuaApplicationState, CuaSystemPermissionState } from '../src/access-types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { PermissionPanel, PermissionSetup, PermissionToast, type PermissionProps } from '../src/client/PermissionPanel.tsx'
import type { PermissionView } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })
const value: CuaApplicationState & { system: Extract<CuaSystemPermissionState, { platform: 'darwin' }> } = { system: { platform: 'darwin' as const, accessibility: false, screenRecording: true,
  helper: { pid: 9, path: '/native/helper' }, parent: { pid: 8, path: '/host/node' } },
allowedApps: [], blockedApps: [], persistentAvailable: true }

function observe(value: CuaApplicationState & { system: CuaSystemPermissionState }) {
  return { system: { value: value.system, busy: false, error: null },
    applications: { value, busy: false, error: null },
    icons: { value: {}, busy: false, error: null }, busy: false }
}

function fixture() {
  const state = createSnapshotStore<PermissionView>({
    windowsProvider: { value: null, busy: false, error: null },
    system: { value: null, busy: true, error: null }, applications: { value: null, busy: true, error: null },
    icons: { value: null, busy: true, error: null }, busy: true, changing: false, toast: null,
  })
  const refresh = vi.fn()
  const props = { useCuaPermissions: bindSnapshotSelector(state), t: makeTranslate(en),
    refresh, request: vi.fn(), openSettings: vi.fn(), revoke: vi.fn(),
    retryApproval: vi.fn(), dismissToast: vi.fn(),
  } satisfies PermissionProps
  return { state, props,
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

it('dismisses activation when permissions are ready', () => {
  const f = fixture(), onDismiss = vi.fn()
  f.publish({ ...observe({ ...value, system: { ...value.system, accessibility: true } }) })
  render(<PermissionSetup {...f.props} onDismiss={onDismiss} onOpenDetails={vi.fn()} />)
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
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

it.each([en, zh])('waits for platform identification before offering system permission actions', (dictionary) => {
  const f = fixture()
  render(<PermissionPanel {...f.props} t={makeTranslate(dictionary)} />)
  expect(screen.queryByRole('group', { name: dictionary.accessibility })).toBeNull()
  expect(screen.getByText(dictionary.permissionsIntro).getAttribute('aria-hidden')).toBe('true')
  f.publish({ system: { ...f.state.getSnapshot().system, busy: false, error: 'connection lost' }, busy: false })
  // The provider lookup has not answered yet, so neither platform's layout or failure appears.
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryAllByText(dictionary.unknown)).toHaveLength(0)
  expect(screen.getByText(dictionary.permissionsIntro).getAttribute('aria-hidden')).toBe('true')
  f.publish({ windowsProvider: { value: false, error: null, busy: false } })
  expect(screen.getAllByText(dictionary.unknown)).toHaveLength(2)
  expect(screen.queryByText(dictionary.granted)).toBeNull()
  expect(screen.queryByRole('button', { name: dictionary.request })).toBeNull()
  expect(screen.queryByRole('button', { name: dictionary.unknown })).toBeNull()
  expect(screen.queryByText(dictionary.permissionsIntro)).toBeNull()
  const alert = screen.getByRole('alert')
  expect(within(alert).getByText(dictionary.queryFailedHint)).toBeTruthy()
  const heading = screen.getByRole('heading', { name: dictionary.title })
  expect(heading.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(alert.compareDocumentPosition(screen.getByRole('group', { name: dictionary.accessibilityUse })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  f.publish({ ...observe({ ...value, system: { ...value.system, accessibility: true, screenRecording: false } }) })
  fireEvent.click(screen.getByRole('button', { name: dictionary.request }))
  expect(f.props.request).toHaveBeenCalledWith('screenRecording')
})

it('offers setup after inspection, permits dismissal, and dismisses once both privileges are observed', () => {
  const f = fixture(), onDismiss = vi.fn(), onOpenDetails = vi.fn()
  render(<PermissionSetup {...f.props} onDismiss={onDismiss} onOpenDetails={onOpenDetails} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  f.publish({ ...observe(value) })
  const dialog = screen.getByRole('dialog', { name: en.setupTitle })
  expect(within(dialog).getByText(en.setupBody)).toBeTruthy()
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

it.each(['/Applications/Calculator.app/Contents/MacOS/Calculator', 'C:\\Applications\\Calculator.exe'])(
  'shows the application name and icon with %s available as a tooltip', (executablePath) => {
    const f = fixture()
    render(<PermissionPanel {...f.props} />)
    f.publish({ ...observe({ ...value, allowedApps: [{ id: 'a'.repeat(64) as CuaApplicationId,
      name: 'Calculator', executablePath }] }),
    icons: { value: { [executablePath]: 'data:image/png;base64,aWNvbg==' }, busy: false, error: null }, busy: false })
    expect(screen.getByText('Calculator')).toBeTruthy()
    expect(screen.queryByText(executablePath)).toBeNull()
    const identity = screen.getByTitle(executablePath)
    expect(identity.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
  })

it('uses a Shell icon for a packaged application without an executable path', () => {
  const f = fixture(), iconPath = 'shell:AppsFolder\\Package!App'
  render(<PermissionPanel {...f.props} />)
  f.publish({ ...observe({ ...value, allowedApps: [{ id: 'b'.repeat(64) as CuaApplicationId, name: 'Notepad', iconPath }] }),
    icons: { value: { [iconPath]: 'data:image/png;base64,aWNvbg==' }, busy: false, error: null } })
  expect(screen.getByText('Notepad').closest('li')?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
})

it.each<CuaSystemPermissionState>([value.system,
  { platform: 'windows', sessionLocked: false, captureAvailable: true, elevated: false, helper: {} },
])('shows the same application groups and actions on $platform', (system) => {
  const f = fixture()
  const allowed = { id: 'b'.repeat(64) as CuaApplicationId, name: 'Allowed application' }
  const blocked = { id: 'c'.repeat(64) as CuaApplicationId, name: 'Blocked application' }
  render(<PermissionPanel {...f.props} />)
  f.publish(observe({ ...value, system, allowedApps: [allowed], blockedApps: [blocked] }))
  const applications = within(screen.getByRole('region', { name: en.applicationsTitle }))
  expect(applications.getAllByRole('heading').map(heading => heading.textContent))
    .toEqual([en.applicationsTitle, en.allowedApps, en.blockedApps])
  fireEvent.click(applications.getByRole('button', { name: en.revoke }))
  fireEvent.click(applications.getByRole('button', { name: en.retryApproval }))
  expect(f.props.revoke).toHaveBeenCalledWith(allowed.id)
  expect(f.props.retryApproval).toHaveBeenCalledWith(blocked.id)
  expect(screen.queryByText(en.noApps)).toBeNull()
})

it.each([en, zh])('shows system permissions with the target application beside each system permission', (dictionary) => {
  const f = fixture()
  render(<PermissionPanel {...f.props} t={makeTranslate(dictionary)} />)
  const application = { name: 'Visual Studio Code.app', path: '/Applications/Visual Studio Code.app', icon: 'data:image/png;base64,aWNvbg==' }
  f.publish({ ...observe({ ...value, system: { ...value.system, parent: { pid: 1, path: '/sbin/launchd' }, launchApplication: application } }) })
  const requirements = screen.getByRole('region', { name: dictionary.title })
  expect(within(requirements).getAllByRole('group')).toHaveLength(2)
  expect(screen.getByRole('region', { name: dictionary.applicationsTitle })).toBeTruthy()
  const accessibility = within(requirements).getByRole('group', { name: dictionary.accessibility })
  expect(within(accessibility).getByText(application.name)).toBeTruthy()
  expect(accessibility.textContent).toContain(dictionary.accessibilityPermission.replace('{application}', application.name))
  expect(accessibility.querySelector('img')?.getAttribute('src')).toBe(application.icon)
  const recording = within(requirements).getByRole('group', { name: dictionary.screenRecording })
  expect(within(recording).getByText(application.name)).toBeTruthy()
  expect(recording.textContent).toContain(dictionary.screenRecordingPermission.replace('{application}', application.name))
  expect(within(requirements).getByText(dictionary.permissionsIntro)).toBeTruthy()
  f.publish({ system: { ...f.state.getSnapshot().system, error: 'offline' } })
  expect(screen.queryByText(application.name)).toBeNull()
  expect(within(requirements).getByText(dictionary.permissionsIntro)).toBeTruthy()
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


it('shows both permissions as allowed without a redundant macOS footer', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} />)
  f.publish({ ...observe({ ...value, system: { ...value.system, accessibility: true, screenRecording: true } }) })
  expect(screen.getAllByText(en.granted)).toHaveLength(2)
  expect(screen.getByText(en.permissionsIntro)).toBeTruthy()
})


it('keeps system permissions visible before the first permission response', () => {
  const f = fixture()
  render(<PermissionPanel {...f.props} />)
  const requirements = screen.getByRole('region', { name: en.title })
  expect(within(requirements).getAllByRole('group')).toHaveLength(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: en.request })).toBeNull()
  for (const permission of [en.accessibilityUse, en.screenRecordingUse]) expect(within(screen.getByRole('group', { name: permission })).queryByRole('button')).toBeNull()
})

it('keeps content mounted and disables actions while management changes are pending', () => {
  const f = fixture()
  f.publish({ ...observe(value), system: { value: value.system, busy: false, error: 'provider is reloading' }, busy: false })
  f.publish({ changing: true })
  const view = render(<PermissionPanel {...f.props} />)
  const requirements = screen.getByRole('region', { name: en.title })
  expect(within(requirements).getAllByRole('group')).toHaveLength(2)
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

it('shows and revokes an application whose executable path is unavailable', () => {
  const f = fixture()
  const app = { id: 'a'.repeat(64) as CuaApplicationId, name: 'Path unavailable fixture' }
  f.publish({ ...observe({ ...value, allowedApps: [app] }) })
  render(<PermissionPanel {...f.props} />)
  const access = screen.getByRole('region', { name: en.applicationsTitle })
  const row = within(access).getByText(app.name).closest('li')!
  expect(row.querySelector('[title]')).toBeNull()
  expect(row.querySelector('img')).toBeNull()
  expect(row.querySelector('[aria-hidden]')).not.toBeNull()
  fireEvent.click(within(row).getByRole('button', { name: en.revoke }))
  expect(f.props.revoke).toHaveBeenCalledWith(app.id)
})

it('keeps new grants visible and revoked apps absent while icons load', () => {
  const f = fixture()
  const old = { id: 'a'.repeat(64) as CuaApplicationId, name: 'Revoked application', executablePath: '/old/app' }
  const app = { id: 'b'.repeat(64) as CuaApplicationId, name: 'New application', iconPath: 'shell:AppsFolder\\Package!App' }
  f.publish({ ...observe({ ...value, allowedApps: [old] }) })
  render(<PermissionPanel {...f.props} />)
  f.publish({ applications: { value: { ...value, allowedApps: [app] }, busy: false, error: null },
    icons: { value: {}, busy: true, error: null } })
  expect(screen.queryByText(old.name)).toBeNull()
  expect(screen.getByText(app.name)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.revoke }).hasAttribute('disabled')).toBe(false)
  f.publish({ icons: { value: { [old.executablePath]: 'data:image/png;base64,b2xk' }, busy: false, error: null } })
  expect(screen.queryByText(old.name)).toBeNull()
  expect(screen.getByText(app.name)).toBeTruthy()
  expect(screen.getByText(app.name).parentElement?.querySelector('img')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.revoke }))
  expect(f.props.revoke).toHaveBeenCalledWith(app.id)
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

it('retains uncertainty and the diagnostic until a refresh succeeds', () => {
  const f = fixture()
  f.publish(observe(value))
  render(<PermissionPanel {...f.props} />)
  f.publish({ system: { value: value.system, busy: true, error: 'stale error' }, busy: true })
  for (const button of screen.getAllByRole('button', { name: en.unknown })) expect(button.hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('alert').textContent).toContain('stale error')
})


it('retains a known query failure throughout management and refresh', () => {
  const f = fixture()
  f.publish({ ...observe(value),
    applications: { value, busy: false, error: 'offline' } })
  const view = render(<PermissionPanel {...f.props} />)
  const query = screen.getByText(en.applicationsFailed.replace('{message}', 'offline'))
  f.publish({ changing: true, busy: true,
    applications: { ...f.state.getSnapshot().applications, busy: true } })
  expect(screen.getByText(en.applicationsFailed.replace('{message}', 'offline'))).toBe(query)
  view.unmount()
  expect(f.state.getSnapshot().changing).toBe(true)
})

it.each([en, zh])('highlights the experimental notice and keeps the PTC recommendation separate', (dictionary) => {
  const f = fixture()
  f.publish({ ...observe(value) })
  render(<PermissionPanel {...f.props} t={makeTranslate(dictionary)} />)
  const note = screen.getByRole('note')
  expect(within(note).getByText(dictionary.previewNoticeTitle)).toBeTruthy()
  expect(within(note).getByText(dictionary.previewNotice)).toBeTruthy()
  expect(within(note).queryByText(dictionary.ptcRecommendation)).toBeNull()
  const ptc = screen.getByText(dictionary.ptcRecommendation)
  const heading = screen.getByRole('heading', { name: dictionary.title })
  expect(note.compareDocumentPosition(ptc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(ptc.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it.each([true, false, null] as const)('omits system permissions on Windows and places warnings above the experimental notice for lock=%s', (sessionLocked) => {
  const f = fixture()
  f.publish({ ...observe(value), system: { value: { platform: 'windows', sessionLocked, captureAvailable: true,
    elevated: false, helper: { path: 'C:\\helper.exe' } }, error: null, busy: false } })
  render(<PermissionPanel {...f.props} />)
  expect(screen.queryByRole('heading', { name: en.title })).toBeNull()
  expect(screen.queryByRole('region', { name: en.title })).toBeNull()
  expect(screen.queryByRole('group')).toBeNull()
  expect(screen.queryByRole('button', { name: en.request })).toBeNull()
  expect(screen.queryByRole('button', { name: en.granted })).toBeNull()
  expect(screen.queryByText('C:\\helper.exe')).toBeNull()
  expect(screen.queryByText(/helperPath/)).toBeNull()
  expect(screen.queryByText(/pnpm run build:native/)).toBeNull()
  const experimental = screen.getByText(en.previewNoticeTitle)
  const instructions = screen.getByText(en.windowsInstructions)
  const privileges = screen.getByText(en.standardPrivileges)
  const ptc = screen.getByText(en.ptcRecommendation)
  expect(experimental.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(instructions.compareDocumentPosition(privileges) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(privileges.compareDocumentPosition(ptc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  if (sessionLocked === true) {
    const note = screen.getByText(en.windowsLockedTitle).closest('[role="note"]')!
    expect(within(note as HTMLElement).getByText(en.windowsLockedBody)).toBeTruthy()
    expect(note.compareDocumentPosition(experimental) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  } else if (sessionLocked === null) {
    const note = screen.getByText(en.windowsSessionUnknownTitle).closest('[role="note"]')!
    expect(within(note as HTMLElement).getByText(en.windowsSessionUnknown)).toBeTruthy()
    expect(note.compareDocumentPosition(experimental) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
  // Standing desktop conditions never interrupt assistive technology.
  expect(screen.queryByRole('alert')).toBeNull()
  f.publish({ system: { value: { platform: 'windows', sessionLocked: false, captureAvailable: false,
    elevated: true, helper: {} }, error: null, busy: false } })
  expect(screen.queryByRole('alert')).toBeNull()
  // Administrator privileges add no warning; they only withhold the standard-privilege limitation.
  expect(screen.queryAllByRole('note').filter(note => note.textContent?.includes('administrator'))).toEqual([])
  const captureNotice = screen.getByText(en.windowsCaptureUnavailableTitle)
  expect(screen.getByText(en.windowsCaptureUnavailableNotice)).toBeTruthy()
  expect(captureNotice.compareDocumentPosition(experimental) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByText(en.standardPrivileges)).toBeNull()
  f.publish({ system: { ...f.state.getSnapshot().system, error: 'offline' } })
  const helperAlert = screen.getByRole('alert')
  expect(within(helperAlert).getByText(en.windowsHelperFailed.replace('{message}', 'offline'))).toBeTruthy()
  expect(within(helperAlert).getByText(en.queryFailedHint)).toBeTruthy()
  expect(helperAlert.compareDocumentPosition(experimental) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByText(en.windowsCaptureUnavailableTitle)).toBeNull()
  fireEvent.click(within(helperAlert).getByRole('button', { name: en.retry }))
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
})

it('shows the Windows helper warning above the experimental notice when startup fails before reporting platform', () => {
  const f = fixture()
  f.publish({ system: { value: null, error: 'Native helper not found', busy: false },
    windowsProvider: { value: true, error: null, busy: false } })
  render(<PermissionPanel {...f.props} />)
  expect(screen.queryByRole('heading', { name: en.title })).toBeNull()
  expect(screen.queryByRole('group')).toBeNull()
  const alert = screen.getByRole('alert')
  expect(within(alert).getByText(en.windowsHelperFailed.replace('{message}', 'Native helper not found'))).toBeTruthy()
  expect(within(alert).getByText(en.queryFailedHint)).toBeTruthy()
  const experimental = screen.getByText(en.previewNoticeTitle)
  expect(alert.compareDocumentPosition(experimental) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('reports a failed provider lookup instead of the native error until the platform is known', () => {
  const f = fixture()
  f.publish({ system: { value: null, error: 'helper missing', busy: false }, windowsProvider: { value: null, error: 'offline', busy: false } })
  render(<PermissionPanel {...f.props} />)
  const alert = screen.getByRole('alert')
  expect(within(alert).getByText(en.providerLookupFailed.replace('{message}', 'offline'))).toBeTruthy()
  expect(within(alert).getByText(en.queryFailedHint)).toBeTruthy()
  expect(screen.queryByText(en.queryFailed.replace('{message}', 'helper missing'))).toBeNull()
  fireEvent.click(within(alert).getByRole('button', { name: en.retry }))
  expect(f.props.refresh).toHaveBeenCalledTimes(2)
  f.publish({ system: { value: null, error: 'helper missing', busy: false }, windowsProvider: { value: false, error: null, busy: false } })
  expect(within(screen.getByRole('alert')).getByText(en.queryFailed.replace('{message}', 'helper missing'))).toBeTruthy()
  f.publish({ system: { value: value.system, error: null, busy: false } })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([[true, true], [false, true], [false, false], [null, true]] as const)('offers Windows setup for lock=%s and capture=%s', (sessionLocked, captureAvailable) => {
  const f = fixture(), onDismiss = vi.fn()
  f.publish({ system: { value: { platform: 'windows', sessionLocked, captureAvailable,
    elevated: false, helper: {} }, error: null, busy: false } })
  render(<PermissionSetup {...f.props} onDismiss={onDismiss} onOpenDetails={vi.fn()} />)
  const needsSetup = sessionLocked !== false || !captureAvailable
  expect(screen.queryByRole('dialog') !== null).toBe(needsSetup)
  if (needsSetup) {
    expect(screen.getByRole('dialog', { name: en.windowsSetupTitle })).toBeTruthy()
    const explanation = sessionLocked === null ? en.windowsSessionUnknown
      : sessionLocked ? en.windowsSetupBody : en.windowsCaptureUnavailable
    expect(screen.getByText(explanation)).toBeTruthy()
  } else expect(onDismiss).toHaveBeenCalledOnce()
})
