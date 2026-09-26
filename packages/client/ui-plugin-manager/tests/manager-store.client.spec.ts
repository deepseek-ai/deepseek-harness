/**
 * The manager store: what it reads, how actions cross the wire, which
 * outcomes become toasts, and how the install run folds its output.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { BundleInfo, ChangeResult, ManagementError, PluginEntryId, PluginInfo, PluginInstallRequestId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigLedger } from '../src/client/config-ledger.ts'
import { offeredRegistries, packageView, PluginManagerController, rowKey, sortPackages } from '../src/client/manager-store.ts'

const INCOMPATIBLE = { name: 'dsh-late', version: '2.0.0', runtimeVersion: '0.1.0', peers: { '@deepseek-ai/dsh': '^0.2.0' } }
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

const MIRROR = 'https://registry.npmmirror.com/'
const OFFICIAL = 'https://registry.npmjs.org/'
const CORP = 'https://npm.corp.example/'

/** The registries the Host asks: pnpm's own first, which names npm's own registry, then the mirror. */
const REGISTRIES = { registry: null, fallbackRegistries: [MIRROR], resolved: OFFICIAL }

/** What the check answers for a registry name. */
const INSPECTED = { status: 'accepted' as const, kind: 'registry' as const, name: 'dsh-better-sidebar', version: '1.0.0', bundle: true, registry: null }

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

/** A configuration ledger with nothing registered, as the page binds it beside the store. */
const NO_CONFIG: HostObservable<ConfigLedger> = {
  getSnapshot: () => ({ items: [], bundles: new Set(), rows: new Set() }),
  subscribe: () => () => {},
}

function bench(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const inventory = { list: overrides.inventory ?? vi.fn(() => Promise.resolve(ok({ entries: [], managementAvailable: true }))) }
  const plugins = {
    listBundles: vi.fn(() => Promise.resolve(ok([BUNDLE]))),
    listPlugins: vi.fn(() => Promise.resolve(ok(PLUGINS))),
    inspect: vi.fn(() => Promise.resolve(ok(INSPECTED))),
    registries: vi.fn(() => Promise.resolve(ok(REGISTRIES))),
    installBundle: vi.fn(() => Promise.resolve(ok({ ...APPLIED, bundle: 'dsh-new' }))),
    waitForInstall: vi.fn(() => Promise.resolve(refused('gateway/internal', 'offline'))),
    cancelInstall: vi.fn(() => Promise.resolve(ok({ status: 'cancelled' }))),
    removeBundle: vi.fn(() => Promise.resolve(ok(APPLIED))),
    setBundleEnabled: vi.fn(() => Promise.resolve(ok(APPLIED))),
    setPluginEnabled: vi.fn(() => Promise.resolve(ok(APPLIED))),
    ...overrides,
  }
  const probe = { fastest: overrides.fastest ?? vi.fn(() => Promise.resolve(ok(null))) }
  const ctx = {
    configForms: { describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }), subscribe: () => () => {} }), get: vi.fn((id: string) => `form:${id}`) },
    remote: { pluginManager: plugins, pluginInventory: inventory, pluginRegistryProbe: probe },
  } as never
  const controller = new PluginManagerController(ctx)
  onTestFinished(() => { controller.dispose() })
  const face = controller.inject(NO_CONFIG, text => typeof text === 'string' ? text : text.en)
  const state = () => controller.getSnapshot()
  /** The request id of the run the dialog just handed to the Host. */
  const started = async (): Promise<PluginInstallRequestId> => {
    await vi.waitFor(() => { expect(state().install.phase).toBe('starting') })
    return state().install.requestId as PluginInstallRequestId
  }
  return { plugins, inventory, probe, controller, face, state, started }
}

