/**
 * The manager store: what it reads, how actions cross the wire, which
 * outcomes become toasts, and how the install run folds its output.
 */

import { describe, expect, it, vi } from 'vitest'
import type { BundleInfo, ChangeResult, ManagementError, PluginEntryId, PluginInfo, PluginInstallRequestId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { packageView, PluginManagerController, rowKey, sortPackages } from '../src/client/manager-store.ts'

const ROW_ENTRY = 'include:sidebar' as PluginEntryId

const BUNDLE: BundleInfo = {
  name: 'dsh-better-sidebar',
  version: '0.16.0',
  description: 'A sidebar.',
  enabled: false,
  installed: true,
  optional: false,
  removable: true,
  rows: [{ rowId: 'sidebar', moduleName: 'dsh-better-sidebar', entryId: ROW_ENTRY }, { rowId: 'theme', moduleName: 'dsh-better-sidebar/theme' }],
  overrides: [],
}

const PLUGINS: PluginInfo[] = [
  { entryId: ROW_ENTRY, moduleName: 'dsh-better-sidebar', enabled: true, fiberPhase: 'active', patchId: 'sidebar' },
  { entryId: 'include:core' as PluginEntryId, moduleName: '@deepseek-ai/dsh-base', enabled: true, fiberPhase: 'active', readOnlyReason: 'management-required' },
]

/** What the check answers for a registry name. */
const INSPECTED = { status: 'accepted' as const, kind: 'registry' as const, name: 'dsh-better-sidebar', version: '1.0.0', bundle: true }

const APPLIED: ChangeResult = { changed: true, application: 'applied', stage: 'enable', target: 'dsh-better-sidebar' }

/** A change the Host could not apply, with the refusal it names. */
function failed(error?: ManagementError, packageResult?: ChangeResult['packageResult']): ChangeResult {
  return {
    changed: false, application: 'failed', stage: 'enable', target: 'dsh-better-sidebar',
    ...error === undefined ? {} : { error }, ...packageResult === undefined ? {} : { packageResult },
  }
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function refused(code: string, message: string, details: object = {}) {
  // The double's code map is keyed by literal codes; a spec-chosen string stands in.
  return { ok: false as const, error: new RemoteError(code as never, message, details as never) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function bench(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const inventory = { list: overrides.inventory ?? vi.fn(() => Promise.resolve(ok({ entries: [], managementAvailable: true }))) }
  const plugins = {
    listBundles: vi.fn(() => Promise.resolve(ok([BUNDLE]))),
    listPlugins: vi.fn(() => Promise.resolve(ok(PLUGINS))),
    inspect: vi.fn(() => Promise.resolve(ok(INSPECTED))),
    installBundle: vi.fn(() => Promise.resolve(ok({ ...APPLIED, bundle: 'dsh-new' }))),
    cancelInstall: vi.fn(() => Promise.resolve(ok({ status: 'cancelled' }))),
    removeBundle: vi.fn(() => Promise.resolve(ok(APPLIED))),
    setBundleEnabled: vi.fn(() => Promise.resolve(ok(APPLIED))),
    setPluginEnabled: vi.fn(() => Promise.resolve(ok(APPLIED))),
    ...overrides,
  }
  const ctx = { remote: { pluginManager: plugins, pluginInventory: inventory } } as never
  const controller = new PluginManagerController(ctx)
  const face = controller.inject()
  const state = () => controller.getSnapshot()
  /** The request id of the run the dialog just handed to the Host. */
  const started = async (): Promise<PluginInstallRequestId> => {
    await vi.waitFor(() => { expect(state().install.phase).toBe('starting') })
    return state().install.requestId as PluginInstallRequestId
  }
  return { plugins, inventory, controller, face, state, started }
}

describe('packageView', () => {
  it('joins a bundle with the entries its rows run as', () => {
    expect(packageView(BUNDLE, PLUGINS)).toEqual({
      name: 'dsh-better-sidebar', version: '0.16.0', description: 'A sidebar.',
      installed: true, optional: false, enabled: false,
      rows: [
        { rowId: 'sidebar', moduleName: 'dsh-better-sidebar', entryId: ROW_ENTRY, enabled: true, phase: 'active' },
        { rowId: 'theme', moduleName: 'dsh-better-sidebar/theme', enabled: false, phase: null },
      ],
    })
    // A row the inventory no longer lists, a protected row, and a bundle the Host cannot read.
    const protectedBundle: BundleInfo = {
      name: '@deepseek-ai/dsh-base', enabled: true, installed: false, optional: false, removable: false, readOnlyReason: 'management-required',
      error: { code: 'operation-error', diagnostic: 'broken' },
      rows: [{ rowId: 'core', moduleName: '@deepseek-ai/dsh-base', entryId: 'include:core' as PluginEntryId }, { rowId: 'gone', moduleName: 'x', entryId: 'include:gone' as PluginEntryId }],
      overrides: [],
    }
    expect(packageView(protectedBundle, PLUGINS)).toEqual({
      name: '@deepseek-ai/dsh-base', installed: false, optional: false, enabled: true, readOnlyReason: 'management-required',
      error: { code: 'operation-error', diagnostic: 'broken' },
      rows: [
        { rowId: 'core', moduleName: '@deepseek-ai/dsh-base', entryId: 'include:core', enabled: true, phase: 'active', readOnlyReason: 'management-required' },
        { rowId: 'gone', moduleName: 'x', entryId: 'include:gone', enabled: false, phase: null },
      ],
    })
  })
})

describe('sortPackages', () => {
  it('orders packages by the short name a person reads, not by the Host order or enablement', async () => {
    const plain = { enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] }
    const zeta: BundleInfo = { ...plain, name: 'dsh-zeta' }
    const alpha: BundleInfo = { ...plain, name: '@acme/dsh-alpha', enabled: false }
    const views = [zeta, BUNDLE, alpha].map(bundle => packageView(bundle, PLUGINS))
    expect(sortPackages(views).map(pkg => pkg.name)).toEqual(['@acme/dsh-alpha', 'dsh-better-sidebar', 'dsh-zeta'])
    // The store lists what it read in that order, whatever the Host's order.
    const { state, controller } = bench({ listBundles: vi.fn(() => Promise.resolve(ok([zeta, BUNDLE, alpha]))) })
    await controller.load()
    expect(state().packages.map(pkg => pkg.name)).toEqual(['@acme/dsh-alpha', 'dsh-better-sidebar', 'dsh-zeta'])
  })
})

describe('PluginManagerController', () => {
  it('starts idle, reads the inventory then the bundles and entries on first use, and folds concurrent loads', async () => {
    const gate = deferred<ReturnType<typeof ok<BundleInfo[]>>>()
    const { plugins, inventory, face, state, controller } = bench({
      listBundles: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(ok([BUNDLE])),
    })
    expect(state().status).toBe('idle')
    face.ensure()
    face.ensure()
    await Promise.resolve()
    expect(state().status).toBe('loading')
    const mid = controller.load()
    gate.resolve(ok([BUNDLE]))
    await mid
    expect(state().status).toBe('ready')
    expect(state().packages).toEqual([packageView(BUNDLE, PLUGINS)])
    expect(inventory.list).toHaveBeenCalledTimes(2)
    expect(plugins.listBundles).toHaveBeenCalledTimes(2)
    expect(plugins.listPlugins).toHaveBeenCalledTimes(2)
    face.ensure()
    expect(plugins.listBundles).toHaveBeenCalledTimes(2)
  })

  it('reports a Host without a managed profile as unavailable and keeps the last packages across a failed read', async () => {
    const { inventory, plugins, face, state, controller } = bench()
    await controller.load()
    expect(state().packages).toHaveLength(1)
    inventory.list.mockResolvedValueOnce(ok({ entries: [] }))
    await controller.load()
    expect(state()).toMatchObject({ status: 'unavailable', packages: [] })
    inventory.list.mockResolvedValueOnce(refused('gateway/internal', 'offline'))
    await controller.load()
    expect(state().status).toBe('error')
    await controller.load()
    expect(state().status).toBe('ready')
    plugins.listPlugins.mockResolvedValueOnce(refused('gateway/internal', 'offline') as never)
    await controller.load()
    expect(state()).toMatchObject({ status: 'error', packages: [packageView(BUNDLE, PLUGINS)] })
    plugins.listBundles.mockResolvedValueOnce(refused('gateway/internal', 'offline') as never)
    await controller.load()
    expect(state().status).toBe('error')
    face.refresh()
    await vi.waitFor(() => { expect(state().status).toBe('ready') })
  })

  it('enables a bundle, marks it busy meanwhile, and says when a restart is needed or a layer overrides it', async () => {
    const gate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { plugins, face, state, controller } = bench({
      setBundleEnabled: vi.fn()
        .mockReturnValueOnce(gate.promise)
        .mockResolvedValueOnce(ok({ ...APPLIED, application: 'restart-required' }))
        .mockResolvedValueOnce(ok({ ...APPLIED, application: 'overridden' })),
    })
    await controller.load()
    face.setEnabled(BUNDLE.name, true)
    face.setEnabled(BUNDLE.name, true)
    await Promise.resolve()
    expect(state().busy).toEqual([BUNDLE.name])
    expect(plugins.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(BUNDLE.name, true)
    gate.resolve(ok(APPLIED))
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    expect(state().notice).toBeNull()
    expect(plugins.listBundles).toHaveBeenCalledTimes(2)
    face.setEnabled(BUNDLE.name, false)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'restart', packageName: BUNDLE.name, seq: 1 }) })
    face.setEnabled(BUNDLE.name, false)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'overridden', packageName: BUNDLE.name, seq: 2 }) })
  })

  it('turns a change the Host could not apply, or a refused answer, into a notice carrying its code and words', async () => {
    const { face, state, controller } = bench({
      setBundleEnabled: vi.fn()
        .mockResolvedValueOnce(ok(failed({ code: 'operation-error', diagnostic: 'the tree rejected it' })))
        .mockResolvedValueOnce(refused('gateway/internal', 'offline'))
        .mockRejectedValueOnce(new Error('transport down'))
        .mockRejectedValueOnce('odd')
        .mockResolvedValueOnce(ok(failed({ code: 'bundle-in-use' })))
        .mockResolvedValueOnce(ok(failed()))
        .mockResolvedValueOnce(ok({ ...failed(), application: 'cancelled' })),
    })
    await controller.load()
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'enable', code: 'operation-error', reason: 'the tree rejected it', packageName: BUNDLE.name, seq: 1 }) })
    face.setEnabled(BUNDLE.name, false)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'disable', reason: 'offline', packageName: BUNDLE.name, seq: 2 }) })
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'enable', reason: 'transport down', packageName: BUNDLE.name, seq: 3 }) })
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'enable', reason: 'odd', packageName: BUNDLE.name, seq: 4 }) })
    // A refusal keeps its code with no words of its own; a failure without a code has neither.
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'enable', code: 'bundle-in-use', reason: '', packageName: BUNDLE.name, seq: 5 }) })
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'enable', reason: '', packageName: BUNDLE.name, seq: 6 }) })
    // A change the Host stopped is said in passing.
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'cancelled', seq: 7 }) })
    face.dismissNotice()
    expect(state().notice).toBeNull()
  })

  it('always asks before uninstalling, and cancelling runs nothing', async () => {
    const { plugins, face, state, controller } = bench()
    await controller.load()
    face.uninstall(BUNDLE.name)
    expect(state().confirm).toEqual({ action: 'uninstall', packageName: BUNDLE.name })
    face.cancelConfirm()
    expect(state().confirm).toBeNull()
    face.confirm()
    expect(plugins.removeBundle).not.toHaveBeenCalled()
    face.uninstall(BUNDLE.name)
    face.confirm()
    expect(state().confirm).toBeNull()
    await vi.waitFor(() => { expect(plugins.removeBundle).toHaveBeenCalledExactlyOnceWith(BUNDLE.name) })
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    // A refused removal names the action it was.
    plugins.removeBundle.mockResolvedValueOnce(ok({ ...failed(), stage: 'remove', error: { code: 'not-removable' } }) as never)
    face.uninstall(BUNDLE.name)
    face.confirm()
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'uninstall', code: 'not-removable', reason: '', packageName: BUNDLE.name, seq: 1 }) })
  })

  it('switches rows under their own busy keys and reports what the Host said', async () => {
    const gate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { plugins, face, state, controller } = bench({
      setPluginEnabled: vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValueOnce(ok(failed({ code: 'unaddressable' }))),
    })
    await controller.load()
    face.setRowEnabled(ROW_ENTRY, false)
    face.setRowEnabled(ROW_ENTRY, false)
    await Promise.resolve()
    expect(state().busy).toEqual([rowKey(ROW_ENTRY)])
    expect(plugins.setPluginEnabled).toHaveBeenCalledExactlyOnceWith(ROW_ENTRY, false)
    gate.resolve(ok(APPLIED))
    await vi.waitFor(() => { expect(state().busy).toEqual([]) })
    face.setRowEnabled(ROW_ENTRY, true)
    await vi.waitFor(() => { expect(state().notice).toEqual({ kind: 'failed', action: 'rowEnable', code: 'unaddressable', reason: '', packageName: ROW_ENTRY, seq: 1 }) })
  })

  it('checks the spec, hands the run to the Host, and folds the chunks that carry its request id', async () => {
    const gate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { plugins, face, state, controller, started } = bench({ installBundle: vi.fn().mockReturnValueOnce(gate.promise) })
    await controller.load()
    face.runInstall()
    expect(plugins.inspect).not.toHaveBeenCalled()
    face.openInstall()
    expect(state().install).toMatchObject({ open: true, spec: '', phase: 'idle', inputError: null, subject: null })
    face.editInstallSpec('  dsh-new ')
    face.runInstall()
    face.runInstall()
    expect(state().install.phase).toBe('checking')
    // Neither typing nor a second run reaches the Host while it checks.
    face.editInstallSpec('other')
    expect(state().install.spec).toBe('  dsh-new ')
    expect(plugins.inspect).toHaveBeenCalledTimes(1)
    expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', expect.any(AbortSignal))
    const requestId = await started()
    expect(state().install.subject).toEqual({ spec: 'dsh-new', ...INSPECTED })
    expect(plugins.installBundle).toHaveBeenCalledTimes(1)
    expect(plugins.installBundle).toHaveBeenCalledWith('dsh-new', { enabled: false, requestId })
    // The Host's acknowledgement makes the run stoppable; a chunk of another request is not this run's.
    controller.installProgress({ requestId, phase: 'installing' })
    expect(state().install.phase).toBe('running')
    controller.appendLog({ requestId: 'other' as PluginInstallRequestId, jobId: 'j1', argv: [], cwd: '/p', stream: 'stdout', text: 'x' })
    expect(state().install.runs).toEqual([])
    const argv = ['pnpm', 'add', 'dsh-new']
    controller.appendLog({ requestId, jobId: 'j1', argv, cwd: '/p', stream: 'stdout', text: 'Progress\n' })
    // A second run of the same install is its own terminal; a later chunk lands on the run it names.
    controller.appendLog({ requestId, jobId: 'j2', argv: ['pnpm', 'remove', 'lib'], cwd: '/p', stream: 'stdout', text: '- lib\n', exitCode: 0 })
    controller.appendLog({ requestId, jobId: 'j1', argv, cwd: '/p', stream: 'stderr', text: 'Done\n' })
    expect(state().install.runs).toEqual([
      { jobId: 'j1', command: 'pnpm add dsh-new', cwd: '/p', output: 'Progress\nDone\n' },
      { jobId: 'j2', command: 'pnpm remove lib', cwd: '/p', output: '- lib\n', exitCode: 0 },
    ])
    face.toggleInstallDetails()
    expect(state().install.detailsOpen).toBe(true)
    gate.resolve(ok({ ...APPLIED, bundle: 'dsh-new' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(state().install).toMatchObject({ installed: 'dsh-new', restartRequired: false, detailsOpen: true })
    // The finished install settled its run; a trailing last chunk still lands
    // on it, while a chunk for a run the dialog never saw is dropped.
    controller.appendLog({ requestId, jobId: 'j1', argv, cwd: '/p', stream: 'stdout', text: '', exitCode: 0 })
    controller.appendLog({ requestId, jobId: 'j3', argv, cwd: '/p', stream: 'stdout', text: 'stray' })
    expect(state().install.runs).toEqual([
      { jobId: 'j1', command: 'pnpm add dsh-new', cwd: '/p', output: 'Progress\nDone\n', exitCode: 0 },
      { jobId: 'j2', command: 'pnpm remove lib', cwd: '/p', output: '- lib\n', exitCode: 0 },
    ])
    await vi.waitFor(() => { expect(plugins.listBundles).toHaveBeenCalledTimes(2) })
    // Cancelling from the finished screen does nothing, nor does the Host's late progress; a new spec after it starts over.
    face.cancelInstall()
    controller.installProgress({ requestId, phase: 'applying' })
    expect(state().install.phase).toBe('done')
    face.editInstallSpec('another')
    expect(state().install).toMatchObject({ phase: 'idle', spec: 'another', runs: [], installed: null, subject: null })
    face.closeInstall()
    expect(state().install.open).toBe(false)
  })

  it('refuses a spec the list already shows without asking the Host, and words what the Host refused', async () => {
    const { plugins, face, state, controller } = bench({
      inspect: vi.fn()
        .mockResolvedValueOnce(ok({ status: 'refused', problem: 'not-found', reason: 'E404' }))
        .mockResolvedValueOnce(ok({ status: 'refused', problem: 'not-a-bundle', reason: 'plain declares no dsh.bundle' }))
        .mockResolvedValueOnce(refused('gateway/internal', 'offline')),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec(BUNDLE.name)
    face.runInstall()
    expect(plugins.inspect).not.toHaveBeenCalled()
    expect(state().install).toMatchObject({ phase: 'idle', inputError: { problem: 'already-installed', reason: BUNDLE.name } })
    // Typing clears the refusal.
    face.editInstallSpec('nope')
    expect(state().install.inputError).toBeNull()
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.inputError).toEqual({ problem: 'not-found', reason: 'E404' }) })
    expect(state().install.phase).toBe('idle')
    expect(plugins.installBundle).not.toHaveBeenCalled()
    face.editInstallSpec('plain')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.inputError).toEqual({ problem: 'not-a-bundle', reason: 'plain declares no dsh.bundle' }) })
    // A refused answer, rather than a refused spec, reads as unknown with the transport's words.
    face.editInstallSpec('x')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.inputError).toEqual({ problem: 'unknown', reason: 'offline' }) })
  })

  it('leaves the check or the failed screen for the spec at once', async () => {
    const inspectGate = deferred<ReturnType<typeof ok<typeof INSPECTED>>>()
    const { plugins, face, state, controller } = bench({
      inspect: vi.fn().mockReturnValueOnce(inspectGate.promise).mockResolvedValue(ok(INSPECTED)),
      installBundle: vi.fn().mockResolvedValue(ok(failed({ code: 'operation-error', diagnostic: 'ERR' }, { exitCode: 1, output: 'ERR', truncated: false, logPath: '/l', kind: 'network' }))),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('dsh-x')
    face.runInstall()
    const checkSignal = (plugins.inspect.mock.calls[0] as unknown[])[1] as AbortSignal
    face.cancelInstall()
    expect(checkSignal.aborted).toBe(true)
    expect(state().install).toMatchObject({ open: true, phase: 'idle', spec: 'dsh-x', inputError: null })
    // The settlement of the dropped check changes nothing.
    inspectGate.resolve(ok(INSPECTED))
    await Promise.resolve()
    await Promise.resolve()
    expect(state().install.phase).toBe('idle')
    expect(plugins.installBundle).not.toHaveBeenCalled()
    // Closing during a check drops it too.
    face.runInstall()
    face.closeInstall()
    expect(state().install.open).toBe(false)
    expect((plugins.inspect.mock.calls[1] as unknown[])[1]).toMatchObject({ aborted: true })
    // From the failed screen the same control goes back to the spec.
    face.openInstall()
    face.editInstallSpec('dsh-x')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.failure).toEqual({ reason: 'ERR', code: 'operation-error', kind: 'network' })
    face.cancelInstall()
    expect(state().install).toMatchObject({ open: true, phase: 'idle', spec: 'dsh-x', failure: null, subject: null })
  })

  it('asks the Host to stop a run, keeps the spec once it confirms, and forgets the stopped run', async () => {
    const first = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const second = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const cancellation = deferred<ReturnType<typeof ok<{ status: 'cancelled' }>>>()
    const { plugins, face, state, controller, started } = bench({
      installBundle: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      cancelInstall: vi.fn().mockReturnValueOnce(cancellation.promise),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    // Before the Host acknowledges the run there is nothing to stop, and the dialog cannot close.
    face.cancelInstall()
    face.closeInstall()
    expect(plugins.cancelInstall).not.toHaveBeenCalled()
    expect(state().install).toMatchObject({ open: true, phase: 'starting' })
    controller.installProgress({ requestId, phase: 'installing' })
    face.cancelInstall()
    face.cancelInstall()
    face.closeInstall()
    face.openInstall()
    expect(plugins.cancelInstall).toHaveBeenCalledExactlyOnceWith(requestId)
    expect(state().install).toMatchObject({ phase: 'cancelling', open: true, spec: 'slow' })
    // A queued start cannot undo the request to stop; the Host's own cancelling phase is the same.
    controller.installProgress({ requestId, phase: 'installing' })
    controller.installProgress({ requestId, phase: 'cancelling' })
    expect(state().install.phase).toBe('cancelling')
    cancellation.resolve(ok({ status: 'cancelled' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('idle') })
    // The spec is offered again, the run is forgotten, and a toast says the Host stopped it.
    expect(state().install).toMatchObject({ open: true, spec: 'slow', subject: null, runs: [] })
    expect(state().install.requestId).toBeUndefined()
    expect(state().notice).toEqual({ kind: 'cancelled', seq: 1 })
    face.runInstall()
    const nextId = await started()
    expect(nextId).not.toBe(requestId)
    // The stopped run's answer, progress, and chunks belong to a request the dialog no longer has.
    first.resolve(ok({ ...failed(), application: 'cancelled' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(state().install).toMatchObject({ requestId: nextId, phase: 'starting' })
    controller.installProgress({ requestId, phase: 'applying' })
    controller.appendLog({ requestId, jobId: 'old', argv: [], cwd: '/p', stream: 'stdout', text: 'late' })
    expect(state().install).toMatchObject({ phase: 'starting', runs: [] })
    second.resolve(ok({ ...APPLIED, application: 'restart-required', bundle: 'slow' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(state().install).toMatchObject({ installed: 'slow', restartRequired: true })
  })

  it.each(['too-late', 'not-running', 'offline'] as const)('keeps a stop the Host answered %s apart from a stopped run', async (status) => {
    const pending = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { plugins, face, state, controller, started } = bench({
      installBundle: vi.fn().mockReturnValue(pending.promise),
      cancelInstall: vi.fn().mockResolvedValue(status === 'offline' ? refused('gateway/internal', 'offline') : ok({ status })),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    controller.installProgress({ requestId, phase: 'installing' })
    face.cancelInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe(status === 'too-late' ? 'applying' : 'running') })
    expect(plugins.cancelInstall).toHaveBeenCalledOnce()
    // A stop the Host did not confirm says so over the running screen, with the transport's words when it has them.
    expect(state().install.failure).toEqual(
      status === 'too-late' ? null : { reason: status === 'offline' ? 'offline' : '', cancelUnconfirmed: true },
    )
    // The Host's own word that it stopped the run still ends it.
    pending.resolve(ok({ ...failed(), application: 'cancelled' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('idle') })
    expect(state().install).toMatchObject({ open: true, spec: 'slow', failure: null })
    expect(state().notice).toEqual({ kind: 'cancelled', seq: 1 })
  })

  it.each([false, true])('drops a stop the Host confirms once the run settled, or after disposal (%s)', async (dispose) => {
    const answer = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const cancellation = deferred<ReturnType<typeof ok<{ status: 'cancelled' }>>>()
    const { face, state, controller, started } = bench({
      installBundle: vi.fn().mockReturnValue(answer.promise),
      cancelInstall: vi.fn().mockReturnValue(cancellation.promise),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    controller.installProgress({ requestId: await started(), phase: 'installing' })
    face.cancelInstall()
    expect(state().install.phase).toBe('cancelling')
    if (dispose) controller.dispose()
    answer.resolve(ok({ ...APPLIED, bundle: 'slow' }))
    if (!dispose) await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    cancellation.resolve(ok({ status: 'cancelled' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(state().install.phase).toBe(dispose ? 'cancelling' : 'done')
    expect(state().notice).toBeNull()
  })

  it('enables what a finished install added from its screen, closes, and marks it in the list', async () => {
    const { plugins, face, state, controller } = bench({
      installBundle: vi.fn()
        .mockResolvedValueOnce(ok({ ...APPLIED, bundle: 'dsh-a' }))
        .mockResolvedValueOnce(ok({ ...APPLIED, bundle: 'dsh-a' }))
        .mockResolvedValueOnce(ok({ ...APPLIED, application: 'overridden' })),
      setBundleEnabled: vi.fn()
        .mockResolvedValueOnce(ok({ ...APPLIED, application: 'restart-required' }))
        .mockResolvedValueOnce(ok(failed({ code: 'operation-error', diagnostic: 'the tree rejected it' }))),
    })
    await controller.load()
    face.enableInstalled()
    expect(plugins.setBundleEnabled).not.toHaveBeenCalled()
    face.openInstall()
    face.editInstallSpec('dsh-a')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    face.enableInstalled()
    face.enableInstalled()
    expect(state().install.enabling).toBe(true)
    await vi.waitFor(() => { expect(state().install.open).toBe(false) })
    expect(plugins.setBundleEnabled).toHaveBeenCalledExactlyOnceWith('dsh-a', true)
    // A restart it waits for is said in passing; the list marks it.
    expect(state().notice).toEqual({ kind: 'restart', packageName: 'dsh-a', seq: 1 })
    expect(state().highlight).toBe('dsh-a')
    face.clearHighlight()
    face.clearHighlight()
    expect(state().highlight).toBeNull()

    // A refusal toasts it and still closes.
    face.openInstall()
    face.editInstallSpec('dsh-a')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    face.enableInstalled()
    await vi.waitFor(() => { expect(state().install.open).toBe(false) })
    expect(plugins.setBundleEnabled).toHaveBeenCalledTimes(2)
    expect(state().notice).toEqual({ kind: 'failed', action: 'enable', code: 'operation-error', reason: 'the tree rejected it', packageName: 'dsh-a', seq: 2 })
    expect(state().highlight).toBe('dsh-a')

    // An install that named no bundle has nothing to enable or mark: the screen just closes.
    face.openInstall()
    face.editInstallSpec('lib')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(state().install.installed).toBeNull()
    face.enableInstalled()
    await vi.waitFor(() => { expect(state().install.open).toBe(false) })
    expect(plugins.setBundleEnabled).toHaveBeenCalledTimes(2)
    expect(state().highlight).toBeNull()
  })

  it('offers the scripts a blocked run left pending, and retries the same spec with them allowed', async () => {
    const gates: ReturnType<typeof deferred<Awaited<ReturnType<typeof ok<ChangeResult>> | ReturnType<typeof refused>>>>[] = []
    const { face, state, controller, plugins, started } = bench({
      installBundle: vi.fn(() => {
        const gate = deferred<Awaited<ReturnType<typeof ok<ChangeResult>> | ReturnType<typeof refused>>>()
        gates.push(gate)
        return gate.promise
      }),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    // Before the failed screen offers anything, the action does nothing.
    face.approveBuildsAndRetry()
    face.runInstall()
    const first = await started()
    gates[0]!.resolve(ok({
      ...failed({ code: 'operation-error', diagnostic: 'ERR_PNPM_IGNORED_BUILDS' },
        { exitCode: 1, output: 'ERR_PNPM_IGNORED_BUILDS', truncated: false, logPath: '/l', kind: 'build-blocked' }),
      pendingBuilds: ['native'],
    }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.failure).toEqual({ reason: 'ERR_PNPM_IGNORED_BUILDS', code: 'operation-error', kind: 'build-blocked', pendingBuilds: ['native'] })
    // The retry keeps the subject the check produced and carries the approved names under a new request id.
    face.approveBuildsAndRetry()
    const second = await started()
    expect(second).not.toBe(first)
    expect(plugins.installBundle).toHaveBeenLastCalledWith('x', { enabled: false, requestId: second, approvedBuilds: ['native'] })
    expect(state().install).toMatchObject({ subject: { spec: 'x', name: 'dsh-better-sidebar' }, failure: null })
    gates[1]!.resolve(ok({ ...APPLIED, bundle: 'dsh-better-sidebar', approvedBuilds: ['native'] }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(state().install).toMatchObject({ installed: 'dsh-better-sidebar', approvedBuilds: ['native'] })
    expect(plugins.installBundle).toHaveBeenCalledTimes(2)
  })

  it('drops an enable from the installed screen that settles after disposal', async () => {
    const enableGate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { plugins, face, state, controller } = bench({ setBundleEnabled: vi.fn().mockReturnValueOnce(enableGate.promise) })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('dsh-a')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    face.enableInstalled()
    expect(plugins.setBundleEnabled).toHaveBeenCalledWith('dsh-new', true)
    const before = state()
    controller.dispose()
    enableGate.resolve(ok(APPLIED))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(state()).toBe(before)
  })

  it('settles an install while reads run beside it', async () => {
    const gate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { plugins, face, state, controller, started } = bench({ installBundle: vi.fn().mockReturnValueOnce(gate.promise) })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('pkg')
    face.runInstall()
    await started()
    // The Host announces the change before the run answers; the read it triggers must not drop the answer.
    await controller.load()
    gate.resolve(ok({ ...APPLIED, bundle: 'pkg' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(plugins.listBundles).toHaveBeenCalledTimes(3)
  })

  it('keeps the Host words and kind of a failed install, and settles a run whose last chunk never came', async () => {
    // Every run waits on its own gate, so chunks can land while it is installing.
    const gates: ReturnType<typeof deferred<Awaited<ReturnType<typeof ok<ChangeResult>> | ReturnType<typeof refused>>>>[] = []
    const { face, state, controller, plugins, started } = bench({
      installBundle: vi.fn(() => {
        const gate = deferred<Awaited<ReturnType<typeof ok<ChangeResult>> | ReturnType<typeof refused>>>()
        gates.push(gate)
        return gate.promise
      }),
    })
    const argv = ['pnpm', 'add', 'x']
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    let requestId = '' as PluginInstallRequestId
    const installing = async (): Promise<void> => {
      face.runInstall()
      requestId = await started()
    }
    const answer = (value: ReturnType<typeof ok<ChangeResult>> | ReturnType<typeof refused>): void => {
      gates[gates.length - 1]?.resolve(value)
    }
    // No chunk arrived: the Host's words are the reason, and there is no run; the kind is kept.
    await installing()
    answer(ok(failed({ code: 'operation-error', diagnostic: 'ERR_PNPM' }, { exitCode: 1, output: 'ERR_PNPM', truncated: false, logPath: '/l', kind: 'network' })))
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([])
    expect(state().install.failure).toEqual({ reason: 'ERR_PNPM', code: 'operation-error', kind: 'network' })
    expect(state().install.subject).toEqual({ spec: 'x', ...INSPECTED })
    // A refused answer, not a failed change, keeps the transport's words and settles the run without an exit code.
    await installing()
    controller.appendLog({ requestId, jobId: 'j', argv, cwd: '/p', stream: 'stderr', text: 'streamed' })
    answer(refused('gateway/internal', 'offline'))
    await vi.waitFor(() => { expect(state().install.failure).toEqual({ reason: 'offline' }) })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'streamed', exitCode: null }])
    // A pnpm failure settles the open run with the code the answer names.
    await installing()
    controller.appendLog({ requestId, jobId: 'j', argv, cwd: '/p', stream: 'stdout', text: 'Done' })
    answer(ok(failed({ code: 'operation-error', diagnostic: 'tail' }, { exitCode: 7, output: 'tail', truncated: false, logPath: '/l', kind: 'unknown' })))
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'Done', exitCode: 7 }])
    // A failure after pnpm carries no package result: a run whose last chunk came keeps its own exit code, one still open settles without.
    await installing()
    controller.appendLog({ requestId, jobId: 'j', argv, cwd: '/p', stream: 'stdout', text: 'partial', exitCode: 0 })
    controller.appendLog({ requestId, jobId: 'k', argv, cwd: '/p', stream: 'stdout', text: 'open' })
    answer(ok(failed({ code: 'not-bundle' })))
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.runs).toEqual([
      { jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'partial', exitCode: 0 },
      { jobId: 'k', command: 'pnpm add x', cwd: '/p', output: 'open', exitCode: null },
    ])
    expect(state().install.failure).toEqual({ reason: '', code: 'not-bundle' })
    // A failure the Host does not explain has neither code nor words.
    await installing()
    answer(ok(failed()))
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.failure).toEqual({ reason: '' })
    expect(plugins.installBundle).toHaveBeenCalledTimes(5)
    // Editing the spec after a failure starts over too.
    face.editInstallSpec('y')
    expect(state().install).toMatchObject({ phase: 'idle', spec: 'y', runs: [], failure: null })
  })

  it('drops every late settlement after disposal', async () => {
    const enableGate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const installGate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { face, state, controller, started } = bench({
      setBundleEnabled: vi.fn().mockReturnValueOnce(enableGate.promise),
      installBundle: vi.fn().mockReturnValueOnce(installGate.promise),
    })
    await controller.load()
    face.openInstall()
    face.editInstallSpec('x')
    face.runInstall()
    await started()
    face.setEnabled(BUNDLE.name, true)
    const before = state()
    controller.dispose()
    enableGate.resolve(ok(APPLIED))
    installGate.resolve(ok(APPLIED))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(state()).toBe(before)
    await controller.load()
    expect(state()).toBe(before)
    face.setEnabled(BUNDLE.name, false)
    expect(state()).toBe(before)
  })

  it('drops a read that settles after disposal', async () => {
    const gate = deferred<ReturnType<typeof ok<{ entries: never[]; managementAvailable: boolean }>>>()
    const { state, controller } = bench({ inventory: vi.fn().mockReturnValueOnce(gate.promise) })
    const loading = controller.load()
    await Promise.resolve()
    const before = state()
    controller.dispose()
    gate.resolve(ok({ entries: [], managementAvailable: true }))
    await loading
    expect(state()).toBe(before)
  })

  it('drops a bundle read that settles after disposal', async () => {
    const gate = deferred<ReturnType<typeof ok<BundleInfo[]>>>()
    const { state, controller } = bench({ listBundles: vi.fn().mockReturnValueOnce(gate.promise) })
    const loading = controller.load()
    await vi.waitFor(() => { expect(state().status).toBe('loading') })
    await Promise.resolve()
    const before = state()
    controller.dispose()
    gate.resolve(ok([BUNDLE]))
    await loading
    expect(state()).toBe(before)
  })
})
