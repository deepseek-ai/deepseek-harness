/** Shipped language selection, metadata and narrow settings through the assembled Web profile. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const languages = [
  ['es', 'es-MX', 'Menú de cuenta', 'Configuración', 'Complementos', 'Idioma', 'Español'],
  ['fr', 'fr-CA', 'Menu du compte', 'Paramètres', 'Plugins', 'Langue', 'Français'],
  ['de', 'de-DE', 'Kontomenü', 'Einstellungen', 'Plugins', 'Sprache', 'Deutsch'],
  ['ru', 'ru-RU', 'Меню аккаунта', 'Настройки', 'Плагины', 'Язык', 'Русский'],
  ['pt', 'pt-BR', 'Menu da conta', 'Configurações', 'Plug-ins', 'Idioma', 'Português'],
] as const

it.each(languages)('selects %s from the browser, localizes metadata and persists an explicit choice', async (id, tag, accountMenu, settings, plugins, language, label) => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold()
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ locale: tag, viewport: { width: 1440, height: 960 } })
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, `additional-locale-${id}`))
  await page.goto(scaffold.authenticatedUrl)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(id)
  await page.getByRole('button', { name: plugins, exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const metadata = JSON.parse(await readFile(new URL(`../../../packages/experimental/auto-review/locale/${id}.json`, import.meta.url), 'utf8')) as { meta: { title: string; description: string } }
  await panel.getByText(metadata.meta.title, { exact: true }).waitFor()
  await panel.getByText(metadata.meta.description, { exact: true }).waitFor()
  await compareOrRefreshGolden(fileURLToPath(new URL(`./expected/additional-locales/${id}.expected.md`, import.meta.url)),
    await captureStableAria(page, `[data-plugin-panel] li:has-text(${JSON.stringify(metadata.meta.title)})`, scaffold.workspaceCwd), webSnapshotMode())
  await page.getByRole('button', { name: accountMenu, exact: true }).click()
  await page.getByRole('menuitem', { name: settings, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: settings, exact: true })
  await dialog.getByText(language, { exact: true }).waitFor()
  await dialog.getByRole('button', { name: label, exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => dialog.evaluate((element) => {
    const content = element.lastElementChild!
    return { panel: element.scrollWidth <= element.clientWidth + 1, content: content.scrollWidth <= content.clientWidth + 1 }
  })).toEqual({ panel: true, content: true })
  await dialog.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toContain(`preference: ${id}`)
  await dialog.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('menuitem', { name: 'English', exact: true }).click()
  await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toContain('preference: en')
  const warningsBeforeReload = tripwire.warnings.length
  await page.reload()
  acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('en')
  expect(tripwire.warnings).toEqual([])
  expect(tripwire.pageErrors).toEqual([])
})

const forgePreviews = [
  ['de', 'de-DE', 'Plugins', 'Eine Unterhaltung mit verknüpftem GitHub-Pull-Request, Prüfungen, Reviews, Codeunterschieden und einem separaten Arbeitsbaum'],
  ['es', 'es-MX', 'Complementos', 'Una conversación vinculada a un pull request de GitHub, con comprobaciones, revisiones, diferencias de código y un árbol de trabajo aislado'],
  ['fr', 'fr-CA', 'Plugins', 'Une conversation liée à une pull request GitHub, avec vérifications, revues, différences de code et un arbre de travail isolé'],
  ['ja', 'ja-JP', 'プラグイン', 'GitHub のプルリクエストに関連付けられた会話、チェックとレビューの状況、コードの差分、独立したワークツリー'],
  ['pt', 'pt-BR', 'Plug-ins', 'Uma conversa vinculada a um pull request do GitHub, com verificações, revisões, diferenças de código e uma árvore de trabalho isolada'],
  ['ru', 'ru-RU', 'Плагины', 'Беседа, связанная с pull request GitHub: проверки, рецензии, различия в коде и отдельное рабочее дерево'],
] as const

it.each(forgePreviews)('reads the Forge preview in %s before activation', async (id, tag, plugins, alt) => {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await resources.browser?.close() } finally { await resources.scaffold?.close() }
  })
  const scaffold = await launchWebScaffold()
  resources.scaffold = scaffold
  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ locale: tag, viewport: { width: 1440, height: 960 } })
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, `forge-preview-${id}`))
  await page.goto(scaffold.authenticatedUrl)
  await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(id)
  await page.getByRole('button', { name: plugins, exact: true }).click()
  const card = page.locator('[data-plugin-package="@deepseek-ai/dsh-experimental-forge-bundle"]')
  expect(await card.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  await card.getByRole('button').click()
  const image = page.locator('[data-detail-document]').getByRole('img', { name: alt, exact: true })
  await image.waitFor()
  await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
  expect(await image.evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight])).toEqual([640, 300])
  expect(tripwire.pageErrors).toEqual([])
})
