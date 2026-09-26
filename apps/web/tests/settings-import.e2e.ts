// Web e2e scenario: a `settings.yaml` left in the harness home by earlier releases is imported into the
// scaffold profile at start, through the shipped entries, and the imported values reach the page.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import { WELCOME_NOTICE_VERSION, launchWebScaffold, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it('imports settings.yaml into the profile once and applies the imported values', async () => {
  const harnessHome = mkdtempSync(join(tmpdir(), 'dsh-settings-import-'))
  writeFileSync(join(harnessHome, 'settings.yaml'), [
    'ui-theme:', '  fontSize: 16',
    'ui-developer-tools:', '  enabled: false',
    'ui-onboarding:', `  welcomeNoticeVersion: '${WELCOME_NOTICE_VERSION}'`,
    '',
  ].join('\n'))
  const scaffold = await launchWebScaffold({ harnessHome, welcomeNoticePending: true })
  const browser = await chromium.launch()
  try {
    const patchPath = join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')
    type Row = { id?: string; config?: Record<string, unknown> }
    const config = (id: string): Record<string, unknown> | undefined =>
      (yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema }) as Row[]).find(row => row.id === id)?.config
    await expect.poll(() => config('ui-theme')?.['fontSize'], { timeout: 10_000 }).toBe(16)
    expect(config('ui-settings')?.['enabled']).toBe(false)
    expect(config('ui-settings-general')?.['welcomeNoticeVersion']).toBe(WELCOME_NOTICE_VERSION)
    expect(existsSync(join(harnessHome, 'settings.yaml'))).toBe(false)
    expect(readFileSync(join(harnessHome, 'settings.yaml.imported'), 'utf8')).toContain('fontSize: 16')

    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')), { timeout: 10_000 }).toBe('16px')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
