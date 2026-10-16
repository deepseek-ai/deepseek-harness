/** Fixture-day clock pins keep page scheduling native at every real-to-fixture distance. */
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newEnglishPage, pinBrowserClock, WEB_FIXTURE_TIME } from './support.ts'

// Host clock shifts spread over one 2^32 ms period of the real-to-fixture
// distance; Playwright's page clock stopped page timers in half of that period.
const DISTANCE_PERIOD_MS = 2 ** 32
const HOST_SHIFTS_MS = Array.from({ length: 8 }, (_, index) => index * DISTANCE_PERIOD_MS / 8)

describe('web e2e: pinned fixture clocks', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
  })

  it.each(HOST_SHIFTS_MS)('runs page timers and reads the fixture day with the Host clock %d ms behind it', async (shift) => {
    const hostStartedAt = performance.now()
    const hostClock = vi.spyOn(Date, 'now').mockImplementation(() =>
      WEB_FIXTURE_TIME - shift + Math.floor(performance.now() - hostStartedAt))
    const page = await newEnglishPage(browser)
    try {
      await pinBrowserClock(page)
      for (const navigation of ['initial', 'replacement']) {
        await page.goto(`data:text/html,<body>${navigation}</body>`)
        const pageStartedAt = await page.evaluate(() => {
          requestAnimationFrame(() => { document.body.dataset.frame = 'done' })
          setTimeout(() => { document.body.dataset.timer = 'done' }, 20)
          return Date.now()
        })
        await expect.poll(() => page.evaluate(() => ({
          frame: document.body.dataset.frame,
          timer: document.body.dataset.timer,
        })), { timeout: 5_000 }).toEqual({ frame: 'done', timer: 'done' })
        const dates = await page.evaluate(() => ({
          now: Date.now(),
          day: new Date().toISOString().slice(0, 10),
          explicit: new Date(0).getTime(),
          parsed: Date.parse('2000-01-01T00:00:00Z'),
        }))
        expect(pageStartedAt).toBeGreaterThanOrEqual(WEB_FIXTURE_TIME)
        expect(dates.now).toBeGreaterThan(pageStartedAt)
        expect(dates.day).toBe(new Date(WEB_FIXTURE_TIME).toISOString().slice(0, 10))
        expect(dates.explicit).toBe(0)
        expect(dates.parsed).toBe(946_684_800_000)
      }
    } finally {
      try {
        await page.close()
      } finally {
        hostClock.mockRestore()
      }
    }
  }, 60_000)
})
