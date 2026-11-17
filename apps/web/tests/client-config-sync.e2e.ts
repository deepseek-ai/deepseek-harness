/** Real profile, Remote, and page Loader: a browser plugin receives its Host face's volatile Config and follows live edits. */
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState } from '@deepseek-ai/cordis'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-synced-config', import.meta.url))
const SCHEMASTERY = fileURLToPath(new URL('../../../vendor/schemastery', import.meta.url))
const PACKAGE = '@fixture/synced-config'
const ROW = 'fixture-synced-config'

/** What the fixture's Client face records from its synced Config object. */
interface Observation {
  keys: string[]
  greeting: string
  account: { label: string }
}

/**
 * Parse the fixture's recorded observation.
 * @param text - JSON the fixture wrote to `data-synced-config`.
 * @returns the observation.
 */
function parseObservation(text: string): Observation {
  const value = JSON.parse(text) as Partial<Observation> | null
  if (value === null || !Array.isArray(value.keys) || typeof value.greeting !== 'string' || typeof value.account?.label !== 'string') {
    throw new Error(`fixture-synced-config recorded an unexpected observation: ${text}`)
  }
  return value as Observation
}

it('renders volatile Config without secrets or ordinary fields and updates it in place from a profile edit', async () => {
  // An installed package carries its own dependencies: the copy links the Schemastery its Host face imports.
  const installed = await mkdtemp(join(tmpdir(), 'dsh-client-config-sync-'))
  onTestFinished(() => rm(installed, { recursive: true, force: true }))
  await cp(FIXTURE, installed, { recursive: true })
  await mkdir(join(installed, 'node_modules', '@deepseek-ai'), { recursive: true })
  await symlink(SCHEMASTERY, join(installed, 'node_modules', '@deepseek-ai', 'schemastery'), 'junction')
  const scaffold = await launchWebScaffold({ profile: { packages: [{ dir: installed, enabled: true }] } })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const entry = [...scaffold.ctx.loader.entries()].find(candidate => candidate.options.id === ROW)
  expect(entry?.fiber?.state).toBe(FiberState.ACTIVE)
  const hostFiber = entry!.fiber!

  // The first-render HTML carries the projection: volatile values only, the secret subfield removed.
  const html = await (await scaffold.hostFetch('/')).text()
  expect(html).toContain('hello-r0')
  expect(html).not.toContain('secret-token-r0')
  expect(html).not.toContain('host-only-cache-r0')

  const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-client-config-sync'))
  let navigations = 0
  const dataset = async () => {
    const { applies, config } = await page.evaluate(() => ({
      applies: document.documentElement.dataset.syncedApplies,
      config: document.documentElement.dataset.syncedConfig,
    }))
    return { applies, config: config === undefined ? undefined : parseObservation(config) }
  }
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  page.on('framenavigated', () => { navigations++ })
  await expect.poll(async () => (await dataset()).applies, { timeout: 20_000 }).toBe('1')
  const bootRow = await page.evaluate((id) => {
    const boot = Reflect.get(window, '__DSH_BOOT__') as { entries: { id: string; config?: unknown }[] }
    return boot.entries.find(row => row.id === id)
  }, PACKAGE)
  expect(bootRow?.config).toEqual({ greeting: 'hello-r0', account: { label: 'primary' } })
  expect(await dataset()).toEqual({
    applies: '1',
    config: { keys: ['account', 'greeting'], greeting: 'hello-r0', account: { label: 'primary' } },
  })

  // A profile edit that changes only volatile values reaches the running activation through its references.
  const patchFile = join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
  const previous = await readFile(patchFile, 'utf8').catch(() => '')
  expect(previous.includes(ROW)).toBe(false)
  await writeFile(patchFile, [
    `- id: ${ROW}`,
    '  config:',
    '    cacheDir: host-only-cache-r0',
    '    greeting: hello-r1',
    '    account:',
    '      label: secondary',
    '      token: secret-token-r1',
    '',
  ].join('\n'))
  await expect.poll(async () => (await dataset()).config, { timeout: 30_000 }).toEqual({
    keys: ['account', 'greeting'], greeting: 'hello-r1', account: { label: 'secondary' },
  })
  expect(scaffold.ctx.clientModules.graph().entries.find(row => row.id === PACKAGE)?.config)
    .toEqual({ greeting: 'hello-r1', account: { label: 'secondary' } })
  expect((await dataset()).applies).toBe('1')
  expect(entry!.fiber).toBe(hostFiber)
  expect(hostFiber.state).toBe(FiberState.ACTIVE)
  expect(navigations).toBe(0)
  expect(console.pageErrors).toEqual([])
}, 120_000)
