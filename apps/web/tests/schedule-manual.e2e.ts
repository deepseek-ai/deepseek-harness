/** Schedule creation, prompt prefill, and editing through the shipped Web composition. */
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type { ScheduleTiming } from '@deepseek-ai/dsh-schedule/client'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

it.each([
  { locale: 'en', panel: 'Automation tasks', create: 'New', menu: 'Choose a creation method', chat: 'Create in a session',
    prompt: 'Please create an automation task based on the requirements.' },
  { locale: 'zh', panel: '自动化任务', create: '新建', menu: '选择创建方式', chat: '在会话中创建',
    prompt: '请根据需求创建一个自动化任务。' },
])('prefills an unsent Schedule creation draft in $locale through both conversation entries', async (copy) => {
  const scaffold = await launchWebScaffold({ firstUse: true })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: copy.locale })
    await page.addInitScript((locale) => { localStorage.setItem('dsh.locale', locale) }, copy.locale)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    for (const { entry, draft } of [
      { entry: 'primary', draft: '' },
      { entry: 'primary', draft: 'Existing unsent draft' },
      { entry: 'menu', draft: '' },
      { entry: 'menu', draft: 'Existing unsent draft' },
    ]) {
      await writeComposerDraft(page, input, draft)
      await page.getByRole('button', { name: copy.panel, exact: true }).click()
      const manager = page.getByTestId('task-manager-page')
      if (entry === 'primary') await manager.getByRole('button', { name: copy.create, exact: true }).click()
      else {
        await manager.getByRole('button', { name: copy.menu, exact: true }).click()
        await page.getByRole('menuitem', { name: copy.chat, exact: true }).click()
      }
      await manager.waitFor({ state: 'detached' })
      await input.getByText(copy.prompt, { exact: true }).waitFor()
      expect(await input.evaluate(element => [...element.children].map(paragraph => paragraph.textContent).join('\n')))
        .toBe(draft === '' ? copy.prompt : `${draft}\n${copy.prompt}`)
      const events = scaffold.ctx.agents.list().flatMap(agent => agent.session.snapshotEvents())
      expect(events.filter(event => event.type === 'user/message' || event.type === 'turn/start')).toEqual([])
      expect(await scaffold.ctx.schedule.catalog()).toEqual([])
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})

it('opens stored timing fields immediately without selecting another repeat option', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const clock = new Date(Date.now() + 4 * 60 * 60_000).toISOString().slice(11, 16)
    const choices = [
      { timing: { kind: 'after', after_seconds: 3600 }, repeat: '仅一次', field: '日期' },
      { timing: { kind: 'at', at: '2099-01-05T09:00:00.000Z' }, repeat: '仅一次', field: '日期' },
      { timing: { kind: 'every', every_seconds: 300 }, repeat: '每 N 分钟', field: '重复间隔' },
      { timing: { kind: 'daily', daily: { time: `${clock}:00`, time_zone: 'UTC' } }, repeat: '每天', field: '时间' },
      { timing: { kind: 'weekly', weekly: { time: `${clock}:45`, time_zone: 'UTC', weekdays: [1, 5] } },
        repeat: '每周', field: '星期' },
    ] satisfies { timing: ScheduleTiming; repeat: string; field: string }[]
    const tasks = []
    for (const [index, choice] of choices.entries()) {
      const task = await scaffold.ctx.schedule.create({ title: `Stored task ${index}`, prompt: 'Review the project', timing: choice.timing })
      await scaffold.ctx.schedule.edit({ id: task.id, action: 'update', patch: { active: false } })
      tasks.push({ ...choice, task })
    }
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'zh') })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '自动化任务', exact: true }).click()
    const manager = page.getByTestId('task-manager-page')
    await manager.getByRole('button', { name: '全部', exact: true }).click()
    for (const { task, repeat, field } of tasks) {
      await manager.getByRole('button', { name: task.title, exact: true }).click()
      const detail = manager.getByRole('complementary', { name: '任务详情', exact: true })
      expect(await detail.getByRole('button', { name: `重复 ${repeat}`, exact: true }).isVisible()).toBe(true)
      const role = field === '星期' ? 'group' : field === '重复间隔' ? 'spinbutton' : 'button'
      expect(await detail.getByRole(role, { name: field, exact: true }).isVisible()).toBe(true)
      expect(await detail.getByRole('button', { name: '保存修改', exact: true }).isDisabled()).toBe(true)
      expect(await scaffold.ctx.schedule.view({ id: task.id })).toMatchObject({ kind: task.kind, scheduledAt: task.scheduledAt })
      if (field === '日期') {
        await detail.getByRole('button', { name: '日期', exact: true }).click()
        await page.getByRole('dialog', { name: '日期', exact: true }).waitFor()
        await page.keyboard.press('Escape')
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})

