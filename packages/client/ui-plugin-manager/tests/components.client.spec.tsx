// @vitest-environment jsdom
import type { ConfigPageForm } from '../src/client/slot-contract.ts'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PluginEntryId, PluginInstallRequestId } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigForm, ConfigFormSnapshot, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { StrictMode, type ReactNode } from 'react'
import { createNavigationStore } from '../src/client/navigation-store.ts'
import { PluginManagerPage } from '../src/client/PluginManagerPage.tsx'
import type { PluginManagerPageProps } from '../src/client/index.ts'
import type { ConfigLedger } from '../src/client/config-ledger.ts'
import { rowKey, type InstallState, type PackageRow, type PackageView, type PluginManagerState } from '../src/client/manager-store.ts'
import { en, zh, type PluginManagerLocaleKey } from '../src/client/locales.ts'
import type { PluginActivationOwnerProps, PluginDetailProps, PluginsSubject } from '../src/client/slot-contract.ts'

afterEach(cleanup)

const translate = (dict: typeof en): PluginManagerPageProps['t'] => ((key: PluginManagerLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    dict[key],
  )) as PluginManagerPageProps['t']

const t = translate(en)

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

const INCOMPATIBLE = { name: 'dsh-late', version: '2.0.0', runtimeVersion: '0.1.0', peers: { '@deepseek-ai/dsh': '^0.2.0', '@deepseek-ai/dsh-core': '^0.2.0' } }
/** The English sentence an incompatibility of {@link INCOMPATIBLE}, optionally renamed, reads as. */
const incompatibleText = (name = INCOMPATIBLE.name): string => en.reasonIncompatibleVersion
  .replace('{plugin}', `${name}@2.0.0`).replace('{runtime}', '0.1.0').replace('{peers}', '@deepseek-ai/dsh ^0.2.0, @deepseek-ai/dsh-core ^0.2.0')
const MIRROR = 'https://registry.npmmirror.com/'
const OFFICIAL = 'https://registry.npmjs.org/'

/** The registries the Host asks: pnpm's own first, which names npm's own registry, then the mirror. */
const REGISTRIES = { registry: null, fallbackRegistries: [MIRROR], resolved: OFFICIAL }

/** pnpm's own registry as the options label it: by npm's own name once read, the neutral default name until then. */
const OFFICIAL_OPTION = en.registryWithHost.replace('{name}', en.registryOfficial).replace('{host}', 'registry.npmjs.org')
const UNREAD_OPTION = en.registryWithHost.replace('{name}', en.registryDefault).replace('{host}', 'registry.npmjs.org')
const MIRROR_OPTION = en.registryWithHost.replace('{name}', en.registryNpmmirror).replace('{host}', 'registry.npmmirror.com')

