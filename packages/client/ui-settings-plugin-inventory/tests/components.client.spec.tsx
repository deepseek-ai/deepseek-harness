// @vitest-environment jsdom
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientEntryState } from '@deepseek-ai/dsh-client-modules/client'
import type { PluginEntryId } from '@deepseek-ai/dsh-api-remotes/client'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, zh, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

type Snapshot = Awaited<ReturnType<PluginInventorySettingsTabInjected['list']>>
const t = ((key: PluginInventoryLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )) as PluginInventorySettingsTabProps['t']

function props(
  list: PluginInventorySettingsTabInjected['list'],
  presetName: PluginInventorySettingsTabInjected['presetName'] = preset => preset.name ?? preset.id,
  resolveText: PluginInventorySettingsTabInjected['resolveText'] = text => typeof text === 'string' ? text : text.en,
): PluginInventorySettingsTabProps {
  return {
    t,
    list,
    presetName,
    resolveText,
    useClientSync: bindSnapshotSelector(createSnapshotStore<ClientEntryState>({ syncing: false, failures: [] })),
    retryClient: vi.fn(),
  } as PluginInventorySettingsTabProps
}

function localizedProps(list: PluginInventorySettingsTabInjected['list']) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const locale = new LocaleRuntime(ctx)
  ctx.effect(() => locale.register('settings.pluginInventory', 'en', en), 'test: English inventory dictionary')
  ctx.effect(() => locale.register('settings.pluginInventory', 'zh', zh), 'test: Chinese inventory dictionary')
  locale.setLocale('en')
  const pageProps: PluginInventorySettingsTabProps = {
    ...props(list, preset => preset.name ?? preset.id, text => locale.resolveText(text)),
    t: locale.bind('settings.pluginInventory'),
  }
  return { locale, pageProps }
}

