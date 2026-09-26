/** Expanded reasoning keeps Markdown semantics at the secondary typography tier. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, saveFailureShot, scrollIntoView } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/thinking-markdown', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./expected/thinking-markdown/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'thinking-markdown-web-e2e'
const DONE = 'THINKING_MARKDOWN_DONE'
const LONG_TOKEN = 'workspace/packages/client/secondary-markdown/'.repeat(12)

/** Closed Session using semantic Markdown and content wider than the message column. */
function thinkingFixture(): string {
  const session = Session.create(SessionId('thinking-markdown-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Show reasoning and a main answer.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Thinking Markdown', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{
        type: 'reasoning',
        text: [
          `## Compact reasoning ${'with a deliberately long summary '.repeat(8)}`,
          '',
          'A paragraph with **strong text**, *emphasis*, [reference](https://example.com/), and `inline_code`.',
          '',
          ...[1, 2, 3, 4, 5, 6].flatMap(level => [`${'#'.repeat(level)} Level ${String(level)}`, '']),
          '- Unordered item',
          '- Second item',
          '- Inline list formula: $x_j$.',
          `- Long list atom: $\\underbrace{${'a'.repeat(240)}}_{long}$.`,
          '',
          '1. Ordered item',
          '2. Another item',
          '',
          '- Loose first paragraph.',
          '',
          '  Loose middle paragraph.',
          '',
          '  Loose last paragraph.',
          '',
          '> Quoted reasoning.',
          '',
          '---',
          '',
          '| First | Second | Third | Fourth | Fifth | Sixth |',
          '| --- | --- | --- | --- | --- | --- |',
          `| ${Array.from({ length: 6 }, (_, index) => `long_table_cell_${String(index)}_${'x'.repeat(40)}`).join(' | ')} |`,
          ...Array.from({ length: 20 }, (_, row) => `| ${Array.from({ length: 6 }, (_, column) => `Row ${String(row + 1)} column ${String(column + 1)}`).join(' | ')} |`),
          '',
          'Short subscript: $x_j$.',
          '',
          'Short scripts: $x_i^2$.',
          '',
          `Long atom: $\\underbrace{${'a'.repeat(240)}}_{long}$.`,
          '',
          `Inline math: $${'a+'.repeat(80)}z$.`,
          '',
          '$$',
          `${'a+'.repeat(80)}\\frac{1}{1+\\frac{1}{x}}`,
          '$$',
          '',
          '```typescript',
          'const value = "reasoning code"',
          '```',
          '',
          LONG_TOKEN,
        ].join('\n'),
      }, { type: 'text', text: `# Main answer\n\n${DONE}` }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
  }), ...session.snapshotEvents().map(({ seq, time: _time, ...event }) => JSON.stringify({
    ...event, seq, time: new Date().setHours(12, 0, 0, 0) + seq * 1_000,
  })), ''].join('\n')
}

