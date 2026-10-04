/** Shared Inspector iframe through the optional Inspector and the shipped Web composition. */
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const bundle = fileURLToPath(new URL('../../../packages/experimental/inspector-profile', import.meta.url))
const fixture = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url))
const shots = fileURLToPath(new URL('../../../.artifacts/screenshots/shared-inspector', import.meta.url))

it('toggles bottom DevTools from the page and iframe without a selected Session', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }], hmr: false },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./fixtures/shared-inspector.patch.yml', import.meta.url)),
    ],
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const panel = page.locator('[data-inspector-panel]')
      const iframe = page.locator('iframe[data-inspector-devtools]')
      const frontend = page.frameLocator('iframe[data-inspector-devtools]')
      await panel.waitFor({ state: 'attached' })
      expect(await panel.isVisible()).toBe(false)
      expect(await iframe.count()).toBe(0)
      const main = page.locator('[data-slot="main"]').locator('..')
      const fullHeight = (await main.boundingBox())!.height
      await page.keyboard.press('ControlOrMeta+Shift+Period')
      await frontend.getByRole('tab', { name: 'Console', exact: true }).waitFor()
      const panelHeight = (await panel.boundingBox())!.height
      expect((await main.boundingBox())!.height).toBe(fullHeight - panelHeight)
      const original = await iframe.evaluateHandle(node => (node as HTMLIFrameElement).contentDocument)
      const titleSize = await panel.locator('header > span').evaluate(node => getComputedStyle(node).fontSize)
      expect(titleSize).toBe('12px')
      const close = panel.getByRole('button', { name: 'Collapse', exact: true })
      expect(await close.textContent()).toBe('')
      expect(await close.locator('svg').count()).toBe(1)
      const divider = panel.getByRole('separator', { name: 'Resize NodeJS Inspector panel' })
      const drag = async (deltaY: number): Promise<void> => {
        const box = (await divider.boundingBox())!
        const x = box.x + box.width / 2
        const y = box.y + box.height / 2
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x, y + deltaY, { steps: 5 })
        await page.mouse.up()
      }
      await drag(-90)
      await expect.poll(async () => (await panel.boundingBox())!.height).toBeCloseTo(panelHeight + 90)
      await drag(135)
      const resizedHeight = panelHeight - 45
      await expect.poll(async () => (await panel.boundingBox())!.height).toBeCloseTo(resizedHeight)
      expect((await main.boundingBox())!.height).toBe(fullHeight - resizedHeight)
      await frontend.getByRole('tab', { name: 'Sources', exact: true }).click()
      await page.keyboard.press('ControlOrMeta+Shift+Period')
      await panel.waitFor({ state: 'hidden' })
      expect(await iframe.count()).toBe(1)
      expect((await main.boundingBox())!.height).toBe(fullHeight)
      await page.keyboard.press('ControlOrMeta+Shift+Period')
      await panel.waitFor({ state: 'visible' })
      expect((await panel.boundingBox())!.height).toBe(resizedHeight)
      expect(await iframe.evaluate((node, previous) => (node as HTMLIFrameElement).contentDocument === previous, original)).toBe(true)
      expect(await frontend.getByRole('tab', { name: 'Sources', exact: true }).getAttribute('aria-selected')).toBe('true')
      await panel.getByRole('button', { name: 'Collapse', exact: true }).click()
      await panel.waitFor({ state: 'hidden' })
      await original.dispose()
      expect(tripwire.pageErrors).toEqual([])
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/shared-inspector/bottom.expected.md', import.meta.url)), [
        '- shortcut: Ctrl/Cmd+Shift+.',
        `- header: ${titleSize}, X collapse button`,
        `- opened: main ${fullHeight - panelHeight}px, bottom ${panelHeight}px`,
        `- resized up/down: main ${fullHeight - resizedHeight}px, bottom ${resizedHeight}px`,
        `- collapsed: main ${fullHeight}px, iframe retained`,
        '- reopened: same iframe document and height, Sources still selected',
      ].join('\n'), webSnapshotMode())
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})