const IDLE_INSTALL: InstallState = {
  open: false, spec: '', registries: null, registry: { kind: 'offered', registry: null }, registryOpen: false, registryError: false, attempts: null,
  phase: 'idle', inputError: null, subject: null, runs: [], detailsOpen: false,
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

/**
 * Slot entries a test supplies: what each slot cell renders, by `<slot>:<cell>`
 * (a list slot's cell is empty), the view asked for — `detail` for a detail
 * contribution — and the owner props.
 */
type SlotBodies = Record<string, (view: 'summary' | 'page' | 'activation' | 'detail', owner: unknown, form?: ConfigPageForm) => ReactNode>

/** The subject a detail contribution was rendered with. */
function subjectOf(owner: unknown): PluginsSubject | undefined {
  return typeof owner === 'object' && owner !== null && 'subject' in owner ? (owner as PluginDetailProps).subject : undefined
}

const NO_CONFIG: ConfigLedger = { items: [], bundles: new Set(), rows: new Set() }

function renderTab(
  state: Partial<PluginManagerState> = {}, config: Partial<ConfigLedger> = {},
  bodies: SlotBodies = {}, forms: Record<string, ConfigPageForm> = {},
) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  const resolveText: PluginManagerPageProps['resolveText'] = text => locale.resolveText(text)
  const store = createSnapshotStore<PluginManagerState>({ ...READY, ...state })
  const ledger = createSnapshotStore<ConfigLedger>({ ...NO_CONFIG, ...config })
  const actions = {
    ensure: vi.fn(),
    refresh: vi.fn(),
    openInstall: vi.fn(),
    closeInstall: vi.fn(),
    editInstallSpec: vi.fn(),
    runInstall: vi.fn(),
    cancelInstall: vi.fn(),
    reconcileInstall: vi.fn(),
    toggleInstallDetails: vi.fn(),
    toggleRegistryOptions: vi.fn(),
    chooseRegistry: vi.fn(),
    changeRegistry: vi.fn(),
    useGithubMirror: vi.fn(),
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
  const unusedStandardHook = (): never => { throw new Error('Plugin manager fixture does not provide global state') }
  const standard = {
    usePanelInfo: unusedStandardHook,
    useWorkspaces: unusedStandardHook,
    useSessions: unusedStandardHook,
    useSessionStatus: unusedStandardHook,
    useSessionRetainInfo: unusedStandardHook,
    useResource: unusedStandardHook,
  }
  const navigation = createNavigationStore().create()
  const props: PluginManagerPageProps = {
    useStore: bindSnapshotSelector(navigation), actions: navigation.actions,
    ...standard,
    t,
    resolveText,
    ...actions,
    usePluginManager: bindSnapshotSelector(store),
    useConfigLedger: bindSnapshotSelector(ledger),
    useConfigurations: bindSnapshotSelector(createSnapshotStore<SettingsMirrorSnapshot>({
      status: 'ready', error: null,
      view: { writable: true, hasDocument: true, namespaces: Object.keys(forms).map(ns => ({
        ns, schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 0, autoGenerate: true,
      })) },
    })),
    configForm: <T,>(id: string): ConfigForm<T> => {
      const stub = stubConfigForm<T>()
      stub.publish(forms[id]!.state as ConfigFormSnapshot<T>)
      return { ...stub.scope, mutate: forms[id]!.mutate }
    },
    renderSlot: (name, owner, opts) => {
      const body = bodies[`${name}:${opts?.only ?? opts?.entryKey ?? ''}`]
      if (body === undefined) return null
      if (name === 'plugins.bundle.activation') return body('activation', owner)
      if (name.startsWith('plugins.detail.')) return body('detail', owner)
      if (!('view' in owner) || (owner.view !== 'summary' && owner.view !== 'page')) {
        throw new Error('Plugin configuration fixture requires a summary or page view')
      }
      return body(owner.view, owner, 'form' in owner ? owner.form as ConfigPageForm | undefined : undefined)
    },
  }
  const { rerender, unmount } = render(<PluginManagerPage {...props} />)
  return {
    navigation,
    props,
    unmount,
    store,
    actions,
    set: (next: Partial<PluginManagerState>) => { act(() => { store.set({ ...store.getSnapshot(), ...next }) }) },
    setLanguage: (dict: typeof en) => {
      locale.setLocale(dict === zh ? 'zh' : 'en')
      rerender(<PluginManagerPage {...props} t={translate(dict)} />)
    },
  }
}

describe('PluginManagerPage', () => {
  it('opens the requested bundle after its inventory arrives and falls back when it is absent', () => {
    const b = renderTab({ status: 'loading' })
    act(() => { b.navigation.actions.setView({ kind: 'package', name: 'dsh-better-sidebar' }) })
    b.set({ status: 'ready', packages: [pkg()] })
    expect(document.querySelector('[data-plugin-detail="dsh-better-sidebar"]')).not.toBeNull()
    act(() => { b.navigation.actions.setView({ kind: 'package', name: 'missing' }) })
    expect(document.querySelector('[data-plugin-detail]')).toBeNull()
    expect(document.querySelector('[data-plugin-package="dsh-better-sidebar"]')).not.toBeNull()
  })

  it('preserves the requested bundle through StrictMode effect replay and page remounts', () => {
    const b = renderTab({ packages: [pkg()] })
    b.unmount()
    act(() => { b.navigation.actions.setView({ kind: 'package', name: 'dsh-better-sidebar' }) })
    const view = render(<StrictMode><PluginManagerPage {...b.props} /></StrictMode>)
    expect(document.querySelector('[data-plugin-detail="dsh-better-sidebar"]')).not.toBeNull()
    view.unmount()
    render(<PluginManagerPage {...b.props} />)
    expect(document.querySelector('[data-plugin-detail="dsh-better-sidebar"]')).not.toBeNull()
  })

  it('asks the store once mounted and renders the loading, unavailable, error, and empty states', () => {
    const { actions, set } = renderTab({ status: 'loading' })
    expect(actions.ensure).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.loading).querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: en.addPlugin })).toHaveProperty('disabled', true)
    set({ status: 'unavailable' })
    expect(screen.getByRole('status').querySelector('[data-state="idle"]')).not.toBeNull()
    set({ status: 'error' })
    expect(screen.getByRole('alert').querySelector('[data-state="error"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(actions.refresh).toHaveBeenCalledTimes(2)
    set({ status: 'ready' })
    expect(screen.getByText(en.empty)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.addPlugin }))
    expect(actions.openInstall).toHaveBeenCalledTimes(1)
  })

  it('keeps the read failure and its retry visible while a detail page is open', () => {
    const { actions, set } = renderTab({ packages: [pkg()] })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
    expect(screen.queryByRole('alert')).toBeNull()
    set({ status: 'error' })
    expect(screen.getByRole('alert').querySelector('[data-state="error"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    // The detail keeps showing the kept data behind the alert.
    expect(document.querySelector('[data-plugin-detail]')).not.toBeNull()
  })

  it('lists the installed bundles as cards, the installation\'s offered ones as official, and tags a problem the Host reports', () => {
    const { actions } = renderTab({
      packages: [
        pkg({ meta: { description: { en: 'A sidebar.' } } }),
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
    // The Official group comes first.
    expect(cards.map(card => card.getAttribute('data-plugin-package'))).toEqual([
      '@deepseek-ai/dsh-experimental-agent-team-profile', 'dsh-better-sidebar', 'dsh-broken', 'dsh-protected', '@acme/dsh-tool', 'dsh-selected',
    ])
    expect(cards.map(card => card.getAttribute('data-plugin-status'))).toEqual(['disabled', 'running', 'problem', 'running', 'disabled', 'problem'])
    // Each group heads with its title and its bare count; the official bundle carries its beta tag, no official tag.
    expect(screen.getByRole('heading', { name: en.bundlesTitle })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.officialTitle })).toBeTruthy()
    expect([...document.querySelectorAll('[data-plugin-count]')].map(count => count.textContent)).toEqual(['1', '5'])
    expect(screen.getAllByText(en.statusBeta)).toHaveLength(1)
    expect(screen.getByRole('switch', { name: en.enableToggle.replace('{name}', '@acme/dsh-tool') })).toHaveProperty('disabled', false)
    expect(screen.getByText('A sidebar.')).toBeTruthy()
    expect(screen.getAllByText(en.statusProblem)).toHaveLength(2)
    // The switch acts on the bundle; a bundle the Host cannot read stays off, a protected one stays as it is.
    fireEvent.click(screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'dsh-better-sidebar') }))
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    expect(screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'dsh-broken') })).toHaveProperty('disabled', true)
    const locked = screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'dsh-protected') })
    expect(locked).toHaveProperty('disabled', true)
    expect(locked.getAttribute('title')).toBe(en.reasonManagementRequired)
  })

  it('omits built-in profile dependencies from cards and counts while retaining optional and third-party bundles', () => {
    renderTab({
      packages: [
        ...[
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@deepseek-ai/dsh-headless',
          '@deepseek-ai/dsh-sdk-app',
          '@deepseek-ai/dsh-acp-app',
          '@deepseek-ai/dsh-sdk-minimal',
        ].map(name => pkg({ name })),
        pkg({ name: '@acme/dsh-base', readOnlyReason: 'management-required' }),
        pkg({ name: 'dsh-better-sidebar' }),
        pkg({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true }),
      ],
    })
    expect(screen.getAllByRole('listitem').map(card => card.getAttribute('data-plugin-package'))).toEqual([
      '@deepseek-ai/dsh-experimental-agent-team-profile', '@acme/dsh-base', 'dsh-better-sidebar',
    ])
    expect([...document.querySelectorAll('[data-plugin-count]')].map(count => count.textContent)).toEqual(['1', '2'])
  })

  it.each([false, true])('shows an empty list for built-in bundles with errors and installed=%s', (installed) => {
    renderTab({
      packages: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map(name => pkg({
        name, installed, error: { code: 'operation-error', diagnostic: 'Unreadable bundle' },
      })),
    })
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(document.querySelectorAll('[data-plugin-count]')).toHaveLength(0)
  })

  it('opens an official bundle\'s page with its beta tag and no uninstall, and switches it on', () => {
    const title = 'Agent Teams'
    const { actions } = renderTab({
      packages: [pkg({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', meta: { title }, installed: false, optional: true, enabled: false })],
    })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', title) }))
    const detail = document.querySelector('[data-plugin-detail]') as HTMLElement
    expect(within(detail).getByText(en.statusBeta)).toBeTruthy()
    expect(within(detail).queryByRole('button', { name: en.uninstallLabel.replace('{name}', title) })).toBeNull()
    fireEvent.click(within(detail).getByRole('switch', { name: en.enableToggle.replace('{name}', title) }))
    expect(actions.setEnabled).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/dsh-experimental-agent-team-profile', true)
  })

  it.each([
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    '@deepseek-ai/dsh-experimental-auto-review',
    '@deepseek-ai/dsh-experimental-fixture-input',
    '@acme/dsh-local-tools',
  ])('localizes Host metadata for %s across cards, details, switches, and uninstall confirmation', (name) => {
    const meta = {
      title: { en: 'Installed tools', zh: '已安装工具' },
      description: { en: 'Tools on this host.', zh: '本机工具。' },
    }
    const title = (dict: typeof en): string => dict === zh ? meta.title.zh : meta.title.en
    const description = (dict: typeof en): string => dict === zh ? meta.description.zh : meta.description.en
    const { actions, set, setLanguage } = renderTab({ packages: [pkg({ name, meta, description: 'Original metadata.' })] })
    const assertCard = (dict: typeof en) => {
      const card = screen.getByRole('button', { name: dict.openDetail.replace('{name}', title(dict)) })
      expect(card.textContent).toBe(title(dict))
      expect(screen.getByText(description(dict))).toBeTruthy()
      expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe(description(dict))
      expect(screen.getByRole('switch', { name: dict.enableToggle.replace('{name}', title(dict)) })).toBeTruthy()
      expect(screen.queryByText('Original metadata.')).toBeNull()
      expect(screen.queryByText(dict.statusBeta) !== null).toBe(name.startsWith('@deepseek-ai/dsh-experimental-'))
    }
    assertCard(en)
    setLanguage(zh)
    assertCard(zh)
    fireEvent.click(screen.getByRole('switch', { name: zh.enableToggle.replace('{name}', title(zh)) }))
    expect(actions.setEnabled).toHaveBeenCalledExactlyOnceWith(name, false)
    fireEvent.click(screen.getByRole('button', { name: zh.openDetail.replace('{name}', title(zh)) }))
    for (const dict of [zh, en]) {
      setLanguage(dict)
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(title(dict))
      expect(screen.getByText(description(dict))).toBeTruthy()
      expect(document.querySelector('[data-plugin-name]')?.textContent).toBe(name)
      expect(screen.getByRole('switch', { name: dict.enableToggle.replace('{name}', title(dict)) })).toBeTruthy()
      expect(screen.getByRole('button', { name: dict.uninstallLabel.replace('{name}', title(dict)) })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: en.uninstallLabel.replace('{name}', title(en)) }))
    expect(actions.uninstall).toHaveBeenCalledExactlyOnceWith(name)
    set({ confirm: { action: 'uninstall', packageName: name } })
    for (const dict of [en, zh]) {
      setLanguage(dict)
      expect(screen.getByRole('dialog', { name: dict.confirmUninstallTitle.replace('{name}', title(dict)) })).toBeTruthy()
    }
  })

  it('renders manifest icons for arbitrary bundles and rows, with decode fallback and source recovery', () => {
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+'
    const updatedIcon = 'data:image/png;base64,cG5n'
    const bundle = pkg({ meta: { icon }, rows: [row({ meta: { icon } }), row({ entryId: 'plain' as PluginEntryId, rowId: 'plain', moduleName: 'plain' })] })
    const { set } = renderTab({ packages: [bundle] }, { rows: new Set(['dsh-better-sidebar#sidebar']) })
    const image = () => document.querySelector<HTMLImageElement>('[data-plugin-package] img, [data-plugin-detail] img')!
    expect(image().getAttribute('src')).toBe(icon)
    expect(image().getAttribute('alt')).toBe('')
    expect(image().width).toBe(36)
    fireEvent.error(image())
    expect(document.querySelector('[data-plugin-package] img')).toBeNull()
    expect(document.querySelector('[data-plugin-package] svg')).not.toBeNull()
    set({ packages: [{ ...bundle, meta: { icon: updatedIcon } }] })
    expect(image().getAttribute('src')).toBe(updatedIcon)
    set({ packages: [bundle] })
    expect(image().getAttribute('src')).toBe(icon)
    fireEvent.click(screen.getByRole('button', { name: 'View dsh-better-sidebar' }))
    expect(image().getAttribute('src')).toBe(icon)
    const rowImage = document.querySelector<HTMLImageElement>('[data-plugin-row] img')!
    expect(rowImage.getAttribute('src')).toBe(icon)
    expect(rowImage.width).toBe(30)
    expect(document.querySelector('[data-plugin-row="plain"] img')).toBeNull()
    expect(document.querySelector('[data-plugin-row="plain"] svg')).not.toBeNull()
    fireEvent.error(rowImage)
    expect(document.querySelector('[data-plugin-row] img')).toBeNull()
    expect(document.querySelector('[data-plugin-row] svg')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Configure dsh-better-sidebar' }))
    const detailImage = document.querySelector<HTMLImageElement>('[data-plugin-row-detail] img')!
    expect(detailImage.getAttribute('src')).toBe(icon)
    expect(detailImage.width).toBe(36)
  })

  it('shows metadata diagnostics without blocking management or displaying legacy descriptions', () => {
    const error = 'locale/zh.json: invalid title'
    const { actions, set, setLanguage } = renderTab({
      packages: [pkg({ enabled: false, description: 'Legacy description.', meta: { error } })],
    })
    expect(screen.getByText(en.metadataError.replace('{error}', error))).toBeTruthy()
    expect(screen.queryByText('Legacy description.')).toBeNull()
    const enable = screen.getByRole('switch', { name: en.enableToggle.replace('{name}', 'dsh-better-sidebar') })
    expect(enable).toHaveProperty('disabled', false)
    fireEvent.click(enable)
    expect(actions.setEnabled).toHaveBeenCalledExactlyOnceWith('dsh-better-sidebar', true)
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
    expect(screen.getByText(en.metadataError.replace('{error}', error))).toBeTruthy()
    const uninstall = screen.getByRole('button', { name: en.uninstallLabel.replace('{name}', 'dsh-better-sidebar') })
    expect(uninstall).toHaveProperty('disabled', false)
    fireEvent.click(uninstall)
    expect(actions.uninstall).toHaveBeenCalledExactlyOnceWith('dsh-better-sidebar')

    setLanguage(zh)
    expect(screen.getByText(zh.metadataError.replace('{error}', error))).toBeTruthy()
    set({ packages: [pkg({ meta: { title: 'Literal title', description: { en: 'English fallback.' } } })] })
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Literal title')
    expect(screen.getByText('English fallback.')).toBeTruthy()
    expect(document.querySelector('[data-package-meta-error]')).toBeNull()
  })

  it.each<{
    field: string
    meta: NonNullable<PackageView['meta']>
    englishTitle: string
    chineseTitle: string
    englishDescription?: string
    chineseDescription: string
  }>([
    {
      field: 'title',
      meta: { title: { en: '@acme/dsh-sidebar', zh: '侧栏套件' }, description: 'Package description.' },
      englishTitle: '@acme/dsh-sidebar', chineseTitle: '侧栏套件',
      englishDescription: 'Package description.', chineseDescription: 'Package description.',
    },
    {
      field: 'description',
      meta: { title: { en: 'English title' }, description: { en: '', zh: '中文套件说明。' } },
      englishTitle: 'English title', chineseTitle: 'English title', chineseDescription: '中文套件说明。',
    },
  ])('resolves bundle $field independently and hides empty descriptions on cards and details', ({ meta, englishTitle, chineseTitle, englishDescription, chineseDescription }) => {
    const { setLanguage } = renderTab({ packages: [pkg({ name: '@acme/dsh-sidebar', meta })] })
    const languages = [
      { dict: en, title: englishTitle, description: englishDescription },
      { dict: zh, title: chineseTitle, description: chineseDescription },
      { dict: en, title: englishTitle, description: englishDescription },
    ]
    for (const { dict, title, description } of languages) {
      setLanguage(dict)
      const card = screen.getByRole('button', { name: dict.openDetail.replace('{name}', title) })
      expect(card.textContent).toBe(title)
      if (description === undefined) {
        expect(card.getAttribute('aria-describedby')).toBeNull()
        expect(screen.queryByText(chineseDescription)).toBeNull()
      } else {
        expect(screen.getByText(description)).toBeTruthy()
        expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe(description)
      }
    }
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', englishTitle) }))
    for (const { dict, title, description } of languages) {
      setLanguage(dict)
      expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(title)
      if (description === undefined) {
        expect(screen.queryByText(chineseDescription)).toBeNull()
        expect(screen.queryByText(dict === zh ? '暂无描述。' : 'No description.')).toBeNull()
      } else {
        expect(screen.getByText(description)).toBeTruthy()
      }
    }
  })

  it('resolves row fields independently from bundle metadata and preserves subpath specifiers', () => {
    const rows = [
      row({ moduleName: '@acme/dsh-sidebar/navigation', meta: { description: { en: 'Navigation description.' } } }),
      row({
        rowId: 'theme', entryId: 'include:theme' as PluginEntryId, moduleName: '@acme/dsh-theme/client',
        meta: { title: { en: '@acme/dsh-theme', zh: '主题插件' }, description: { en: '', zh: '中文主题说明。' } },
      }),
    ]
    const { actions, setLanguage } = renderTab(
      { packages: [pkg({ meta: { title: 'Bundle title', description: 'Bundle description.' }, rows })] },
      { rows: new Set(['dsh-better-sidebar#theme']) },
      { 'plugins.row.config:dsh-better-sidebar#theme': view => view === 'page' ? <form aria-label="theme settings" /> : null },
    )
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'Bundle title') }))
    expect(screen.getByRole('switch', { name: en.partToggle.replace('{name}', '@acme/dsh-sidebar/navigation') })).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.partToggle.replace('{name}', '@acme/dsh-theme') })).toBeTruthy()
    expect(screen.queryByText('中文主题说明。')).toBeNull()
    setLanguage(zh)
    const navigation = document.querySelector('[data-plugin-row="include:sidebar"]') as HTMLElement
    expect(within(navigation).getByText('Navigation description.')).toBeTruthy()
    expect(within(navigation).queryByText('Bundle title')).toBeNull()
    expect(within(navigation).queryByText('Bundle description.')).toBeNull()
    fireEvent.click(within(navigation).getByRole('switch', { name: zh.partToggle.replace('{name}', '@acme/dsh-sidebar/navigation') }))
    expect(actions.setRowEnabled).toHaveBeenCalledExactlyOnceWith('include:sidebar', false)
    expect(screen.getByText('中文主题说明。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.configureRow.replace('{name}', '主题插件') }))
    expect(document.querySelector('[data-plugin-row-detail]')?.getAttribute('data-plugin-row-detail')).toBe('dsh-better-sidebar#theme')
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('主题插件')
    expect(screen.getByText('中文主题说明。')).toBeTruthy()
    setLanguage(en)
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('@acme/dsh-theme')
    expect(screen.getByText('@acme/dsh-theme/client')).toBeTruthy()
    expect(screen.getByText('theme')).toBeTruthy()
    expect(screen.queryByText('中文主题说明。')).toBeNull()
    expect(screen.getByRole('form', { name: 'theme settings' })).toBeTruthy()
  })

  it('shows a row id only once when it is the localized title in lists and configuration pages', () => {
    const moduleName = '@acme/dsh-sidebar/navigation'
    const { setLanguage } = renderTab(
      { packages: [pkg({ rows: [row({ moduleName, meta: { title: { en: 'Sidebar component', zh: 'sidebar' } } })] })] },
      { rows: new Set(['dsh-better-sidebar#sidebar']) },
      { 'plugins.row.config:dsh-better-sidebar#sidebar': view => view === 'page' ? <form aria-label="sidebar settings" /> : null },
    )
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
    const listed = document.querySelector('[data-plugin-row="include:sidebar"]') as HTMLElement
    expect(within(listed).getByText('Sidebar component')).toBeTruthy()
    expect(within(listed).getByText('sidebar', { selector: 'code' })).toBeTruthy()
    setLanguage(zh)
    expect(within(listed).getAllByText('sidebar')).toHaveLength(1)
    expect(within(listed).queryByText('sidebar', { selector: 'code' })).toBeNull()
    expect(within(listed).getByText(moduleName, { selector: 'code' })).toBeTruthy()

    fireEvent.click(within(listed).getByRole('button', { name: zh.configureRow.replace('{name}', 'sidebar') }))
    const detail = document.querySelector('[data-plugin-row-detail="dsh-better-sidebar#sidebar"]') as HTMLElement
    expect(within(detail).getByRole('heading', { level: 3 }).textContent).toBe('sidebar')
    expect(within(detail).getAllByText('sidebar')).toHaveLength(1)
    expect(within(detail).queryByText('sidebar', { selector: 'code' })).toBeNull()
    expect(within(detail).getByText(moduleName, { selector: 'code' })).toBeTruthy()
    expect(within(detail).getByRole('form', { name: 'sidebar settings' })).toBeTruthy()
    setLanguage(en)
    expect(within(detail).getByRole('heading', { level: 3 }).textContent).toBe('Sidebar component')
    expect(within(detail).getByText('sidebar', { selector: 'code' })).toBeTruthy()
  })

  it('translates row text, searches current copy and technical identities, and keeps configuration keys unchanged', () => {
    const error = 'locale/zh.json: invalid description'
    const localized = row({
      moduleName: '@acme/dsh-sidebar-widget',
      meta: {
        title: { en: 'Sidebar component', zh: '导航组件' },
        description: { en: 'Sidebar navigation', zh: '侧边导航' },
        error,
      },
    })
    const rows = [localized, ...Array.from({ length: 10 }, (_, index) => row({
      rowId: `extra-${String(index)}`, entryId: `include:extra-${String(index)}` as PluginEntryId, moduleName: '@acme/other',
    }))]
    const { actions, setLanguage } = renderTab(
      { packages: [pkg({ meta: { title: { en: 'Personal tools', zh: '个人工具' } }, rows })] },
      { rows: new Set(['dsh-better-sidebar#sidebar']) },
      { 'plugins.row.config:dsh-better-sidebar#sidebar': view => view === 'summary' ? 'Config summary' : <form aria-label="row settings" /> },
    )
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'Personal tools') }))
    setLanguage(zh)
    const search = screen.getByRole('searchbox', { name: zh.partsFilter })
    for (const query of ['导航组件', '侧边导航', 'sidebar', '@acme/dsh-sidebar-widget']) {
      fireEvent.change(search, { target: { value: query } })
      expect(document.querySelectorAll('[data-plugin-row]')).toHaveLength(1)
      expect(screen.getByRole('button', { name: zh.configureRow.replace('{name}', '导航组件') })).toBeTruthy()
    }
    expect(screen.getByText('sidebar')).toBeTruthy()
    expect(screen.getByText('@acme/dsh-sidebar-widget')).toBeTruthy()
    expect(screen.getByText('侧边导航')).toBeTruthy()
    expect(screen.getByText(zh.metadataError.replace('{error}', error))).toBeTruthy()
    const toggle = screen.getByRole('switch', { name: zh.partToggle.replace('{name}', '导航组件') })
    expect(toggle).toHaveProperty('disabled', false)
    fireEvent.click(toggle)
    expect(actions.setRowEnabled).toHaveBeenCalledExactlyOnceWith('include:sidebar', false)

    fireEvent.change(search, { target: { value: 'Sidebar component' } })
    expect(screen.getByText(zh.partsFilterEmpty)).toBeTruthy()
    setLanguage(en)
    expect(screen.getByRole('button', { name: en.configureRow.replace('{name}', 'Sidebar component') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.configureRow.replace('{name}', 'Sidebar component') }))
    expect(document.querySelector('[data-plugin-row-detail]')?.getAttribute('data-plugin-row-detail')).toBe('dsh-better-sidebar#sidebar')
    expect(screen.getByRole('form', { name: 'row settings' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Sidebar component')
    expect(screen.getByText('Sidebar navigation')).toBeTruthy()
    expect(screen.queryByText('Config summary')).toBeNull()
    setLanguage(zh)
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('导航组件')
    expect(screen.getByText('侧边导航')).toBeTruthy()
    expect(screen.getByText('sidebar')).toBeTruthy()
    expect(screen.getByText('@acme/dsh-sidebar-widget')).toBeTruthy()
    expect(screen.getByText(zh.metadataError.replace('{error}', error))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.backToPackage.replace('{name}', '个人工具') }))
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('个人工具')
  })

  describe('configuration pages', () => {
    const bodies: SlotBodies = {
      'plugins.item:bash': view => view === 'summary' ? 'Limits every command.' : <form aria-label="bash form" />,
      'plugins.bundle.config:dsh-better-sidebar': view => view === 'page' ? <form aria-label="sidebar form" /> : null,
      'plugins.row.config:dsh-better-sidebar#sidebar': view => view === 'summary' ? 'The sidebar row.' : <form aria-label="row form" />,
    }

    it('lists an official plugin after the official bundles with its summary, and opens its page', () => {
      renderTab(
        { packages: [pkg({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', installed: false, optional: true, enabled: false })] },
        { items: [{ id: 'bash', label: 'Shell' }] },
        bodies,
      )
      const official = document.querySelector('[data-plugin-group="official"]') as HTMLElement
      expect(within(official).getAllByRole('listitem').map(card => card.getAttribute('data-plugin-item') ?? card.getAttribute('data-plugin-package')))
        .toEqual(['@deepseek-ai/dsh-experimental-agent-team-profile', 'bash'])
      expect(document.querySelector('[data-plugin-count]')?.textContent).toBe('2')
      expect(within(official).getByText('Limits every command.')).toBeTruthy()
      // An official plugin has no switch of its own: the Host composes it.
      expect(within(official).queryByRole('switch', { name: en.enableToggle.replace('{name}', 'Shell') })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'Shell') }))
      const detail = document.querySelector('[data-plugin-item-detail="bash"]') as HTMLElement
      expect(within(detail).getByRole('heading', { level: 3 }).textContent).toBe('Shell')
      expect(within(detail).getByText('Limits every command.')).toBeTruthy()
      expect(within(detail).getByRole('form', { name: 'bash form' })).toBeTruthy()
      fireEvent.click(within(detail).getByRole('button', { name: en.backToList }))
      expect(document.querySelector('[data-plugin-item-detail]')).toBeNull()
      expect(screen.getByRole('heading', { name: en.officialTitle })).toBeTruthy()
    })

    it('counts an official plugin as content: the empty line waits for a page with nothing at all', () => {
      renderTab({ packages: [] }, { items: [{ id: 'bash', label: 'Shell' }] }, bodies)
      expect(screen.queryByText(en.empty)).toBeNull()
      expect(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'Shell') })).toBeTruthy()
    })

    it('gives an official plugin without artwork of its own the default artwork', () => {
      renderTab({ packages: [] }, { items: [{ id: 'custom-tool', label: 'Custom' }] })
      const card = document.querySelector('[data-plugin-item="custom-tool"]') as HTMLElement
      const stops = [...card.querySelectorAll('stop')].map(stop => stop.getAttribute('stop-color'))
      expect(stops).toEqual(['#54ECE7', '#658EFF'])
    })

    it('renders a bundle\'s own configuration on its page, and no configure control on a row without one', () => {
      renderTab({ packages: [pkg({ rows: [row()] })] }, { bundles: new Set(['dsh-better-sidebar']) }, bodies)
      fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
      const detail = document.querySelector('[data-plugin-detail]') as HTMLElement
      expect(within(detail).getByRole('form', { name: 'sidebar form' })).toBeTruthy()
      expect(within(detail).queryByRole('button', { name: en.configureRow.replace('{name}', 'dsh-better-sidebar') })).toBeNull()
    })

    it('opens a row\'s configuration page from its configure control and leads back to the bundle', () => {
      const theme = row({ rowId: 'theme', moduleName: 'dsh-better-sidebar/theme', entryId: 'include:theme' as PluginEntryId })
      renderTab({ packages: [pkg({ rows: [row(), theme] })] }, { rows: new Set(['dsh-better-sidebar#sidebar']) }, bodies)
      fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
      expect(screen.queryByRole('button', { name: en.configureRow.replace('{name}', 'dsh-better-sidebar/theme') })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en.configureRow.replace('{name}', 'dsh-better-sidebar') }))
      const page = document.querySelector('[data-plugin-row-detail="dsh-better-sidebar#sidebar"]') as HTMLElement
      expect(within(page).getByRole('heading', { level: 3 }).textContent).toBe('dsh-better-sidebar')
      expect(within(page).getByText('dsh-better-sidebar', { selector: 'code' })).toBeTruthy()
      expect(within(page).getByText('sidebar', { selector: 'code' })).toBeTruthy()
      expect(within(page).getByText('The sidebar row.')).toBeTruthy()
      expect(within(page).getByRole('form', { name: 'row form' })).toBeTruthy()
      fireEvent.click(within(page).getByRole('button', { name: en.backToPackage.replace('{name}', 'dsh-better-sidebar') }))
      expect(document.querySelector('[data-plugin-row-detail]')).toBeNull()
      expect(document.querySelector('[data-plugin-detail="dsh-better-sidebar"]')).toBeTruthy()
    })
  })

  describe('detail contributions', () => {
    const subjects: PluginsSubject[] = []
    const label = (owner: unknown): string => {
      const subject = subjectOf(owner)
      if (subject === undefined) return 'none'
      subjects.push(subject)
      if (subject.kind === 'bundle') return `bundle ${subject.pkg.name}`
      if (subject.kind === 'row') return `row ${subject.pkg.name}#${subject.row.rowId}`
      return `item ${subject.id}`
    }
    const bodies: SlotBodies = {
      'plugins.item:bash': view => view === 'summary' ? 'Limits every command.' : <form aria-label="bash form" />,
      'plugins.row.config:dsh-better-sidebar#sidebar': view => view === 'summary' ? 'The sidebar row.' : <form aria-label="row form" />,
      'plugins.detail.actions:': (_view, owner) => <button type="button">{`act ${label(owner)}`}</button>,
      'plugins.detail.badge:': (_view, owner) => <span>{`badge ${label(owner)}`}</span>,
      'plugins.detail.section:': (_view, owner) => <section aria-label={`section ${label(owner)}`} />,
    }

    it('renders the contributed actions, badges, and sections on each page, told what the page is about', () => {
      renderTab(
        { packages: [pkg({ rows: [row()] })] },
        { items: [{ id: 'bash', label: 'Shell' }], rows: new Set(['dsh-better-sidebar#sidebar']) },
        bodies,
      )
      // The cards carry none of it.
      expect(screen.queryByRole('button', { name: /^act / })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
      const detail = document.querySelector('[data-plugin-detail]') as HTMLElement
      const act = within(detail).getByRole('button', { name: 'act bundle dsh-better-sidebar' })
      expect(within(detail).getByText('badge bundle dsh-better-sidebar')).toBeTruthy()
      const section = within(detail).getByRole('region', { name: 'section bundle dsh-better-sidebar' })
      // The contributed actions come before the page's own switch; the sections after the rows.
      const toggle = within(detail).getByRole('switch', { name: en.enableToggle.replace('{name}', 'dsh-better-sidebar') })
      expect(act.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const rows = detail.querySelector('[data-plugin-rows]') as HTMLElement
      expect(rows.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // A contribution sees the bundle's facts, not the page's own state.
      expect(subjects.at(-1)).toEqual({
        kind: 'bundle',
        pkg: { name: 'dsh-better-sidebar', version: '0.16.0', installed: true, enabled: true, rows: [{ rowId: 'sidebar', moduleName: 'dsh-better-sidebar', enabled: true }] },
      })

      fireEvent.click(screen.getByRole('button', { name: en.configureRow.replace('{name}', 'dsh-better-sidebar') }))
      const page = document.querySelector('[data-plugin-row-detail]') as HTMLElement
      expect(within(page).getByRole('button', { name: 'act row dsh-better-sidebar#sidebar' })).toBeTruthy()
      expect(within(page).getByText('badge row dsh-better-sidebar#sidebar')).toBeTruthy()
      expect(within(page).getByRole('region', { name: 'section row dsh-better-sidebar#sidebar' })).toBeTruthy()
      expect(subjects.at(-1)).toMatchObject({ kind: 'row', row: { rowId: 'sidebar', moduleName: 'dsh-better-sidebar', enabled: true } })
      fireEvent.click(within(page).getByRole('button', { name: en.backToPackage.replace('{name}', 'dsh-better-sidebar') }))
      fireEvent.click(screen.getByRole('button', { name: en.backToList }))

      fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'Shell') }))
      const item = document.querySelector('[data-plugin-item-detail="bash"]') as HTMLElement
      expect(within(item).getByRole('button', { name: 'act item bash' })).toBeTruthy()
      expect(within(item).getByText('badge item bash')).toBeTruthy()
      expect(within(item).getByRole('region', { name: 'section item bash' })).toBeTruthy()
      expect(within(item).getByRole('form', { name: 'bash form' })).toBeTruthy()
    })

    it('leaves the version out of a bundle the Host reports none for', () => {
      const unversioned: PackageView = { name: 'dsh-better-sidebar', installed: true, optional: false, enabled: true, rows: [] }
      renderTab({ packages: [unversioned] }, {}, bodies)
      fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
      expect(subjects.at(-1)).toEqual({ kind: 'bundle', pkg: { name: 'dsh-better-sidebar', installed: true, enabled: true, rows: [] } })
    })
  })

  it('preserves the full package name and description for a third-party scope', () => {
    const name = '@acme/dsh-experimental-agent-team-profile'
    const { setLanguage } = renderTab({ packages: [pkg({ name, meta: { description: { en: 'Third-party description.' } } })] })
    setLanguage(zh)
    fireEvent.click(screen.getByRole('button', { name: zh.openDetail.replace('{name}', name) }))
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(name)
    expect(screen.getByText('Third-party description.')).toBeTruthy()
    expect(document.querySelector('[data-plugin-name]')?.textContent).toBe(name)
  })

  it('opens a guide under the field and drops an example into it', () => {
    const { actions } = renderTab({ install: { ...IDLE_INSTALL, open: true } })
    expect(screen.queryByText(en.installGuideIdHint)).toBeNull()
    const toggle = screen.getByRole('button', { name: en.installGuideToggle })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: en.installGuideHide }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.installGuideIdHint)).toBeTruthy()
    expect(screen.getByText(en.installGuideGitExample)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.installGuideFillAria.replace('{example}', en.installGuideIdExample) }))
    expect(actions.editInstallSpec).toHaveBeenCalledExactlyOnceWith(en.installGuideIdExample)
    fireEvent.click(screen.getByRole('button', { name: en.installGuideHide }))
    expect(screen.queryByText(en.installGuideIdHint)).toBeNull()
  })

  it('opens a bundle\'s page with its facts and rows, and uninstalls from it', () => {
    const { actions, set } = renderTab({
      packages: [pkg({
        meta: { description: { en: 'A sidebar.' } },
        rows: [row(), row({ rowId: 'theme', moduleName: 'dsh-better-sidebar/theme', entryId: 'include:theme' as PluginEntryId, enabled: false, phase: null })],
      })],
    })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
    const detail = document.querySelector('[data-plugin-detail="dsh-better-sidebar"]') as HTMLElement
    expect(within(detail).getByRole('heading', { level: 3 }).textContent).toBe('dsh-better-sidebar')
    // The version sits beside the name as a tag; the crumb only leads back.
    expect(within(detail).getByText('v0.16.0')).toBeTruthy()
    expect(document.querySelector('[data-plugin-name]')?.textContent).toBe('dsh-better-sidebar')
    expect(within(detail).getByRole('button', { name: en.backToList }).textContent).toBe(en.crumbRoot)
    expect(within(detail).getByText('A sidebar.')).toBeTruthy()
    // The rows, in order, with their state and their module.
    const rows = within(detail).getAllByRole('listitem').filter(item => item.hasAttribute('data-plugin-row'))
    expect(rows.map(item => item.getAttribute('data-plugin-row'))).toEqual(['include:sidebar', 'include:theme'])
    expect(rows[1]?.getAttribute('data-state')).toBe('off')
    expect(within(detail).getByText(en.partsCountTotal.replace('{count}', '2'), { exact: false })).toBeTruthy()
    expect(within(detail).getByRole('switch', { name: en.partToggle.replace('{name}', 'dsh-better-sidebar/theme') })).toBeTruthy()
    expect(within(detail).getByText(en.rowPhaseActive)).toBeTruthy()
    expect(within(detail).getByText(en.partOff)).toBeTruthy()
    fireEvent.click(within(detail).getByRole('button', { name: en.uninstallLabel.replace('{name}', 'dsh-better-sidebar') }))
    expect(actions.uninstall).toHaveBeenCalledWith('dsh-better-sidebar')
    fireEvent.click(within(detail).getByRole('switch', { name: en.enableToggle.replace('{name}', 'dsh-better-sidebar') }))
    expect(actions.setEnabled).toHaveBeenCalledWith('dsh-better-sidebar', false)
    // A problem and a protection the Host reports read on the page in the dictionary's words; the page leaves with the crumb.
    set({ packages: [pkg({ error: { code: 'operation-error', diagnostic: 'unreadable' }, readOnlyReason: 'management-required' })] })
    expect(within(detail).getByText(`${en.reasonLabel}: unreadable`)).toBeTruthy()
    expect(within(detail).getByText(en.reasonManagementRequired)).toBeTruthy()
    expect(within(detail).getByRole('button', { name: en.uninstallLabel.replace('{name}', 'dsh-better-sidebar') })).toHaveProperty('disabled', true)
    expect(within(detail).getByText(en.partsEmpty)).toBeTruthy()
    set({ packages: [pkg({ error: { code: 'not-bundle' } })] })
    expect(within(detail).getByText(`${en.reasonLabel}: ${en.reasonNotBundle}`)).toBeTruthy()
    set({ packages: [pkg({ error: { code: 'operation-error' } })] })
    expect(within(detail).getByText(`${en.reasonLabel}: ${en.reasonOperationError}`)).toBeTruthy()
    // An incompatibility reads from its structured packages in the dictionary's words, one sentence per package.
    set({ packages: [pkg({ error: { code: 'incompatible-version', incompatible: [INCOMPATIBLE, { ...INCOMPATIBLE, name: 'other' }] } })] })
    expect(within(detail).getByText(`${en.reasonLabel}: ${incompatibleText()} ${incompatibleText('other')}`)).toBeTruthy()
    set({ packages: [pkg({ error: { code: 'incompatible-version' } })] })
    expect(within(detail).getByText(`${en.reasonLabel}: ${en.reasonIncompatibleVersionUnnamed}`)).toBeTruthy()
    fireEvent.click(within(detail).getByRole('button', { name: en.backToList }))
    expect(document.querySelector('[data-plugin-detail]')).toBeNull()
    // A bundle that leaves the list drops back to the cards.
    const { version: _version, ...unversioned } = pkg()
    set({ packages: [unversioned] })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
    expect(screen.queryByText('No description.')).toBeNull()
    expect(screen.queryByText(en.versionTag.replace('{version}', '0.16.0'))).toBeNull()
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
        ...index === 5 ? { phase: 'unloading' as const } : {},
      })
      if (index !== 2) return live
      // The third row has no live entry: nothing to switch.
      const { entryId: _entryId, ...unmounted } = live
      return { ...unmounted, enabled: false, phase: null }
    })
    const { actions, set } = renderTab({ packages: [pkg({ rows })], busy: [rowKey('include:row-5')] })
    fireEvent.click(screen.getByRole('button', { name: en.openDetail.replace('{name}', 'dsh-better-sidebar') }))
    const detail = document.querySelector('[data-plugin-detail]') as HTMLElement
    const toggle = (id: string): HTMLElement => within(detail.querySelector<HTMLElement>(`[data-plugin-row="${id}"]`)!)
      .getByRole('switch', { name: en.partToggle.replace('{name}', 'dsh-better-sidebar') })
    expect(within(detail).getByText(`${en.partsCountTotal.replace('{count}', '12')} · ${en.partsCountRunning.replace('{count}', '8')} · ${en.partsCountOff.replace('{count}', '1')} · ${en.partsCountFailed.replace('{count}', '1')}`)).toBeTruthy()
    fireEvent.click(toggle('include:row-0'))
    expect(actions.setRowEnabled).toHaveBeenCalledWith('include:row-0', false)
    // A protected row, a row without a live entry, and a row with a write in flight cannot be switched.
    const locked = toggle('include:row-1')
    expect(locked).toHaveProperty('disabled', true)
    expect(locked.getAttribute('title')).toBe(en.reasonUnaddressable)
    expect(toggle('row-2')).toHaveProperty('disabled', true)
    fireEvent.click(toggle('row-2'))
    expect(actions.setRowEnabled).toHaveBeenCalledTimes(1)
    expect(toggle('include:row-5')).toHaveProperty('disabled', true)
    expect(within(detail).getByText(en.rowPhaseFailed)).toBeTruthy()
    expect(within(detail).getByText(en.rowPhaseLoading)).toBeTruthy()
    expect(within(detail).getByText(en.rowPhaseUnloading)).toBeTruthy()
    expect(document.querySelector('[data-plugin-row="include:row-3"]')?.getAttribute('data-state')).toBe('failed')
    expect(document.querySelector('[data-plugin-row="include:row-4"] [data-state="ongoing"]')).not.toBeNull()
    expect(document.querySelector('[data-plugin-row="include:row-5"] [data-state="ongoing"]')).not.toBeNull()
    // A long list gets a filter; nothing matching says so.
    const filter = within(detail).getByRole('searchbox', { name: en.partsFilter })
    fireEvent.change(filter, { target: { value: 'ROW-1' } })
    expect(within(detail).getAllByRole('listitem').filter(item => item.hasAttribute('data-plugin-row'))).toHaveLength(3)
    fireEvent.change(filter, { target: { value: 'nothing' } })
    expect(within(detail).getByText(en.partsFilterEmpty)).toBeTruthy()
    fireEvent.change(filter, { target: { value: '' } })
    // A bundle that is off shows its rows without switches.
    set({ packages: [pkg({ enabled: false, rows: rows.slice(0, 2).map(item => ({ ...item, enabled: false, phase: null })) })] })
    expect(within(detail).queryByRole('switch', { name: en.partToggle.replace('{name}', 'dsh-better-sidebar') })).toBeNull()
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
    expect(checking.querySelector('[data-state="ongoing"]')).not.toBeNull()
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
    // A check no registry answered names them all.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', inputError: { problem: 'network', reason: 'r', registries: [null, MIRROR] } } })
    expect(screen.getByRole('alert').textContent).toBe(en.installProblemNetworkAll.replace('{registries}', `${en.registryDefault}, ${en.registryNpmmirror}`))
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)
  })

  it('shows the subject while installing, folds the pnpm output behind the details, and stops through the Host', () => {
    const subject = { spec: 'dsh-x', status: 'accepted', kind: 'registry', name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', bundle: true, registry: null } as const
    const run = { jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/home/u/.dsh/profiles/web', output: 'Progress: resolved \x1b[96m1\x1b[39m\n' }
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, runs: [run] } })
    expect(screen.getByRole('status').textContent).toBe(en.installingTitle)
    expect(screen.getByRole('status').parentElement?.querySelector('[data-state="ongoing"]')).not.toBeNull()
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
    // Cancel and the back control each ask the Host to stop the run; the close control asks too, and closes once the Host confirms.
    fireEvent.click(screen.getByRole('button', { name: en.installCancel }))
    fireEvent.click(screen.getByRole('button', { name: en.installCancelAndEdit }))
    expect(actions.cancelInstall).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: en.close })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installCloseCancels }))
    expect(actions.closeInstall).toHaveBeenCalledOnce()
  })

  it('waits with the Host through starting, stopping, and applying, and words an unconfirmed stop', () => {
    const subject = { spec: 'slow', status: 'accepted', kind: 'registry', name: 'slow', bundle: true, registry: null } as const
    const { actions, set } = renderTab({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'starting', subject } })
    expect(screen.getByRole('status').textContent).toBe(en.installStarting)
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: en.installCancelAndEdit })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: en.installCloseCancels }))
    expect(actions.closeInstall).toHaveBeenCalledOnce()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'running', subject } })
    fireEvent.click(screen.getByRole('button', { name: en.installCancel }))
    fireEvent.click(screen.getByRole('button', { name: en.installCancelAndEdit }))
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
    expect(screen.getByRole('button', { name: en.close })).toHaveProperty('disabled', false)
    expect(within(document.querySelector('[data-terminal]') as HTMLElement).getByText(en.installCancelledShort)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'applying', subject } })
    expect(screen.getByRole('status').textContent).toBe(en.installApplying)
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.close })).toHaveProperty('disabled', false)
    // A stop the Host could not confirm says so over the running screen.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'slow', phase: 'running', subject, failure: { reason: 'offline', uncertainty: 'cancellation' } } })
    expect(screen.getByRole('alert').textContent).toContain('offline')
    expect(screen.getByRole('button', { name: en.installCancel })).toHaveProperty('disabled', false)
  })

  it('offers to enable what a finished install added, and says when it waits for a restart', () => {
    const subject = { spec: '/plugins/dsh-x', status: 'accepted', kind: 'path', name: 'dsh-x', bundle: true, registry: null } as const
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
    expect(screen.getByText(en.installedTitle).parentElement?.querySelector('[data-state="done"]')).not.toBeNull()
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
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'done', subject: { spec: 'dsh-x', status: 'accepted', kind: 'registry', name: 'dsh-x', bundle: true, registry: null } } })
    expect(screen.getByText(en.installDoneNothing)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installEnableNow })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.installClose }))
    expect(actions.closeInstall).toHaveBeenCalledTimes(1)
  })

  it('asks to allow the scripts a blocked install left pending, retries with them, and says what was allowed', () => {
    const subject = { spec: 'dsh-x', status: 'accepted', kind: 'registry', name: 'dsh-x', bundle: true, registry: null } as const
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
    const subject = { spec: 'github:a/b', status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' } as const
    const { actions, set } = renderTab({
      install: {
        ...IDLE_INSTALL,
        open: true,
        spec: 'github:a/b',
        phase: 'failed',
        subject,
        detailsOpen: true,
        runs: [{ jobId: 'j1', command: 'pnpm add github:a/b', cwd: '/p', output: 'ERR\n', exitCode: 1 }],
        failure: { reason: 'ERR\n', kind: 'network', failedAt: 'spec-host' },
      },
    })
    expect(screen.getByRole('alert').textContent).toBe(en.installFailedTitle)
    // A git spec the Host could not reach reads by its own host: no registry stands in for it, so none is offered.
    expect(screen.getByText(en.installFailureNetworkHost.replace('{host}', 'github.com'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installChangeRegistry })).toBeNull()
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
    // A compatibility refusal outranks the kind pnpm's exit was classified as.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed',
      failure: { reason: '', code: 'incompatible-version', incompatible: [INCOMPATIBLE], kind: 'unknown' } } })
    expect(screen.getByText(incompatibleText())).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: '', code: 'incompatible-version' } } })
    expect(screen.getByText(en.reasonIncompatibleVersionUnnamed)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: 'the transport said so' } } })
    expect(screen.getByText('the transport said so')).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: { reason: '' } } })
    expect(screen.getByText(en.installFailureGeneric)).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'x', phase: 'failed', failure: null } })
    expect(screen.getByText(en.installFailureGeneric)).toBeTruthy()
    // A tarball spec reads by its kind too.
    set({ install: { ...IDLE_INSTALL, open: true, spec: '/p/x.tgz', phase: 'failed', subject: { spec: '/p/x.tgz', status: 'accepted', kind: 'tarball', bundle: null, registry: null }, failure: null } })
    expect(screen.getByText(en.installSubjectTarball)).toBeTruthy()
  })

  it.each(['network', 'timeout'] as const)('shows GitHub recovery only after a %s failure and returns to package input', (kind) => {
    const subject = { spec: 'github:a/b', status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' } as const
    const failed: InstallState = {
      ...IDLE_INSTALL, open: true, spec: subject.spec, registries: REGISTRIES, phase: 'failed', subject,
      failure: { reason: 'GitHub connection failed', kind, failedAt: 'spec-host' },
    }
    const { actions, set, setLanguage } = renderTab({ install: { ...failed, phase: 'idle', failure: null } })
    expect(screen.queryByText(en.installGithubFailedTitle)).toBeNull()
    set({ install: failed })
    const dialog = screen.getByRole('dialog', { name: kind === 'timeout' ? en.installGithubTimeoutTitle : en.installGithubFailedTitle })
    expect(within(dialog).getByText(en.installGithubFailedDescription)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.installRetry })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en.installUseGithubMirror }))
    expect(actions.useGithubMirror).toHaveBeenCalledOnce()
    expect(actions.runInstall).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(actions.closeInstall).toHaveBeenCalledOnce()
    setLanguage(zh)
    expect(screen.getByRole('dialog', { name: kind === 'timeout' ? '连接 GitHub 超时' : '无法访问 GitHub' })).toBeTruthy()
    expect(screen.getByText('请尝试其他安装来源。')).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, mirrorRecovery: true, registries: REGISTRIES, registry: { kind: 'offered', registry: MIRROR } } })
    const form = within(screen.getByRole('dialog', { name: zh.installTitle }))
    expect(form.queryByText(zh.installDescription)).toBeNull()
    expect(form.queryByRole('textbox', { name: zh.installSpecLabel })).toBeNull()
    const input = screen.getByRole('textbox', { name: zh.installPackageLabel })
    expect(input).toHaveProperty('value', '')
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('button', { name: zh.installRun })).toHaveProperty('disabled', true)
    expect(form.getAllByRole('button')).toEqual([
      form.getByRole('button', { name: zh.close }),
      form.getByRole('button', { name: zh.installGuideToggle }),
      form.getByRole('button', { name: '安装源 中国大陆镜像源' }),
      form.getByRole('button', { name: zh.installRun }),
    ])
  })

  it('offers another way instead of a mirror the failed GitHub install already asked', () => {
    const subject = { spec: 'github:a/b', status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' } as const
    const failed: InstallState = {
      ...IDLE_INSTALL, open: true, spec: subject.spec, registries: REGISTRIES, registry: { kind: 'offered', registry: MIRROR },
      phase: 'failed', subject, failure: { reason: 'GitHub connection timed out', kind: 'timeout', failedAt: 'spec-host' },
    }
    const { actions, set, setLanguage } = renderTab({ install: failed })
    // The mirror picked from the options, also while pnpm's own configuration is unread, typed as an address, or named
    // by pnpm's own configuration.
    for (const patch of [
      {},
      { registries: { ...REGISTRIES, resolved: null } },
      { registry: { kind: 'custom', url: ' https://registry.npmmirror.com ' } },
      { registries: { ...REGISTRIES, resolved: MIRROR }, registry: { kind: 'offered', registry: null } },
    ] as const) {
      set({ install: { ...failed, ...patch } })
      const dialog = within(screen.getByRole('dialog', { name: en.installGithubTimeoutTitle }))
      expect(dialog.getByText(en.installGithubFailedDescription)).toBeTruthy()
      expect(dialog.getAllByRole('button')).toEqual([
        dialog.getByRole('button', { name: en.close }),
        dialog.getByRole('button', { name: en.cancel }),
        dialog.getByRole('button', { name: en.installTryAnotherWay }),
      ])
    }
    fireEvent.click(screen.getByRole('button', { name: en.installTryAnotherWay }))
    expect(actions.useGithubMirror).toHaveBeenCalledOnce()
    expect(actions.runInstall).not.toHaveBeenCalled()
    // The form it returns to opens the guide to the other kinds of spec.
    set({ install: { ...IDLE_INSTALL, open: true, mirrorRecovery: true, registries: REGISTRIES, registry: failed.registry } })
    expect(screen.getByRole('button', { name: en.installGuideHide }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.installGuidePathExample)).toBeTruthy()
    // A typed address other than the mirror can still switch to it.
    set({ install: { ...failed, registry: { kind: 'custom', url: 'npm.corp' } } })
    expect(screen.getByRole('button', { name: en.installUseGithubMirror })).toBeTruthy()
    setLanguage(zh)
    set({ install: failed })
    expect(screen.getByRole('button', { name: '试试其他方式' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '改用国内镜像' })).toBeNull()
  })

  it('keeps the ordinary failure view for registry errors, other hosts, and unavailable mirrors', () => {
    const failed: InstallState = {
      ...IDLE_INSTALL, open: true, registries: REGISTRIES, phase: 'failed',
      subject: { spec: 'github:a/b', status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' },
      failure: { reason: 'failed', kind: 'network', failedAt: 'registry' },
    }
    const { set } = renderTab({ install: failed })
    expect(screen.getByRole('button', { name: en.installChangeRegistry })).toBeTruthy()
    for (const patch of [
      { subject: { ...failed.subject!, host: 'gitlab.com' } },
      { subject: null },
      { registries: { ...REGISTRIES, fallbackRegistries: [] } },
      { registries: null },
      { failure: { reason: 'not found', kind: 'not-found' as const, failedAt: 'spec-host' as const } },
    ]) {
      set({ install: { ...failed, failure: { reason: 'failed', kind: 'network', failedAt: 'spec-host' }, ...patch } })
      expect(screen.queryByRole('dialog', { name: en.installGithubFailedTitle })).toBeNull()
      expect(screen.getByRole('button', { name: en.installRetry })).toBeTruthy()
    }
  })

  it('offers the registries under the spec, folded by default, and picks or types one', () => {
    const open = { ...IDLE_INSTALL, open: true, registries: REGISTRIES }
    const { actions, set } = renderTab({ install: open })
    // Folded, the toggle names the registry the install asks first, by name alone.
    const toggle = screen.getByRole('button', { name: `${en.registryToggle} ${en.registryOfficial}` })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('radio')).toBeNull()
    fireEvent.click(toggle)
    expect(actions.toggleRegistryOptions).toHaveBeenCalledTimes(1)
    set({ install: { ...open, registryOpen: true } })
    expect(screen.getByRole('button', { name: `${en.registryToggle} ${en.registryOfficial}` }).getAttribute('aria-expanded')).toBe('true')
    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(radios[0]).toHaveProperty('checked', true)
    // The options carry the host each names; the control does not.
    expect(radios.map(radio => radio.parentElement?.textContent)).toEqual([OFFICIAL_OPTION, MIRROR_OPTION, en.registryCustom])
    // The options float from the toggle, so the dialog card itself does not grow.
    expect(screen.getByRole('dialog').contains(screen.getByRole('group', { name: en.registryLegend }))).toBe(false)
    // Escape folds the options without reaching the dialog; a pointer outside them folds them too.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(actions.toggleRegistryOptions).toHaveBeenCalledTimes(2)
    expect(actions.closeInstall).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(actions.toggleRegistryOptions).toHaveBeenCalledTimes(3)
    fireEvent.pointerDown(screen.getByRole('group', { name: en.registryLegend }))
    expect(actions.toggleRegistryOptions).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('radio', { name: MIRROR_OPTION }))
    expect(actions.chooseRegistry).toHaveBeenLastCalledWith({ kind: 'offered', registry: MIRROR })
    set({ install: { ...open, registryOpen: true, registry: { kind: 'offered', registry: MIRROR } } })
    expect(screen.getByRole('button', { name: `${en.registryToggle} ${en.registryNpmmirror}` })).toBeTruthy()
    // A typed registry: the radio picks it, the field carries it, and it is asked alone.
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.registryCustom) }))
    expect(actions.chooseRegistry).toHaveBeenLastCalledWith({ kind: 'custom', url: '' })
    set({ install: { ...open, registryOpen: true, registry: { kind: 'custom', url: 'npm.corp' }, registryError: true } })
    const field = screen.getByRole('textbox', { name: en.registryCustom })
    expect(field).toHaveProperty('value', 'npm.corp')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').textContent).toBe(en.registryCustomInvalid)
    fireEvent.change(field, { target: { value: 'https://npm.corp/' } })
    expect(actions.chooseRegistry).toHaveBeenLastCalledWith({ kind: 'custom', url: 'https://npm.corp/' })
    expect(screen.getByRole('button', { name: `${en.registryToggle} ${en.registryCustom}` })).toBeTruthy()
    // Enter in the field installs, once there is a spec.
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(actions.runInstall).not.toHaveBeenCalled()
    set({ install: { ...open, spec: 'dsh-x', registryOpen: true, registry: { kind: 'custom', url: 'https://npm.corp/' } } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.registryCustom }), { key: 'Enter' })
    expect(actions.runInstall).toHaveBeenCalledTimes(1)
    // A remembered registry that does not parse as a URL reads as written.
    set({ install: { ...open, registry: { kind: 'offered', registry: 'garbage' } } })
    expect(screen.getByRole('button', { name: `${en.registryToggle} garbage` })).toBeTruthy()
    // A registry the Host configured that the dictionary does not know reads by its host, listed first.
    const corporate = { registry: 'https://npm.corp.example/', fallbackRegistries: [], resolved: OFFICIAL }
    set({ install: { ...open, registryOpen: true, registries: corporate, registry: { kind: 'offered', registry: 'https://npm.corp.example/' } } })
    expect(screen.getAllByRole('radio').map(radio => radio.parentElement?.textContent)).toEqual(['npm.corp.example', OFFICIAL_OPTION, en.registryCustom])
    // pnpm's own configuration naming another registry reads by that host, never as npm's own.
    set({ install: { ...open, registryOpen: true, registries: { ...REGISTRIES, resolved: 'https://npm.corp.example/' } } })
    expect(screen.getByRole('radio', { name: 'npm.corp.example' })).toBeTruthy()
    expect(screen.getByRole('button', { name: `${en.registryToggle} npm.corp.example` })).toBeTruthy()
    // One that names the mirror reads by the mirror's name, and the mirror the Host offers is not listed twice.
    set({ install: { ...open, registryOpen: true, registries: { ...REGISTRIES, resolved: MIRROR } } })
    expect(screen.getByRole('button', { name: `${en.registryToggle} ${en.registryNpmmirror}` })).toBeTruthy()
    const mirrorLabels = screen.getAllByRole('radio').map(radio => radio.parentElement?.textContent)
    expect(mirrorLabels).toEqual([MIRROR_OPTION, en.registryCustom])
    expect(new Set(mirrorLabels).size).toBe(mirrorLabels.length)
    // A configuration the Host could not read keeps the neutral default name.
    set({ install: { ...open, registryOpen: true, registries: { ...REGISTRIES, resolved: null } } })
    expect(screen.getByRole('button', { name: `${en.registryToggle} ${en.registryDefault}` })).toBeTruthy()
    // Before the Host answers, only pnpm's own is offered, under the neutral name its unread configuration keeps.
    set({ install: { ...open, registryOpen: true, registries: null } })
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.getByRole('radio', { name: UNREAD_OPTION })).toBeTruthy()
  })

  it('names the registry each attempt asks while installing, badges each run, and says when every registry failed', () => {
    const subject = { spec: 'dsh-x', status: 'accepted', kind: 'registry', name: 'dsh-x', bundle: true, registry: null } as const
    const runs = [
      { jobId: 'j1', command: 'pnpm add dsh-x', cwd: '/p', output: 'ERR\n', exitCode: 1 },
      { jobId: 'j2', command: `pnpm add dsh-x --registry=${MIRROR}`, cwd: '/p', output: 'Progress\n' },
    ]
    const { actions, set } = renderTab({
      install: {
        ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, runs, detailsOpen: true, attempts: { registries: [null, MIRROR], total: 2 },
      },
    })
    expect(screen.getByRole('status').textContent).toBe(en.installingTitle)
    expect(screen.getByText(en.installAttempt
      .replace('{previous}', en.registryDefault).replace('{registry}', en.registryNpmmirror).replace('{index}', '2').replace('{total}', '2'))).toBeTruthy()
    expect(screen.getByText(en.installAttemptBadge.replace('{index}', '1').replace('{registry}', en.registryDefault))).toBeTruthy()
    expect(screen.getByText(en.installAttemptBadge.replace('{index}', '2').replace('{registry}', en.registryNpmmirror))).toBeTruthy()
    // The first attempt says nothing about a registry before it; a single run carries no badge.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'running', subject, runs: [runs[0] as never], detailsOpen: true, attempts: { registries: [null], total: 2 } } })
    expect(screen.queryByText(en.installAttemptBadge.replace('{index}', '1').replace('{registry}', en.registryDefault))).toBeNull()
    expect(screen.getByRole('status').parentElement?.textContent).toBe(en.installingTitle)
    // Every registry failed: the failure names them all, and the registries can be changed from here.
    set({
      install: {
        ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', subject, runs,
        attempts: { registries: [null, MIRROR], total: 2 }, failure: { reason: 'ERR', kind: 'network', failedAt: 'registry' },
      },
    })
    expect(screen.getByText(en.installFailureNetworkAll.replace('{registries}', `${en.registryDefault}, ${en.registryNpmmirror}`))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.installChangeRegistry }))
    expect(actions.changeRegistry).toHaveBeenCalledTimes(1)
    // One registry that failed reads as the plain network failure; a stale copy on it still offers another registry.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', subject, attempts: { registries: [null], total: 1 }, failure: { reason: 'ERR', kind: 'network', failedAt: 'registry' } } })
    expect(screen.getByText(en.installFailureNetwork)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.installChangeRegistry })).toBeTruthy()
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', subject, attempts: { registries: [null], total: 1 }, failure: { reason: 'ERR', kind: 'not-found', failedAt: 'registry' } } })
    expect(screen.getByRole('button', { name: en.installChangeRegistry })).toBeTruthy()
    // A failure the Host laid at neither offers no other registry.
    set({ install: { ...IDLE_INSTALL, open: true, spec: 'dsh-x', phase: 'failed', subject, attempts: { registries: [null], total: 1 }, failure: { reason: 'ERR', kind: 'disk-full' } } })
    expect(screen.queryByRole('button', { name: en.installChangeRegistry })).toBeNull()
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
    expect(screen.getByRole('dialog', { name: en.confirmUninstallTitle.replace('{name}', 'dsh-better-sidebar') })).toBeTruthy()
    expect(screen.getByText(en.confirmUninstallDescription)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(actions.cancelConfirm).toHaveBeenCalledTimes(1)
    set({ confirm: { action: 'uninstall', packageName: 'dsh-other' } })
    expect(screen.getByRole('dialog', { name: en.confirmUninstallTitle.replace('{name}', 'dsh-other') })).toBeTruthy()
    set({ packages: [] })
    expect(screen.getByRole('dialog', { name: en.confirmUninstallTitle.replace('{name}', 'dsh-other') })).toBeTruthy()
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
      set({ notice: { kind: 'failed', action: 'enable', code: 'incompatible-version', incompatible: [INCOMPATIBLE], reason: '', packageName: 'pkg-1', seq: 5 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedEnable.replace('{reason}', incompatibleText()))
      set({ notice: { kind: 'failed', action: 'rowDisable', code: 'operation-error', reason: 'EACCES', packageName: 'pkg-1', seq: 6 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedRowDisable.replace('{reason}', 'EACCES'))
      set({ notice: { kind: 'failed', action: 'disable', reason: '', packageName: 'pkg-1', seq: 7 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedDisable.replace('{reason}', en.reasonOperationError))
      set({ notice: { kind: 'failed', action: 'rowEnable', reason: 'x', packageName: 'pkg-1', seq: 8 } })
      expect(screen.getByRole('alert').textContent).toContain(en.failedRowEnable.replace('{reason}', 'x'))
      for (const [index, outcome] of (['done', 'failed', 'unconfirmed', 'applying', 'unknown'] as const).entries()) {
        set({ notice: { kind: 'install', outcome, seq: 9 + index } })
        const key = ({ done: 'installBackgroundDone', failed: 'installBackgroundFailed', unconfirmed: 'installBackgroundUnconfirmed', applying: 'installBackgroundApplying', unknown: 'installBackgroundUnknown' } as const)[outcome]
        expect(screen.getByRole('alert').textContent).toContain(en[key])
      }
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

  it('distinguishes lost results, pending acceptance, and unknown outcomes in both languages', () => {
    const { actions, set, setLanguage } = renderTab()
    for (const dict of [en, zh]) {
      setLanguage(dict)
      set({ install: { ...IDLE_INSTALL, open: true, phase: 'unconfirmed', failure: { reason: 'offline', uncertainty: 'result' } } })
      expect(screen.getByRole('alert').textContent).toBe(dict.installResultUnconfirmed.replace('{reason}', 'offline'))
      fireEvent.click(screen.getByRole('button', { name: dict.installReconcile }))
      expect(screen.getByRole('button', { name: dict.installCancelAndEdit }).textContent).toBe(dict.installCancelAndEdit)
      set({ install: { ...IDLE_INSTALL, open: true, phase: 'unconfirmed', failure: { reason: '', uncertainty: 'acceptance' } } })
      expect(screen.getByRole('alert').textContent).toBe(dict.installAwaitingAcceptance)
      expect(screen.queryByRole('button', { name: dict.installReconcile })).toBeNull()
      set({ install: { ...IDLE_INSTALL, open: true, phase: 'applying', failure: { reason: 'offline', uncertainty: 'cancellation' } } })
      expect(screen.getByRole('alert').textContent).toBe(dict.installApplyingCancellationError.replace('{reason}', 'offline'))
      expect(screen.getByRole('button', { name: dict.installCancel })).toHaveProperty('disabled', true)
      set({ install: { ...IDLE_INSTALL, open: true, phase: 'unknown' } })
      expect(screen.getByRole('status').textContent).toBe(dict.installUnknownTitle)
      expect(screen.getByText(dict.installUnknownDescription)).toBeTruthy()
      expect(screen.queryByRole('button', { name: dict.installCancel })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: dict.installEditAria }))
    }
    expect(actions.reconcileInstall).toHaveBeenCalledTimes(2)
    expect(actions.cancelInstall).toHaveBeenCalledTimes(2)
  })

  it('offers the retained installation and keeps its uncertain state cancellable', () => {
    const { actions } = renderTab({ install: {
      ...IDLE_INSTALL, open: true, phase: 'unconfirmed', requestId: 'pending-install' as PluginInstallRequestId,
      failure: { reason: 'offline', uncertainty: 'cancellation' },
    } })
    fireEvent.click(screen.getByRole('button', { name: en.installViewTask }))
    expect(actions.openInstall).toHaveBeenCalledOnce()
    expect(screen.getByRole('status').textContent).toBe(en.installUnconfirmedTitle)
    fireEvent.click(screen.getByRole('button', { name: en.installCancel }))
    expect(actions.cancelInstall).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: en.installCloseCancels }))
    expect(actions.closeInstall).toHaveBeenCalledOnce()
  })
})

