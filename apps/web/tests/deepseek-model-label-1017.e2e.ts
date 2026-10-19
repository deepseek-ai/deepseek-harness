/** The shipped browser plugin decorates both DeepSeek routes without changing catalog identity. */
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const NAME = 'DeepSeek-V4.1-Flash'
const FIXTURE = fileURLToPath(new URL('./fixtures/deepseek-model-label-1017/session.v4.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/deepseek-model-label-1017/models.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: temporary DeepSeek release badge', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('./fixtures/deepseek-model-label-1017/account.overlay.yml', import.meta.url)),
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      replayProviders: [
        { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: NAME }] },
        { id: 'deepseek-official', name: 'DeepSeek', models: [
          { id: 'deepseek-flash', name: NAME }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
        ] },
        { id: 'external', name: 'External', models: [{ id: 'deepseek-flash', name: NAME }] },
      ],
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  })

  it('shows the same badge in all placements while preserving the chosen provider and model id', async () => {
    const trigger = page.getByRole('button', { name: /^选择模型/ })
    await trigger.getByText('1017', { exact: true }).waitFor()
    expect(await trigger.textContent()).toContain(`${NAME} 1017`)
    expect(await trigger.getAttribute('aria-label')).toBe(`选择模型，当前 ${NAME}`)
    try {
      await trigger.click()
      const current = page.getByRole('menuitem', { name: /^模型/ })
      expect(await current.getByText('1017', { exact: true }).count()).toBe(1)
      await current.click()
      const menu = page.getByRole('menu', { name: '模型', exact: true })
      await compareOrRefreshGolden(EXPECTED, await captureStableAria(page, '[role="menu"][aria-label="模型"]', scaffold.workspaceCwd), MODE)
      expect(await menu.getByText('1017', { exact: true }).count()).toBe(2)
      expect(await menu.getByRole('group', { name: 'External', exact: true }).getByText('1017', { exact: true }).count()).toBe(0)
      const account = menu.getByRole('group', { name: 'DeepSeek 账号', exact: true })
      await account.getByRole('menuitemradio', { name: `${NAME} 1017`, exact: true }).click()
      await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-account', model: 'deepseek-flash' })
      await expect.poll(() => trigger.textContent()).toContain(`${NAME} 1017`)
      const catalog = await scaffold.ctx.llm.listModels('deepseek-account')
      expect(catalog.map(model => ({ id: model.id, name: model.name }))).toEqual([{ id: 'deepseek-flash', name: NAME }])
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    }
  })

  it('keeps the release badge inside a 390px model menu and uses both theme palettes', async () => {
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      const trigger = page.getByRole('button', { name: /^选择模型/ })
      await trigger.click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      const menu = page.getByRole('menu', { name: '模型', exact: true })
      const badge = menu.getByRole('group', { name: 'DeepSeek 账号', exact: true }).getByText('1017', { exact: true })
      const box = await badge.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(12)
      expect(box!.x + box!.width).toBeLessThanOrEqual(378)
      const colors = await badge.evaluate((node) => {
        const body = node.ownerDocument.body
        const previous = body.getAttribute('data-ds-dark-theme')
        try {
          return [false, true].map((dark) => {
            body.toggleAttribute('data-ds-dark-theme', dark)
            const style = getComputedStyle(node)
            return { color: style.color, background: style.backgroundColor }
          })
        } finally {
          if (previous === null) body.removeAttribute('data-ds-dark-theme')
          else body.setAttribute('data-ds-dark-theme', previous)
        }
      })
      expect(colors[0]).not.toEqual(colors[1])
      for (const color of colors) expect(color.color).not.toBe(color.background)
    } finally {
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    expect(tripwire.pageErrors).toEqual([])
  })
})
