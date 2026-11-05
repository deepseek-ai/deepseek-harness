// UI-only phone geometry for the Automation tasks page: no text field it owns
// sits under the 16px touch step, so the page never reads wider than the screen
// — iOS Safari zooms the visual viewport for a focused field below it.
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-schedule'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { revealNavigationDrawer } from './support.ts'

const PHONE_TASK_TITLE = 'Review overdue deployment'
const PHONE_PAGE_WIDTH = 390

/** The page's box against the screen, plus the font steps of its text fields. */
interface ViewFacts {
  width: number
  documentWidth: number
  smallestField: number
  name: string
  search: string
  instruction: string
}

/** Open the Automation tasks page and return its panel. */
async function openTaskManager(page: Page, url: string): Promise<Locator> {
  await page.goto(url, { waitUntil: 'load' })
  await revealNavigationDrawer(page, 'zh')
  await page.getByRole('button', { name: '自动化任务', exact: true }).click()
  const panel = page.getByTestId('task-manager-page')
  await panel.getByRole('heading', { name: '自动化任务', exact: true }).waitFor({ timeout: 30_000 })
  await page.evaluate(() => document.fonts.ready)
  return panel
}

/** Read the facts above from the open view. */
async function viewFacts(page: Page): Promise<ViewFacts> {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="task-manager-page"]')
    const fields = Array.from(panel?.querySelectorAll('input, textarea, select') ?? [])
    const steps = fields.map(element => Number.parseFloat(getComputedStyle(element).fontSize))
    const step = (selector: string): string => {
      const element = document.querySelector(selector)
      return element === null ? 'absent' : getComputedStyle(element).fontSize
    }
    return {
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      smallestField: steps.length === 0 ? -1 : Math.min(...steps),
      name: step('[class*="_editorField"] input'),
      search: step('[class*="_searchField"] input'),
      instruction: step('[class*="_instruction"]'),
    }
  })
}

/** Header, form, notices, and footer share the pane's visible content edges. */
async function expectEditorAlignment(title: Locator): Promise<void> {
  await expect.poll(() => title.evaluate((field) => {
    const pane = field.closest('aside')!
    const bounds = pane.getBoundingClientRect()
    const name = field.parentElement!.getBoundingClientRect()
    const action = pane.querySelector('footer:last-of-type > button:last-of-type')!.getBoundingClientRect()
    const content = Array.from(pane.querySelectorAll('h2, textarea, [class*="_ruleRows"], [class*="_saveNotice"], [class*="_detailNotice"], [class*="_saveFailure"]'))
      .filter(node => node.getClientRects().length > 0)
    const offsets = {
      gutters: Math.abs(name.left - bounds.left - bounds.right + name.right),
      action: Math.abs(action.right - name.right),
      left: Math.max(...content.map(node => Math.abs(node.getBoundingClientRect().left - name.left))),
      right: Math.max(...Array.from(pane.querySelectorAll('textarea, [class*="_ruleRows"]'))
        .map(node => Math.abs(node.getBoundingClientRect().right - name.right))),
    }
    return Object.fromEntries(Object.entries(offsets).filter(([, offset]) => offset > 1))
  })).toEqual({})
}

