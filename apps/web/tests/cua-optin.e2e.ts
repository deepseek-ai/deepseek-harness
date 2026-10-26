/** CUA follows PTC Agent scopes and changes the default only from its detail page. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { load } from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

// The shipped bundle admits only macOS Hosts; unsupported Hosts are exercised in bundle-platform.e2e.ts.
it.skipIf(process.platform !== 'darwin').each([
  { selectedDefault: undefined, codingTools: false, script: false },
  { selectedDefault: undefined, codingTools: true, script: false },
  { selectedDefault: 'minimal', codingTools: true, script: false },
  { selectedDefault: undefined, codingTools: true, script: true },
] as const)('preserves Coding Tools=$codingTools and default=$selectedDefault and Script=$script across CUA toggles', async ({ selectedDefault, codingTools, script }) => {
  const directory = await mkdtemp(join(tmpdir(), 'cua-optin-web-'))
  let ownedScaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const patch = join(directory, 'native-fixture.yml')
    // Permission inspection fails against this non-helper executable; activation still permits dismissing setup.
    await writeFile(patch, JSON.stringify([{ id: 'cua', config: { helperPath: process.execPath } }]))
    const defaults = join(directory, 'script-defaults')
    if (script) {
      await mkdir(defaults)
      await writeFile(join(defaults, 'package.json'), JSON.stringify({ name: 'cua-script-defaults', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      await writeFile(join(defaults, 'cordis.patch.yml'), '- id: ptc-runtime\n  config:\n    executionMode: vm-script\n    scriptPersistence: false\n')
    }
    const harnessHome = join(directory, 'home')
    const scaffold = ownedScaffold = await launchWebScaffold({
      profile: { packages: script ? [{ dir: defaults, enabled: true }] : [] },
      harnessHome, extraOverlayPath: [
        fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), patch,
      ] })
    const initialDefault = selectedDefault ?? 'standard'
    if (selectedDefault !== undefined) await scaffold.ctx.settings.update('agent-preset-registry', { selectedDefault })
    await scaffold.ctx.settings.update('ui-settings', { enabled: codingTools })
    const settingsPath = join(harnessHome, 'profiles/scaffold/cordis.patch.yml')
    const beforeEnable = await readFile(settingsPath, 'utf8')
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const plugins = page.locator('[data-plugin-panel]')
    await plugins.getByRole('button', { name: '更多', exact: true }).waitFor()
    expect(await page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]').count()).toBe(0)
    await plugins.getByRole('button', { name: '更多', exact: true }).click()
    const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]')
    expect(await card.count()).toBe(0)
    expect((await scaffold.ctx.pluginManager.listBundles()).find(bundle => bundle.name === '@deepseek-ai/dsh-cua-bundle'))
      .toMatchObject({ listedByDefault: false, enabled: false, installed: false })
    await plugins.getByRole('button', { name: '返回插件', exact: true }).click()
    const offerCua = async () => {
      await plugins.getByRole('button', { name: '添加插件', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '添加插件', exact: true })
      await dialog.getByRole('textbox', { name: '包名或地址', exact: true }).fill('@deepseek-ai/dsh-cua-bundle')
      await dialog.getByRole('button', { name: '安装', exact: true }).click()
      const ready = page.getByRole('dialog', { name: '插件已随 DSH 提供', exact: true })
      await ready.waitFor()
      expect(await ready.getByText('无需下载，启用即可使用', { exact: true }).count()).toBe(1)
      return ready.getByRole('button', { name: '立即启用', exact: true })
    }
    const enableNow = await offerCua()
    let toggle = card.getByRole('switch', { name: '启用 Computer Use', exact: true })
    const originalAgent = scaffold.ctx.agents.list()[0]!
    const ptcAgent = (await scaffold.ctx.agents.create({
      sessionId: SessionId('cua-existing-ptc'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx, 'ptc') },
    })).agent
    expect(scaffold.ctx.tools.schemas(ptcAgent).some(tool => tool.name === 'cua')).toBe(false)
    const runtimeFiber = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'ptc-runtime')?.fiber
    const originalRuntimeFiber = runtimeFiber()
    expect(originalRuntimeFiber).toBeDefined()
    const originalRuntime = scaffold.ctx.ptcRuntime
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(originalRuntime.programFormat).toBe(script ? 'script' : 'function-body')
    expect(scaffold.ctx.get('computerUse')).toBeUndefined()
    const profileManifest = () => readProfileManifest('scaffold', join(scaffold.harnessHome, 'profiles/scaffold'))
    const selected = () => profileManifest().dsh?.profile?.bundles
    const dependencies = profileManifest().dependencies
    expect(selected()).not.toContain('@deepseek-ai/dsh-cua-bundle')

    const enabling = Promise.withResolvers<undefined>()
    const setEnabled = scaffold.ctx.pluginManager.setBundleEnabled.bind(scaffold.ctx.pluginManager)
    let applying: ReturnType<typeof setEnabled> | undefined
    // Hold the Host request so the pending UI does not depend on machine speed; release into the real operation.
    const enableCall = vi.spyOn(scaffold.ctx.pluginManager, 'setBundleEnabled').mockImplementationOnce((name, enabled) => {
      applying = enabling.promise.then(() => setEnabled(name, enabled))
      return applying
    })
    try {
      await enableNow.click()
      await expect.poll(() => enableNow.isEnabled()).toBe(false)
      expect(await enableNow.getAttribute('aria-busy')).toBe('true')
      expect(await card.count()).toBe(0)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/cua-permissions/enabling.expected.md', import.meta.url)),
        await captureStableAria(page, '[data-install-phase="done"] button[aria-busy]', scaffold.workspaceCwd), webSnapshotMode())
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
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/cua-permissions/setup.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(await setup.getByRole('button', { name: '设为 PTC', exact: true }).count()).toBe(0)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(selected()).toContain('@deepseek-ai/dsh-cua-bundle')
    expect(profileManifest().dependencies).toEqual(dependencies)
    expect(await card.getByText('实验性', { exact: true }).count()).toBe(1)
    expect(await card.textContent()).not.toContain('将 PTC 模式改为可持久化')
    expect(await card.textContent()).toContain('请切换到 PTC 模式')
    expect(await card.textContent()).toContain('Windows 支持正在开发中')
    expect(await card.textContent()).not.toContain('Swift')
    const description = await card.getByRole('button', { name: '查看 Computer Use', exact: true }).evaluate((button) => {
      const element = document.getElementById(button.getAttribute('aria-describedby')!)!
      const style = getComputedStyle(element)
      return { lines: style.webkitLineClamp, height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight) }
    })
    expect(description.lines).toBe('1')
    expect(description.height).toBeLessThanOrEqual(description.lineHeight + 1)
    expect(scaffold.ctx.get('computerUse')).toBeDefined()
    expect(scaffold.ctx.agents.get(originalAgent.id) === originalAgent).toBe(true)
    expect(scaffold.ctx.agents.get(ptcAgent.id) === ptcAgent).toBe(true)
    expect(scaffold.ctx.agentPresets.composedPreset(originalAgent.ctx)).toBe(initialDefault)
    expect(scaffold.ctx.tools.schemas(originalAgent).some(tool => tool.name === 'cua')).toBe(false)
    expect(scaffold.ctx.tools.schemas(ptcAgent).some(tool => tool.name === 'cua')).toBe(true)
    expect((await scaffold.ctx.systemPrompt.assemble({ scope: ptcAgent })).tools.map(tool => tool.name)).toEqual(['run_code'])
    for (const preset of ['ptc', 'standard', 'ptc', initialDefault]) {
      await scaffold.ctx.agentPresets.select(originalAgent, preset)
      expect(scaffold.ctx.tools.schemas(originalAgent).some(tool => tool.name === 'cua')).toBe(preset === 'ptc')
    }
    const child = await scaffold.ctx.agents.create({
      sessionId: SessionId('cua-child'), parentAgent: ptcAgent,
      setup: (ctx) => { scaffold.ctx.agentPresets.composeFrom(ctx, ptcAgent.ctx) },
    })
    expect(scaffold.ctx.tools.schemas(child.agent).some(tool => tool.name === 'cua')).toBe(true)
    await child.dispose()
    expect(scaffold.ctx.tools.schemas(child.agent).some(tool => tool.name === 'cua')).toBe(false)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(runtimeFiber() === originalRuntimeFiber).toBe(true)
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe(script ? 'script' : 'function-body')
    await setup.waitFor()
    expect(await setup.getByText('Computer Use 插件已开启，但暂时无法检测系统权限。请前往插件详情页查看原因并重试。', { exact: true }).count()).toBe(1)
    await setup.getByRole('button', { name: '稍后', exact: true }).click()
    await setup.waitFor({ state: 'hidden' })
    let saved = await readFile(settingsPath, 'utf8')
    expect(saved).toBe(beforeEnable)
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: codingTools })
    expect(saved).not.toContain('executionMode:')
    if (selectedDefault === undefined) {
      expect(load(saved)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'agent-preset-registry' })]))
    } else {
      expect(load(saved)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'agent-preset-registry', config: { default: 'standard', selectedDefault } }),
      ]))
    }
    const freshDefault = (await scaffold.ctx.agents.create({
      sessionId: SessionId('cua-new-default'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx) },
    })).agent
    expect(scaffold.ctx.agentPresets.composedPreset(freshDefault.ctx)).toBe(initialDefault)
    expect(scaffold.ctx.tools.schemas(freshDefault).some(tool => tool.name === 'cua')).toBe(false)
    const fresh = (await scaffold.ctx.agents.create({
      sessionId: SessionId('cua-new-ptc'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx, 'ptc') },
    })).agent
    expect(scaffold.ctx.agentPresets.composedPreset(fresh.ctx)).toBe('ptc')
    expect(scaffold.ctx.tools.schemas(fresh).some(tool => tool.name === 'cua')).toBe(true)
    await card.getByRole('button', { name: '查看 Computer Use', exact: true }).click()
    toggle = page.locator('[data-plugin-panel]').getByRole('switch', { name: '启用 Computer Use', exact: true })
    const persistent = page.getByRole('group', { name: 'PTC 执行方式', exact: true })
    const beforePersistent = scaffold.ctx.ptcRuntime
    await persistent.getByRole('button', { name: '设为持久化', exact: true }).click()
    await persistent.getByRole('button', { name: '已设为持久化', exact: true }).waitFor()
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe(script ? 'script' : 'repl')
    expect(scaffold.ctx.ptcRuntime.retainsState).toBe(true)
    expect(scaffold.ctx.ptcRuntime === beforePersistent).toBe(false)
    saved = await readFile(settingsPath, 'utf8')
    expect(saved).toContain(`executionMode: ${script ? 'vm-script' : 'persistent-in-memory'}`)
    expect(saved).toContain(`scriptPersistence: ${script}`)
    const runtime = scaffold.ctx.ptcRuntime
    const persistentRuntimeFiber = runtimeFiber()
    const owner = {}
    const program = 'globalThis.counter = (globalThis.counter ?? 0) + 1'
    expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))).value).toBe(1)
    await toggle.click()
    await toggle.waitFor({ state: 'hidden' })
    await card.waitFor({ state: 'hidden' })
    expect(scaffold.ctx.get('computerUse')).toBeUndefined()
    expect(runtimeFiber() === persistentRuntimeFiber).toBe(true)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(scaffold.ctx.agents.get(ptcAgent.id) === ptcAgent).toBe(true)
    for (const agent of [ptcAgent, fresh]) {
      expect(scaffold.ctx.tools.schemas(agent).some(tool => tool.name === 'cua')).toBe(false)
      expect((await scaffold.ctx.systemPrompt.assemble({ scope: agent })).tools.map(tool => tool.name)).toEqual(['run_code'])
    }
    expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))).value).toBe(2)
    expect(await readFile(settingsPath, 'utf8')).toBe(saved)
    await (await offerCua()).click()
    await toggle.and(page.locator('[aria-checked="true"]')).waitFor({ state: 'visible' })
    await setup.waitFor()
    expect(await setup.getByText('Computer Use 插件已开启，但暂时无法检测系统权限。请前往插件详情页查看原因并重试。', { exact: true }).count()).toBe(1)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    await setup.getByRole('button', { name: '前往设置', exact: true }).click()
    await setup.waitFor({ state: 'hidden' })
    await page.getByRole('region', { name: '给 Computer Use 授权', exact: true }).getByRole('alert').waitFor()
    if (!codingTools) {
      expect(await readFile(settingsPath, 'utf8')).toBe(saved)
      expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: false })
      expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
      expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))).value).toBe(3)
      await runtime.release(owner)
      return
    }
    const defaultSetting = page.getByRole('group', { name: '新会话默认模式', exact: true })
    await expect.poll(() => defaultSetting.getByRole('button', { name: '设为 PTC', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/cua-permissions/default-mode.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="group"][aria-label="新会话默认模式"]', scaffold.workspaceCwd), webSnapshotMode())
    await defaultSetting.getByRole('button', { name: '设为 PTC', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agentPresets.defaultId).toBe('ptc')
    expect(scaffold.ctx.agentPresets.composedPreset(originalAgent.ctx)).toBe(initialDefault)
    expect(scaffold.ctx.agentPresets.composedPreset(freshDefault.ctx)).toBe(initialDefault)
    const confirmed = (await scaffold.ctx.agents.create({
      sessionId: SessionId('cua-confirmed-default'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx) },
    })).agent
    expect(scaffold.ctx.agentPresets.composedPreset(confirmed.ctx)).toBe('ptc')
    expect(scaffold.ctx.tools.schemas(confirmed).some(tool => tool.name === 'cua')).toBe(true)
    expect(runtimeFiber() === persistentRuntimeFiber).toBe(true)
    expect(scaffold.ctx.tools.schemas(ptcAgent).some(tool => tool.name === 'cua')).toBe(true)
    expect((await runtime.run(runtime.resolve({ program, bindings: [], stateOwner: owner }))).value).toBe(3)
    const confirmedSettings = await readFile(settingsPath, 'utf8')
    expect(load(confirmedSettings)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agent-preset-registry', config: { default: 'standard', selectedDefault: 'ptc' } }),
    ]))
    await toggle.click()
    await toggle.waitFor({ state: 'hidden' })
    await card.waitFor({ state: 'hidden' })
    await (await offerCua()).click()
    await toggle.and(page.locator('[aria-checked="true"]')).waitFor({ state: 'visible' })
    await setup.waitFor()
    expect(await setup.getByText('Computer Use 插件已开启，但暂时无法检测系统权限。请前往插件详情页查看原因并重试。', { exact: true }).count()).toBe(1)
    expect(await setup.getByRole('button', { name: '设为 PTC', exact: true }).count()).toBe(0)
    expect(await readFile(settingsPath, 'utf8')).toBe(confirmedSettings)
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: codingTools })
    await runtime.release(owner)
  } finally {
    try { await browser?.close() } finally {
      try { await ownedScaffold?.close() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
})