it('offers bundle-owned guidance only after explicit enablement and navigates to its detail page', () => {
  const name = 'dsh-better-sidebar'
  const { set, actions } = renderTab({ packages: [pkg({ enabled: false })] }, { bundles: new Set([name]) }, {
    [`plugins.bundle.activation:${name}`]: (_view, owner) => <button onClick={(owner as PluginActivationOwnerProps).onOpenDetails}>Go to setup</button>,
    [`plugins.bundle.config:${name}`]: () => <div>Bundle setup</div>,
  })
  expect(screen.queryByText('Go to setup')).toBeNull()
  set({ packages: [pkg()] })
  expect(screen.queryByText('Go to setup')).toBeNull()
  set({ packages: [pkg({ enabled: false })] })
  fireEvent.click(screen.getByRole('switch'))
  expect(actions.setEnabled).toHaveBeenCalledWith(name, true)
  expect(screen.queryByText('Go to setup')).toBeNull()
  set({ packages: [pkg()], busy: [name] })
  expect(screen.queryByText('Go to setup')).toBeNull()
  set({ busy: [] })
  fireEvent.click(screen.getByText('Go to setup'))
  expect(screen.getByText('Bundle setup')).toBeTruthy()
  expect(screen.queryByText('Go to setup')).toBeNull()
})

