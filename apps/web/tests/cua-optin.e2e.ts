/** CUA activation preserves the configured session preset and PTC execution mode. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { expect, it, vi } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { stepToolNames } from '@deepseek-ai/dsh-tool-testkit'
import { ToolStep } from '@deepseek-ai/dsh-tools/pipeline'

/** Tools an Agent's next step can call, directly or from programs. */
async function reachable(scaffold: WebScaffold, agent: Agent): Promise<string[]> {
  const toolStep = ToolStep.capture(scaffold.ctx.tools, agent)
  return stepToolNames(await scaffold.ctx.systemPrompt.assemble({ scope: agent, agent, toolStep }))
}

// This fixture exercises the macOS provider’s permission setup.
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
    await writeFile(patch, JSON.stringify([{ id: 'cua-macos', config: { helperPath: process.execPath } }]))
    // Explicit one-shot profiles retain their execution mode across bundle activation.
    const defaults = join(directory, 'ptc-defaults')
    await mkdir(defaults)
    await writeFile(join(defaults, 'package.json'), JSON.stringify({ name: 'cua-ptc-defaults', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    await writeFile(join(defaults, 'cordis.patch.yml'), script
      ? '- id: ptc-runtime\n  config:\n    executionMode: vm-script\n    scriptPersistence: false\n'
      : '- id: ptc-runtime\n  config:\n    executionMode: per-call\n')
    const harnessHome = join(directory, 'home')
    const scaffold = ownedScaffold = await launchWebScaffold({
      profile: { packages: [{ dir: defaults, enabled: true }] },
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
    // The installation ships the bundle off; the Experimental plugins list offers it without an installation step.
    const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-cua-bundle"]')
    await plugins.locator('[data-plugin-group="more"] [data-plugin-package="@deepseek-ai/dsh-cua-bundle"]').waitFor()
    const listed = (await scaffold.ctx.pluginManager.listBundles()).find(bundle => bundle.name === '@deepseek-ai/dsh-cua-bundle')
    expect(listed).toMatchObject({ availability: 'installation', optional: true, enabled: false, installed: false })
    expect(listed).not.toHaveProperty('listedByDefault')
    let toggle = card.getByRole('switch', { name: '启用 自动电脑操作', exact: true })
    const originalAgent = scaffold.ctx.agents.list()[0]!
    const ptcAgent = (await scaffold.ctx.agents.create({
      sessionId: brandString<SessionId>('cua-existing-ptc'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx, 'ptc') },
    })).agent
    expect((await reachable(scaffold, ptcAgent)).includes('cua')).toBe(false)
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
      await toggle.click()
      await card.getByRole('status').getByText('正在应用 自动电脑操作 的更改', { exact: true }).waitFor()
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/cua-permissions/enabling.expected.md', import.meta.url)),
        await captureStableAria(page, '[data-plugin-package="@deepseek-ai/dsh-cua-bundle"] [role="status"]', scaffold.workspaceCwd), webSnapshotMode())
    } finally {
      enabling.resolve(undefined)
      enableCall.mockRestore()
      await applying
    }
    // Bundle transitions await native cleanup under the browser action deadline.
    await toggle.and(page.locator('[aria-checked="true"]')).waitFor({ state: 'visible' })
    await card.getByRole('status').getByText('正在应用 自动电脑操作 的更改', { exact: true }).waitFor({ state: 'hidden' })
    const setup = page.getByRole('dialog', { name: '配置自动电脑操作', exact: true })
    await setup.waitFor()
    expect(await setup.getByText('“自动电脑操作”已开启，但暂时无法检查系统权限。请前往插件详情页查看详情并重试。', { exact: true }).count()).toBe(1)
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/cua-permissions/setup.expected.md', import.meta.url)),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(await setup.getByRole('group', { name: '新会话默认模式', exact: true }).count()).toBe(0)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(selected()).toContain('@deepseek-ai/dsh-cua-bundle')
    expect(profileManifest().dependencies).toEqual(dependencies)
    expect(await card.getByText('实验性', { exact: true }).count()).toBe(1)
    expect(await card.textContent()).not.toContain('将 PTC 模式改为可持久化')
    expect(await card.textContent()).not.toContain('请切换到 PTC 模式')
    expect(await card.textContent()).toContain('允许智能体直接操作电脑上的应用程序。')
    expect(await card.textContent()).not.toContain('helper')
    expect(await card.textContent()).not.toContain('Swift')
    const description = await card.getByRole('button', { name: '查看 自动电脑操作', exact: true }).evaluate((button) => {
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
    expect((await reachable(scaffold, originalAgent)).includes('cua')).toBe(false)
    expect((await reachable(scaffold, originalAgent)).includes('cua_run_code')).toBe(true)
    expect((await reachable(scaffold, ptcAgent)).includes('cua_run_code')).toBe(false)
    expect((await reachable(scaffold, ptcAgent)).includes('cua')).toBe(true)
    expect((await scaffold.ctx.systemPrompt.assemble({ scope: ptcAgent })).tools.map(tool => tool.name)).toEqual(['run_code'])
    for (const preset of ['ptc', 'standard', 'ptc', initialDefault]) {
      await scaffold.ctx.agentPresets.select(originalAgent, preset)
      expect((await reachable(scaffold, originalAgent)).includes('cua')).toBe(preset === 'ptc')
      expect((await reachable(scaffold, originalAgent)).includes('cua_run_code')).toBe(preset !== 'ptc')
    }
    const child = await scaffold.ctx.agents.create({
      sessionId: brandString<SessionId>('cua-child'),
      setup: (ctx) => { scaffold.ctx.agentPresets.composeFrom(ctx, ptcAgent.ctx) },
    })
    expect((await reachable(scaffold, child.agent)).includes('cua')).toBe(true)
    await child.dispose()
    expect(scaffold.ctx.tools.getAll(child.agent).some(tool => tool.name === 'cua')).toBe(false)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(runtimeFiber() === originalRuntimeFiber).toBe(true)
    expect(scaffold.ctx.ptcRuntime.programFormat).toBe(script ? 'script' : 'function-body')
    await setup.waitFor()
    expect(await setup.getByText('“自动电脑操作”已开启，但暂时无法检查系统权限。请前往插件详情页查看详情并重试。', { exact: true }).count()).toBe(1)
    await setup.getByRole('button', { name: '稍后', exact: true }).click()
    await setup.waitFor({ state: 'hidden' })
    const saved = await readFile(settingsPath, 'utf8')
    expect(saved).toBe(beforeEnable)
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: codingTools })
    expect(saved).not.toContain('executionMode:')
    if (selectedDefault === undefined) {
      expect(parseEntryYaml(saved)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'agent-preset-registry' })]))
    } else {
      expect(parseEntryYaml(saved)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'agent-preset-registry', config: { default: 'standard', selectedDefault } }),
      ]))
    }
    const freshDefault = (await scaffold.ctx.agents.create({
      sessionId: brandString<SessionId>('cua-new-default'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx) },
    })).agent
    expect(scaffold.ctx.agentPresets.composedPreset(freshDefault.ctx)).toBe(initialDefault)
    expect((await reachable(scaffold, freshDefault)).includes('cua')).toBe(false)
    expect((await reachable(scaffold, freshDefault)).includes('cua_run_code')).toBe(true)
    const fresh = (await scaffold.ctx.agents.create({
      sessionId: brandString<SessionId>('cua-new-ptc'),
      setup: async (ctx) => { await scaffold.ctx.agentPresets.mount(ctx, 'ptc') },
    })).agent
    expect(scaffold.ctx.agentPresets.composedPreset(fresh.ctx)).toBe('ptc')
    expect((await reachable(scaffold, fresh)).includes('cua')).toBe(true)
    await card.getByRole('button', { name: '查看 自动电脑操作', exact: true }).click()
    const detail = plugins.locator('[data-detail-document]')
    await detail.getByRole('img', { name: '在多窗口桌面中自动操作选定任务看板窗口的示意图' }).waitFor()
    const guidance = plugins.locator('[data-cua-guidance]')
    await guidance.getByText(/请谨慎在重要或生产环境中使用/).waitFor()
    expect(await guidance.textContent()).not.toContain('helperPath')
    expect(await detail.textContent()).not.toContain('PTC')
    toggle = page.locator('[data-plugin-panel]').getByRole('switch', { name: '启用 自动电脑操作', exact: true })
    const panel = page.locator('[data-cua-settings]')
    await expect.poll(() => panel.getAttribute('aria-busy')).toBe('false')
    for (const title of ['新会话默认模式', 'PTC 执行方式']) {
      expect(await panel.getByText(title, { exact: true }).count()).toBe(0)
    }
    if (!codingTools) {
      for (const width of [1680, 390]) {
        await page.setViewportSize({ width, height: 1000 })
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme })
          await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
          await expect.poll(() => panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
          if (webSnapshotMode() === 'refresh') {
            const directory = fileURLToPath(new URL('../../../.playwright-mcp/cua-run-code-ui', import.meta.url))
            await mkdir(directory, { recursive: true })
            await panel.screenshot({ path: join(directory, `details-zh-${width}-${colorScheme}.png`), animations: 'disabled' })
          }
        }
      }
      await page.emulateMedia({ colorScheme: null })
      await page.setViewportSize({ width: 1680, height: 1000 })
    }
    await toggle.click()
    await toggle.and(page.locator('[aria-checked="false"]')).waitFor({ state: 'visible' })
    expect(scaffold.ctx.get('computerUse')).toBeUndefined()
    expect(runtimeFiber() === originalRuntimeFiber).toBe(true)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    expect(scaffold.ctx.agents.get(ptcAgent.id) === ptcAgent).toBe(true)
    for (const agent of [originalAgent, freshDefault, ptcAgent, fresh]) {
      expect((await reachable(scaffold, agent)).includes('cua_run_code')).toBe(false)
    }
    for (const agent of [ptcAgent, fresh]) {
      expect((await reachable(scaffold, agent)).includes('cua')).toBe(false)
      expect((await scaffold.ctx.systemPrompt.assemble({ scope: agent })).tools.map(tool => tool.name)).toEqual(['run_code'])
    }
    expect(await readFile(settingsPath, 'utf8')).toBe(saved)
    await toggle.click()
    await toggle.and(page.locator('[aria-checked="true"]')).waitFor({ state: 'visible' })
    await setup.waitFor()
    expect(await setup.getByText('“自动电脑操作”已开启，但暂时无法检查系统权限。请前往插件详情页查看详情并重试。', { exact: true }).count()).toBe(1)
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
    await setup.getByRole('button', { name: '前往设置', exact: true }).click()
    await setup.waitFor({ state: 'hidden' })
    await page.getByRole('region', { name: '系统权限', exact: true }).getByRole('alert').waitFor()
    expect(await readFile(settingsPath, 'utf8')).toBe(saved)
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: codingTools })
    expect(scaffold.ctx.agentPresets.defaultId).toBe(initialDefault)
  } finally {
    try { await browser?.close() } finally {
      try { await ownedScaffold?.close() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
})
