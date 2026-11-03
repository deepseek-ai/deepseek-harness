import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { newEnglishPage, pinBrowserClock, pinHostClock, WEB_FIXTURE_TIME } from './support.ts'

it.each(['UTC', 'America/Los_Angeles'])('isolates the recorded browser timezone from %s', async (hostTimeZone) => {
  const browser = await chromium.launch({ env: { ...process.env, TZ: hostTimeZone } })
  try {
    const ambientPage = await browser.newPage()
    expect(await ambientPage.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(hostTimeZone)

    const page = await newEnglishPage(browser)
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Shanghai')
    expect(await page.evaluate(() => navigator.language)).toBe('en-US')
    expect(await ambientPage.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(hostTimeZone)

    await page.close()
    const nextPage = await browser.newPage()
    expect(await nextPage.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(hostTimeZone)
  } finally {
    await browser.close()
  }
})

it('keeps browser timers and animation frames live with the Host date pinned, including reload', async () => {
  const originalNow = Date.now
  const hostClock = pinHostClock()
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await pinBrowserClock(page)
      await page.goto('data:text/html,<body>clock</body>')
      let previousTime = WEB_FIXTURE_TIME
      for (const reload of [false, true]) {
        if (reload) await page.reload()
        const now = await page.evaluate(() => Date.now())
        if (reload) expect(now).toBeGreaterThan(previousTime)
        else expect(now).toBeGreaterThanOrEqual(previousTime)
        expect(now).toBeLessThan(WEB_FIXTURE_TIME + 60_000)
        previousTime = now
        await page.evaluate(() => {
          setTimeout(() => { document.body.dataset.timer = 'fired' }, 0)
          requestAnimationFrame(() => { document.body.dataset.frame = 'fired' })
        })
        await expect.poll(() => page.evaluate(() => ({
          timer: document.body.dataset.timer, frame: document.body.dataset.frame,
        })), { timeout: 5_000 }).toEqual({ timer: 'fired', frame: 'fired' })
      }
      await page.close()
      const nextPage = await newEnglishPage(browser)
      expect(await nextPage.evaluate(() => Math.abs(Date.now() - new Date().getTime()))).toBeLessThan(100)
    } finally {
      await browser.close()
    }
  } finally {
    hostClock.mockRestore()
  }
  expect(Date.now).toBe(originalNow)
})