it.each(['2026-03-07T16:00:00.000Z', '2026-03-08T16:00:00.000Z'])(
  'saves a stored weekly task on %s without a false timing error', async (now) => {
    const scaffold = await launchWebScaffold({ firstUse: true })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      const task = await scaffold.ctx.schedule.create({ title: 'Weekly review', prompt: 'Review the project',
        timing: { kind: 'weekly', weekly: { time: '02:30:00', time_zone: 'America/New_York', weekdays: [5] } } })
      await scaffold.ctx.schedule.edit({ id: task.id, action: 'update', patch: { active: false } })
      browser = await chromium.launch()
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'America/New_York' })
      await page.addInitScript((now) => {
        localStorage.setItem('dsh.locale', 'zh')
        Date.now = () => Date.parse(now)
      }, now)
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: '自动化任务', exact: true }).click()
      const manager = page.getByTestId('task-manager-page')
      await manager.getByRole('button', { name: '全部', exact: true }).click()
      await manager.getByRole('button', { name: task.title, exact: true }).click()
      const detail = manager.getByRole('complementary', { name: '任务详情', exact: true })
      await detail.getByRole('group', { name: '星期', exact: true }).getByRole('button').nth(0).click()
      expect(await detail.getByRole('status').count()).toBe(0)
      const save = detail.getByRole('button', { name: '保存修改', exact: true })
      expect(await save.isEnabled()).toBe(true)
      await save.click()
      await expect.poll(async () => {
        const record = await scaffold.ctx.schedule.view({ id: task.id })
        return 'code' in record ? undefined : record.kind
      }).toBe('rrule')
      const updated = await scaffold.ctx.schedule.view({ id: task.id })
      expect(updated).toMatchObject({ kind: 'rrule', status: 'paused', target: task.target })
      if ('code' in updated || updated.kind !== 'rrule') throw new Error('expected an edited weekly rule')
      expect(updated.rrule).toContain('BYDAY=MO,FR')

      await page.reload({ waitUntil: 'load' })
      await page.getByRole('button', { name: '自动化任务', exact: true }).click()
      await manager.getByRole('button', { name: '全部', exact: true }).click()
      await manager.getByRole('button', { name: task.title, exact: true }).click()
      await detail.getByRole('button', { name: '重复 每周', exact: true }).waitFor()
      expect(await detail.getByRole('group', { name: '星期', exact: true }).getByRole('button')
        .evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-pressed'))))
        .toEqual(['true', 'false', 'false', 'false', 'true', 'false', 'false'])
      expect(await detail.getByRole('status').count()).toBe(0)
      expect(await save.isDisabled()).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      try { await browser?.close() } finally { await scaffold.close() }
    }
  },
)