describe('web e2e: secondary Thinking Markdown', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, thinkingFixture(), SEED_ID)
    browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText(DONE, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await page.waitForFunction(() => {
      const frame = document.querySelector('[data-sidebar-collapsed]')
      return frame !== null && getComputedStyle(frame).gridTemplateColumns.split(' ')[0] === '56px'
        && frame.getAnimations().every(animation => animation.playState === 'finished' || animation.playState === 'idle')
    }, undefined, { timeout: 10_000 })
    await expandTurnProcesses(page)
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('renders semantic blocks without promoting headings or overflowing the column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-thinking-markdown'))
    const thinking = page.locator('[data-variant="think"]')
    const toggle = thinking.getByRole('button').first()
    const summary = thinking.locator('[class*="summaryText"]')
    const summaryStyle = await summary.evaluate((element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
    })
    expect(await summary.evaluate(element => element.getBoundingClientRect().height))
      .toBeLessThanOrEqual(Number.parseFloat(summaryStyle.lineHeight) + 1)
    await toggle.click()
    const markdown = thinking.locator('[data-markdown-variant="compact"]')
    await markdown.locator('h1').waitFor({ timeout: 10_000 })
    expect(await markdown.locator('h1,h2,h3,h4,h5,h6').count()).toBe(7)
    expect(await markdown.locator('ul').count()).toBe(2)
    expect(await markdown.locator('ol').count()).toBe(1)
    expect(await markdown.locator('strong').textContent()).toBe('strong text')
    expect(await markdown.locator('em').textContent()).toBe('emphasis')
    expect(await markdown.getByRole('link', { name: 'reference' }).getAttribute('href')).toBe('https://example.com/')
    expect(await markdown.locator('pre code').textContent()).toContain('const value = "reasoning code"')
    expect(await markdown.locator('hr').count()).toBe(1)
    expect(await markdown.locator('table').count()).toBe(1)
    expect(await markdown.locator('.katex').count()).toBe(7)
    await scrollIntoView(markdown.locator('pre'))
    await expect.poll(() => markdown.locator('pre.shiki').count(), { timeout: 15_000 }).toBe(1)
    const snapshot = (await captureStableAria(page, '[data-variant="think"][data-expanded]', scaffold.workspaceCwd))
      .split(LONG_TOKEN).join('{{longToken}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    for (const width of [1680, 640]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(async () => { await document.fonts.ready })
      const styles = await markdown.evaluate((root, secondary) => {
        const elements = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,a,strong,em,pre,pre code,pre span,th,td,.katex')]
        const prose = elements.filter(element => element.closest('pre') === null)
        const code = elements.filter(element => element.closest('pre') !== null)
        const scrollers = [...root.querySelectorAll<HTMLElement>('[class*="tableScroll"],.katex-display,p:has(.katex),ul:has(.katex)')]
        const shortFormulas = [...root.querySelectorAll('p')].filter(element => element.textContent?.startsWith('Short '))
        // Native KaTeX baselines vary with host fonts; compact adds one pixel for descender ink.
        const shortMathNaturalHeight = shortFormulas.map((paragraph) => {
          const native = paragraph.cloneNode(true) as HTMLParagraphElement
          native.style.font = getComputedStyle(paragraph).font
          native.style.position = 'absolute'
          native.style.width = `${String(paragraph.clientWidth)}px`
          for (const formula of native.querySelectorAll<HTMLElement>('.katex')) formula.style.fontSize = secondary.fontSize
          document.body.appendChild(native)
          const height = native.getBoundingClientRect().height
          native.remove()
          return paragraph.getBoundingClientRect().height <= height + 1
        })
        const longAtom = [...root.querySelectorAll('p')].find(element => element.textContent?.startsWith('Long atom:'))
        const mathList = root.querySelector('ul:has(.katex)')
        const mathListItem = mathList?.querySelector('li')
        const banner = root.querySelector('[data-code-block-banner]')?.parentElement
        const loose = [...root.querySelectorAll('li p')].find(element => element.textContent === 'Loose middle paragraph.')
        return {
          secondarySize: prose.every(element => getComputedStyle(element).fontSize === secondary.fontSize),
          secondaryLine: prose.filter(element => !element.classList.contains('katex'))
            .every(element => getComputedStyle(element).lineHeight === secondary.lineHeight),
          codeTypography: code.length > 0 && code.every((element) => {
            const style = getComputedStyle(element)
            return style.fontSize === '11px' && style.lineHeight === '19px'
          }),
          tertiaryColor: elements.every(element => getComputedStyle(element).color === secondary.color),
          tertiaryMarkers: [...root.querySelectorAll('li')]
            .every(element => getComputedStyle(element, '::marker').color === secondary.color),
          contained: root.scrollWidth <= root.clientWidth + 1,
          bannerStatic: banner !== undefined && banner !== null && getComputedStyle(banner).position === 'static',
          looseSpacing: loose !== undefined && getComputedStyle(loose).marginTop === '4px' && getComputedStyle(loose).marginBottom === '4px',
          wideContentBounded: scrollers.length === 7 && scrollers.every(element => element.clientWidth <= root.clientWidth + 1),
          mathListMarkerSpace: mathList !== null && mathListItem !== null && mathListItem !== undefined
            && mathListItem.getBoundingClientRect().left - mathList.getBoundingClientRect().left >= Number.parseFloat(secondary.fontSize),
          shortMathNaturalHeight: shortMathNaturalHeight.length === 2 && shortMathNaturalHeight.every(Boolean),
          shortMathNoScrollbar: shortFormulas.every(paragraph => [paragraph, ...paragraph.querySelectorAll<HTMLElement>('span')].every((element) => {
            const style = getComputedStyle(element)
            const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll'
            const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll'
            return (!scrollsX || element.scrollWidth <= element.clientWidth)
              && (!scrollsY || element.scrollHeight <= element.clientHeight)
          })),
          longAtomScrolls: longAtom !== undefined && longAtom.scrollWidth > longAtom.clientWidth,
          displayMathScrolls: [...root.querySelectorAll<HTMLElement>('.katex-display')]
            .every(element => element.scrollWidth > element.clientWidth),
        }
      }, summaryStyle)
      expect(styles, `Thinking typography at ${String(width)}px`).toEqual({
        secondarySize: true, secondaryLine: true, codeTypography: true, tertiaryColor: true, tertiaryMarkers: true,
        contained: true, bannerStatic: true, looseSpacing: true,
        wideContentBounded: true, displayMathScrolls: true,
        shortMathNaturalHeight: true, shortMathNoScrollbar: true, longAtomScrolls: true, mathListMarkerSpace: true,
      })
    }
    const answerSize = await page.getByRole('heading', { name: 'Main answer', exact: true })
      .evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))
    expect(answerSize).toBeGreaterThan(Number.parseFloat(summaryStyle.fontSize))
    await page.setViewportSize({ width: 1680, height: 1000 })
    const groupScroll = thinking.locator('xpath=ancestor::*[@data-step-process-body][1]')
    await scrollIntoView(groupScroll)
    await groupScroll.evaluate((host) => {
      const row = host.querySelector('[data-variant="think"] tbody tr:nth-child(12)')
      if (row === null) throw new Error('tall Thinking table row missing')
      host.scrollTop += row.getBoundingClientRect().top - host.getBoundingClientRect().top
    })
    await expect.poll(() => toggle.evaluate((button) => {
      const host = button.closest('[data-step-process-body]')
      const table = button.closest('[data-variant="think"]')?.querySelector('table')
      if (host === null || table === null || table === undefined) throw new Error('Thinking scroll context missing')
      const buttonRect = button.getBoundingClientRect()
      const tableRect = table.getBoundingClientRect()
      const x = buttonRect.left + buttonRect.width / 2
      const y = buttonRect.top + buttonRect.height / 2
      return {
        pinned: Math.abs(buttonRect.top - host.getBoundingClientRect().top) <= 1,
        tableUnderHeader: tableRect.top < y && tableRect.bottom > y,
        headerReceivesPointer: button.contains(document.elementFromPoint(x, y)),
      }
    }), { timeout: 5_000 }).toEqual({ pinned: true, tableUnderHeader: true, headerReceivesPointer: true })
    await toggle.click()
    expect(await thinking.getAttribute('data-expanded')).toBeNull()
    expect(await summary.evaluate(element => element.getBoundingClientRect().height))
      .toBeLessThanOrEqual(Number.parseFloat(summaryStyle.lineHeight) + 1)
    expect(await summary.evaluate(element => getComputedStyle(element).textOverflow)).toBe('ellipsis')

    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    await page.locator('tr[data-trajectory-row-key]', { hasText: DONE }).click()
    const details = page.getByRole('tabpanel')
    const trajectoryToggle = details.getByRole('button', { name: 'Thinking', exact: true })
    if (await trajectoryToggle.getAttribute('aria-expanded') !== 'true') await trajectoryToggle.click()
    const trajectoryHeading = details.locator('[data-markdown-variant="compact"] h1')
    await trajectoryHeading.waitFor({ timeout: 10_000 })
    expect(await trajectoryHeading.evaluate(element => getComputedStyle(element).fontSize)).toBe(summaryStyle.fontSize)
    const originalFontSize = await page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size'))
    try {
      for (const fontSize of [16, 17]) {
        await scaffold.ctx.settings.update('ui-theme', { fontSize })
        await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
          .toBe(`${String(fontSize)}px`)
        const typography = await details.evaluate((panel) => {
          const heading = panel.querySelector('[data-markdown-variant="compact"] h1')
          const paragraph = panel.querySelector('[data-markdown-variant="compact"] p')
          const answer = panel.querySelector('[class*="assistantOutput"] p')
          if (heading === null || paragraph === null || answer === null) throw new Error('Trajectory prose missing')
          const headingStyle = getComputedStyle(heading)
          const paragraphStyle = getComputedStyle(paragraph)
          return {
            headingSize: headingStyle.fontSize,
            paragraphSize: paragraphStyle.fontSize,
            lineHeight: paragraphStyle.lineHeight,
            noLargerThanAnswer: Number.parseFloat(paragraphStyle.fontSize) <= Number.parseFloat(getComputedStyle(answer).fontSize),
          }
        })
        expect(typography, `Trajectory with ${String(fontSize)}px content setting`).toEqual({
          headingSize: '13px', paragraphSize: '13px', lineHeight: '20px', noLargerThanAnswer: true,
        })
      }
    } finally {
      await scaffold.ctx.settings.update('ui-theme', { fontSize: Number.parseFloat(originalFontSize) })
      await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size')))
        .toBe(originalFontSize)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(EXPECTED_DIR, ['ui.expected.md'])
  })
})
