/** Calendar fixtures leave browser scheduling and other pages independent. */
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { pinBrowserClock, pinHostClock, WEB_FIXTURE_TIME } from './support.ts'

it('advances pinned dates and native timers across navigation with a pinned Host clock', async () => {
  const hostClock = pinHostClock()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const context = await browser.newContext()
    const page = await context.newPage()
    await pinBrowserClock(page)
    for (const navigation of ['initial', 'replacement']) {
      await page.goto(`data:text/html,<body>${navigation}</body>`)
      const startedAt = await page.evaluate(() => {
        requestAnimationFrame(() => {
          document.body.dataset.frame = 'complete'
          setTimeout(() => { document.body.dataset.nested = 'complete' }, 0)
        })
        setTimeout(() => { document.body.dataset.timer = 'complete' }, 20)
        return Date.now()
      })
      await expect.poll(() => page.evaluate(() => ({
        frame: document.body.dataset.frame,
        timer: document.body.dataset.timer,
        nested: document.body.dataset.nested,
      })), { timeout: 10_000 }).toEqual({ frame: 'complete', timer: 'complete', nested: 'complete' })
      const dates = await page.evaluate(() => ({
        now: Date.now(), constructed: new Date().getTime(), after: Date.now(),
        day: new Date().toISOString().slice(0, 10),
        explicit: new Date(0).getTime(), parsed: Date.parse('2000-01-01T00:00:00Z'),
      }))
      expect(startedAt).toBeGreaterThanOrEqual(WEB_FIXTURE_TIME)
      expect(dates.now).toBeGreaterThan(startedAt)
      expect(dates.constructed).toBeGreaterThanOrEqual(dates.now)
      expect(dates.constructed).toBeLessThanOrEqual(dates.after)
      expect(dates.day).toBe('2026-01-15')
      expect(dates.explicit).toBe(0)
      expect(dates.parsed).toBe(946684800000)
    }
    const independent = await context.newPage()
    await independent.goto('data:text/html,<body>independent</body>')
    const wallTime = performance.timeOrigin + performance.now()
    expect(await independent.evaluate(() => Date.now())).toBeGreaterThanOrEqual(wallTime - 1000)
    await page.close()
  } finally {
    try { await browser?.close() }
    finally { hostClock.mockRestore() }
  }
})