it('creates from a paused empty state, selects the task, and saves an inline edit without starting an Agent', async () => {
  // First use registers the default Workspace, which a new task's directory starts with.
  const scaffold = await launchWebScaffold({ firstUse: true })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'zh') })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '自动化任务', exact: true }).click()
    const manager = page.getByTestId('task-manager-page')
    const createStyles = await manager.getByRole('group', { name: '创建', exact: true }).getByRole('button').evaluateAll(buttons => buttons.map((button) => {
      const style = getComputedStyle(button)
      return { height: style.height, topLeft: style.borderTopLeftRadius, bottomLeft: style.borderBottomLeftRadius,
        topRight: style.borderTopRightRadius, bottomRight: style.borderBottomRightRadius }
    }))
    expect(createStyles).toEqual([
      { height: '32px', topLeft: '16px', bottomLeft: '16px', topRight: '0px', bottomRight: '0px' },
      { height: '32px', topLeft: '0px', bottomLeft: '0px', topRight: '16px', bottomRight: '16px' },
    ])
    await manager.getByRole('button', { name: '已暂停', exact: true }).click()
    await manager.getByRole('heading', { name: '没有已暂停的自动化任务', exact: true }).waitFor()
    await manager.getByRole('button', { name: '选择创建方式', exact: true }).click()
    await page.getByRole('menuitem', { name: '手动创建', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await manager.getByRole('button', { name: '新建自动化任务', exact: true }).click()
    const dialog = manager.getByRole('complementary', { name: '手动创建', exact: true })
    await dialog.getByRole('textbox', { name: '自动化任务名称', exact: true }).fill('AI 新闻简报')
    expect(await dialog.getByRole('status').count()).toBe(0)
    expect(await dialog.getByRole('textbox', { name: '自动化任务名称', exact: true }).getAttribute('aria-required')).toBe('true')
    await dialog.getByRole('textbox', { name: '自动化任务内容', exact: true }).fill('整理过去 24 小时的 AI 新闻，附原文链接。')
    await dialog.getByRole('button', { name: /^重复 / }).click()
    await page.getByRole('menuitem', { name: '周一至周五', exact: true }).click()
    await dialog.getByRole('button', { name: '时间', exact: true }).click()
    await page.getByRole('listbox', { name: '时', exact: true }).getByRole('option', { name: '09', exact: true }).click()
    await page.getByRole('listbox', { name: '分', exact: true }).getByRole('option', { name: '00', exact: true }).click()
    await page.getByRole('listbox', { name: '秒', exact: true }).getByRole('option', { name: '00', exact: true }).click()
    await page.keyboard.press('Escape')
    await dialog.getByRole('button', { name: /^执行位置 / }).click()
    await page.getByRole('menuitem', { name: '新建会话并复用 首次运行时创建，之后沿用这个会话', exact: true }).waitFor()
    expect(await page.getByRole('menuitem').count()).toBe(2)
    const workspace = dialog.getByRole('button', { name: /^关联工作区 / })
    await expect.poll(() => workspace.textContent()).toContain('默认工作区')
    await page.keyboard.press('Escape')
    // The workspace menu states each directory, so the default workspace names its folder.
    const defaultPath = scaffold.ctx.workspaceRegistry.list()[0]?.path
    if (defaultPath === undefined) throw new Error('first use did not register the default workspace')
    await workspace.click()
    await page.getByRole('menuitem').getByTitle(defaultPath, { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    expect(await dialog.count()).toBe(1)
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    const detail = manager.getByRole('complementary', { name: '任务详情', exact: true })
    await detail.getByRole('heading', { name: 'AI 新闻简报', exact: true }).waitFor()
    expect(await manager.getByRole('button', { name: '全部', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await manager.getByRole('list', { name: '任务列表', exact: true }).getByRole('button', { name: 'AI 新闻简报', exact: true }).count()).toBe(1)
    await detail.getByText('待创建', { exact: true }).waitFor()
    const task = (await scaffold.ctx.schedule.catalog()).find(task => task.title === 'AI 新闻简报')
    if (task === undefined || task.target.kind !== 'new_once') throw new Error('manual task was not created with the reusable target')
    expect(task.target.create.cwd).toBe(defaultPath)
    expect(await detail.getByRole('button', { name: '保存修改', exact: true }).isDisabled()).toBe(true)
    await detail.getByRole('textbox', { name: '自动化任务内容', exact: true }).fill('整理过去 24 小时的 AI 新闻，附原文链接，按重要性排序。')
    expect(await detail.getByRole('button', { name: '暂停任务', exact: true }).isDisabled()).toBe(true)
    await manager.getByRole('button', { name: '关闭详情', exact: true }).click()
    await manager.getByRole('list', { name: '任务列表', exact: true }).getByRole('button', { name: task.title, exact: true }).click()
    expect(await detail.getByRole('textbox', { name: '自动化任务内容', exact: true }).inputValue())
      .toBe('整理过去 24 小时的 AI 新闻，附原文链接，按重要性排序。')
    await detail.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect.poll(() => detail.getByRole('button', { name: '保存修改', exact: true }).isDisabled()).toBe(true)
    expect(await detail.getByRole('textbox', { name: '自动化任务内容', exact: true }).inputValue())
      .toBe('整理过去 24 小时的 AI 新闻，附原文链接，按重要性排序。')
    const saved = await scaffold.ctx.schedule.view({ id: task.id })
    if ('code' in saved) throw new Error('edited task was not retained')
    expect(saved.prompt).toBe('整理过去 24 小时的 AI 新闻，附原文链接，按重要性排序。')
    await detail.getByRole('textbox', { name: '自动化任务名称', exact: true }).fill('本地简报草稿')
    const remote = await scaffold.ctx.schedule.edit({ id: task.id, action: 'update',
      expectedUpdatedAt: saved.updatedAt ?? null, patch: { prompt: '来自其他窗口的新指令' } })
    expect(remote).toMatchObject({ prompt: '来自其他窗口的新指令' })
    const recovery = detail.getByRole('button', { name: '保留修改并复核', exact: true })
    await recovery.waitFor()
    const notice = detail.getByRole('alert').locator('..')
    const palettes = []
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark)
      const [box, field, message, action] = await Promise.all([
        notice.boundingBox(), detail.getByRole('textbox', { name: '自动化任务名称', exact: true }).locator('..').boundingBox(),
        detail.getByRole('alert').boundingBox(), recovery.boundingBox(),
      ])
      expect(box).not.toBeNull()
      expect(field).not.toBeNull()
      expect(message).not.toBeNull()
      expect(action).not.toBeNull()
      expect(Math.abs(box!.x - field!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(box!.x + box!.width - field!.x - field!.width)).toBeLessThanOrEqual(1)
      expect(action!.y).toBeLessThan(message!.y + message!.height)
      expect(action!.y + action!.height).toBeGreaterThan(message!.y)
      expect(box!.y + box!.height).toBeLessThan(field!.y)
      palettes.push(await notice.evaluate((element) => {
        const style = getComputedStyle(element)
        return { color: style.color, background: style.backgroundColor }
      }))
    }
    expect(palettes[0]).not.toEqual(palettes[1])
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    expect(await detail.getByRole('button', { name: '保存修改', exact: true }).isDisabled()).toBe(true)
    expect(await detail.getByRole('textbox', { name: '自动化任务内容', exact: true }).inputValue()).toBe(saved.prompt)
    await detail.getByRole('button', { name: '保留修改并复核', exact: true }).click()
    expect(await detail.getByRole('textbox', { name: '自动化任务名称', exact: true }).inputValue()).toBe('本地简报草稿')
    expect(await detail.getByRole('textbox', { name: '自动化任务内容', exact: true }).inputValue()).toBe('来自其他窗口的新指令')
    expect(await scaffold.ctx.schedule.view({ id: task.id })).toMatchObject({ title: task.title })
    await detail.getByRole('button', { name: '保存修改', exact: true }).click()
    await detail.getByRole('heading', { name: '本地简报草稿', exact: true }).waitFor()
    expect(await scaffold.ctx.schedule.view({ id: task.id })).toMatchObject({ title: '本地简报草稿', prompt: '来自其他窗口的新指令' })
    expect(await detail.evaluate(element => element === document.activeElement)).toBe(true)
    await manager.getByRole('button', { name: '选择创建方式', exact: true }).click()
    await page.getByRole('menuitem', { name: '手动创建', exact: true }).click()
    await dialog.getByRole('textbox', { name: '自动化任务名称', exact: true }).fill('检查最新进展')
    await dialog.getByRole('textbox', { name: '自动化任务内容', exact: true }).fill('汇总最近的更新')
    await dialog.getByRole('button', { name: /^重复 / }).click()
    await page.getByRole('menuitem', { name: '每 N 分钟', exact: true }).click()
    await dialog.getByRole('spinbutton', { name: '重复间隔', exact: true }).fill('5')
    await dialog.getByRole('button', { name: /^执行位置 / }).click()
    await page.getByRole('menuitem', { name: '每次新建会话 每次运行都创建独立会话', exact: true }).click()
    await dialog.getByText('运行间隔至少 1分钟', { exact: true }).waitFor()
    const beforeCreate = Date.now()
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    await detail.getByRole('heading', { name: '检查最新进展', exact: true }).waitFor()
    const afterCreate = Date.now()
    const intervalTask = (await scaffold.ctx.schedule.catalog()).find(item => item.title === '检查最新进展')
    if (intervalTask === undefined) throw new Error('interval task was not created')
    expect(intervalTask.target.kind).toBe('new')
    expect(Date.parse(intervalTask.scheduledAt) - beforeCreate).toBeGreaterThan(240_000)
    expect(Date.parse(intervalTask.scheduledAt) - afterCreate).toBeLessThanOrEqual(300_000)
    await detail.getByRole('button', { name: '暂停任务', exact: true }).click()
    await detail.getByRole('button', { name: '恢复任务', exact: true }).waitFor()
    expect(await detail.getByText('待创建', { exact: true }).count()).toBe(0)
    expect(await detail.getByText('最近运行会话', { exact: true }).count()).toBe(0)
    expect(await detail.getByText('运行间隔至少', { exact: false }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(scaffold.ctx.agents.get(task.target.sessionId)).toBeUndefined()
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})

it('creates and edits Custom Cron through the built UI while retaining its explicit zone and record kind', async () => {
  const scaffold = await launchWebScaffold({ firstUse: true })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    await page.addInitScript(() => { localStorage.setItem('dsh.locale', 'zh') })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '自动化任务', exact: true }).click()
    const manager = page.getByTestId('task-manager-page')
    await manager.getByRole('button', { name: '选择创建方式', exact: true }).click()
    await page.getByRole('menuitem', { name: '手动创建', exact: true }).click()
    const dialog = manager.getByRole('complementary', { name: '手动创建', exact: true })
    await dialog.getByRole('textbox', { name: '自动化任务名称', exact: true }).fill('Cron deployment check')
    await dialog.getByRole('textbox', { name: '自动化任务内容', exact: true }).fill('Check the deployment status.')
    await dialog.getByRole('button', { name: /^重复 / }).click()
    await page.getByRole('menuitem', { name: '自定义', exact: true }).click()
    await dialog.getByRole('textbox', { name: '自定义', exact: true }).fill('0 9 * * 1-5')
    await dialog.getByRole('button', { name: /^时区 / }).waitFor()
    await dialog.getByRole('button', { name: '创建', exact: true }).click()
    const detail = manager.getByRole('complementary', { name: '任务详情', exact: true })
    await detail.getByRole('heading', { name: 'Cron deployment check', exact: true }).waitFor()
    const created = (await scaffold.ctx.schedule.catalog()).find(task => task.title === 'Cron deployment check')
    if (created === undefined) throw new Error('Custom Cron creation did not store a task')
    expect(created).toMatchObject({ kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Asia/Shanghai' })
    expect(created).not.toHaveProperty('rrule')

    await detail.getByRole('textbox', { name: '自定义', exact: true }).fill(' ')
    expect(await detail.getByRole('button', { name: '保存修改', exact: true }).isDisabled()).toBe(true)
    await detail.getByRole('status').getByText('请修改自定义规则、选择其他重复方式，或让智能体协助修改', { exact: true }).waitFor()
    expect(await scaffold.ctx.schedule.view({ id: created.id })).toEqual(created)
    await detail.getByRole('textbox', { name: '自定义', exact: true }).fill('0 10 * * 1-5')
    await detail.getByRole('button', { name: /^时区 / }).waitFor()
    await detail.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect.poll(() => detail.getByRole('button', { name: '保存修改', exact: true }).isDisabled()).toBe(true)
    const edited = await scaffold.ctx.schedule.view({ id: created.id })
    expect(edited).toMatchObject({ id: created.id, kind: 'cron', expression: '0 10 * * 1-5', timeZone: 'Asia/Shanghai' })
    expect(edited).not.toHaveProperty('rrule')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
})