it('hands a custom page the shared configuration form of its entry', () => {
  const { face } = bench()
  expect(face.configForm('bundle#row')).toBe('form:bundle#row' as never)
})

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
  it.each(['before', 'after'] as const)('closes immediately and retries an early cancellation when acceptance arrives %s its reply', async (order) => {
    const install = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const firstCancel = deferred<ReturnType<typeof ok<{ status: 'not-running' }>>>()
    const stopped = deferred<ReturnType<typeof ok<{ status: 'cancelled' }>>>()
    const { face, state, controller, plugins, started } = bench({
      installBundle: vi.fn().mockReturnValue(install.promise),
      cancelInstall: vi.fn().mockReturnValueOnce(firstCancel.promise).mockReturnValueOnce(stopped.promise),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    face.closeInstall()
    expect(state().install).toMatchObject({ open: false, phase: 'cancelling', requestId })
    expect(plugins.cancelInstall).toHaveBeenCalledExactlyOnceWith(requestId)
    face.openInstall()
    face.runInstall()
    expect(state().install).toMatchObject({ open: true, requestId, spec: 'slow' })
    expect(plugins.installBundle).toHaveBeenCalledOnce()
    if (order === 'before') controller.installProgress({ requestId, phase: 'installing' })
    firstCancel.resolve(ok({ status: 'not-running' }))
    if (order === 'after') {
      await vi.waitFor(() => { expect(state().install.failure?.uncertainty).toBe('acceptance') })
      controller.installProgress({ requestId, phase: 'installing' })
    }
    await vi.waitFor(() => { expect(plugins.cancelInstall).toHaveBeenCalledTimes(2) })
    expect(state().install.phase).toBe('cancelling')
    stopped.resolve(ok({ status: 'cancelled' }))
    await vi.waitFor(() => { expect(state().install).toMatchObject({ open: true, phase: 'idle', spec: 'slow' }) })
    install.resolve(ok({ ...failed(), application: 'cancelled' }))
  })

  it('keeps local package and row metadata in the loaded view without changing technical identities', async () => {
    const meta = { title: { en: 'Sidebar', zh: '侧栏' }, description: 'Local package', error: 'locale/zh.json: invalid title' }
    const rowMeta = { title: { en: 'Theme', zh: '主题' }, description: { en: 'Display options', zh: '显示选项' } }
    const bundle: BundleInfo = {
      ...BUNDLE,
      meta,
      rows: BUNDLE.rows.map(row => ({ ...row, meta: rowMeta })),
    }
    const { controller, state } = bench({ listBundles: vi.fn().mockResolvedValue(ok([bundle])) })

    await controller.load()

    expect(state().packages[0]).toMatchObject({ name: BUNDLE.name, meta })
    expect(state().packages[0]!.meta).toBe(meta)
    expect(state().packages[0]!.rows[0]).toMatchObject({ rowId: 'sidebar', moduleName: BUNDLE.name, entryId: ROW_ENTRY, meta: rowMeta })
    expect(state().packages[0]!.rows[0]!.meta).toBe(rowMeta)
    expect(state().packages[0]!.error).toBeUndefined()
  })

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
        .mockResolvedValueOnce(ok({ ...failed(), application: 'cancelled' }))
        .mockResolvedValueOnce(ok(failed({ code: 'incompatible-version', incompatible: [INCOMPATIBLE] }))),
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
    // An incompatibility keeps the packages it names for the page to word.
    face.setEnabled(BUNDLE.name, true)
    await vi.waitFor(() => {
      expect(state().notice).toEqual({
        kind: 'failed', action: 'enable', code: 'incompatible-version', incompatible: [INCOMPATIBLE], reason: '', packageName: BUNDLE.name, seq: 8,
      })
    })
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
    await vi.waitFor(() => { expect(plugins.inspect).toHaveBeenCalledTimes(1) })
    expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', { registry: null }, expect.any(AbortSignal))
    const requestId = await started()
    expect(state().install.subject).toEqual({ spec: 'dsh-new', ...INSPECTED })
    expect(plugins.installBundle).toHaveBeenCalledTimes(1)
    expect(plugins.installBundle).toHaveBeenCalledWith('dsh-new', { enabled: false, requestId, registry: null })
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
        .mockResolvedValueOnce(ok({ status: 'refused', problem: 'not-found', reason: 'E404', registries: [null, MIRROR] }))
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
    await vi.waitFor(() => { expect(state().install.inputError).toEqual({ problem: 'not-found', reason: 'E404', registries: [null, MIRROR] }) })
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
    await vi.waitFor(() => { expect(plugins.inspect).toHaveBeenCalledOnce() })
    const checkSignal = (plugins.inspect.mock.calls[0] as unknown[])[2] as AbortSignal
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
    expect((plugins.inspect.mock.calls[1] as unknown[])[2]).toMatchObject({ aborted: true })
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
    await vi.waitFor(() => { expect(state().install.phase).toBe(status === 'too-late' ? 'applying' : 'unconfirmed') })
    expect(plugins.cancelInstall).toHaveBeenCalledOnce()
    // A stop the Host did not confirm says so over the running screen, with the transport's words when it has them.
    expect(state().install.failure).toEqual(
      status === 'too-late' ? null : { reason: status === 'offline' ? 'offline' : '', uncertainty: 'cancellation' },
    )
    // The Host's own word that it stopped the run still ends it.
    pending.resolve(ok({ ...failed(), application: 'cancelled' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('idle') })
    expect(state().install).toMatchObject({ open: true, spec: 'slow', failure: null })
    expect(state().notice).toEqual({ kind: 'cancelled', seq: 1 })
  })

  it.each(['cancelled', 'too-late', 'offline'] as const)('keeps a hidden installation recoverable when cancellation answers %s', async (status) => {
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
    face.closeInstall()
    expect(state().install).toMatchObject({ open: false, phase: 'cancelling', requestId })
    if (status === 'cancelled') {
      await vi.waitFor(() => { expect(state().install).toMatchObject({ open: false, phase: 'idle', spec: 'slow' }) })
      expect(state().notice).toEqual({ kind: 'cancelled', seq: 1 })
    } else {
      await vi.waitFor(() => { expect(state().install.phase).toBe(status === 'too-late' ? 'applying' : 'unconfirmed') })
      expect(state().install.open).toBe(false)
      expect(state().notice).toMatchObject({ kind: 'install', outcome: status === 'too-late' ? 'applying' : 'unconfirmed' })
      face.openInstall()
      expect(state().install).toMatchObject({ open: true, requestId, spec: 'slow' })
    }
    expect(plugins.cancelInstall).toHaveBeenCalledExactlyOnceWith(requestId)
    pending.resolve(ok({ ...failed(), application: 'cancelled' }))
  })

  it.each(['done', 'failed'] as const)('keeps a hidden %s result available without reopening the dialog', async (phase) => {
    const pending = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { face, state, controller, plugins, started } = bench({ installBundle: vi.fn().mockReturnValue(pending.promise) })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    controller.installProgress({ requestId, phase: 'applying' })
    face.closeInstall()
    expect(state().install).toMatchObject({ open: false, phase: 'applying', requestId })
    expect(plugins.cancelInstall).not.toHaveBeenCalled()
    pending.resolve(ok(phase === 'done' ? { ...APPLIED, bundle: 'slow' } : failed()))
    await vi.waitFor(() => { expect(state().install.phase).toBe(phase) })
    expect(state().install.open).toBe(false)
    expect(state().notice).toMatchObject({ kind: 'install', outcome: phase })
    face.openInstall()
    expect(state().install).toMatchObject({ open: true, phase, requestId })
    face.closeInstall()
    face.openInstall()
    expect(state().install).toMatchObject({ open: true, phase: 'idle', spec: '' })
  })

  it('retries a premature cancellation when output arrives without a start notification', async () => {
    const pending = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const cancellation = deferred<ReturnType<typeof ok<{ status: 'cancelled' }>>>()
    const { face, state, controller, plugins, started } = bench({
      installBundle: vi.fn().mockReturnValue(pending.promise),
      cancelInstall: vi.fn().mockResolvedValueOnce(ok({ status: 'not-running' })).mockReturnValueOnce(cancellation.promise),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    face.closeInstall()
    await vi.waitFor(() => { expect(state().install.failure?.uncertainty).toBe('acceptance') })
    controller.appendLog({ requestId, jobId: 'j1', argv: ['pnpm', 'add', 'slow'], cwd: '/p', stream: 'stdout', text: 'Waiting for download' })
    expect(plugins.cancelInstall).toHaveBeenCalledTimes(2)
    expect(state().install).toMatchObject({ open: false, phase: 'cancelling', runs: [{ output: 'Waiting for download' }] })
    cancellation.resolve(ok({ status: 'cancelled' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('idle') })
    pending.resolve(ok({ ...failed(), application: 'cancelled' }))
  })

  it('retains cancellation intent after a transport failure before the Host accepts installation', async () => {
    const pending = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { face, state, controller, plugins, started } = bench({
      installBundle: vi.fn().mockReturnValue(pending.promise),
      cancelInstall: vi.fn().mockResolvedValueOnce(refused('gateway/internal', 'offline')).mockResolvedValueOnce(ok({ status: 'cancelled' })),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    face.closeInstall()
    await vi.waitFor(() => { expect(state().install).toMatchObject({ open: false, phase: 'unconfirmed' }) })
    controller.installProgress({ requestId, phase: 'installing' })
    await vi.waitFor(() => { expect(state().install.phase).toBe('idle') })
    expect(plugins.cancelInstall).toHaveBeenCalledTimes(2)
    expect(state().notice).toMatchObject({ kind: 'cancelled' })
    pending.resolve(ok({ ...failed(), application: 'cancelled' }))
  })

  it('keeps an in-flight cancellation authoritative when the installation response is lost', async () => {
    const pending = deferred<ReturnType<typeof refused>>()
    const cancellation = deferred<ReturnType<typeof ok<{ status: 'cancelled' }>>>()
    const { face, state, plugins, started } = bench({
      installBundle: vi.fn().mockReturnValue(pending.promise),
      cancelInstall: vi.fn().mockReturnValue(cancellation.promise),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    face.closeInstall()
    pending.resolve(refused('gateway/internal', 'offline'))
    await vi.waitFor(() => { expect(state().install).toMatchObject({ open: false, phase: 'unconfirmed', requestId }) })
    face.openInstall()
    face.runInstall()
    face.cancelInstall()
    expect(plugins.installBundle).toHaveBeenCalledOnce()
    expect(plugins.cancelInstall).toHaveBeenCalledOnce()
    cancellation.resolve(ok({ status: 'cancelled' }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('idle') })
    expect(state().install.open).toBe(true)
  })

  it.each(['not-running', 'too-late'] as const)('recovers a lost install reply after cancellation answers %s', async (status) => {
    const original = deferred<ReturnType<typeof refused>>()
    const recovery = deferred<ReturnType<typeof ok<ChangeResult | null>>>()
    const { face, state, plugins, started } = bench({
      installBundle: vi.fn().mockReturnValueOnce(original.promise).mockResolvedValue(ok(APPLIED)),
      cancelInstall: vi.fn().mockResolvedValue(ok({ status })),
      waitForInstall: vi.fn().mockResolvedValueOnce(refused('gateway/internal', 'offline')).mockReturnValue(recovery.promise),
    })
    face.openInstall()
    face.editInstallSpec('git+https://example.test/plugin')
    face.runInstall()
    const requestId = await started()
    original.resolve(refused('gateway/internal', 'lost reply'))
    await vi.waitFor(() => { expect(state().install.failure?.reason).toBe('offline') })
    face.closeInstall()
    await vi.waitFor(() => { expect(plugins.waitForInstall).toHaveBeenCalledTimes(2) })
    expect(plugins.waitForInstall).toHaveBeenLastCalledWith(requestId)
    expect(state().install.phase).toBe(status === 'too-late' ? 'applying' : 'unconfirmed')
    recovery.resolve(ok(status === 'too-late' ? { ...APPLIED, bundle: 'recovered' } : null))
    const phase = status === 'too-late' ? 'done' : 'unknown'
    await vi.waitFor(() => { expect(state().install.phase).toBe(phase) })
    expect(state().install.open).toBe(false)
    expect(state().notice).toMatchObject({ kind: 'install', outcome: phase })
    await vi.waitFor(() => { expect(plugins.listBundles).toHaveBeenCalled() })
    face.openInstall()
    expect(state().install.phase).toBe(phase)
    if (status === 'not-running') {
      face.cancelInstall()
      expect(state().install).toMatchObject({ phase: 'idle', spec: 'git+https://example.test/plugin' })
    }
    face.editInstallSpec('another')
    face.runInstall()
    await vi.waitFor(() => { expect(plugins.installBundle).toHaveBeenCalledTimes(2) })
  })

  it('keeps Host acceptance across cancellation retries', async () => {
    const original = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { face, state, controller, plugins, started } = bench({
      installBundle: vi.fn().mockReturnValue(original.promise),
      cancelInstall: vi.fn().mockResolvedValueOnce(refused('gateway/internal', 'offline')).mockResolvedValue(ok({ status: 'not-running' })),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    controller.installProgress({ requestId, phase: 'installing' })
    face.cancelInstall()
    await vi.waitFor(() => { expect(state().install.failure?.reason).toBe('offline') })
    face.cancelInstall()
    await vi.waitFor(() => { expect(state().install.failure).toEqual({ reason: '', uncertainty: 'cancellation' }) })
    controller.installProgress({ requestId, phase: 'installing' })
    expect(plugins.cancelInstall).toHaveBeenCalledTimes(2)
    original.resolve(ok(APPLIED))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
  })

  it.each(['offline', 'not-running'] as const)('preserves applying when a late cancellation answers %s', async (status) => {
    const original = deferred<ReturnType<typeof refused>>()
    const cancellation = deferred<ReturnType<typeof refused> | ReturnType<typeof ok<{ status: 'not-running' }>>>()
    const { face, state, controller, started } = bench({
      installBundle: vi.fn().mockReturnValue(original.promise),
      cancelInstall: vi.fn().mockReturnValue(cancellation.promise),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    face.cancelInstall()
    controller.installProgress({ requestId, phase: 'applying' })
    cancellation.resolve(status === 'offline' ? refused('gateway/internal', 'offline') : ok({ status }))
    await vi.waitFor(() => { expect(state().install.failure?.uncertainty).toBe('cancellation') })
    expect(state().install.phase).toBe('applying')
    controller.installProgress({ requestId, phase: 'installing' })
    expect(state().install.phase).toBe('applying')
    original.resolve(refused('gateway/internal', 'offline'))
    await vi.waitFor(() => { expect(state().install.failure?.uncertainty).toBe('result') })
    expect(state().install.phase).toBe('applying')
    controller.dispose()
  })

  it('can retry recovery after both installation and cancellation replies are lost', async () => {
    const original = deferred<ReturnType<typeof refused>>()
    const cancellation = deferred<ReturnType<typeof refused>>()
    const { face, state, plugins, controller, started } = bench({
      installBundle: vi.fn().mockReturnValue(original.promise),
      cancelInstall: vi.fn().mockReturnValue(cancellation.promise),
      waitForInstall: vi.fn().mockResolvedValueOnce(refused('gateway/internal', 'offline')).mockResolvedValue(ok(null)),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    const requestId = await started()
    controller.installProgress({ requestId, phase: 'installing' })
    face.cancelInstall()
    original.resolve(refused('gateway/internal', 'lost install reply'))
    await vi.waitFor(() => { expect(state().install.failure?.reason).toBe('offline') })
    cancellation.resolve(refused('gateway/internal', 'lost cancellation reply'))
    await vi.waitFor(() => { expect(state().install.failure).toEqual({ reason: 'lost cancellation reply', uncertainty: 'result' }) })
    face.reconcileInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('unknown') })
    expect(plugins.waitForInstall).toHaveBeenCalledTimes(2)
  })

  it.each(['failed', 'cancelled', 'disposed'] as const)('deduplicates recovery and handles its %s outcome', async (outcome) => {
    const recovery = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { face, state, controller, plugins } = bench({
      installBundle: vi.fn().mockResolvedValue(refused('gateway/internal', 'offline')),
      waitForInstall: vi.fn().mockReturnValue(recovery.promise),
    })
    face.openInstall()
    face.editInstallSpec('slow')
    face.runInstall()
    await vi.waitFor(() => { expect(plugins.waitForInstall).toHaveBeenCalledOnce() })
    face.reconcileInstall()
    await controller.load()
    expect(plugins.waitForInstall).toHaveBeenCalledOnce()
    if (outcome === 'disposed') controller.dispose()
    recovery.resolve(ok({ ...failed(), application: outcome === 'cancelled' ? 'cancelled' : 'failed' }))
    await recovery.promise
    await Promise.resolve()
    expect(state().install.phase).toBe(outcome === 'disposed' ? 'unconfirmed' : outcome === 'cancelled' ? 'idle' : 'failed')
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
    if (dispose) {
      controller.dispose()
      controller.installProgress({ requestId: state().install.requestId!, phase: 'applying' })
    }
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
    expect(plugins.installBundle).toHaveBeenLastCalledWith('x', { enabled: false, requestId: second, registry: null, approvedBuilds: ['native'] })
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
    // A lost answer cannot establish whether the Host stopped the process.
    await installing()
    controller.appendLog({ requestId, jobId: 'j', argv, cwd: '/p', stream: 'stderr', text: 'streamed' })
    answer(refused('gateway/internal', 'offline'))
    await vi.waitFor(() => { expect(state().install).toMatchObject({ phase: 'unconfirmed', failure: { reason: 'offline', uncertainty: 'result' } }) })
    expect(state().install.runs).toEqual([{ jobId: 'j', command: 'pnpm add x', cwd: '/p', output: 'streamed' }])
    face.runInstall()
    expect(plugins.installBundle).toHaveBeenCalledTimes(2)
    face.cancelInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('idle') })
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
    // An incompatibility keeps the packages it names.
    await installing()
    answer(ok(failed({ code: 'incompatible-version', incompatible: [INCOMPATIBLE] })))
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.failure).toEqual({ reason: '', code: 'incompatible-version', incompatible: [INCOMPATIBLE] })
    // A failure the Host does not explain has neither code nor words.
    await installing()
    answer(ok(failed()))
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.failure).toEqual({ reason: '' })
    expect(plugins.installBundle).toHaveBeenCalledTimes(6)
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
  it('offers the registries the Host configured, starts from its first, and asks the check and the run to start where the person chose', async () => {
    const gate = deferred<ReturnType<typeof ok<ChangeResult>>>()
    const { plugins, face, state, controller, started } = bench({
      inspect: vi.fn(() => Promise.resolve(ok({ ...INSPECTED, registry: MIRROR }))),
      installBundle: vi.fn().mockReturnValueOnce(gate.promise),
    })
    face.openInstall()
    expect(state().install).toMatchObject({ registries: null, registry: { kind: 'offered', registry: null }, registryOpen: false, registryError: false })
    await vi.waitFor(() => { expect(state().install.registries).toEqual(REGISTRIES) })
    expect(state().install.registry).toEqual({ kind: 'offered', registry: null })
    face.toggleRegistryOptions()
    expect(state().install.registryOpen).toBe(true)
    // Changing the registry is for the failed screen; at the spec it does nothing.
    face.changeRegistry()
    expect(state().install.registryOpen).toBe(true)
    face.chooseRegistry({ kind: 'offered', registry: MIRROR })
    face.editInstallSpec('dsh-new')
    face.runInstall()
    expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', { registry: MIRROR }, expect.any(AbortSignal))
    // A choice made while the Host checks or runs is dropped.
    face.chooseRegistry({ kind: 'offered', registry: null })
    expect(state().install.registry).toEqual({ kind: 'offered', registry: MIRROR })
    const requestId = await started()
    // The run starts at the registry that answered the check.
    expect(state().install.subject).toMatchObject({ registry: MIRROR })
    expect(plugins.installBundle).toHaveBeenCalledWith('dsh-new', { enabled: false, requestId, registry: MIRROR })
    // The Host names each registry it asks; the dialog keeps their order and how many there may be.
    controller.installProgress({ requestId, phase: 'installing', attempt: { registry: MIRROR, index: 1, total: 2 } })
    controller.installProgress({ requestId, phase: 'installing', attempt: { registry: null, index: 2, total: 2 } })
    expect(state().install).toMatchObject({ phase: 'running', attempts: { registries: [MIRROR, null], total: 2 } })
    gate.resolve(ok({ ...APPLIED, bundle: 'dsh-new', registries: [MIRROR, null] }))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(state().install.attempts).toEqual({ registries: [MIRROR, null], total: 2 })
  })

  it('compares a registry that does not parse as written', () => {
    // A remembered or configured address that no longer parses still stands for itself, so only an exact repeat folds.
    expect(offeredRegistries({ registry: null, fallbackRegistries: ['garbage'], resolved: 'garbage' })).toEqual([null])
    expect(offeredRegistries({ registry: 'garbage', fallbackRegistries: [], resolved: null })).toEqual(['garbage', null])
  })

  it('lists pnpm\'s own configuration once when it names the registry the Host also offers', async () => {
    const shared = { registry: null, fallbackRegistries: [MIRROR], resolved: MIRROR }
    const storage = new Map([['dsh.plugin-manager.install-registry', JSON.stringify({ kind: 'offered', registry: MIRROR })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    try {
      const { face, state } = bench({ registries: vi.fn(() => Promise.resolve(ok(shared))) })
      face.openInstall()
      await vi.waitFor(() => { expect(state().install.registries).toEqual(shared) })
      // The mirror the Host offers is the registry pnpm's own configuration names, so the dialog lists one entry for it.
      expect(offeredRegistries(shared)).toEqual([null])
      // The remembered mirror takes the entry that still asks the same registry.
      expect(state().install.registry).toEqual({ kind: 'offered', registry: null })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a remembered pnpm configuration that names its own registry', async () => {
    const storage = new Map([['dsh.plugin-manager.install-registry', JSON.stringify({ kind: 'offered', registry: null })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    try {
      const { face, state } = bench()
      face.openInstall()
      await vi.waitFor(() => { expect(state().install.registries).toEqual(REGISTRIES) })
      expect(state().install.registry).toEqual({ kind: 'offered', registry: null })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('starts from the registry the Host configured first while nothing is remembered', async () => {
    const corporate = { registry: CORP, fallbackRegistries: [MIRROR], resolved: OFFICIAL }
    const { plugins, face, state } = bench({
      registries: vi.fn(() => Promise.resolve(ok(corporate))),
      inspect: vi.fn(() => Promise.resolve(ok({ ...INSPECTED, registry: CORP }))),
    })
    face.openInstall()
    await vi.waitFor(() => { expect(state().install.registries).toEqual(corporate) })
    expect(state().install.registry).toEqual({ kind: 'offered', registry: CORP })
    face.editInstallSpec('dsh-new')
    face.runInstall()
    expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', { registry: CORP }, expect.any(AbortSignal))
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(plugins.installBundle).toHaveBeenCalledWith('dsh-new', expect.objectContaining({ registry: CORP }))
  })

  it('refuses a custom registry that is not an http(s) URL before asking the Host, and remembers the registry last used', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    try {
      const { plugins, face, state } = bench({
        inspect: vi.fn(() => Promise.resolve(ok({ ...INSPECTED, registry: 'https://npm.corp.example/' }))),
      })
      face.openInstall()
      face.editInstallSpec('dsh-new')
      face.chooseRegistry({ kind: 'custom', url: ' npm.corp.example ' })
      face.runInstall()
      expect(state().install).toMatchObject({ phase: 'idle', registryError: true })
      expect(plugins.inspect).not.toHaveBeenCalled()
      // Typing again clears the refusal; a URL is asked as typed, trimmed.
      face.chooseRegistry({ kind: 'custom', url: ' https://npm.corp.example ' })
      expect(state().install.registryError).toBe(false)
      face.runInstall()
      expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', { registry: 'https://npm.corp.example' }, expect.any(AbortSignal))
      await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
      expect(plugins.installBundle).toHaveBeenCalledWith('dsh-new', expect.objectContaining({ registry: 'https://npm.corp.example/' }))
      // A dialog opened later, by another controller, starts from the registry last used.
      const later = bench()
      later.face.openInstall()
      expect(later.state().install.registry).toEqual({ kind: 'custom', url: 'https://npm.corp.example' })
      // A remembered registry the Host no longer offers is kept as a typed one.
      storage.set('dsh.plugin-manager.install-registry', JSON.stringify({ kind: 'offered', registry: 'https://old.example/' }))
      const stale = bench()
      stale.face.openInstall()
      expect(stale.state().install.registry).toEqual({ kind: 'offered', registry: 'https://old.example/' })
      await vi.waitFor(() => { expect(stale.state().install.registries).toEqual(REGISTRIES) })
      expect(stale.state().install.registry).toEqual({ kind: 'custom', url: 'https://old.example/' })
      // A read the Host refuses leaves pnpm's own and a typed one; one that settles after the dialog closed is dropped.
      const gate = deferred<ReturnType<typeof ok<typeof REGISTRIES>>>()
      const closed = bench({ registries: vi.fn().mockResolvedValueOnce(refused('unavailable', 'no profile')).mockReturnValueOnce(gate.promise) })
      closed.face.openInstall()
      await Promise.resolve()
      await Promise.resolve()
      expect(closed.state().install.registries).toBeNull()
      closed.face.closeInstall()
      closed.face.openInstall()
      closed.face.closeInstall()
      gate.resolve(ok(REGISTRIES))
      await Promise.resolve()
      await Promise.resolve()
      expect(closed.state().install).toMatchObject({ open: false, registries: null })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('goes back to the spec with the registries open from a failed run, keeping the registries the Host asked', async () => {
    const outcome = {
      ...failed({ code: 'operation-error', diagnostic: 'ETIMEDOUT' }, { exitCode: 1, output: '', truncated: false, logPath: '/l', kind: 'network' }),
      registries: [null, MIRROR], failedAt: 'registry' as const,
    }
    const { face, state } = bench({ installBundle: vi.fn(() => Promise.resolve(ok(outcome))) })
    face.openInstall()
    face.editInstallSpec('dsh-new')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    expect(state().install.failure).toMatchObject({ kind: 'network', failedAt: 'registry' })
    expect(state().install.attempts).toEqual({ registries: [null, MIRROR], total: 2 })
    face.changeRegistry()
    expect(state().install).toMatchObject({ phase: 'idle', spec: 'dsh-new', registryOpen: true, runs: [], failure: null })
  })

  it.each(['network', 'timeout'] as const)('recovers a GitHub %s failure without retrying its URL through a mirror', async (kind) => {
    const spec = 'https://github.com/example/dsh-plugin.git'
    const inspect = vi.fn().mockResolvedValueOnce(ok({ status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' }))
      .mockResolvedValue(ok({ ...INSPECTED, registry: MIRROR }))
    const { face, state, plugins } = bench({
      inspect,
      installBundle: vi.fn().mockResolvedValueOnce(ok({
        ...failed(undefined, { exitCode: 1, output: 'Could not resolve host: github.com', truncated: false, logPath: '/l', kind }),
        failedAt: 'spec-host',
      })).mockResolvedValueOnce(ok({
        ...failed(undefined, { exitCode: 1, output: 'Registry connection failed', truncated: false, logPath: '/l', kind: 'network' }),
        failedAt: 'registry',
      })).mockResolvedValue(ok({ ...APPLIED, bundle: 'dsh-new' })),
    })
    face.openInstall()
    await vi.waitFor(() => { expect(state().install.registries).toEqual(REGISTRIES) })
    face.editInstallSpec(spec)
    face.useGithubMirror()
    expect(state().install.spec).toBe(spec)
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    face.useGithubMirror()
    expect(state().install).toMatchObject({
      phase: 'idle', open: true, spec: '', mirrorRecovery: true, registry: { kind: 'offered', registry: MIRROR },
      registryOpen: false, failure: null, runs: [],
    })
    expect(plugins.installBundle).toHaveBeenCalledTimes(1)
    face.editInstallSpec('dsh-new')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    face.changeRegistry()
    expect(state().install).toMatchObject({ phase: 'idle', spec: 'dsh-new', mirrorRecovery: true, registryOpen: true })
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
    expect(plugins.inspect).toHaveBeenLastCalledWith('dsh-new', { registry: MIRROR }, expect.any(AbortSignal))
    expect(plugins.installBundle).toHaveBeenLastCalledWith('dsh-new', expect.objectContaining({ registry: MIRROR }))
    face.closeInstall()
    face.openInstall()
    await vi.waitFor(() => { expect(state().install.registries).toEqual(REGISTRIES) })
    expect(state().install.registry).toEqual({ kind: 'offered', registry: MIRROR })
  })

  it.each([
    ['typed as an address', { kind: 'custom', url: 'https://registry.npmmirror.com' }, REGISTRIES],
    ['named by pnpm\'s own configuration', { kind: 'offered', registry: null }, { ...REGISTRIES, resolved: MIRROR }],
  ] as const)('clears the GitHub address and keeps the registry when the install already asked the mirror %s', async (_how, choice, registries) => {
    const { face, state, plugins } = bench({
      registries: vi.fn(() => Promise.resolve(ok(registries))),
      inspect: vi.fn(() => Promise.resolve(ok({ status: 'accepted', kind: 'git', bundle: null, registry: MIRROR, host: 'github.com' }))),
      installBundle: vi.fn(() => Promise.resolve(ok({
        ...failed(undefined, { exitCode: 1, output: 'Could not resolve host: github.com', truncated: false, logPath: '/l', kind: 'timeout' }),
        failedAt: 'spec-host',
      }))),
    })
    face.openInstall()
    await vi.waitFor(() => { expect(state().install.registries).toEqual(registries) })
    face.chooseRegistry(choice)
    face.editInstallSpec('https://github.com/example/dsh-plugin.git')
    face.runInstall()
    await vi.waitFor(() => { expect(state().install.phase).toBe('failed') })
    face.useGithubMirror()
    expect(state().install).toMatchObject({ phase: 'idle', spec: '', mirrorRecovery: true, registry: choice, failure: null })
    // The choice stays as made, so the next dialog starts from it too.
    face.closeInstall()
    face.openInstall()
    await vi.waitFor(() => { expect(state().install.registries).toEqual(registries) })
    expect(state().install.registry).toEqual(choice)
    expect(plugins.installBundle).toHaveBeenCalledTimes(1)
  })
})

describe('Host registry response recommendation', () => {
  it('inspects the remembered registry when the offered choice becomes custom during the initial read', async () => {
    const key = 'dsh.plugin-manager.install-registry'
    const registry = 'https://old.example/'
    const storage = new Map([[key, JSON.stringify({ kind: 'offered', registry })]])
    const registries = deferred<ReturnType<typeof ok<typeof REGISTRIES>>>()
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => { storage.set(name, value) },
      removeItem: (name: string) => { storage.delete(name) },
    })
    try {
      const { face, state, plugins, probe } = bench({
        registries: vi.fn(() => registries.promise),
        inspect: vi.fn(async () => ok({ ...INSPECTED, registry })),
      })
      face.openInstall()
      face.editInstallSpec('dsh-new')
      face.runInstall()
      expect(state().install.phase).toBe('checking')
      expect(plugins.inspect).not.toHaveBeenCalled()
      registries.resolve(ok(REGISTRIES))
      await vi.waitFor(() => { expect(plugins.inspect).toHaveBeenCalled() })
      expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', { registry }, expect.any(AbortSignal))
      expect(state().install.registry).toEqual({ kind: 'custom', url: registry })
      expect(JSON.parse(storage.get(key)!)).toEqual({ kind: 'custom', url: registry })
      expect(probe.fastest).not.toHaveBeenCalled()
      await vi.waitFor(() => { expect(state().install.phase).toBe('done') })
      expect(plugins.installBundle).toHaveBeenCalledWith('dsh-new', expect.objectContaining({ registry }))
    } finally {
      registries.resolve(ok(REGISTRIES))
      vi.unstubAllGlobals()
    }
  })

  it('selects the mainland mirror before the first inspection, even when install was clicked during lookup', async () => {
    const fastest = deferred<ReturnType<typeof ok<string | null>>>()
    const { face, state, plugins, probe } = bench({ fastest: vi.fn(() => fastest.promise) })
    face.openInstall()
    face.editInstallSpec('dsh-new')
    face.runInstall()
    await vi.waitFor(() => { expect(probe.fastest).toHaveBeenCalledOnce() })
    expect(plugins.inspect).not.toHaveBeenCalled()
    fastest.resolve(ok(MIRROR))
    await vi.waitFor(() => { expect(plugins.inspect).toHaveBeenCalled() })
    expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', { registry: MIRROR }, expect.any(AbortSignal))
    expect(state().install.registry).toEqual({ kind: 'offered', registry: MIRROR })
  })

  it.each([OFFICIAL, null])('keeps the default for probe result %s', async (winner) => {
    const { face, state, probe } = bench({ fastest: vi.fn(() => Promise.resolve(ok(winner))) })
    face.openInstall()
    await vi.waitFor(() => { expect(probe.fastest).toHaveBeenCalledOnce() })
    expect(state().install.registry).toEqual({ kind: 'offered', registry: null })
  })

  it('keeps the default when the Host lookup is unavailable', async () => {
    const { face, state, probe } = bench({ fastest: vi.fn(() => Promise.resolve(refused('gateway/internal', 'offline'))) })
    face.openInstall()
    await vi.waitFor(() => { expect(probe.fastest).toHaveBeenCalledOnce() })
    expect(state().install.registry).toEqual({ kind: 'offered', registry: null })
  })

  it.each([
    { registry: MIRROR, resolved: OFFICIAL, fallbackRegistries: [MIRROR] },
    { registry: null, resolved: CORP, fallbackRegistries: [MIRROR] },
    { registry: null, resolved: null, fallbackRegistries: [MIRROR] },
    { registry: null, resolved: 'invalid', fallbackRegistries: [MIRROR] },
    { registry: null, resolved: OFFICIAL, fallbackRegistries: [] },
  ])('does not probe registries for an ineligible registry configuration %j', async (registries) => {
    const { face, state, probe } = bench({ registries: vi.fn(() => Promise.resolve(ok(registries))) })
    face.openInstall()
    await vi.waitFor(() => { expect(state().install.registries).toEqual(registries) })
    expect(state().install.registry).toEqual({ kind: 'offered', registry: registries.registry })
    expect(probe.fastest).not.toHaveBeenCalled()
  })

  it('preserves a manual choice made before the registry list arrives', async () => {
    const registries = deferred<ReturnType<typeof ok<typeof REGISTRIES>>>()
    const { face, state, probe } = bench({ registries: vi.fn(() => registries.promise) })
    face.openInstall()
    face.chooseRegistry({ kind: 'custom', url: CORP })
    registries.resolve(ok(REGISTRIES))
    await vi.waitFor(() => { expect(state().install.registries).toEqual(REGISTRIES) })
    expect(state().install.registry).toEqual({ kind: 'custom', url: CORP })
    expect(probe.fastest).not.toHaveBeenCalled()
  })

  it('does not overwrite a manual choice or wait for registry probing after that choice', async () => {
    const fastest = deferred<ReturnType<typeof ok<string | null>>>()
    const { face, state, plugins, probe } = bench({ fastest: vi.fn(() => fastest.promise) })
    face.openInstall()
    await vi.waitFor(() => { expect(probe.fastest).toHaveBeenCalledOnce() })
    face.chooseRegistry({ kind: 'custom', url: CORP })
    face.editInstallSpec('dsh-new')
    face.runInstall()
    await vi.waitFor(() => { expect(plugins.inspect).toHaveBeenCalled() })
    fastest.resolve(ok(MIRROR))
    await fastest.promise
    expect(state().install.registry).toEqual({ kind: 'custom', url: CORP })
    expect(plugins.inspect).toHaveBeenCalledWith('dsh-new', { registry: CORP }, expect.any(AbortSignal))
  })

  it.each(['close', 'dispose'] as const)('discards a waiting install after %s', async (action) => {
    const fastest = deferred<ReturnType<typeof ok<string | null>>>()
    const { face, controller, plugins, probe } = bench({ fastest: vi.fn(() => fastest.promise) })
    face.openInstall()
    face.editInstallSpec('dsh-new')
    face.runInstall()
    await vi.waitFor(() => { expect(probe.fastest).toHaveBeenCalledOnce() })
    if (action === 'close') face.closeInstall()
    else controller.dispose()
    fastest.resolve(ok(MIRROR))
    await fastest.promise
    await Promise.resolve()
    expect(plugins.inspect).not.toHaveBeenCalled()
  })
})

it('recognizes the official registry without a trailing slash and with uppercase host letters', async () => {
  const { face, state } = bench({
    registries: vi.fn(async () => ok({ ...REGISTRIES, resolved: 'https://REGISTRY.NPMJS.ORG' })),
    fastest: vi.fn(async () => ok(MIRROR)),
  })
  face.openInstall()
  await vi.waitFor(() => { expect(state().install.registry).toEqual({ kind: 'offered', registry: MIRROR }) })
})
