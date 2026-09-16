// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginEntryId } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import type { PluginManagerPageProps } from '../src/client/PluginManagerPage.tsx'
import { rowKey, type InstallState, type PackageRow, type PackageView, type PluginManagerState } from '../src/client/manager-store.ts'
import { en, type PluginManagerLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: PluginManagerLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as PluginManagerPageProps['t']

function pkg(overrides: Partial<PackageView> = {}): PackageView {
  return {
    name: 'dsh-better-sidebar',
    version: '0.16.0',
    installed: true,
    optional: false,
    enabled: true,
    rows: [],
    ...overrides,
  }
}

function row(overrides: Partial<PackageRow> = {}): PackageRow {
  return { entryId: 'include:sidebar' as PluginEntryId, rowId: 'sidebar', moduleName: 'dsh-better-sidebar', enabled: true, phase: 'active', ...overrides }
}

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', phase: 'idle', inputError: null, subject: null, runs: [], detailsOpen: false,
  installed: null, restartRequired: false, failure: null, approvedBuilds: [], enabling: false,
}

const READY: PluginManagerState = {
  status: 'ready',
  packages: [],
  busy: [],
  notice: null,
  install: IDLE_INSTALL,
  confirm: null,
  highlight: null,
}

function renderTab(state: Partial<PluginManagerState> = {}) {
  const store = createSnapshotStore<PluginManagerState>({ ...READY, ...state })
  const actions = {
    ensure: vi.fn(),
    refresh: vi.fn(),
    openInstall: vi.fn(),
    closeInstall: vi.fn(),
    editInstallSpec: vi.fn(),
    runInstall: vi.fn(),
    cancelInstall: vi.fn(),
    toggleInstallDetails: vi.fn(),
    approveBuildsAndRetry: vi.fn(),
    enableInstalled: vi.fn(),
    clearHighlight: vi.fn(),
    setEnabled: vi.fn(),
    uninstall: vi.fn(),
    confirm: vi.fn(),
    cancelConfirm: vi.fn(),
    setRowEnabled: vi.fn(),
    dismissNotice: vi.fn(),
  }
  const props = {
    t,
    ...actions,
    usePluginManager: bindSnapshotSelector(store),
  } as unknown as PluginManagerPageProps
  render(<PluginManagerPage {...props} />)
  return { store, actions, set: (next: Partial<PluginManagerState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) } }
}