it.each([
  {
    locale: 'zh-CN', file: 'zh', plugins: '插件', open: '查看 开发者工具', bundle: '开发者工具',
    description: '查看调试会话原始数据、聊天消息分组数据，以及调试 NodeJS 后端',
    inspector: 'NodeJS 诊断', inspectorDescription: '按 Ctrl/Cmd+Shift+. 在底部面板打开 Chrome DevTools 进行开发调试',
    session: '会话数据诊断', sessionDescription: '在会话侧边栏启用当前会话的原始数据和聊天分组数据分析功能',
    openSidebar: '打开右侧边栏', sidebarDescription: '在侧边栏分析当前会话原始日志和聊天分组数据',
  },
  {
    locale: 'en-US', file: 'en', plugins: 'Plugins', open: 'View Developer Tools', bundle: 'Developer Tools',
    description: 'Inspect and debug raw session data, grouped chat messages, and the NodeJS backend.',
    inspector: 'NodeJS Inspector', inspectorDescription: 'Press Ctrl/Cmd+Shift+. to open Chrome DevTools in the bottom panel for development and debugging.',
    session: 'Session Log', sessionDescription: "Enable analysis of the current session's raw data and grouped chat messages in the session sidebar.",
    openSidebar: 'Open right sidebar', sidebarDescription: 'Analyze raw logs and grouped chat messages for the current session in the sidebar.',
  },
])('shows the Inspector bundle and component copy in $locale', async (copy) => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }], hmr: false },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./fixtures/inspector-copy.patch.yml', import.meta.url)),
    ],
  })
  resources.scaffold = scaffold
  await seedSession(scaffold, await readFile(await selectedSessionFixture(fixture), 'utf8'), 'inspector-copy')
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ locale: copy.locale })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('button', { name: copy.plugins, exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const card = panel.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-inspector-profile"]')
  await card.getByText(copy.description, { exact: true }).waitFor()
  const snapshot = [
    `- bundle: ${await card.getByText(copy.bundle, { exact: true }).innerText()}`,
    `  description: ${await card.getByText(copy.description, { exact: true }).innerText()}`,
  ]
  await card.getByRole('button', { name: copy.open, exact: true }).click()
  for (const [id, title, description] of [
    ['experimental-inspector', copy.inspector, copy.inspectorDescription],
    ['session-inspector', copy.session, copy.sessionDescription],
  ] as const) {
    const row = panel.locator('[data-plugin-row]', { hasText: id })
    await row.getByText(description, { exact: true }).waitFor()
    snapshot.push(`- component: ${await row.getByText(title, { exact: true }).innerText()}`,
      `  description: ${await row.getByText(description, { exact: true }).innerText()}`)
  }
  const workspace = page.getByRole('treeitem').first()
  if (await workspace.getAttribute('aria-expanded') === 'false') await workspace.click()
  await page.locator('[data-row-key="session:inspector-copy"]').click()
  await page.getByRole('button', { name: copy.openSidebar, exact: true }).click()
  const sessionGuide = page.locator('[data-sidebar-right-guide-entry="session-inspector-log"]')
  await sessionGuide.getByText(copy.sidebarDescription, { exact: true }).waitFor()
  const nodeGuide = page.locator('[data-sidebar-right-guide-entry="nodejs-inspector"]')
  expect(await nodeGuide.count()).toBe(0)
  await page.keyboard.press('ControlOrMeta+Shift+Period')
  const bottomTitle = page.locator('[data-inspector-panel] > header > span')
  await bottomTitle.getByText(copy.inspector, { exact: true }).waitFor()
  snapshot.push(`- session sidebar: ${await sessionGuide.getByText(copy.session, { exact: true }).innerText()}`,
    `  description: ${await sessionGuide.getByText(copy.sidebarDescription, { exact: true }).innerText()}`,
    `- NodeJS bottom: ${await bottomTitle.innerText()}`)
  await sessionGuide.click()
  await page.getByRole('table', { name: copy.locale === 'zh-CN' ? '原始数据' : 'Raw Log', exact: true }).waitFor()
  await compareOrRefreshGolden(fileURLToPath(new URL(`./expected/shared-inspector/metadata-${copy.file}.expected.md`, import.meta.url)),
    snapshot.join('\n'), webSnapshotMode())
})

