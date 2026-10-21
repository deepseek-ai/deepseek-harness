/** Optional CUA uses existing plugin activation and offers a separate persistent PTC action. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { expect, it, vi } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

it.each([undefined, 'minimal'] as const)('adds CUA to PTC sessions while preserving default %s until the explicit persistent-runtime action', async (selectedDefault) => {
  const directory = await mkdtemp(join(tmpdir(), 'cua-optin-web-'))
  let ownedScaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const patch = join(directory, 'native-fixture.yml')
    // The executable cannot answer native permission queries, so setup must offer retry in the detail page.
    await writeFile(patch, JSON.stringify([{ id: 'cua', disabled: false, config: { helperPath: process.execPath } }]))
    // Install the test provider explicitly so the helper override also exercises session wiring on Linux.
    const scaffold = ownedScaffold = await launchWebScaffold({
      profile: { packages: [{ dir: fileURLToPath(new URL('../../../packages/experimental/cua-macos', import.meta.url)), enabled: false }] },
      harnessHome: join(directory, 'home'), extraOverlayPath: [
        fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), patch,
      ] })
    const initialDefault = selectedDefault ?? 'standard'
    if (selectedDefault !== undefined) await scaffold.ctx.settings.update('agent-preset-registry', { selectedDefault })
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const originalAgent = scaffold.ctx.agents.list()[0]!
    const ptcAgent = (await scaffold.ctx.agents.create({ sessionId: SessionId('cua-existing-ptc'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx, 'ptc') },
    })).agent
    const runtimeFiber = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ptc-runtime')?.fiber
    const originalRuntime = scaffold.ctx.ptcRuntime
    const originalRuntimeFiber = runtimeFiber()
    expect(originalRuntimeFiber).toBeDefined()
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
    const settingsPath = join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml')
    const before = await readFile(settingsPath, 'utf8')
    const selected = () => readProfileManifest('scaffold', join(scaffold.harnessHome, 'profiles/scaffold')).dsh?.profile?.bundles
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const plugins = page.locator('[data-plugin-panel]')
    await plugins.getByRole('button', { name: '更多', exact: true }).waitFor()
    expect(await page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]').count()).toBe(0)
    await plugins.getByRole('button', { name: '更多', exact: true }).click()
    const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]')
    expect(await card.getByText('实验性', { exact: true }).count()).toBe(1)
    const toggle = card.getByRole('switch', { name: '启用 Computer Use', exact: true })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    expect(await card.textContent()).toContain('请切换到 PTC 模式')
    const enabling = Promise.withResolvers<undefined>()
    const setEnabled = scaffold.ctx.pluginManager.setBundleEnabled.bind(scaffold.ctx.pluginManager)
    let applying: ReturnType<typeof setEnabled> | undefined
    // Hold the Host request so the pending UI does not depend on machine speed; release into the real operation.
    const enableCall = vi.spyOn(scaffold.ctx.pluginManager, 'setBundleEnabled').mockImplementationOnce((name, enabled) => {
      applying = enabling.promise.then(() => setEnabled(name, enabled))
      return applying
    })
    try {
      await toggle.click()
      await card.getByRole('status').getByText('正在应用 Computer Use 的更改', { exact: true }).waitFor()
      expect(await toggle.isEnabled()).toBe(false)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/cua-permissions/enabling.expected.md', import.meta.url)),
        await captureStableAria(page, '[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]', scaffold.workspaceCwd), webSnapshotMode())
    } finally {
      enabling.resolve(undefined)
      enableCall.mockRestore()
      await applying
    }
    // Bundle transitions await native cleanup under the browser action deadline.
    await toggle.and(page.locator('[aria-checked="true"]')).waitFor({ state: 'visible' })
    await card.getByRole('status').getByText('正在应用 Computer Use 的更改', { exact: true }).waitFor({ state: 'hidden' })
    const setup = page.getByRole('dialog', { name: '使用 Computer Use 前需要设置', exact: true })
    await setup.waitFor()
    expect(await setup.getByText('Computer Use 插件已开启，但暂时无法检测系统权限。请前往插件详情页查看原因并重试。', { exact: true }).count()).toBe(1)
    await setup.getByRole('button', { name: '稍后', exact: true }).click()
    expect(selected()).toContain('@deepseek-ai/dsh-cua-bundle')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    expect(runtimeFiber() === originalRuntimeFiber).toBe(true)
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(scaffold.ctx.agents.get(originalAgent.id) === originalAgent).toBe(true)
    expect(scaffold.ctx.tools.schemas(originalAgent).some(tool => tool.name === 'cua')).toBe(false)
    expect(scaffold.ctx.tools.schemas(ptcAgent).some(tool => tool.name === 'cua')).toBe(true)
    expect((await scaffold.ctx.systemPrompt.assemble({ scope: ptcAgent })).tools.map(tool => tool.name)).toEqual(['run_code'])
    const fresh = await scaffold.ctx.agents.create({ sessionId: SessionId('cua-new-ptc'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx, 'ptc') },
    })
    expect(scaffold.ctx.tools.schemas(fresh.agent).some(tool => tool.name === 'cua')).toBe(true)
    await toggle.click()
    await toggle.and(page.locator('[aria-checked="false"]')).waitFor({ state: 'visible' })
    expect(scaffold.ctx.get('computerUse')).toBeUndefined()
    for (const agent of [ptcAgent, fresh.agent]) expect(scaffold.ctx.tools.schemas(agent).some(tool => tool.name === 'cua')).toBe(false)
    expect(runtimeFiber() === originalRuntimeFiber).toBe(true)
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    await card.getByRole('button', { name: '查看 Computer Use', exact: true }).click()
    const detailToggle = page.locator('[data-plugin-panel]').getByRole('switch', { name: '启用 Computer Use', exact: true })
    await detailToggle.click()
    await detailToggle.and(page.locator('[aria-checked="true"]')).waitFor({ state: 'visible' })
    const panel = page.locator('[data-cua-settings]')
    await panel.waitFor()
    const defaultSetting = panel.getByRole('group', { name: '新会话默认模式', exact: true })
    await expect.poll(() => defaultSetting.getByRole('button', { name: '设为 PTC', exact: true }).isEnabled()).toBe(true)
    await defaultSetting.getByRole('button', { name: '设为 PTC', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentPresets.defaultId).toBe('ptc')
    expect(scaffold.ctx.agentPresets.composedPreset(originalAgent.ctx)).toBe(initialDefault)
    expect(runtimeFiber() === originalRuntimeFiber).toBe(true)
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe('function-body')
    const confirmed = await scaffold.ctx.agents.create({ sessionId: SessionId('cua-confirmed-default'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx) },
    })
    expect(scaffold.ctx.tools.schemas(confirmed.agent).some(tool => tool.name === 'cua')).toBe(true)
    const saved = await readFile(settingsPath, 'utf8')
    expect(saved).toContain('selectedDefault: ptc')
    expect(saved).not.toContain('executionMode:')
    const persistent = panel.getByRole('group', { name: 'PTC 执行方式', exact: true })
    await persistent.getByRole('button', { name: '设为持久化', exact: true }).click()
    await persistent.getByRole('button', { name: '已设为持久化', exact: true }).waitFor()
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe('repl')
    expect(scaffold.ctx.ptcRuntime === originalRuntime).toBe(false)
    const persistentRuntimeFiber = runtimeFiber()
    const runtime = scaffold.ctx.ptcRuntime, owner = {}
    const program = 'globalThis.counter = (globalThis.counter ?? 0) + 1'
    expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))).value).toBe(1)
    const configured = await readFile(settingsPath, 'utf8')
    expect(configured).toContain('executionMode: persistent-in-memory')
    expect(scaffold.ctx.agentPresets.defaultId).toBe('ptc')
    expect(scaffold.ctx.agentPresets.composedPreset(originalAgent.ctx)).toBe(initialDefault)
    await detailToggle.click()
    await detailToggle.and(page.locator('[aria-checked="false"]')).waitFor({ state: 'visible' })
    expect(await readFile(settingsPath, 'utf8')).toBe(configured)
    expect(runtimeFiber() === persistentRuntimeFiber).toBe(true)
    expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))).value).toBe(2)
    await detailToggle.click()
    await detailToggle.and(page.locator('[aria-checked="true"]')).waitFor({ state: 'visible' })
    expect(await readFile(settingsPath, 'utf8')).toBe(configured)
    expect(runtimeFiber() === persistentRuntimeFiber).toBe(true)
    expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))).value).toBe(3)
    await runtime.release(owner)
  } finally {
    try { await browser?.close() } finally {
      try { await ownedScaffold?.close() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
})