/** A deployment with a roster: one failed global row, two preset-provided rows. */
const SNAPSHOT = {
  entries: [
    { entryId: 'telemetry', moduleName: '@fixture/telemetry', enabled: true, fiberPhase: 'failed' },
    { entryId: 'timer', moduleName: 'cordis:timer', enabled: true, fiberPhase: 'active' },
    { entryId: '8a1b2c3d', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
    { entryId: 'unobserved', moduleName: '@fixture/unobserved-name', enabled: true, fiberPhase: null },
    { entryId: 'bash-host', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: false, fiberPhase: null },
    { entryId: 'fs-host', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: false, fiberPhase: null },
    { entryId: 'dormant', moduleName: '@fixture/dormant', enabled: false, fiberPhase: null },
  ],
  agentPresets: [
    {
      id: 'standard',
      name: '标准模式',
      isDefault: true,
      rows: [
        { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: 'active' },
        { entryId: 'fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: true, fiberPhase: null },
        {
          entryId: 'pwsh',
          moduleName: '@fixture/pwsh',
          enabled: 'conditional',
          condition: 'process.platform === \'win32\'',
          fiberPhase: null,
        },
        { entryId: 'codex', moduleName: '@fixture/codex', enabled: false, fiberPhase: null },
        { entryId: 'crashy', moduleName: '@fixture/crashy', enabled: true, fiberPhase: 'failed' },
        { entryId: null, moduleName: '@fixture/anonymous', enabled: true, fiberPhase: null },
      ],
    },
    {
      id: 'ptc',
      isDefault: false,
      rows: [
        { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'bash-fork', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: 'conditional', fiberPhase: null },
      ],
    },
    { id: 'shattered', name: '坏预设', isDefault: false, broken: 'the composition file is missing', rows: [] },
  ],
} as unknown as Snapshot

async function renderReady(snapshot: Snapshot = SNAPSHOT): Promise<ReturnType<typeof render>> {
  const view = render(<PluginInventorySettingsTab {...props(async () => snapshot)} />)
  await screen.findByRole('searchbox', { name: en.search })
  return view
}

const globalToggle = (): HTMLElement =>
  screen.getByRole('button', { name: (name: string) => name.startsWith(en.globalTitle) })
const presetToggle = (): HTMLElement => screen.getByRole('button', { name: en.presetTitle })

describe('PluginInventorySettingsTab', () => {
  it.each(['global', 'preset'])('shortens package and module name fallbacks in the %s inventory', async (scope) => {
    const names = [
      ['@deepseek-ai/dsh-tool-subagent', 'tool-subagent'],
      ['@deepseek-ai/dsh-host-web', 'web'],
      ['@deepseek-ai/dsh-client-tabs', 'tabs'],
      ['@deepseek-ai/cordis-plugin-hmr', 'hmr'],
      ['cordis:timer', 'timer'],
      ['@acme/dsh-sidebar/navigation', 'sidebar/navigation'],
      ['plain-plugin', 'plain-plugin'],
    ] as const
    const rows = names.flatMap(([moduleName], index) => [false, true].map(fromManifest => ({
      entryId: `include:short-${String(index)}-${String(fromManifest)}` as PluginEntryId,
      moduleName,
      enabled: true,
      fiberPhase: null,
      ...fromManifest ? { meta: { title: moduleName, description: 'Package description.' } } : {},
    })))
    const snapshot: Snapshot = scope === 'global'
      ? { entries: rows }
      : { entries: [], agentPresets: [{ id: 'custom', isDefault: true, rows }] }
    const view = await renderReady(snapshot)
    fireEvent.click(scope === 'global' ? globalToggle() : presetToggle())
    for (const [index, [moduleName, title]] of names.entries()) {
      for (const fromManifest of [false, true]) {
        const entryId = `include:short-${String(index)}-${String(fromManifest)}`
        const card = screen.getByRole('button', { name: `${title}, ${entryId}, Enabled` })
        if (fromManifest) {
          expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe('Package description.')
        }
        fireEvent.click(card)
        expect(screen.getByText(en.moduleLabel).nextElementSibling?.textContent).toBe(moduleName)
        expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe(entryId)
        fireEvent.click(card)
      }
    }
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), {
      target: { value: '@deepseek-ai/dsh-tool-subagent' },
    })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^tool-subagent, include:short-0-/ })).toHaveLength(2)
  })

  it('keeps authored locale titles verbatim when they resemble module names', async () => {
    const { locale, pageProps } = localizedProps(async () => ({
      entries: [{
        entryId: 'include:navigation' as PluginEntryId, moduleName: '@acme/dsh-navigation', enabled: true, fiberPhase: null,
        meta: { title: { en: 'dsh-Navigation', zh: 'dsh-导航' } },
      }],
    }))
    const view = render(<PluginInventorySettingsTab {...pageProps} />)
    await screen.findByRole('searchbox', { name: en.search })
    fireEvent.click(globalToggle())
    expect(screen.getByRole('button', { name: 'dsh-Navigation, include:navigation, Enabled' })).toBeTruthy()
    locale.setLocale('zh')
    view.rerender(<PluginInventorySettingsTab {...pageProps} />)
    expect(screen.getByRole('button', { name: 'dsh-导航, include:navigation, 已启用' })).toBeTruthy()
  })

  it('localizes global and preset metadata at render time while preserving identities and query state', async () => {
    const globalError = 'locale/zh.json: invalid title'
    const presetError = 'locale/fr.json: invalid description'
    const snapshot: Snapshot = {
      entries: [{
        entryId: 'include:global-navigation' as PluginEntryId, moduleName: '@acme/navigation', enabled: true, fiberPhase: 'active',
        meta: {
          title: { en: 'Navigation', zh: '导航' },
          description: { en: 'Global navigation controls', zh: '全局导航控件' },
          error: globalError,
        },
      }],
      agentPresets: [{
        id: 'custom', name: 'My preset', isDefault: true,
        rows: [{
          entryId: 'include:preset-runner', moduleName: '@acme/runner', enabled: true, fiberPhase: null,
          meta: {
            title: { en: 'Session runner', zh: '会话执行器' },
            description: { en: 'Run per session', zh: '运行会话命令' },
            error: presetError,
          },
        }],
      }],
    }
    const list = vi.fn(async () => snapshot)
    const { locale, pageProps } = localizedProps(list)
    const view = render(<PluginInventorySettingsTab {...pageProps} />)
    await screen.findByRole('searchbox', { name: en.search })
    fireEvent.click(globalToggle())
    fireEvent.click(presetToggle())
    const global = screen.getByRole('button', { name: 'Navigation, include:global-navigation, Enabled' })
    const preset = screen.getByRole('button', { name: 'Session runner, include:preset-runner, Enabled' })
    expect(document.getElementById(global.getAttribute('aria-describedby')!)?.textContent).toBe('Global navigation controls')
    expect(document.getElementById(preset.getAttribute('aria-describedby')!)?.textContent).toBe('Run per session')
    expect(screen.getByText(en.metadataError.replace('{error}', globalError))).toBeTruthy()
    expect(screen.getByText(en.metadataError.replace('{error}', presetError))).toBeTruthy()
    expect(global.closest('li')?.getAttribute('data-failed')).toBeNull()
    fireEvent.click(global)
    expect(screen.getByText(en.moduleLabel).nextElementSibling?.textContent).toBe('@acme/navigation')
    fireEvent.click(preset)
    expect(screen.getByText(en.moduleLabel).nextElementSibling?.textContent).toBe('@acme/runner')
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('include:preset-runner')

    locale.setLocale('zh')
    view.rerender(<PluginInventorySettingsTab {...pageProps} />)
    expect(screen.getByRole('button', { name: '导航, include:global-navigation, 已启用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '会话执行器, include:preset-runner, 已启用' })).toBeTruthy()
    expect(screen.getByText('全局导航控件')).toBeTruthy()
    expect(screen.getByText('运行会话命令')).toBeTruthy()
    expect(screen.getByText(zh.metadataError.replace('{error}', presetError))).toBeTruthy()
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('include:preset-runner')
    const search = screen.getByRole('searchbox', { name: zh.search })
    for (const query of ['导航', '全局导航控件', '@acme/navigation', 'include:global-navigation']) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
      expect(screen.getByRole('button', { name: '导航, include:global-navigation, 已启用' })).toBeTruthy()
    }
    fireEvent.change(search, { target: { value: '运行会话命令' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '会话执行器, include:preset-runner, 已启用' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'Run per session' } })
    expect(screen.getByText(zh.emptySearch)).toBeTruthy()
    locale.setLocale('en')
    view.rerender(<PluginInventorySettingsTab {...pageProps} />)
    expect(screen.getByRole('button', { name: 'Session runner, include:preset-runner, Enabled' })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: en.search })).toHaveProperty('value', 'Run per session')
    expect(list).toHaveBeenCalledOnce()
  })

  it.each(['global', 'preset'])('resolves each %s row field independently and hides empty English descriptions', async (scope) => {
    const rows: Snapshot['entries'] = [
      {
        entryId: 'include:navigation' as PluginEntryId, moduleName: '@acme/dsh-sidebar/navigation', enabled: true, fiberPhase: null,
        meta: { description: { en: 'Navigation description.' } },
      },
      {
        entryId: 'include:commands' as PluginEntryId, moduleName: '@acme/dsh-sidebar/commands', enabled: true, fiberPhase: null,
        meta: { title: { en: 'English title' }, description: { en: 'Package description.', zh: '中文命令说明。' } },
      },
      {
        entryId: 'include:theme' as PluginEntryId, moduleName: '@acme/dsh-theme/client', enabled: true, fiberPhase: null,
        meta: { title: { en: '@acme/dsh-theme', zh: '主题插件' }, description: { en: '', zh: '中文主题说明。' } },
      },
    ]
    const snapshot: Snapshot = scope === 'global'
      ? { entries: rows }
      : { entries: [], agentPresets: [{ id: 'custom', isDefault: true, rows }] }
    const list = vi.fn(async () => snapshot)
    const { locale, pageProps } = localizedProps(list)
    const view = render(<PluginInventorySettingsTab {...pageProps} />)
    await screen.findByRole('searchbox', { name: en.search })
    fireEvent.click(scope === 'global' ? globalToggle() : presetToggle())
    expect(screen.getByRole('button', { name: 'sidebar/navigation, include:navigation, Enabled' })).toBeTruthy()
    expect(screen.getByText('Navigation description.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'English title, include:commands, Enabled' })).toBeTruthy()
    expect(screen.getByText('Package description.')).toBeTruthy()
    const theme = screen.getByRole('button', { name: '@acme/dsh-theme, include:theme, Enabled' })
    expect(theme.getAttribute('aria-describedby')).toBeNull()
    expect(screen.queryByText('中文主题说明。')).toBeNull()

    locale.setLocale('zh')
    view.rerender(<PluginInventorySettingsTab {...pageProps} />)
    for (const [name, description] of [
      ['sidebar/navigation, include:navigation, 已启用', 'Navigation description.'],
      ['English title, include:commands, 已启用', '中文命令说明。'],
      ['主题插件, include:theme, 已启用', '中文主题说明。'],
    ] as const) {
      const card = screen.getByRole('button', { name })
      expect(screen.getByText(description)).toBeTruthy()
      expect(document.getElementById(card.getAttribute('aria-describedby')!)?.textContent).toBe(description)
    }
    expect(screen.queryByText('Package description.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '主题插件, include:theme, 已启用' }))
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('include:theme')
    expect(screen.getByText(zh.moduleLabel).nextElementSibling?.textContent).toBe('@acme/dsh-theme/client')

    fireEvent.change(screen.getByRole('searchbox', { name: zh.search }), { target: { value: '中文主题说明。' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    locale.setLocale('en')
    view.rerender(<PluginInventorySettingsTab {...pageProps} />)
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: '@acme/dsh-theme/client' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '@acme/dsh-theme, include:theme, Enabled' }).getAttribute('aria-describedby')).toBeNull()
    expect(list).toHaveBeenCalledOnce()
  })

  it('keeps metadata-error-only rows inspectable by their full module specifier', async () => {
    const error = 'locale/zh.json: invalid title'
    await renderReady({
      entries: [{
        entryId: 'include:legacy' as PluginEntryId, moduleName: '@acme/dsh-legacy', enabled: false, fiberPhase: null,
        meta: { error },
      }],
    })
    fireEvent.click(globalToggle())
    expect(screen.getByText(en.metadataError.replace('{error}', error))).toBeTruthy()
    const card = screen.getByRole('button', { name: 'legacy, include:legacy, Disabled' })
    expect(card).toHaveProperty('disabled', false)
    expect(card.closest('li')?.getAttribute('data-failed')).toBeNull()
    fireEvent.click(card)
    expect(screen.getByText(en.moduleLabel).nextElementSibling?.textContent).toBe('@acme/dsh-legacy')
  })

  it('shows the default preset first with both groups collapsed', async () => {
    const view = await renderReady()

    const switcher = screen.getByRole('button', { name: en.switcherLabel })
    expect(switcher.textContent).toBe('标准模式 (default)')
    fireEvent.click(switcher)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '标准模式 (default)',
      'ptc',
      '坏预设 (failed to load)',
    ])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    expect(screen.getByText(en.presetSubtitle)).toBeTruthy()
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('6')

    // Both groups start collapsed; opening the preset group lists its rows while the global plane stays folded.
    expect(presetToggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    fireEvent.click(presetToggle())
    expect(presetToggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    expect(screen.getAllByText(en.enabledTag)).toHaveLength(3)
    expect(screen.getByText(en.conditionalTag)).toBeTruthy()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(screen.getByText(en.failedTag)).toBeTruthy()
    // The enablement tag is the row's one settled status signal: an active fiber
    // and a row with no live fiber both render without a phase dot.
    expect(screen.queryByRole('img', { name: en.active })).toBeNull()
    expect(screen.queryByRole('img', { name: en.unobserved })).toBeNull()

    expect(globalToggle().getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('7')
    expect(screen.getByText(`1 ${en.failedCountLabel}`)).toBeTruthy()

    // A preset row expands into its source facts.
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, pwsh, Conditional' }))
    expect(screen.getByText(en.fromPreset)).toBeTruthy()
    expect(screen.getByText('标准模式')).toBeTruthy()
    expect(screen.getByText(en.condition)).toBeTruthy()
    expect(screen.getByText('process.platform === \'win32\'')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, pwsh, Conditional' }))
    expect(screen.queryByText(en.condition)).toBeNull()

    // A failed preset row names its runtime state instead of a condition.
    fireEvent.click(screen.getByRole('button', { name: 'crashy, crashy, Failed' }))
    expect(screen.getByText(en.runtime)).toBeTruthy()
    expect(screen.getByText('Failed to start')).toBeTruthy()

    // A row declaring no id has no Loader identity line, only its module.
    fireEvent.click(screen.getByRole('button', { name: 'anonymous, Enabled' }))
    expect(view.container.querySelector('[data-loader-entry]')).toBeNull()
    expect(screen.getByText(en.moduleLabel).nextElementSibling?.textContent).toBe('@fixture/anonymous')
  })

  it('keeps the phase dot for a live phase the enablement tag does not state', async () => {
    await renderReady({
      entries: [
        { entryId: 'booting', moduleName: '@fixture/booting', enabled: true, fiberPhase: 'loading' },
        { entryId: 'waiting', moduleName: '@fixture/waiting', enabled: true, fiberPhase: 'pending' },
        { entryId: 'running', moduleName: '@fixture/running', enabled: true, fiberPhase: 'active' },
        { entryId: 'unobserved', moduleName: '@fixture/unobserved', enabled: true, fiberPhase: null },
      ],
      agentPresets: [{
        id: 'standard',
        isDefault: true,
        rows: [
          { entryId: 'stopping', moduleName: '@fixture/stopping', enabled: true, fiberPhase: 'unloading' },
          { entryId: 'preset-running', moduleName: '@fixture/preset-running', enabled: true, fiberPhase: 'active' },
        ],
      }],
    } as unknown as Snapshot)

    fireEvent.click(globalToggle())
    fireEvent.click(presetToggle())
    expect(screen.getAllByText(en.enabledTag)).toHaveLength(6)
    expect(screen.getByRole('img', { name: en.loadingPhase })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.pending })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.unloading })).toBeTruthy()
    expect(screen.queryByRole('img', { name: en.active })).toBeNull()
    expect(screen.queryByRole('img', { name: en.unobserved })).toBeNull()
  })

  it('distinguishes collapsed same-module rows by stable entry id', async () => {
    const longId = 'include:agent-presets:tool-subagent-secondary-with-a-complete-stable-identity'
    const subtitle = 'agent-presets:tool-subagent-secondary-with-a-complete-stable-identity'
    await renderReady({
      entries: [],
      agentPresets: [{
        id: 'same-module',
        isDefault: true,
        rows: [
          { entryId: 'tool-subagent-primary', moduleName: '@deepseek-ai/dsh-tool-subagent', enabled: true, fiberPhase: null },
          { entryId: longId, moduleName: '@deepseek-ai/dsh-tool-subagent', enabled: false, fiberPhase: null },
        ],
      }],
    })

    fireEvent.click(presetToggle())
    expect(screen.getByRole('button', { name: 'tool-subagent, tool-subagent-primary, Enabled' })
      .getAttribute('aria-expanded')).toBe('false')
    const secondary = screen.getByRole('button', { name: `tool-subagent, ${longId}, Disabled` })
    expect(secondary.getAttribute('aria-expanded')).toBe('false')
    expect(secondary.children).toHaveLength(2)
    expect(secondary.children[0]?.textContent).toContain('tool-subagent')
    expect(secondary.children[0]?.textContent).toContain('Disabled')
    expect(secondary.children[1]?.textContent).toBe(subtitle)
    expect(screen.getByTitle(longId).textContent).toBe(subtitle)

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'include:agent-presets:tool-subagent-secondary' } })
    expect(screen.queryByRole('button', { name: 'tool-subagent, tool-subagent-primary, Enabled' })).toBeNull()
    const filteredSecondary = screen.getByRole('button', { name: `tool-subagent, ${longId}, Disabled` })
    fireEvent.click(filteredSecondary)
    expect(filteredSecondary.getAttribute('aria-expanded')).toBe('true')
  })

  it('expands the global plane with failures first and preset-provided rows inline', async () => {
    const view = await renderReady()

    expect(screen.queryByText(en.presetEnabledTag)).toBeNull()
    fireEvent.click(globalToggle())
    expect(globalToggle().getAttribute('aria-expanded')).toBe('true')
    const failed = view.container.querySelector('[data-plugin-scope="global"] [data-failed="true"]')
    expect(failed?.getAttribute('data-plugin-entry')).toBe('telemetry')
    // Failures float above the Loader-ordered remainder.
    expect(view.container.querySelector('[data-plugin-scope="global"] li')).toBe(failed)

    // Rows the presets took over sit inline, marked instead of plainly disabled.
    expect(screen.getAllByText(en.presetEnabledTag)).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash-host, Enabled via presets' }))
    expect(screen.getByText(en.presetProvidedDetail)).toBeTruthy()
    expect(screen.getByText(en.enabledIn)).toBeTruthy()
    expect(screen.getByText('标准模式 · ptc')).toBeTruthy()

    // The failed global card reports its runtime state.
    fireEvent.click(screen.getByRole('button', { name: 'telemetry, telemetry, Failed' }))
    expect(screen.getByText('Failed to start')).toBeTruthy()

    // An enabled entry with no live fiber says so in its details, dot-free.
    fireEvent.click(screen.getByRole('button', { name: 'unobserved-name, unobserved, Enabled' }))
    expect(screen.getByText('Not running')).toBeTruthy()

    // A disabled row outside every preset stays plainly disabled.
    fireEvent.click(screen.getByRole('button', { name: 'dormant, dormant, Disabled' }))
    expect(screen.queryByText(en.presetProvidedDetail)).toBeNull()

    fireEvent.click(globalToggle())
    expect(globalToggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(en.presetEnabledTag)).toBeNull()
  })

  it('switches the inspected preset in place, including broken ones', async () => {
    const view = await renderReady()
    const pickPreset = (label: string): void => {
      fireEvent.click(screen.getByRole('button', { name: en.switcherLabel }))
      fireEvent.click(screen.getByRole('menuitem', { name: label }))
    }

    pickPreset('ptc')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('3')
    fireEvent.click(presetToggle())
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash, Enabled' }))
    // An unnamed preset labels its source by id.
    expect(screen.getByText(en.fromPreset).nextElementSibling?.textContent).toBe('ptc')

    pickPreset('坏预设 (failed to load)')
    expect(screen.getByRole('alert').textContent).toBe('the composition file is missing')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('0')
  })

  it('keeps the preset group folded until opened or searched', async () => {
    const view = await renderReady()
    const toggle = presetToggle()

    // The header keeps its count while the rows are folded away.
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('6')
    expect(view.container.querySelectorAll('[data-plugin-scope="preset"] li')).toHaveLength(0)
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'pwsh' } })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(en.conditionalTag)).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: '' } })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('routes every preset name through the display resolver', async () => {
    // The resolver stands in for presetDisplayText: shipped presets localize,
    // user-authored ones keep their own metadata.
    const localized: PluginInventorySettingsTabInjected['presetName'] = preset =>
      ['standard', 'ptc'].includes(preset.id) ? `Localized ${preset.id}` : preset.name ?? preset.id
    render(<PluginInventorySettingsTab {...props(async () => SNAPSHOT, localized)} />)
    await screen.findByRole('searchbox', { name: en.search })

    const switcher = screen.getByRole('button', { name: en.switcherLabel })
    expect(switcher.textContent).toBe('Localized standard (default)')
    fireEvent.click(switcher)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Localized standard (default)',
      'Localized ptc',
      '坏预设 (failed to load)',
    ])
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(presetToggle())
    fireEvent.click(screen.getByRole('button', { name: 'pwsh, pwsh, Conditional' }))
    expect(screen.getByText(en.fromPreset).nextElementSibling?.textContent).toBe('Localized standard')

    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash-host, Enabled via presets' }))
    expect(screen.getByText('Localized standard · Localized ptc')).toBeTruthy()
  })

  it('jumps from a preset-provided row to the preset that enables it', async () => {
    await renderReady()
    fireEvent.click(screen.getByRole('button', { name: en.switcherLabel }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'ptc' }))

    fireEvent.click(globalToggle())
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash-host, Enabled via presets' }))
    fireEvent.click(screen.getByRole('button', { name: en.viewInPreset }))
    expect(screen.getByRole('button', { name: en.switcherLabel }).textContent)
      .toBe('标准模式 (default)')
  })

  it('searches across scopes and points at matches in other presets', async () => {
    const view = await renderReady()
    const search = screen.getByRole('searchbox', { name: en.search })

    fireEvent.change(search, { target: { value: 'tool-bash' } })
    // Searching forces the collapsed global plane and drawer open.
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('1')
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    expect(screen.getByText(en.presetEnabledTag)).toBeTruthy()
    expect(screen.queryByText(`1 ${en.failedCountLabel}`)).toBeNull()
    const hint = screen.getByText((text: string) => text.startsWith('2 more matches'))
    expect(hint).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ptc' }))
    expect(screen.getByRole('button', { name: en.switcherLabel }).textContent).toBe('ptc')

    // A match visible only in another preset keeps the pointer without rows.
    fireEvent.change(search, { target: { value: 'crashy' } })
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('0')
    expect(screen.getByText((text: string) => text.startsWith('1 more matches'))).toBeTruthy()
    expect(screen.queryByText(en.emptySearch)).toBeNull()

    // A match on a Loader entry id only reaches the global plane.
    fireEvent.change(search, { target: { value: '8a1b2c3d' } })
    expect(view.container.querySelector('[data-plugin-count]')?.getAttribute('data-plugin-count')).toBe('1')
    expect(screen.queryByText((text: string) => text.includes('more matches'))).toBeNull()

    fireEvent.change(search, { target: { value: 'not-a-plugin' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('renders a rosterless deployment as one global list, folded until opened', async () => {
    const view = await renderReady({
      entries: [
        { entryId: 'hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
        { entryId: 'off', moduleName: '@fixture/off', enabled: false, fiberPhase: null },
      ],
    } as unknown as Snapshot)

    expect(screen.queryByRole('button', { name: en.switcherLabel })).toBeNull()
    expect(globalToggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    fireEvent.click(globalToggle())
    expect(globalToggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'hmr, hmr, Enabled' }))
    expect(screen.getByText(en.runtime)).toBeTruthy()
    expect(view.container.querySelector('[data-loader-entry]')?.textContent).toBe('hmr')
    fireEvent.click(screen.getByRole('button', { name: 'off, off, Disabled' }))
    expect(screen.getAllByText(en.moduleLabel).length).toBeGreaterThan(0)
    expect(screen.queryByText(en.runtime)).toBeNull()
  })

  it('renders a preset-only snapshot without the global section', async () => {
    await renderReady({
      entries: [],
      agentPresets: [{
        id: 'solo',
        isDefault: false,
        rows: [{ entryId: 'one', moduleName: '@fixture/one', enabled: true, fiberPhase: null }],
      }],
    })

    expect(screen.queryByRole('button', { name: (name: string) => name.startsWith(en.globalTitle) })).toBeNull()
    expect(screen.queryByText(en.empty)).toBeNull()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    fireEvent.click(presetToggle())
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PluginInventorySettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginInventorySettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).querySelector('[data-state="error"]')).not.toBeNull()
    expect(screen.queryByText('private transport detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.empty)).toBeTruthy()
  })

  it('contains a synchronous Remote failure and ignores a result after unmount', async () => {
    const syncFailure = vi.fn(() => { throw new Error('namespace unavailable') }) as PluginInventorySettingsTabInjected['list']
    const failed = render(<PluginInventorySettingsTab {...props(syncFailure)} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
    failed.unmount()

    const deferred = Promise.withResolvers<Snapshot>()
    const pending = render(<PluginInventorySettingsTab {...props(() => deferred.promise)} />)
    expect(screen.getByText(en.loading).querySelector('[data-state="ongoing"]')).not.toBeNull()
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<Snapshot>()
    const pendingFailure = render(<PluginInventorySettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })
})

it('shows current-page sync errors and retries without re-reading Host inventory', async () => {
  const list = vi.fn(async () => ({ entries: [] }))
  const sync = createSnapshotStore<ClientEntryState>({ syncing: true, failures: [] })
  const retryClient = vi.fn()
  render(<PluginInventorySettingsTab {...props(list)} useClientSync={bindSnapshotSelector(sync)} retryClient={retryClient} />)
  expect(screen.getByText(en.clientSyncing).closest('[role="status"]')?.querySelector('[data-state="ongoing"]')).not.toBeNull()
  await waitFor(() => { expect(list).toHaveBeenCalledOnce() })
  act(() => { sync.set({ syncing: false, failures: [{ id: 'client-addon', message: 'download failed' }] }) })
  expect(screen.getByRole('alert').querySelector('[data-state="error"]')).not.toBeNull()
  expect(screen.getByText('client-addon: download failed')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry this page' }))
  expect(retryClient).toHaveBeenCalledOnce()
  expect(list).toHaveBeenCalledOnce()
  act(() => { sync.set({ syncing: false, failures: [] }) })
  expect(screen.queryByRole('alert')).toBeNull()
})