it('dismisses activation guidance until the user enables the bundle again', () => {
  const name = 'dsh-better-sidebar'
  const { set } = renderTab({ packages: [pkg({ enabled: false })] }, {}, {
    [`plugins.bundle.activation:${name}`]: (_view, owner) => <button onClick={(owner as PluginActivationOwnerProps).onDismiss}>Later</button>,
  })
  fireEvent.click(screen.getByRole('switch'))
  set({ packages: [pkg()] })
  fireEvent.click(screen.getByText('Later'))
  set({ packages: [pkg()] })
  expect(screen.queryByText('Later')).toBeNull()
  fireEvent.click(screen.getByRole('switch'))
  set({ packages: [pkg({ enabled: false })] })
  fireEvent.click(screen.getByRole('switch'))
  set({ packages: [pkg()] })
  expect(screen.getByText('Later')).toBeTruthy()
})

it('supplies the accepted entry values and atomic mutation action to a custom plugin page', () => {
  const mutate = vi.fn(async () => true)
  const form: ConfigPageForm = {
    state: { status: 'ready', value: { count: 2 }, base: {}, user: {}, revision: 7, writable: true, mode: 'host' }, mutate,
  }
  renderTab({}, { items: [{ id: 'custom', label: 'Custom' }] }, {
    'plugins.item:custom': (view, _owner, supplied) => view === 'summary' ? 'Custom summary'
      : <button onClick={() => { void supplied!.mutate([{ op: 'set', path: ['count'], value: 3 }], supplied!.state.revision) }}>Save custom</button>,
  }, { custom: form })
  fireEvent.click(screen.getByText('Custom'))
  fireEvent.click(screen.getByText('Save custom'))
  expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['count'], value: 3 }], 7)
})