it('marks a retained Client tree disconnected and clears the attribute when the page returns', async () => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }], hmr: false },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./fixtures/shared-inspector.patch.yml', import.meta.url)),
    ],
  })
  resources.scaffold = scaffold
  const browser = await chromium.launch({ executablePath: chromium.executablePath() })
  resources.browser = browser
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const client = await context.newPage()
  await client.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const bootstrap = await (await scaffold.hostFetch('/api/experimental-inspector/bootstrap')).json() as { endpoint: string }
  const targets = await (await fetch(`http://${new URL(bootstrap.endpoint).host}/json/list`)).json() as Array<{ devtoolsFrontendUrl: string }>
  const inspector = await context.newPage()
  await inspector.goto(targets[0]!.devtoolsFrontendUrl)
  const clientTag = inspector.locator('.webkit-html-tag-name').filter({ hasText: /^client$/u }).first()
  const disconnected = inspector.locator('.webkit-html-attribute-name').filter({ hasText: /^disconnected$/u })
  await clientTag.waitFor()
  expect(await disconnected.count()).toBe(0)
  const before = await scaffold.ctx.inspector.cordis.getTree()
  expect(before.clients).toHaveLength(1)
  await client.goto('about:blank')
  await disconnected.waitFor()
  await clientTag.waitFor()
  const snapshot = [`- disconnected Client attribute: ${await disconnected.innerText()}`]
  await inspector.getByRole('tab', { name: 'Console', exact: true }).click()
  await inspector.getByRole('button', { name: /^JavaScript context:/u }).click()
  await expect.poll(() => inspector.getByRole('menuitem').count()).toBe(1)
  snapshot.push(`- disconnected Console contexts: ${await inspector.getByRole('menuitem').count()} (Host)`)
  await inspector.getByRole('menuitem', { name: /^Host(?:\s|$)/u }).click()
  await inspector.getByRole('tab', { name: 'Elements', exact: true }).click()
  await client.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await expect.poll(async () => {
    const tree = await scaffold.ctx.inspector.cordis.getTree()
    return tree.clients.find(realm => realm.source.sourceId === before.clients[0]!.source.sourceId)?.connection.state
  }).toBe('connected')
  await expect.poll(() => disconnected.count()).toBe(0)
  await clientTag.waitFor()
  snapshot.push(`- reconnected Client disconnected attributes: ${await disconnected.count()}`)
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/shared-inspector/client-status.expected.md', import.meta.url)),
    snapshot.join('\n'), webSnapshotMode())
})

