// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginInventorySettingsTab } from '../src/client/PluginInventorySettingsTab.tsx'
import type {
  PluginInventorySettingsTabInjected,
  PluginInventorySettingsTabProps,
} from '../src/client/PluginInventorySettingsTab.tsx'
import { en, type PluginInventoryLocaleKey } from '../src/client/locales.ts'

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
): PluginInventorySettingsTabProps {
  return {
    t,
    list,
    presetName,
  } as PluginInventorySettingsTabProps
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
      trust: 'system',
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
      trust: 'system',
      isDefault: false,
      rows: [
        { entryId: 'bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'bash-fork', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: null },
        { entryId: 'fs', moduleName: '@deepseek-ai/dsh-tool-fs', enabled: 'conditional', fiberPhase: null },
      ],
    },
    { id: 'shattered', trust: 'user', name: '坏预设', isDefault: false, broken: 'the composition file is missing', rows: [] },
  ],
} as unknown as Snapshot

async function renderReady(snapshot: Snapshot = SNAPSHOT): Promise<ReturnType<typeof render>> {
  const view = render(<PluginInventorySettingsTab {...props(async () => snapshot)} />)
  await screen.findByRole('searchbox', { name: en.search })
  return view
}

const globalToggle = (): HTMLElement =>
  screen.getByRole('button', { name: (name: string) => name.startsWith(en.globalTitle) })

describe('PluginInventorySettingsTab', () => {
  it('shows the default preset first and keeps the global plane collapsed', async () => {
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

    // Only the preset group lists rows while the global plane stays collapsed.
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
    expect(screen.getAllByText(en.enabledTag)).toHaveLength(3)
    expect(screen.getByText(en.conditionalTag)).toBeTruthy()
    expect(screen.getByText(en.disabledTag)).toBeTruthy()
    expect(screen.getByText(en.failedTag)).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Running' })).toBeTruthy()
    // No live fiber, no dot: file-state rows carry only their enablement tag.
    expect(screen.queryByRole('img', { name: 'Not running' })).toBeNull()

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

  it('distinguishes collapsed same-module rows by stable entry id', async () => {
    const longId = 'include:agent-presets:tool-subagent-secondary-with-a-complete-stable-identity'
    const subtitle = 'agent-presets:tool-subagent-secondary-with-a-complete-stable-identity'
    await renderReady({
      entries: [],
      agentPresets: [{
        id: 'same-module',
        trust: 'user',
        isDefault: true,
        rows: [
          { entryId: 'tool-subagent-primary', moduleName: '@deepseek-ai/dsh-tool-subagent', enabled: true, fiberPhase: null },
          { entryId: longId, moduleName: '@deepseek-ai/dsh-tool-subagent', enabled: false, fiberPhase: null },
        ],
      }],
    })

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
    fireEvent.click(screen.getByRole('button', { name: 'tool-bash, bash, Enabled' }))
    // An unnamed preset labels its source by id.
    expect(screen.getByText(en.fromPreset).nextElementSibling?.textContent).toBe('ptc')

    pickPreset('坏预设 (failed to load)')
    expect(screen.getByRole('alert').textContent).toBe('the composition file is missing')
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('0')
  })

  it('collapses the preset group until a search forces it open', async () => {
    const view = await renderReady()
    const toggle = screen.getByRole('button', { name: en.presetTitle })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // The header keeps its count while the rows are folded away.
    expect(view.container.querySelector('[data-preset-plugin-count]')?.getAttribute('data-preset-plugin-count')).toBe('6')
    expect(view.container.querySelectorAll('[data-plugin-scope="preset"] li')).toHaveLength(0)

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
      preset.trust === 'system' ? `Localized ${preset.id}` : preset.name ?? preset.id
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

  it('renders a rosterless deployment as one expanded global list', async () => {
    const view = await renderReady({
      entries: [
        { entryId: 'hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
        { entryId: 'off', moduleName: '@fixture/off', enabled: false, fiberPhase: null },
      ],
    } as unknown as Snapshot)

    expect(screen.queryByRole('button', { name: en.switcherLabel })).toBeNull()
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
        trust: 'user',
        isDefault: false,
        rows: [{ entryId: 'one', moduleName: '@fixture/one', enabled: true, fiberPhase: null }],
      }],
    })

    expect(screen.queryByRole('button', { name: (name: string) => name.startsWith(en.globalTitle) })).toBeNull()
    expect(screen.queryByText(en.empty)).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('shows a generic failure and retries into the empty state', async () => {
    const list = vi.fn<PluginInventorySettingsTabInjected['list']>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValueOnce({ entries: [] })
    render(<PluginInventorySettingsTab {...props(list)} />)

    expect((await screen.findByRole('alert')).textContent).toBe(en.error)
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
    expect(screen.getByText(en.loading)).toBeTruthy()
    pending.unmount()
    await act(async () => { deferred.resolve(SNAPSHOT) })

    const deferredFailure = Promise.withResolvers<Snapshot>()
    const pendingFailure = render(<PluginInventorySettingsTab {...props(() => deferredFailure.promise)} />)
    pendingFailure.unmount()
    await act(async () => { deferredFailure.reject(new Error('late failure')) })
  })
})
