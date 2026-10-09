/** Git Worktrees opt-in through the shipped plugin manager, profile, and Loader. */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, PLUGIN_TOGGLE_SETTLE_MS, saveFailureShot } from './support.ts'

const BUNDLE = '@deepseek-ai/dsh-experimental-tool-worktree'
const exec = promisify(execFile)

it('persists the Git Worktrees switch and removes its capability while retaining checkouts', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  const browserPromise = chromium.launch()
  onTestFinished(async () => {
    try {
      await (await browserPromise).close()
    } finally {
      await scaffold.close()
    }
  })
  const browser = await browserPromise
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-worktree-opt-in'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const agent = scaffold.ctx.agents.list()[0]
  if (agent === undefined) throw new Error('connected workspace did not create an Agent')
  const repository = agent.session.header.cwd
  if (repository === undefined) throw new Error('connected workspace has no directory')
  const git = (...args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: repository,
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '', GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0',
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
    },
  })
  await git('init', '-b', 'main')
  await git('config', 'core.autocrlf', 'false')
  await writeFile(join(repository, 'retained.txt'), 'retained checkout\n')
  await git('add', 'retained.txt')
  await git('-c', 'user.name=Worktree fixture', '-c', 'user.email=worktree@example.invalid', '-c', 'commit.gpgSign=false',
    'commit', '-m', 'initial')

  const tools = () => scaffold.ctx.tools.schemas(agent).map(schema => schema.name)
  const rows = () => [...scaffold.ctx.loader.entries()]
    .filter(entry => ['worktree', 'tool-worktree'].includes(entry.options.id) && entry.fiber?.state === FiberState.ACTIVE)
  const selectedBundles = async (): Promise<string[]> => {
    const manifest = JSON.parse(await readFile(join(scaffold.harnessHome, 'profiles/scaffold/package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    return manifest.dsh.profile.bundles
  }
  const openPlugins = async () => {
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('heading', { name: 'Plugins', exact: true }).waitFor()
    await panel.getByRole('button', { name: 'More', exact: true }).click()
    return panel
  }
  let panel = await openPlugins()
  let card = panel.locator(`[data-plugin-group="more"] [data-plugin-package="${BUNDLE}"]`)
  await card.getByRole('button', { name: 'View Git Worktrees', exact: true }).waitFor()
  expect(await card.getByText('Experimental', { exact: true }).count()).toBe(1)
  let toggle = card.getByRole('switch', { name: 'Enable Git Worktrees', exact: true })
  expect(await toggle.getAttribute('aria-checked')).toBe('false')
  expect(await selectedBundles()).not.toContain(BUNDLE)
  expect(rows()).toEqual([])
  expect(scaffold.ctx.get('worktrees')).toBeUndefined()
  expect(tools()).toContain('working_directory')
  expect(tools()).not.toContain('create_worktree')

  await toggle.click()
  await expect.poll(() => rows().length, { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe(2)
  await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
  expect(await selectedBundles()).toContain(BUNDLE)
  expect(tools()).toContain('create_worktree')
  const created = await scaffold.ctx.worktrees.create(agent, { name: 'gui-opt-in' })
  expect(await readFile(join(created.path, 'retained.txt'), 'utf8')).toBe('retained checkout\n')
  expect(scaffold.ctx.workingDirectory.get(agent.session)).toBe(created.path)

  await page.reload({ waitUntil: 'load' })
  panel = await openPlugins()
  card = panel.locator(`[data-plugin-group="more"] [data-plugin-package="${BUNDLE}"]`)
  toggle = card.getByRole('switch', { name: 'Enable Git Worktrees', exact: true })
  await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
  expect(tools()).toContain('create_worktree')
  await toggle.click()
  await expect.poll(() => rows().length, { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe(0)
  await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('false')
  expect(await selectedBundles()).not.toContain(BUNDLE)
  expect(scaffold.ctx.get('worktrees')).toBeUndefined()
  expect(tools()).not.toContain('create_worktree')
  expect(tools()).toContain('working_directory')
  expect(await readFile(join(created.path, 'retained.txt'), 'utf8')).toBe('retained checkout\n')
  expect((await git('show-ref', '--verify', 'refs/heads/gui-opt-in')).stdout).toContain(created.baseCommit)
  expect(scaffold.ctx.workingDirectory.get(agent.session)).toBe(created.path)

  await page.reload({ waitUntil: 'load' })
  panel = await openPlugins()
  await expect.poll(() => panel.getByRole('switch', { name: 'Enable Git Worktrees', exact: true })
    .getAttribute('aria-checked')).toBe('false')
  expect(tools()).not.toContain('create_worktree')
  expect(await selectedBundles()).not.toContain(BUNDLE)
  expect(tripwire.pageErrors).toEqual([])
})