it('opens bottom DevTools and retains its document and selected panel across Sessions', async () => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: bundle, enabled: true }], hmr: false },
    extraOverlayPath: [
      fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      fileURLToPath(new URL('./fixtures/shared-inspector.patch.yml', import.meta.url)),
    ],
  })
  resources.scaffold = scaffold
  const seed = await readFile(await selectedSessionFixture(fixture), 'utf8')
  await seedSession(scaffold, seed, 'shared-a')
  await seedSession(scaffold, seed, 'shared-b')
  // Full Chromium includes the devtools:// frontend; the headless shell does not.
  const browser = await chromium.launch({ executablePath: chromium.executablePath() })
  resources.browser = browser
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'Asia/Shanghai' })
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('treeitem').first().click()
  await page.locator('[data-row-key="session:shared-a"]').click()
  await page.locator('[data-inspector-panel]').waitFor({ state: 'attached' })
  await page.keyboard.press('ControlOrMeta+Shift+Period')
  const iframe = page.locator('iframe[data-inspector-devtools]')
  const frontend = page.frameLocator('iframe[data-inspector-devtools]')
  await frontend.getByRole('tab', { name: 'Console', exact: true }).waitFor({ state: 'visible' })
  await frontend.getByRole('button', { name: /^JavaScript context:/u }).click()
  await expect.poll(() => frontend.getByRole('menuitem').count()).toBe(2)
  expect(await frontend.getByRole('menuitem', { name: /^internal(?:\s|$)/u }).count()).toBe(0)
  const extraPage = await page.context().newPage()
  await extraPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const extraGroup = extraPage.getByRole('treeitem').first()
  await extraGroup.waitFor()
  if (await extraGroup.getAttribute('aria-expanded') === 'false') await extraGroup.click()
  await extraPage.locator('[data-row-key="session:shared-a"]').click()
  await extraPage.locator('[data-inspector-panel]').waitFor({ state: 'attached' })
  await extraPage.keyboard.press('ControlOrMeta+Shift+Period')
  const extraFrontend = extraPage.frameLocator('iframe[data-inspector-devtools]')
  await extraFrontend.getByRole('tab', { name: 'Console', exact: true }).waitFor()
  await extraFrontend.getByRole('button', { name: /^JavaScript context:/u }).click()
  await expect.poll(() => extraFrontend.getByRole('menuitem').count()).toBe(2)
  const firstSource = new URL((await iframe.getAttribute('src'))!, scaffold.baseUrl).searchParams.get('clientSourceId')
  const secondSource = new URL((await extraPage.locator('iframe[data-inspector-devtools]').getAttribute('src'))!, scaffold.baseUrl).searchParams.get('clientSourceId')
  expect(firstSource).toMatch(/^client-/u)
  expect(secondSource).toMatch(/^client-/u)
  expect(secondSource).not.toBe(firstSource)
  await page.evaluate(() => { Reflect.set(window, '__inspectorPageMarker', 'embedding-page-one') })
  await extraPage.evaluate(() => { Reflect.set(window, '__inspectorPageMarker', 'embedding-page-two') })
  await extraFrontend.getByRole('menuitem', { name: /^Client —/u }).click()
  await extraFrontend.getByRole('textbox', { name: 'Console prompt', exact: true }).fill('window.__inspectorPageMarker')
  await extraFrontend.getByRole('textbox', { name: 'Console prompt', exact: true }).press('Enter')
  await extraFrontend.getByText('embedding-page-two', { exact: false }).waitFor()
  await frontend.getByRole('menuitem', { name: /^Client —/u }).click()
  await frontend.getByRole('textbox', { name: 'Console prompt', exact: true }).fill('window.__inspectorPageMarker')
  await frontend.getByRole('textbox', { name: 'Console prompt', exact: true }).press('Enter')
  await frontend.getByText('embedding-page-one', { exact: false }).waitFor()
  await frontend.getByRole('button', { name: /^JavaScript context:/u }).click()
  await expect.poll(() => frontend.getByRole('menuitem').count()).toBe(2)
  const bootstrap = await (await scaffold.hostFetch('/api/experimental-inspector/bootstrap')).json() as { endpoint: string }
  const targets = await (await fetch(`http://${new URL(bootstrap.endpoint).host}/json/list`)).json() as Array<{ devtoolsFrontendUrl: string }>
  const direct = await page.context().newPage()
  await direct.goto(targets[0]!.devtoolsFrontendUrl)
  await direct.getByRole('tab', { name: 'Console', exact: true }).click()
  await direct.getByRole('button', { name: /^JavaScript context:/u }).click()
  await expect.poll(() => direct.getByRole('menuitem').count()).toBe(3)
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/shared-inspector/connections.expected.md', import.meta.url)), [
    `- embedded page one: ${await frontend.getByRole('menuitem').count()} contexts (Host + own Client)`,
    '- embedded page two: own Client evaluates embedding-page-two',
    `- direct devtools: ${await direct.getByRole('menuitem').count()} contexts (Host + both Clients)`,
  ].join('\n'), webSnapshotMode())
  await extraPage.close()
  await expect.poll(() => direct.getByRole('menuitem').count()).toBe(2)
  await direct.close()
  await expect.poll(() => frontend.getByRole('menuitem').count()).toBe(2)
  await frontend.getByRole('menuitem', { name: /^Host(?:\s|$)/u }).click()
  const prompt = frontend.getByRole('textbox', { name: 'Console prompt', exact: true })
  await prompt.fill('[process.release.name, 6 * 7].join(":")')
  await prompt.press('Enter')
  await frontend.getByText('node:42', { exact: false }).waitFor({ state: 'visible' })
  await frontend.getByRole('button', { name: /^JavaScript context:/u }).click()
  await frontend.getByRole('menuitem', { name: /^Client —/u }).click()
  await prompt.fill('[document.title, 6 * 7].join(":")')
  await prompt.press('Enter')
  await frontend.getByText(`${await page.title()}:42`, { exact: false }).waitFor({ state: 'visible' })
  expect(await frontend.getByRole('tab', { name: 'Connection', exact: true }).count()).toBe(0)
  await frontend.getByRole('tab', { name: 'Sources', exact: true }).click()
  await expect.poll(() => frontend.getByRole('tab', { name: 'Sources', exact: true }).getAttribute('aria-selected')).toBe('true')
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/shared-inspector/page.expected.md', import.meta.url)),
    await frontend.getByRole('tablist', { name: 'Panels', exact: true }).ariaSnapshot(), webSnapshotMode())
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'devtools-bottom.png') })
  await iframe.evaluate((node) => {
    if (!(node instanceof HTMLIFrameElement)) throw new Error('Expected the Inspector iframe')
    const evidence = { frame: node, document: node.contentDocument, loads: 0 }
    node.addEventListener('load', () => { evidence.loads++ })
    Reflect.set(window, '__sharedInspectorEvidence', evidence)
  })
  const unchanged = () => page.evaluate(() => {
    const evidence = Reflect.get(window, '__sharedInspectorEvidence') as {
      frame: HTMLIFrameElement
      document: Document
      loads: number
    }
    return { frame: evidence.frame === document.querySelector('[data-inspector-devtools]'),
      document: evidence.frame.contentDocument === evidence.document, connected: evidence.frame.isConnected, loads: evidence.loads }
  })
  const identity = { frame: true, document: true, connected: true, loads: 0 }

  await page.locator('[data-row-key="session:shared-b"]').click()
  expect(await iframe.isVisible()).toBe(true)
  expect(await unchanged()).toEqual(identity)
  await expect.poll(() => frontend.getByRole('tab', { name: 'Sources', exact: true }).getAttribute('aria-selected')).toBe('true')
  await page.locator('[data-inspector-panel]').getByRole('button', { name: 'Collapse', exact: true }).click()
  await iframe.waitFor({ state: 'hidden' })
  await page.locator('[data-row-key="session:shared-a"]').click()
  expect(await iframe.isVisible()).toBe(false)
  expect(await unchanged()).toEqual(identity)
  await page.keyboard.press('ControlOrMeta+Shift+Period')
  await iframe.waitFor({ state: 'visible' })
  expect(await unchanged()).toEqual(identity)
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.locator('[data-plugin-panel]').waitFor()
  expect(await iframe.isVisible()).toBe(true)
  expect(await unchanged()).toEqual(identity)
  await page.locator('[data-inspector-panel]').getByRole('button', { name: 'Collapse', exact: true }).click()
  await iframe.waitFor({ state: 'hidden' })
  expect(await unchanged()).toEqual(identity)
  expect(tripwire.pageErrors).toEqual([])
})