it('keeps the automation page on screen with its text fields at the touch step', async () => {
  const scaffold = await launchWebScaffold()
  const url = scaffold.authenticatedUrl
  try {
    await scaffold.ctx.schedule.create({
      prompt: 'Check the deployment log', title: PHONE_TASK_TITLE,
      timing: { kind: 'at', at: '2099-08-25T12:08:00.000Z' }, target: { kind: 'new_once' },
    })
    const browser: Browser = await chromium.launch()
    try {
      // A coarse pointer is the touch device, so the phone context takes the
      // 16px step.
      const phone = await browser.newContext({
        viewport: { width: PHONE_PAGE_WIDTH, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'zh-CN',
      })
      const phonePage = await phone.newPage()
      const phoneConsole = watchConsole(phonePage)
      const phonePanel = await openTaskManager(phonePage, url)
      await expect.poll(() => viewFacts(phonePage)).toEqual({
        width: PHONE_PAGE_WIDTH,
        documentWidth: PHONE_PAGE_WIDTH,
        smallestField: 16,
        name: 'absent',
        search: '16px',
        instruction: 'absent',
      })
      // The editor keeps the touch floor for its name and instruction fields.
      await phonePanel.getByRole('button', { name: PHONE_TASK_TITLE, exact: true }).click()
      await phonePanel.locator('[class*="_detailScroll"]').waitFor({ timeout: 10_000 })
      await expect.poll(() => viewFacts(phonePage)).toEqual({
        width: PHONE_PAGE_WIDTH,
        documentWidth: PHONE_PAGE_WIDTH,
        smallestField: 16,
        name: '16px',
        search: '16px',
        instruction: '16px',
      })
      const detail = phonePanel.getByRole('complementary', { name: '任务详情', exact: true })
      await expectEditorAlignment(detail.getByRole('textbox', { name: '自动化任务名称', exact: true }))
      await detail.getByRole('textbox', { name: '自动化任务名称', exact: true }).fill('未保存的手机草稿')
      const task = (await scaffold.ctx.schedule.catalog()).find(item => item.title === PHONE_TASK_TITLE)
      if (task === undefined) throw new Error('phone task was not retained')
      await scaffold.ctx.schedule.edit({ id: task.id, action: 'update', expectedUpdatedAt: task.updatedAt ?? null,
        patch: { prompt: '其他窗口的最新内容' } })
      const recovery = detail.getByRole('button', { name: '保留修改并复核', exact: true })
      await recovery.waitFor()
      await recovery.scrollIntoViewIfNeeded()
      const recoveryBox = await recovery.boundingBox()
      expect(recoveryBox).not.toBeNull()
      expect(recoveryBox!.x).toBeGreaterThanOrEqual(0)
      expect(recoveryBox!.x + recoveryBox!.width).toBeLessThanOrEqual(PHONE_PAGE_WIDTH)
      expect(recoveryBox!.y).toBeGreaterThanOrEqual(0)
      expect(recoveryBox!.y + recoveryBox!.height).toBeLessThanOrEqual(844)
      const [noticeBox, messageBox, nameBox] = await Promise.all([
        detail.getByRole('alert').locator('..').boundingBox(), detail.getByRole('alert').boundingBox(),
        detail.getByRole('textbox', { name: '自动化任务名称', exact: true }).locator('..').boundingBox(),
      ])
      expect(noticeBox).not.toBeNull()
      expect(messageBox).not.toBeNull()
      expect(nameBox).not.toBeNull()
      expect(Math.abs(noticeBox!.x - nameBox!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(noticeBox!.x + noticeBox!.width - nameBox!.x - nameBox!.width)).toBeLessThanOrEqual(1)
      expect(recoveryBox!.y).toBeGreaterThanOrEqual(messageBox!.y + messageBox!.height)
      expect(recoveryBox!.x + recoveryBox!.width).toBeLessThanOrEqual(noticeBox!.x + noticeBox!.width)
      expect(await detail.getByRole('button', { name: '保存修改', exact: true }).isDisabled()).toBe(true)
      await recovery.click()
      expect(await detail.getByRole('textbox', { name: '自动化任务名称', exact: true }).inputValue()).toBe('未保存的手机草稿')
      expect(await detail.getByRole('textbox', { name: '自动化任务内容', exact: true }).inputValue()).toBe('其他窗口的最新内容')
      expect((await viewFacts(phonePage)).documentWidth).toBe(PHONE_PAGE_WIDTH)
      expect(await scaffold.ctx.schedule.view({ id: task.id })).toMatchObject({ title: PHONE_TASK_TITLE })
      await detail.getByRole('button', { name: '放弃', exact: true }).click()
      await phonePanel.getByRole('button', { name: '关闭详情', exact: true }).click()
      await phonePanel.getByRole('button', { name: '选择创建方式', exact: true }).click()
      await phonePage.getByRole('menuitem', { name: '手动创建', exact: true }).click()
      const creation = phonePanel.getByRole('complementary', { name: '手动创建', exact: true })
      await creation.waitFor()
      await expectEditorAlignment(creation.getByRole('textbox', { name: '自动化任务名称', exact: true }))
      await expect.poll(() => viewFacts(phonePage)).toEqual({
        width: PHONE_PAGE_WIDTH,
        documentWidth: PHONE_PAGE_WIDTH,
        smallestField: 16,
        name: '16px',
        search: '16px',
        instruction: '16px',
      })
      for (const name of ['放弃', '创建']) {
        const button = creation.getByRole('button', { name, exact: true })
        await button.scrollIntoViewIfNeeded()
        const box = await button.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(0)
        expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE_PAGE_WIDTH)
        expect(box!.y).toBeGreaterThanOrEqual(0)
        expect(box!.y + box!.height).toBeLessThanOrEqual(844)
      }
      await creation.getByRole('button', { name: '放弃', exact: true }).click()
      expect(await phonePanel.getByRole('complementary').count()).toBe(0)
      await phone.close()

      // A fine pointer keeps the compact steps: the floor is pointer-scoped.
      const desktop = await browser.newContext({ viewport: { width: 1024, height: 800 }, locale: 'zh-CN' })
      const desktopPage = await desktop.newPage()
      const desktopConsole = watchConsole(desktopPage)
      const desktopPanel = await openTaskManager(desktopPage, url)
      await expect.poll(() => viewFacts(desktopPage)).toEqual({
        width: 1024,
        documentWidth: 1024,
        smallestField: 14,
        name: 'absent',
        search: '14px',
        instruction: 'absent',
      })
      await desktopPanel.getByRole('button', { name: PHONE_TASK_TITLE, exact: true }).click()
      await desktopPanel.locator('[class*="_detailScroll"]').waitFor({ timeout: 10_000 })
      await expect.poll(() => viewFacts(desktopPage)).toEqual({
        width: 1024,
        documentWidth: 1024,
        smallestField: 14,
        name: '14px',
        search: '14px',
        instruction: '14px',
      })
      await desktop.close()

      expect(phoneConsole.pageErrors).toEqual([])
      expect(phoneConsole.warnings).toEqual([])
      expect(desktopConsole.pageErrors).toEqual([])
      expect(desktopConsole.warnings).toEqual([])
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
}, 180_000)

it.each([
  { locale: 'en-US', tasks: 'Automation tasks', sidebar: 'Collapse sidebar', openSidebar: 'Open sidebar', close: 'Close details',
    methods: 'Choose a creation method', manual: 'Create manually', title: 'Automation task name', discard: 'Discard',
    instruction: 'Automation task instruction', create: 'Create',
    repeat: /^Repeat /, frequencies: ['Every month', 'Weekly', 'Once'] },
  { locale: 'zh-CN', tasks: '自动化任务', sidebar: '收起侧边栏', openSidebar: '打开侧边栏', close: '关闭详情',
    methods: '选择创建方式', manual: '手动创建', title: '自动化任务名称', discard: '放弃',
    instruction: '自动化任务内容', create: '创建',
    repeat: /^重复 /, frequencies: ['每月', '每周', '仅一次'] },
  { locale: 'fr-FR', tasks: "Tâches d'automatisation", sidebar: 'Réduire la barre latérale', openSidebar: 'Ouvrir la barre latérale', close: 'Fermer les détails',
    methods: 'Choisir le mode de création', manual: 'Créer manuellement', title: "Nom de la tâche d'automatisation", discard: 'Abandonner',
    instruction: "Instruction de tâche d'automatisation", create: 'Créer',
    repeat: /^Répéter /, frequencies: ['Tous les mois', 'Hebdomadaire', 'Une fois'] },
] as const)('keeps both editor modes inside a narrow pane with the sidebar open ($locale)', async (copy) => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    await scaffold.ctx.schedule.create({
      title: PHONE_TASK_TITLE, prompt: 'Check the deployment log',
      timing: { kind: 'at', at: '2099-08-25T12:08:00.000Z' }, target: { kind: 'new_once' },
    })
    const context = await browser.newContext({ viewport: { width: 1100, height: 844 }, locale: copy.locale, timezoneId: 'Asia/Shanghai' })
    const page = await context.newPage()
    const consoleWatch = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: copy.sidebar, exact: true }).waitFor()
    await page.getByRole('button', { name: copy.tasks, exact: true }).click()
    const panel = page.getByTestId('task-manager-page')
    await panel.getByRole('button', { name: PHONE_TASK_TITLE, exact: true }).click()
    await page.evaluate(() => document.fonts.ready)
    for (const mode of ['edit', 'create']) {
      if (mode === 'create') {
        await panel.getByRole('button', { name: copy.close, exact: true }).click()
        await panel.getByRole('button', { name: copy.methods, exact: true }).click()
        await page.getByRole('menuitem', { name: copy.manual, exact: true }).click()
      }
      const editor = panel.getByRole('complementary')
      const title = editor.getByRole('textbox', { name: copy.title, exact: true })
      if (mode === 'create') {
        for (const name of [copy.title, copy.instruction]) {
          const field = editor.getByRole('textbox', { name, exact: true })
          expect(await field.getAttribute('required')).toBeNull()
          expect(await field.getAttribute('aria-required')).toBe('true')
          expect(await field.evaluate(node => (node as HTMLInputElement | HTMLTextAreaElement).validationMessage)).toBe('')
        }
        expect(await editor.getByRole('button', { name: copy.create, exact: true }).isDisabled()).toBe(true)
      }
      await title.fill('Retained draft through resizing')
      await editor.getByRole('button', { name: copy.discard, exact: true }).waitFor()
      for (const width of [1280, 1100, 1024, 900, 800]) {
        await title.focus()
        await page.setViewportSize({ width, height: 844 })
        expect(await title.evaluate(node => document.activeElement === node)).toBe(true)
        // Entering the shell's narrow range publishes the reopen action after its resize observer runs.
        if (width === 900) { await page.getByRole('button', { name: copy.openSidebar, exact: true }).click(); await title.focus() }
        await page.getByRole('button', { name: copy.sidebar, exact: true }).waitFor()
        expect(await panel.getByRole('button', { name: PHONE_TASK_TITLE, exact: true }).isVisible()).toBe(true)
        for (const frequency of copy.frequencies) {
          await editor.getByRole('button', { name: copy.repeat }).click()
          await page.getByRole('menuitem', { name: frequency, exact: true }).click()
          await expectEditorAlignment(title)
          await expect.poll(() => editor.locator('[class*="_detailScroll"]').evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0)
          expect(await editor.locator('input, textarea, button').evaluateAll(nodes => nodes.every((node) => {
            const box = node.getBoundingClientRect()
            const pane = node.closest('aside')!.getBoundingClientRect()
            return box.left >= pane.left && box.right <= pane.right
          }))).toBe(true)
        }
        expect(await title.inputValue()).toBe('Retained draft through resizing')
      }
      await page.setViewportSize({ width: 1100, height: 844 })
    }
    expect(consoleWatch.pageErrors).toEqual([])
    expect(consoleWatch.warnings).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 180_000)