describe('PluginManagerPage', () => {
  it('asks the store once mounted and renders the loading, unavailable, error, and empty states', () => {
    const { actions, set } = renderTab({ status: 'loading' })
    expect(actions.ensure).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.addPlugin })).toHaveProperty('disabled', true)
    set({ status: 'unavailable' })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    set({ status: 'error' })
    expect(screen.getByRole('alert').textContent).toBe(en.error)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(actions.refresh).toHaveBeenCalledTimes(2)
    set({ status: 'ready' })
    expect(screen.getByText(en.empty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.addPlugin }))
    expect(actions.openInstall).toHaveBeenCalledTimes(1)
  })

  it('lists the installed bundles as cards, the installation\'s offered ones as built in, and tags a problem the Host reports', () => {
    const { actions } = renderTab({
      packages: [
        pkg({ description: 'A sidebar.' }),
        pkg({ name: 'dsh-broken', enabled: false, error: { code: 'not-bundle' } }),
        pkg({ name: '@deepseek-ai/dsh-web-app', installed: false }),
        pkg({ name: 'dsh-protected', readOnlyReason: 'management-required' }),
        pkg({ name: '@acme/dsh-tool', enabled: false }),
        // Selected by the profile but not a bundle: a problem the person can switch off, in the profile's own group.
        pkg({ name: 'dsh-selected', installed: false, error: { code: 'not-bundle' } }),
        pkg({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true, enabled: false }),
      ],
      busy: ['dsh-protected'],
    })
    const cards = screen.getAllByRole('listitem')
    // The built-in group comes first.
    expect(cards.map(card => card.getAttribute('data-plugin-package'))).toEqual([
      '@deepseek-ai/dsh-experimental-agent-team-profile', 'dsh-better-sidebar', 'dsh-broken', 'dsh-protected', '@acme/dsh-tool', 'dsh-selected',
    ])
    expect(cards.map(card => card.getAttribute('data-plugin-status'))).toEqual(['disabled', 'running', 'problem', 'running', 'disabled', 'problem'])
    // Each group heads with its title and its bare count; the built-in card carries the official tag.
    expect(screen.getByRole('heading', { name: en.bundlesTitle })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.builtinTitle })).toBeTruthy()
    expect([...document.querySelectorAll('[data-plugin-count]')].map(count => count.textContent)).toEqual(['1', '5'])
    expect(screen.getAllByText(en.statusOfficial)).toHaveLength(1)
    // A scoped name reads without its scope and harness prefix.
    expect(screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'tool') })).toHaveProperty('disabled', false)
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(screen.getAllByText(en.statusProblem)).toHaveLength(2)
    // The switch acts on the bundle; a bundle the Host cannot read stays off, a protected one stays as it is.
    fireEvent.click(screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'better-sidebar') }))
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    expect(screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'broken') })).toHaveProperty('disabled', true)
    const locked = screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'protected') })
    expect(locked).toHaveProperty('disabled', true)
    expect(locked.getAttribute('title')).toBe(en.reasonManagementRequired)
  })

  it('opens a built-in bundle\'s page with its official tag and no uninstall, and switches it on', () => {
    const { actions } = renderTab({
      packages: [pkg({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true, enabled: false })],
    })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'experimental-agent-team-profile') }))
    const detail = document.querySelector('[data-plugin-detail]') as HTMLElement
    expect(within(detail).getByText(en.statusOfficial)).toBeTruthy()
    expect(within(detail).queryByRole('button', { name: en.uninstallLabel.replace('{name}', 'experimental-agent-team-profile') })).toBeNull()
    fireEvent.click(within(detail).getByRole('switch', { name: en.enableToggle.replace('{name}', 'experimental-agent-team-profile') }))
    expect(actions.setEnabled).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/dsh-experimental-agent-team-profile', true)
  })

  it('opens a guide under the field and drops an example into it', () => {
    const { actions } = renderTab({ install: { ...IDLE_INSTALL, open: true } })
    expect(screen.queryByText(en.installGuideIntro)).toBeNull()
    const toggle = screen.getByRole('button', { name: en.installGuideToggle })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: en.installGuideHide }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.installGuideIdNote)).toBeTruthy()
    expect(screen.getByText(en.installGuideGitExample)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.installGuideFillAria.replace('{example}', en.installGuideIdExample) }))
    expect(actions.editInstallSpec).toHaveBeenCalledExactlyOnceWith(en.installGuideIdExample)
    fireEvent.click(screen.getByRole('button', { name: en.installGuideHide }))
    expect(screen.queryByText(en.installGuideIntro)).toBeNull()
  })

  it('opens a bundle\'s page with its facts and rows, and uninstalls from it', () => {
    const { actions, set } = renderTab({
      packages: [pkg({
        description: 'A sidebar.',
        rows: [row(), row({ rowId: 'theme', moduleName: 'dsh-better-sidebar/theme', entryId: 'include:theme' as PluginEntryId, enabled: false, phase: null })],
      })],
    })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'better-sidebar') }))
    const detail = document.querySelector('[data-plugin-detail="dsh-better-sidebar"]') as HTMLElement
    expect(within(detail).getByRole('heading', { level: 3 }).textContent).toBe('better-sidebar')
    // The version sits beside the name as a tag; the crumb only leads back.
    expect(within(detail).getByText('v0.16.0')).toBeTruthy()
    // The full package name stays visible under the short name.
    expect(document.querySelector('[data-plugin-name]')?.textContent).toBe('dsh-better-sidebar')
    expect(within(detail).getByRole('button', { name: en.backToList }).textContent).toBe(en.crumbRoot)
    expect(within(detail).getByText('A sidebar.')).toBeTruthy()
    // The rows, in order, with their state and their module.
    const rows = within(detail).getAllByRole('listitem').filter(item => item.hasAttribute('data-plugin-row'))
    expect(rows.map(item => item.getAttribute('data-plugin-row'))).toEqual(['include:sidebar', 'include:theme'])
    expect(rows[1]?.getAttribute('data-state')).toBe('off')
    expect(within(detail).getByText(en.partsCountTotal.replace('{count}', '2'), { exact: false })).toBeTruthy()
    expect(within(detail).getByText('dsh-better-sidebar/theme')).toBeTruthy()
    expect(within(detail).getByText(en.rowPhaseActive)).toBeTruthy()
    expect(within(detail).getByText(en.partOff)).toBeTruthy()
    fireEvent.click(within(detail).getByRole('button', { name: en.uninstallLabel.replace('{name}', 'better-sidebar') }))
    expect(actions.uninstall).toHaveBeenCalledWith('dsh-better-sidebar')
    fireEvent.click(within(detail).getByRole('switch', { name: en.enableToggle.replace('{name}', 'better-sidebar') }))
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    // A problem and a protection the Host reports read on the page in the dictionary's words; the page leaves with the crumb.
    set({ packages: [pkg({ error: { code: 'operation-error', diagnostic: 'unreadable' }, readOnlyReason: 'management-required' })] })
    expect(within(detail).getByText(`${en.reasonLabel}: unreadable`)).toBeTruthy()
    expect(within(detail).getByText(en.reasonManagementRequired)).toBeTruthy()
    expect(within(detail).getByRole('button', { name: en.uninstallLabel.replace('{name}', 'better-sidebar') })).toHaveProperty('disabled', true)
    expect(within(detail).getByText(en.partsEmpty)).toBeTruthy()
    set({ packages: [pkg({ error: { code: 'not-bundle' } })] })
    expect(within(detail).getByText(`${en.reasonLabel}: ${en.reasonNotBundle}`)).toBeTruthy()
    set({ packages: [pkg({ error: { code: 'operation-error' } })] })
    expect(within(detail).getByText(`${en.reasonLabel}: ${en.reasonOperationError}`)).toBeTruthy()
    fireEvent.click(within(detail).getByRole('button', { name: en.backToList }))
    expect(document.querySelector('[data-plugin-detail]')).toBeNull()
    // A bundle without a description or a version says so; one that leaves the list drops back to the cards.
    const { version: _version, ...unversioned } = pkg()
    set({ packages: [unversioned] })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'better-sidebar') }))
    expect(screen.getByText(en.noDescription)).toBeTruthy()
    expect(document.querySelector('[data-plugin-version]')).toBeNull()
    set({ packages: [] })
    expect(document.querySelector('[data-plugin-detail]')).toBeNull()
    expect(screen.getByText(en.empty)).toBeTruthy()
  })

  it('switches the rows of a bundle that is on, filters a long list, and locks what the Host will not address', () => {
    const rows = Array.from({ length: 12 }, (_row, index): PackageRow => {
      const live = row({
        rowId: `row-${String(index)}`, entryId: `include:row-${String(index)}` as PluginEntryId,
        ...index === 1 ? { readOnlyReason: 'unaddressable' as const } : {},
        ...index === 3 ? { phase: 'failed' as const } : {},
        ...index === 4 ? { phase: 'loading' as const } : {},
      })
      if (index !== 2) return live
      // The third row has no live entry: nothing to switch.
      const { entryId: _entryId, ...unmounted } = live
      return { ...unmounted, enabled: false, phase: null }
    })
    const { actions, set } = renderTab({ packages: [pkg({ rows })], busy: [rowKey('include:row-5')] })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'better-sidebar') }))
    const detail = document.querySelector('[data-plugin-detail]') as HTMLElement
    expect(within(detail).getByText(`${en.partsCountTotal.replace('{count}', '12')} · ${en.partsCountRunning.replace('{count}', '9')} · ${en.partsCountOff.replace('{count}', '1')} · ${en.partsCountFailed.replace('{count}', '1')}`)).toBeTruthy()
    fireEvent.click(within(detail).getByRole('switch', { name: en.partToggle.replace('{name}', 'row-0') }))
    expect(actions.setRowEnabled).toHaveBeenCalledWith('include:row-0', false)
    // A protected row, a row without a live entry, and a row with a write in flight cannot be switched.
    const locked = within(detail).getByRole('switch', { name: en.partToggle.replace('{name}', 'row-1') })
    expect(locked).toHaveProperty('disabled', true)
    expect(locked.getAttribute('title')).toBe(en.reasonUnaddressable)
    expect(within(detail).getByRole('switch', { name: en.partToggle.replace('{name}', 'row-2') })).toHaveProperty('disabled', true)
    fireEvent.click(within(detail).getByRole('switch', { name: en.partToggle.replace('{name}', 'row-2') }))
    expect(actions.setRowEnabled).toHaveBeenCalledTimes(1)
    expect(within(detail).getByRole('switch', { name: en.partToggle.replace('{name}', 'row-5') })).toHaveProperty('disabled', true)
    expect(within(detail).getByText(en.rowPhaseFailed)).toBeTruthy()
    expect(within(detail).getByText(en.rowPhaseLoading)).toBeTruthy()
    expect(document.querySelector('[data-plugin-row="include:row-3"]')?.getAttribute('data-state')).toBe('failed')
    // A long list gets a filter; nothing matching says so.
    const filter = within(detail).getByRole('searchbox', { name: en.partsFilter })
    fireEvent.change(filter, { target: { value: 'ROW-1' } })
    expect(within(detail).getAllByRole('listitem').filter(item => item.hasAttribute('data-plugin-row'))).toHaveLength(3)
    fireEvent.change(filter, { target: { value: 'nothing' } })
    expect(within(detail).getByText(en.partsFilterEmpty)).toBeTruthy()
    fireEvent.change(filter, { target: { value: '' } })
    // A bundle that is off shows its rows without switches.
    set({ packages: [pkg({ enabled: false, rows: rows.slice(0, 2).map(item => ({ ...item, enabled: false, phase: null })) })] })
    expect(within(detail).queryByRole('switch', { name: en.partToggle.replace('{name}', 'row-0') })).toBeNull()
    expect(within(detail).getAllByText(en.partOff)).toHaveLength(2)
    // A row without a fiber, on a bundle that is on, reads idle.
    set({ packages: [pkg({ rows: [row({ phase: null })] })] })
    expect(within(detail).getByText(en.rowStateIdle)).toBeTruthy()
  })

  it('takes a spec, checks it, and words what the check refused', () => {
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true } })
    expect(screen.getByText(en.installDescription)).toBeTruthy()
    const install = () => screen.getByRole('button', { name: en.installRun })
    expect(install()).toHaveProperty('disabled', true)
    const field = screen.getByRole('textbox', { name: en.installSpecLabel })
    fireEvent.change(field, { target: { value: 'dsh-x' } })
    expect(actions.editInstallSpec).toHaveBeenCalledWith('dsh-x')
    expect(document.querySelector('[data-terminal]')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()

    set({ install: { ...IDLE_INSTALL, open: true, spec: ' dsh-x ' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.installSpecLabel }), { key: 'Enter' })
    fireEvent.click(install())
    expect(actions.runInstall).toHaveBeenCalledTimes(2)
    // The check keeps the field and the button inert.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'checking' } })
    expect(screen.getByRole('textbox', { name: en.installSpecLabel })).toHaveProperty('disabled', true)
    const checking = screen.getByRole('button', { name: en.installChecking })
    expect(checking).toHaveProperty('disabled', true)
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.installSpecLabel }), { key: 'Enter' })
    expect(actions.runInstall).toHaveBeenCalledTimes(2)

    // Each refusal reads under the field.
    const problems: [string, string][] = [
      ['invalid-spec', en.installProblemInvalid.replace('{reason}', 'r')],
      ['already-installed', en.installProblemInstalled],
      ['not-found', en.installProblemNotFound],
      ['not-a-package', en.installProblemNotPackage],
      ['not-a-bundle', en.installProblemNotBundle.replace('{reason}', 'r')],
      ['network', en.installProblemNetwork],
      ['unknown', en.installProblemUnknown.replace('{reason}', 'r')],
    ]
    for (const [problem, sentence] of problems) {
      set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', inputError: { problem: problem as never, reason: 'r' } } })
      expect(screen.getByRole('alert').textContent).toBe(sentence)
      expect(screen.getByRole('textbox', { name: en.installSpecLabel }).getAttribute('aria-invalid')).toBe('true')
    }
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)
  })

  it('shows the subject while installing, folds the pnpm output behind the details, and stops through the Host', () => {
    const subject = { spec: 'dsh-x', status: 'accepted', kind: 'registry', name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', bundle: true } as const
    const run = { jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/home/u/.dsh/profiles/web', output: 'Progress: resolved \x1b[96m1\x1b[39m\n' }
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, runs: [run] } })
    expect(screen.getByRole('status').textContent).toBe(en.installingTitle)
    expect(screen.getByText('dsh-x')).toBeTruthy()
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(screen.getByText(en.installVersion.replace('{version}', '1.4.2'))).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    // The output stays folded until asked for.
    expect(document.querySelector('[data-terminal]')).toBeNull()
    const details = screen.getByRole('button', { name: en.installDetailsShow })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(details)
    expect(actions.toggleInstallDetails).toHaveBeenCalledTimes(1)
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, runs: [run], detailsOpen: true } })
    expect(screen.getByRole('button', { name: en.installDetailsHide }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.installLocation.replace('{dir}', '/home/u/.dsh/profiles/web'))).toBeTruthy()
    // The run streams as a terminal: its command line, its coloured output so far, the running label.
    expect(screen.getByText('pnpm add dsh-x')).toBeTruthy()
    const terminal = document.querySelector('[data-terminal]') as HTMLElement
    expect(terminal.hasAttribute('data-running')).toBe(true)
    expect(within(terminal).getByText('1').getAttribute('style')).toContain('--dsw-static-blue-500')
    expect(within(terminal).getByText(en.terminalRunning)).toBeTruthy()
    // A long log folds its middle behind an expand control, so the dialog keeps its height while pnpm talks.
    const lines = Array.from({ length: 15 }, (_line, index) => `line ${String(index + 1)}`).join('\n')
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, detailsOpen: true, runs: [{ ...run, output: `${lines}\n` }] } })
    expect(screen.queryByText('line 8')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.terminalExpandAria.replace('{n}', '3') }))
    expect(screen.getByText('line 8')).toBeTruthy()
    // Before the first chunk there is no location to name.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, detailsOpen: true } })
    expect(screen.getByText(en.terminalNoOutput)).toBeTruthy()
    // Cancel and the back control each ask the Host to stop the run; close waits for the Host's word.
    fireEvent.click(screen.getByRole('button', { name: en.installCancel }))
    fireEvent.click(screen.getByRole('button', { name: en.installEditAria }))
    expect(actions.cancelInstall).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: en.close })).toHaveProperty('disabled', true)
    expect(actions.closeInstall).not.toHaveBeenCalled()
  })

  it('waits with the Host through starting, stopping, and applying, and words an unconfirmed stop', () => {
    const subject = { spec: 'slow', status: 'accepted', kind: 'registry', name: 'slow', bundle: true } as const
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'starting', subject } })
    // Before the Host acknowledges the run there is nothing to stop: cancel, back, and close all wait.
    expect(screen.getByRole('status').textContent).toBe(en.installStarting)
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.installEditAria })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.close })).toHaveProperty('disabled', true)
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'running', subject } })
    fireEvent.click(screen.getByRole('button', { name: en.installCancel }))
    fireEvent.click(screen.getByRole('button', { name: en.installEditAria }))
    expect(actions.cancelInstall).toHaveBeenCalledTimes(2)
    // While the Host stops the run the terminal reads as cancelled rather than failed.
    set({
      install: {
        ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'cancelling', subject, detailsOpen: true,
        runs: [{ jobId: 'j', command: 'pnpm add slow', cwd: '/p', output: '', exitCode: null }],
      },
    })
    expect(screen.getByRole('status').textContent).toBe(en.installCancelling)
    expect(screen.getByRole('button', { name: en.installCancelling })).toHaveProperty('disabled', true)
    expect(within(document.querySelector('[data-terminal]') as HTMLElement).getByText(en.installCancelledShort)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'applying', subject } })
    expect(screen.getByRole('status').textContent).toBe(en.installApplying)
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', true)
    // A stop the Host could not confirm says so over the running screen.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'running', subject, failure: { reason: 'offline', cancelUnconfirmed: true } } })
    expect(screen.getByRole('alert').textContent).toContain('offline')
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', false)
  })

  it('offers to enable what a finished install added, and says when it waits for a restart', () => {
    const subject = { spec: '/plugins/dsh-x', status: 'accepted', kind: 'path', name: 'dsh-x', bundle: true } as const
    const { actions, set } = renderTab({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: '/plugins/dsh-x',
        phase: 'done',
        subject,
        runs: [{ jobId: 'j1', command: 'pnpm add /plugins/dsh-x', cwd: '/p', output: 'Done in 1s\n', exitCode: 0 }],
        installed: 'dsh-x',
      },
    })
    expect(screen.getByText(en.installedTitle)).toBeTruthy()
    // A path without a description reads by its kind.
    expect(screen.getByText('dsh-x')).toBeTruthy()
    expect(screen.getByText(en.installSubjectPath)).toBeTruthy()
    expect(screen.queryByText(en.installDoneRestart)).toBeNull()
    // No way back to the spec from here; enabling is the one action.
    expect(screen.queryByRole('button', { name: en.installEditAria })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installEnableNow }))
    expect(actions.enableInstalled).toHaveBeenCalledTimes(1)
    set({ install: { ...IDLE_INSTALL, open: true, spec: '/plugins/dsh-x', phase: 'done', subject, installed: 'dsh-x', restartRequired: true, enabling: true } })
    expect(screen.getByRole('button', { name: en.installEnableNow })).toHaveProperty('disabled', true)
    expect(screen.getByText(en.installDoneRestart)).toBeTruthy()

    // A run that named no bundle leaves only Done.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'done', subject: { spec: 'dsh-x', status: 'accepted', kind: 'registry', name: 'dsh-x', bundle: true } } })
    expect(screen.getByText(en.installDoneNothing)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installEnableNow })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installClose }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)
  })

  it('asks to allow the scripts a blocked install left pending, retries with them, and says what was allowed', () => {
    const subject = { spec: 'dsh-x', status: 'accepted', kind: 'registry', name: 'dsh-x', bundle: true } as const
    const { actions, set } = renderTab({
      install: {
        ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', subject,
        failure: { reason: 'ERR', kind: 'build-blocked', pendingBuilds: ['native', '@scope/other'] },
      },
    })
    expect(screen.getByText(en.installFailureBuildBlocked)).toBeTruthy()
    const group = screen.getByRole('group', { name: en.installApprovalTitle })
    expect(within(group).getByText('native')).toBeTruthy()
    expect(within(group).getByText('@scope/other')).toBeTruthy()
    expect(within(group).getByText(en.installApprovalCaution)).toBeTruthy()
    // Plain retry would fail the same way, so only the approval is offered.
    expect(screen.queryByRole('button', { name: en.installRetry })).toBeNull()
    fireEvent.click(within(group).getByRole('button', { name: en.installApproveAndRetry }))
    expect(actions.approveBuildsAndRetry).toHaveBeenCalledTimes(1)
    // Without the pending names the failure reads as the manual instruction, and plain retry is back.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', subject, failure: { reason: 'ERR', kind: 'build-blocked' } } })
    expect(screen.getByText(en.installFailureBuildBlockedManual)).toBeTruthy()
    expect(screen.queryByRole('group', { name: en.installApprovalTitle })).toBeNull()
    expect(screen.getByRole('button', { name: en.installRetry })).toBeTruthy()
    // The installed screen says which scripts were allowed.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'done', subject, installed: 'dsh-x', approvedBuilds: ['native'] } })
    expect(screen.getByText(en.installDoneApproved.replace('{names}', 'native'))).toBeTruthy()
  })

  it('words a failed install by its kind, else in the Host\'s words, and retries it', () => {
    const subject = { spec: 'github:a/b', status: 'accepted', kind: 'git', bundle: null } as const
    const { actions, set } = renderTab({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: 'github:a/b',
        phase: 'failed',
        subject,
        detailsOpen: true,
        runs: [{ jobId: 'j1', command: 'pnpm add github:a/b', cwd: '/p', output: 'ERR\n', exitCode: 1 }],
        failure: { reason: 'ERR\n', kind: 'network' },
      },
    })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailedTitle)
    expect(screen.getByText(en.installFailureNetwork)).toBeTruthy()
    // A git spec without a manifest reads by its address and kind.
    expect(screen.getByText('github:a/b')).toBeTruthy()
    expect(screen.getByText(en.installSubjectGit)).toBeTruthy()
    expect(screen.getByText(en.terminalExitCode.replace('{code}', '1'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.installRetry }))
    expect(actions.runInstall).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.installEditAria }))
    expect(actions.cancelInstall).toHaveBeenCalledTimes(1)

    const kinds: [string, string][] = [
      ['pnpm-missing', en.installFailurePnpmMissing], ['timeout', en.installFailureTimeout],
      ['not-found', en.installFailureNotFound], ['no-matching-version', en.installFailureNoMatchingVersion],
      ['disk-full', en.installFailureDiskFull], ['permission', en.installFailurePermission],
      ['build-blocked', en.installFailureBuildBlockedManual], ['integrity', en.installFailureIntegrity], ['unknown', en.installFailureGeneric],
    ]
    for (const [kind, sentence] of kinds) {
      set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: 'r', kind: kind as never } } })
      expect(screen.getByText(sentence)).toBeTruthy()
    }
    // A failure without a kind reads by its code, else in the Host's words; without words, or without a failure at all, generically.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: '', code: 'not-bundle' } } })
    expect(screen.getByText(en.reasonNotBundle)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: 'ERR_PNPM_ADDING_TO_ROOT', code: 'operation-error' } } })
    expect(screen.getByText('ERR_PNPM_ADDING_TO_ROOT')).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: 'the transport said so' } } })
    expect(screen.getByText('the transport said so')).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: '' } } })
    expect(screen.getByText(en.installFailureGeneric)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: null } })
    expect(screen.getByText(en.installFailureGeneric)).toBeTruthy()
    // A tarball spec reads by its kind too.
    set({ install: { ...IDLE_INSTALL, open: true, spec: '/p/x.tgz', phase: 'failed', subject: { spec: '/p/x.tgz', status: 'accepted', kind: 'tarball', bundle: null }, failure: null } })
    expect(screen.getByText(en.installSubjectTarball)).toBeTruthy()
  })

  it('scrolls to and marks the package an install enabled, then lets the mark go', () => {
    vi.useFakeTimers()
    const scrollIntoView = vi.fn()
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true })
    try {
      const { actions, set } = renderTab({ packages: [pkg()] })
      // A package the list does not show has nothing to scroll to; the mark still times out.
      set({ highlight: 'missing' })
      expect(scrollIntoView).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(2_400) })
      expect(actions.clearHighlight).toHaveBeenCalledTimes(1)
      set({ highlight: 'dsh-better-sidebar' })
      expect(document.querySelector('[data-plugin-package="dsh-better-sidebar"]')?.hasAttribute('data-plugin-highlight')).toBe(true)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
      act(() => { vi.advanceTimersByTime(2_400) })
      expect(actions.clearHighlight).toHaveBeenCalledTimes(2)
      set({ highlight: null })
      expect(document.querySelector('[data-plugin-package="dsh-better-sidebar"]')?.hasAttribute('data-plugin-highlight')).toBe(false)
    } finally {
      if (descriptor === undefined) delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
      else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
      vi.useRealTimers()
    }
  })

  it('marks a card without a scrollIntoView to call', () => {
    vi.useFakeTimers()
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    try {
      const { set } = renderTab({ packages: [pkg()] })
      set({ highlight: 'dsh-better-sidebar' })
      expect(document.querySelector('[data-plugin-package="dsh-better-sidebar"]')?.hasAttribute('data-plugin-highlight')).toBe(true)
    } finally {
      if (descriptor !== undefined) Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
      vi.useRealTimers()
    }
  })

  it('confirms an uninstall by the package\'s title and runs the action through it', () => {
    const { actions, set } = renderTab({
      packages: [pkg(), pkg({ name: 'dsh-other' })],
      confirm: { action: 'uninstall', packageName: 'dsh-better-sidebar' },
    })
    expect(screen.getByRole('dialog', { name: en.confirmUninstallTitle.replace('{name}', 'better-sidebar') })).toBeTruthy()
    expect(screen.getByText(en.confirmUninstallDescription)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.cancelConfirm).toHaveBeenCalledTimes(1)
    set({ confirm: { action: 'uninstall', packageName: 'dsh-other' } })
    expect(screen.getByRole('dialog', { name: en.confirmUninstallTitle.replace('{name}', 'other') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.confirmUninstall }))
    expect(actions.confirm).toHaveBeenCalledTimes(1)
  })

  it('words every notice as a toast that dismisses itself', () => {
    vi.useFakeTimers()
    try {
      const { actions, set } = renderTab({ notice: { kind: 'restart', packageName: 'x', seq: 1 } })
      expect(screen.getByRole('alert').textContent).toContain(en.restartNotice)
      set({ notice: { kind: 'overridden', packageName: 'pkg-1', seq: 2 } })
      expect(screen.getByRole('alert').textContent).toContain(en.overriddenNotice.replace('{name}', 'pkg-1'))
      set({ notice: { kind: 'cancelled', seq: 3 } })
      expect(screen.getByRole('alert').textContent).toContain(en.installCancelled)
      // A failure names what was being done; a refusal is worded by its code, a silent one generically.
      set({ notice: { kind: 'failed', action: 'enable', reason: 'the tree rejected it', packageName: 'pkg-1', seq: 4 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedEnable.replace('{reason}', 'the tree rejected it'))
      set({ notice: { kind: 'failed', action: 'uninstall', code: 'bundle-in-use', reason: '', packageName: 'pkg-1', seq: 5 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedUninstall.replace('{reason}', en.reasonBundleInUse))
      set({ notice: { kind: 'failed', action: 'rowDisable', code: 'operation-error', reason: 'EACCES', packageName: 'pkg-1', seq: 6 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedRowDisable.replace('{reason}', 'EACCES'))
      set({ notice: { kind: 'failed', action: 'disable', reason: '', packageName: 'pkg-1', seq: 7 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedDisable.replace('{reason}', en.reasonOperationError))
      set({ notice: { kind: 'failed', action: 'rowEnable', reason: 'x', packageName: 'pkg-1', seq: 8 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedRowEnable.replace('{reason}', 'x'))
      // No button to press: the toast retires on its own and the store forgets it.
      expect(screen.queryByRole('button', { name: /got it/i })).toBeNull()
      expect(actions.dismissNotice).not.toHaveBeenCalled()
      // The hold grows with the text, up to eight seconds, then the fade.
      act(() => { vi.advanceTimersByTime(8_000 + 1_000) })
      expect(actions.dismissNotice).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
