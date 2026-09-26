/** A turn that edits, creates, and shell-appends files in a git workspace ends with the changed-files card; its rows open the review. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import type { ChangesSummary } from '@deepseek-ai/dsh-client-ui-deliverables/src/changes.ts'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertFinalWorkspaceSnapshot, captureExpandedTurnProcessAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, recordFixture, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, connectFreshWorkspaceZh, expandOwningTurnProcess, ZH_BROWSER_LOCALE } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/changed-files-turn', import.meta.url))
const FIXTURE = join(DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()
const PROMPT = '不用先查看目录，直接做四件事：把 intro.md 里的标题「示例项目」改成「项目说明」，新建 src/util.ts 导出一个两数相加的 add 函数，新建 app.local 写一行 mode=demo，最后用 bash 在 notes.txt 末尾追加一行 done。'

/** Seed a committed repository so the turn's own edits are the only difference between its snapshots; `*.local` stays ignored. */
async function seedRepository(cwd: string): Promise<void> {
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'intro.md'), '# 示例项目\n\n一个用于演示的仓库。\n')
  await writeFile(join(cwd, 'notes.txt'), 'start\n')
  await writeFile(join(cwd, '.gitignore'), '*.local\n')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=seed@example.com', '-c', 'user.name=seed', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
}

/** Sample the real opacity transition at its midpoint without depending on wall-clock scheduling. */
function hoverOpacityTransition(page: Page, closing: boolean): Promise<{ duration: number; opacity: number }> {
  return page.evaluate(closing => new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const card = document.querySelector('[data-changes-hover-preview]')?.parentElement
      if (card === undefined || card === null || card.hasAttribute('data-closing') !== closing) return
      const initialOpacity = Number(getComputedStyle(card).opacity)
      const animation = card.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
      observer.disconnect()
      if (animation === undefined) { resolve({ duration: 0, opacity: initialOpacity }); return }
      animation.pause()
      animation.currentTime = 50
      const opacity = Number(getComputedStyle(card).opacity)
      const duration = Number(animation.effect!.getTiming().duration)
      animation.finish()
      resolve({ duration, opacity })
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-closing'] })
    if (closing) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }), closing)
}

describe('web e2e: a git workspace turn ends with its changed files', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let cwd: string
  let replayRoot: string | undefined
  let releasePreparations: (() => void) | undefined

  beforeAll(async () => {
    let replayOverride: string | undefined
    if (MODE !== 'record') {
      replayRoot = await mkdtemp(join(tmpdir(), 'dsh-changed-files-turn-replay-'))
      replayOverride = join(replayRoot, 'replay.override.json')
      const script = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
      // Recorded absolute paths must follow each isolated Session's working directory.
      const cwdToken = '{{fromRequest:Your working directory is ([^\\n]+)\\.}}'
      await writeFile(replayOverride, JSON.stringify(script).replaceAll('{{cwd}}', JSON.stringify(cwdToken).slice(1, -1)))
    }
    scaffold = await launchWebScaffold({
      developerTools: false,
      compareReplaySession: true,
      extraOverlayPath: fileURLToPath(new URL('./changed-files-turn.overlay.yml', import.meta.url)),
      ...(replayOverride === undefined ? {} : { replayFixture: FIXTURE, replayOverride }),
    })
    await seedRepository(join(scaffold.workspaceCwd, 'workspace'))
    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai',
    })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]')
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    releasePreparations?.()
    try {
      await browser?.close()
    } finally {
      try {
        await scaffold?.close()
      } finally {
        if (replayRoot !== undefined) await rm(replayRoot, { recursive: true, force: true })
      }
    }
  })

  it('records the edited, created, and shell-appended files with their line counts', async () => {
    if (MODE !== 'record') expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    const settled = scaffold.whenTurnSettled()
    const preparations = ['edit', 'write'].map(name => ({
      name, ready: Promise.withResolvers<{ callId: string; kilobytes: number }>(),
      release: Promise.withResolvers<undefined>(), held: false,
    }))
    const names = new Map<string, string>()
    const dispose = scaffold.ctx.on('llm/stream', async function* (_options, next) {
      for await (const chunk of next()) {
        yield chunk
        if (chunk.type !== 'tool-call-delta') continue
        if (chunk.name !== undefined) names.set(chunk.id, chunk.name)
        const preparation = preparations.find(value => value.name === names.get(chunk.id))
        if (preparation === undefined || preparation.held || chunk.argumentsDelta.length === 0) continue
        preparation.held = true
        preparation.ready.resolve({ callId: chunk.id, kilobytes: Math.ceil(chunk.argumentsDelta.length / 1024) })
        await preparation.release.promise
      }
    }, { prepend: true })
    releasePreparations = () => {
      for (const preparation of preparations) preparation.release.resolve(undefined)
      dispose()
    }
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const observations = preparations.map(async (preparation) => {
      const { callId, kilobytes } = await Promise.race([
        preparation.ready.promise,
        settled.then(() => { throw new Error(`No ${preparation.name} argument prefix was streamed`) }),
      ])
      const row = page.locator(`[data-chat-call-id="${callId}"] [data-state="preparing"]`)
      await row.waitFor({ state: 'attached' })
      await expandOwningTurnProcess(page, row)
      await row.getByText(`正在准备内容 ${kilobytes}KB`, { exact: true }).waitFor()
      expect(await row.getByRole('button').count()).toBe(0)
      expect(await row.locator('pre').count()).toBe(0)
      await compareOrRefreshGolden(join(DIR, `preparing-${preparation.name}.expected.md`), await row.ariaSnapshot(), MODE)
      preparation.release.resolve(undefined)
    })
    const [sessionId] = await Promise.all([settled, ...observations]).finally(() => { releasePreparations?.() })
    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session?.header.cwd === undefined) throw new Error('changed-files Session has no workspace')
    cwd = session.header.cwd
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)

    const announced = session.snapshotEvents().filter(event => event.type === 'workspace/changes').at(-1)
    expect(announced, 'the turn must announce its changed files').toBeDefined()
    if (announced === undefined) throw new Error('no changed-files announcement')
    expect(announced.data).toEqual({ turn: 1 })
    // The log carries only the turn; the Host serves the summary for the announcing event while the Session lives.
    const summary = scaffold.ctx.workspaceChanges.summary(sessionId, announced.seq)
    if (summary === undefined) throw new Error('the Host serves no summary for the announcement')
    // app.local is ignored by the repository, so its counts come from the write call rather than git.
    expect(summary.files.map(file => file.display)).toEqual(['app.local', 'intro.md', 'notes.txt', 'src/util.ts'])
    expect(summary.total).toBe(4)
    for (const file of summary.files) expect(file.added).toBeGreaterThan(0)
    expect(summary.files[0]).toMatchObject({ path: 'app.local', added: 1, deleted: 0 })
    expect(summary.files[2]).toMatchObject({ path: 'notes.txt', added: 1, deleted: 0 })
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('start\ndone\n')

    const card = page.locator('[data-changed-files]')
    expect(await card.count()).toBe(0)
    const header = page.locator('header').filter({ has: page.locator('[data-conversation-header-leading]') })
    expect(await header.getByRole('tablist').count()).toBe(0)
    const compactHeight = await header.evaluate(element => element.getBoundingClientRect().height)
    expect(compactHeight).toBeLessThan(60)
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.getByRole('switch', { name: '代码工作工具' }).click()
    await expect.poll(() => settings.getByRole('switch', { name: '代码工作工具' }).getAttribute('aria-checked')).toBe('true')
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    await header.getByRole('tablist').waitFor({ state: 'visible' })
    expect(await header.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(compactHeight)
    await card.waitFor({ state: 'visible' })
    expect(await card.getByText('已编辑 4 个文件', { exact: true }).count()).toBe(1)
    expect(await card.getByRole('listitem').count()).toBe(4)
    expect(await card.getByRole('button', { name: '展开全部 4 个改动文件' }).count()).toBe(0)
    // The header and every row open the turn's review in the Sidebar, with or without a Host desktop.
    expect(await card.getByRole('button', { name: '在侧边栏查看本轮改动' }).count()).toBe(1)
    expect(await card.getByRole('button', { name: '查看 notes.txt 的改动' }).count()).toBe(1)
    const geometry = await card.evaluate((element) => {
      const requiredElement = <T extends Element>(value: T | null | undefined, name: string): T => {
        if (value === null || value === undefined) throw new Error(`changed-files layout is missing ${name}`)
        return value
      }
      const header = requiredElement(element.children[0] as HTMLElement | undefined, 'header')
      const tile = requiredElement(header.children[0] as HTMLElement | undefined, 'tile')
      const icon = requiredElement(tile.querySelector('svg'), 'icon')
      const titles = requiredElement(header.children[1] as HTMLElement | undefined, 'titles')
      const title = requiredElement(titles.children[0] as HTMLElement | undefined, 'title')
      const stat = requiredElement(titles.children[1] as HTMLElement | undefined, 'stat')
      const list = requiredElement(element.querySelector('ul'), 'list')
      const row = requiredElement(list.querySelector('button'), 'row')
      const path = requiredElement(row.children[0] as HTMLElement | undefined, 'path')
      return {
        radius: getComputedStyle(element).borderRadius,
        headerHeight: header.getBoundingClientRect().height,
        headerPadding: getComputedStyle(header).padding,
        tileSize: `${tile.getBoundingClientRect().width}x${tile.getBoundingClientRect().height}`,
        tileBorder: getComputedStyle(tile).borderTopWidth,
        iconViewBox: icon.getAttribute('viewBox'),
        iconWidth: icon.getAttribute('width'),
        titleFontSize: getComputedStyle(title).fontSize,
        statFontSize: getComputedStyle(stat).fontSize,
        listPadding: getComputedStyle(list).padding,
        rowHeight: row.getBoundingClientRect().height,
        rowPadding: getComputedStyle(row).padding,
        rowFontSize: getComputedStyle(row).fontSize,
        pathFontSize: getComputedStyle(path).fontSize,
      }
    })
    expect(geometry).toEqual({
      radius: '16px',
      headerHeight: 60,
      headerPadding: '8px 10px',
      tileSize: '40x40',
      tileBorder: '1px',
      iconViewBox: '0 0 28 28',
      iconWidth: '20',
      titleFontSize: '13px',
      statFontSize: '10px',
      listPadding: '0px',
      rowHeight: 32,
      rowPadding: '7px 18px 7px 14px',
      rowFontSize: '11px',
      pathFontSize: '12px',
    })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('previews a single column with a scrollable path and no file notes or hunk headers', async () => {
    const card = page.locator('[data-changed-files]')
    const row = card.getByRole('button', { name: '查看 notes.txt 的改动' })
    const preview = page.locator('[data-changes-hover-preview]')
    const entrance = hoverOpacityTransition(page, false)
    await row.hover()
    expect(await entrance).toEqual({ duration: 100, opacity: 0.5 })
    await preview.locator('[data-review-view="unified"]').waitFor({ state: 'visible' })
    expect(await preview.locator('[data-diff-side]').count()).toBe(0)
    expect(await preview.locator('[data-diff-hunk-header]').isVisible()).toBe(false)
    const geometry = await preview.evaluate((element) => {
      const popup = element.parentElement!.getBoundingClientRect()
      const card = document.querySelector('[data-changed-files]')!.getBoundingClientRect()
      return { inset: popup.left - card.left, width: popup.width, cardWidth: card.width, height: popup.height }
    })
    expect(geometry.inset).toBe(24)
    expect(geometry.width).toBe(geometry.cardWidth - 48)
    expect(geometry.height).toBeLessThanOrEqual(420)
    const path = preview.locator('[data-changes-preview-path]')
    expect(await row.evaluate(element => document.getElementById(element.getAttribute('aria-describedby')!)?.textContent)).toBe(await path.textContent())
    expect(await path.getAttribute('tabindex')).toBeNull()
    const pathStyle = await path.evaluate((element) => {
      const style = getComputedStyle(element)
      return { family: style.fontFamily, overflow: style.overflowX, whiteSpace: style.whiteSpace, ellipsis: style.textOverflow }
    })
    expect(pathStyle.family).toMatch(/mono/i)
    expect(pathStyle).toMatchObject({ overflow: 'auto', whiteSpace: 'nowrap', ellipsis: 'clip' })
    await path.evaluate((element) => { element.style.maxWidth = '160px'; element.scrollLeft = 50 })
    expect(await path.evaluate(element => element.scrollLeft)).toBe(50)
    await path.evaluate((element) => { element.style.removeProperty('max-width') })
    await compareOrRefreshGolden(join(DIR, 'hover.expected.md'), await preview.locator('[data-review-view]').ariaSnapshot(), MODE)
    await preview.hover()
    await preview.locator('[data-review-view]').evaluate((element) => {
      const line = element.querySelector('[data-diff-line]')!
      for (let index = 0; index < 40; index++) element.appendChild(line.cloneNode(true))
    })
    await expect.poll(() => preview.evaluate(element => element.parentElement!.getBoundingClientRect().height)).toBe(420)
    const scroll = preview.locator('[data-review-view]')
    await scroll.evaluate((element) => { element.scrollTop = 80 })
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(80)
    await row.click()
    await preview.waitFor({ state: 'detached' })
    const review = page.locator('[data-changes-review]')
    await review.locator('[data-review-file="notes.txt"]').waitFor({ state: 'visible' })
    await review.locator('[data-review-view="unified"]').waitFor({ state: 'visible' })
    await card.getByRole('button', { name: '查看 src/util.ts 的改动' }).hover()
    await preview.locator('[data-diff-code]').first().waitFor({ state: 'visible' })
    expect(await preview.locator('[data-review-view="unified"]').count()).toBe(1)
    expect(await preview.locator('[data-diff-note]').isVisible()).toBe(false)
    // Empty comparisons keep their status; only metadata accompanying code is hidden.
    await preview.locator('[data-diff-note]').evaluate((element) => { element.setAttribute('data-diff-note', 'empty') })
    expect(await preview.locator('[data-diff-note]').isVisible()).toBe(true)
    await preview.locator('[data-diff-note]').evaluate((element) => { element.setAttribute('data-diff-note', 'metadata') })
    expect(await preview.locator('[data-diff-hunk-header]').isVisible()).toBe(false)
    await expect.poll(() => preview.evaluate(element => Number(getComputedStyle(element.parentElement!).opacity))).toBe(1)
    expect(await hoverOpacityTransition(page, true)).toEqual({ duration: 100, opacity: 0.5 })
    await preview.waitFor({ state: 'detached' })
    for (const key of ['Enter', 'Space']) {
      await page.mouse.move(0, 0)
      await row.focus()
      await row.hover()
      await preview.locator('[data-review-view="unified"]').waitFor({ state: 'visible' })
      await row.press(key)
      await preview.waitFor({ state: 'detached' })
      await review.locator('[data-review-file="notes.txt"]').waitFor({ state: 'visible' })
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('reviews a shell-appended file from the snapshots and an ignored file from its captured copies in one tab', async () => {
    const card = page.locator('[data-changed-files]')
    const column = page.locator('[data-rightbar-col]')
    const drawn = (root: ReturnType<typeof column.locator>) =>
      root.locator('[data-diff-line]').evaluateAll(lines => lines.map(line => `${line.getAttribute('data-diff-line')}:${line.textContent}`))
    const review = column.locator('[data-changes-review]')
    // The header lands on the first listed file; a row lands on its own.
    await card.getByRole('button', { name: '在侧边栏查看本轮改动' }).click()
    await review.locator('[data-review-file="app.local"]').waitFor({ state: 'visible' })
    await card.getByRole('button', { name: '查看 notes.txt 的改动' }).click()
    await review.locator('[data-review-file="notes.txt"]').waitFor({ state: 'visible' })
    expect(await column.locator('[data-dockkit-tab]').filter({ hasText: '第 1 轮改动' }).count()).toBe(1)
    await review.locator('[data-review-view="unified"]').waitFor({ state: 'visible' })
    const compareTool = review.locator('[data-review-tool="split"]')
    const wrapTool = review.locator('[data-review-tool="wrap"]')
    expect(await compareTool.evaluate(button => getComputedStyle(button).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    expect(await wrapTool.evaluate(button => getComputedStyle(button).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    expect(await compareTool.locator('svg').evaluate(icon => getComputedStyle(icon).transform)).toBe('matrix(0, 1, -1, 0, 0, 0)')
    expect(await compareTool.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => drawn(review)).toEqual(['context:11 start', 'add:2+done'])
    await wrapTool.click()
    await review.locator('[data-review-view="unified"][data-review-wrap]').waitFor({ state: 'visible' })
    expect(await compareTool.getAttribute('aria-pressed')).toBe('true')
    await wrapTool.click()
    const headerAlignment = await review.locator('[data-review-file="notes.txt"]').evaluate((button) => {
      const center = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      }
      const text = button.querySelector('span')
      const caret = button.querySelector('svg')
      const counts = button.parentElement?.nextElementSibling
      if (text === null || caret === null || counts === null || counts === undefined) {
        throw new Error('review selector alignment elements are missing')
      }
      const buttonCenter = center(button)
      return [center(text), center(caret), center(counts)].map(value => Math.abs(value - buttonCenter))
    })
    for (const offset of headerAlignment) expect(offset).toBeLessThanOrEqual(0.5)
    // The hunk header overflows the appended row when the comparison is narrow.
    const emptyRowLayout = await page.addStyleTag({ content: `
      [data-review-view="unified"] { width: 90px; }
    ` })
    try {
      const left = review.locator('[data-review-view="unified"]')
      const emptyRow = left.locator('[data-diff-line="add"]')
      const maximum = await left.evaluate(element => element.scrollWidth - element.clientWidth)
      expect(maximum).toBeGreaterThan(0)
      await left.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      await expect.poll(() => left.evaluate(element => element.scrollLeft)).toBe(maximum)
      const fill = await emptyRow.evaluate((row) => {
        const column = row.closest('[data-review-view]')!
        const columnBox = column.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        const y = rowBox.top + rowBox.height / 2
        return {
          rowWidth: rowBox.width,
          contentWidth: column.scrollWidth,
          background: getComputedStyle(row).backgroundColor,
          coversViewport: [columnBox.left + 4, columnBox.right - 4].every(x =>
            document.elementFromPoint(x, y)?.closest('[data-diff-line]') === row),
        }
      })
      expect(fill.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(fill.rowWidth).toBeGreaterThanOrEqual(fill.contentWidth - 0.5)
      expect(fill.coversViewport).toBe(true)
    } finally {
      await emptyRowLayout.evaluate(element => element.parentNode!.removeChild(element))
      await review.locator('[data-review-view]').evaluateAll((elements) => {
        for (const element of elements) element.scrollLeft = 0
      })
    }
    const primaryTextColour = await review.evaluate(element => getComputedStyle(element).color)
    const addedLine = review.locator('[data-diff-line="add"]')
    const rightContextLine = review.locator('[data-diff-line="context"]')
    const addedRule = await addedLine.evaluate((line) => {
      const number = line.children[0]
      const text = line.querySelector<HTMLElement>('span:last-child')
      if (number === undefined || text === null) throw new Error('added diff line is incomplete')
      const left = line.getBoundingClientRect().left
      return {
        shadow: getComputedStyle(number).boxShadow,
        markerColour: getComputedStyle(number).color,
        textColour: getComputedStyle(text).color,
        numberLeft: number.getBoundingClientRect().left - left,
        textLeft: text.getBoundingClientRect().left - left,
      }
    })
    const rightContextRule = await rightContextLine.evaluate((line) => {
      const number = line.children[0]
      const text = line.querySelector('span:last-child')
      if (number === undefined || text === null) throw new Error('context diff line is incomplete')
      const left = line.getBoundingClientRect().left
      return {
        numberLeft: number.getBoundingClientRect().left - left,
        textLeft: text.getBoundingClientRect().left - left,
      }
    })
    expect(addedRule.shadow).toContain(addedRule.markerColour)
    expect(addedRule.textColour).toBe(primaryTextColour)
    expect(addedRule.numberLeft).toBeCloseTo(rightContextRule.numberLeft, 1)
    expect(addedRule.textLeft).toBeCloseTo(rightContextRule.textLeft, 1)
    // The ignored file has no snapshot; its comparison comes from the copies captured around the write call.
    await review.getByRole('button', { name: '选择要查看的文件' }).click()
    const selectedAlignment = await page.getByRole('menuitem').filter({ hasText: 'notes.txt' }).evaluate((row) => {
      const center = (element: Element) => {
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      }
      const content = row.querySelector<HTMLElement>('span > span')
      const path = content?.children[0]
      const counts = content?.children[1]
      const check = row.querySelector(':scope > svg')
      if (path === undefined || counts === undefined || check === null) throw new Error('review menu alignment elements are missing')
      const rowCenter = center(row)
      return [center(path), center(counts), center(check)].map(value => Math.abs(value - rowCenter))
    })
    for (const offset of selectedAlignment) expect(offset).toBeLessThanOrEqual(0.5)
    await page.getByRole('menuitem').filter({ hasText: 'app.local' }).click()
    await review.locator('[data-review-file="app.local"]').waitFor({ state: 'visible' })
    await expect.poll(() => drawn(review)).toEqual(['add:1+mode=demo'])
    expect(await compareTool.getAttribute('aria-pressed')).toBe('true')
    expect(await review.getByText('本轮新建的文件').count()).toBe(1)
    // A mixed comparison uses the tab's retained split preference.
    await card.getByRole('button', { name: '查看 intro.md 的改动' }).click()
    await review.locator('[data-review-file="intro.md"]').waitFor({ state: 'visible' })
    expect(await column.locator('[data-dockkit-tab]').filter({ hasText: '第 1 轮改动' }).count()).toBe(1)
    await review.locator('[data-review-view="split"]').waitFor({ state: 'visible' })
    expect(await compareTool.getAttribute('aria-pressed')).toBe('true')
    const deletedLine = review.locator('[data-diff-side="left"] [data-diff-line="del"]').first()
    await expect.poll(() => deletedLine.evaluate(line => line.querySelector('[data-diff-code] span[style]') !== null)).toBe(true)
    const deletedRule = await deletedLine.evaluate((line) => {
      const number = line.children[0]
      const text = line.querySelector<HTMLElement>('span:last-child')
      if (number === undefined || text === null) throw new Error('deleted diff line is incomplete')
      const left = line.getBoundingClientRect().left
      return {
        shadow: getComputedStyle(number).boxShadow,
        markerColour: getComputedStyle(number).color,
        textColour: getComputedStyle(text).color,
        numberLeft: number.getBoundingClientRect().left - left,
        textLeft: text.getBoundingClientRect().left - left,
      }
    })
    const leftContextRule = await review.locator('[data-diff-side="left"] [data-diff-line="context"]').first().evaluate((line) => {
      const number = line.children[0]
      const text = line.children[1]
      if (number === undefined || text === undefined) throw new Error('context diff line is incomplete')
      const left = line.getBoundingClientRect().left
      return {
        numberLeft: number.getBoundingClientRect().left - left,
        textLeft: text.getBoundingClientRect().left - left,
      }
    })
    expect(deletedRule.shadow).toContain(deletedRule.markerColour)
    expect(deletedRule.textColour).toBe(primaryTextColour)
    expect(deletedRule.numberLeft).toBeCloseTo(leftContextRule.numberLeft, 1)
    expect(deletedRule.textLeft).toBeCloseTo(leftContextRule.textLeft, 1)
    await compareTool.click()
    await review.locator('[data-review-view="unified"]').waitFor({ state: 'visible' })
    expect(await compareTool.locator('svg').evaluate(icon => getComputedStyle(icon).transform)).toBe('none')
    await compareTool.click()
    await review.locator('[data-review-view="split"]').waitFor({ state: 'visible' })
    await expect.poll(() => drawn(review.locator('[data-diff-side="left"]'))).toEqual(['del:1# 示例项目', 'context:2', 'context:3一个用于演示的仓库。'])
    expect(await drawn(review.locator('[data-diff-side="right"]'))).toEqual(['del:1# 项目说明', 'context:2', 'context:3一个用于演示的仓库。'])
    // Constrain the recorded three-row diff to exercise unequal horizontal ranges and classic scrollbars.
    const scrollLayout = await page.addStyleTag({ content: `
      [data-changes-review] { height: 120px !important; }
      [data-diff-side] { scrollbar-width: auto; }
      [data-diff-side]::-webkit-scrollbar { width: 16px; height: 16px; }
      [data-diff-side="left"] { width: 65px; }
    ` })
    try {
      const left = review.locator('[data-diff-side="left"]')
      const right = review.locator('[data-diff-side="right"]')
      const metrics = (side: typeof left) => side.evaluate(element => ({
        x: element.scrollLeft, y: element.scrollTop,
        maxX: element.scrollWidth - element.clientWidth,
        maxY: element.scrollHeight - element.clientHeight,
        bottom: element.lastElementChild!.getBoundingClientRect().bottom,
      }))
      const initialLeft = await metrics(left)
      const initialRight = await metrics(right)
      expect(initialLeft.maxX).toBeGreaterThan(0)
      expect(initialRight.maxX).toBe(0)
      expect(initialLeft.maxY).toBeGreaterThan(0)
      expect(initialLeft.maxY).toBe(initialRight.maxY)
      await left.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      await expect.poll(async () => (await metrics(left)).x).toBe(initialLeft.maxX)
      await left.evaluate((element) => { element.scrollTop = element.scrollHeight })
      await expect.poll(async () => (await metrics(right)).y).toBe(initialLeft.maxY)
      // Two frames allow the browser-generated peer event to run before checking the source.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))))
      expect((await metrics(left)).x).toBe(initialLeft.maxX)
      expect((await metrics(left)).y).toBe(initialLeft.maxY)
      expect((await metrics(left)).bottom).toBeCloseTo((await metrics(right)).bottom, 1)
      await right.evaluate((element) => { element.scrollTop = 0 })
      await expect.poll(async () => (await metrics(left)).y).toBe(0)
      expect((await metrics(left)).x).toBe(initialLeft.maxX)
    } finally {
      await scrollLayout.evaluate(element => element.parentNode!.removeChild(element))
    }
    await review.getByRole('button', { name: '自动换行' }).click()
    await review.locator('[data-review-view][data-review-wrap]').waitFor({ state: 'visible' })
    await expect.poll(() => drawn(review)).toEqual(['del:1# 示例项目1# 项目说明', 'context:22', 'context:3一个用于演示的仓库。3一个用于演示的仓库。'])
    const wrappedAddition = review.locator('[data-diff-line="del"] > span').nth(1)
    const wrappedAdditionRule = await wrappedAddition.evaluate((cell) => {
      const number = cell.children[0]
      const text = cell.querySelector<HTMLElement>('[data-diff-code]')
      if (number === undefined || text === null) throw new Error('wrapped addition is incomplete')
      return {
        shadow: getComputedStyle(number).boxShadow,
        markerColour: getComputedStyle(number).color,
        textColour: getComputedStyle(text).color,
      }
    })
    expect(wrappedAdditionRule.shadow).toContain(wrappedAdditionRule.markerColour)
    expect(wrappedAdditionRule.textColour).toBe(primaryTextColour)
    // No desktop, so the tools offer the sidebar file but no native open.
    expect(await review.locator('[data-review-tool="open-file"]').count()).toBe(1)
    expect(await review.locator('[data-review-tool="open-native"]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('keeps the file menu aligned while dragging the floating review', async () => {
    const column = page.locator('[data-rightbar-col]')
    const tab = column.locator('[data-dockkit-tab]').filter({ hasText: '第 1 轮改动' })
    const tabBox = await tab.boundingBox()
    if (tabBox === null) throw new Error('review tab is not rendered')
    await page.mouse.move(tabBox.x + 6, tabBox.y + tabBox.height / 2)
    await page.mouse.down()
    try {
      await page.mouse.move(360, 140, { steps: 8 })
    } finally {
      await page.mouse.up()
    }
    const floating = page.locator('[data-dockkit-float]').filter({ has: page.locator('[data-changes-review]') })
    await floating.waitFor({ state: 'visible' })
    const selector = floating.getByRole('button', { name: '选择要查看的文件' })
    await selector.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ state: 'visible' })
    const grip = floating.locator('[data-dockkit-float-grip]')
    for (const delta of [{ x: 120, y: 60 }, { x: -60, y: -30 }]) {
      const handle = await grip.boundingBox()
      const before = await selector.boundingBox()
      if (handle === null || before === null) throw new Error('floating review controls are not rendered')
      const start = { x: handle.x + 12, y: handle.y + handle.height / 2 }
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      try {
        await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 8 })
        await expect.poll(async () => {
          const anchor = await selector.boundingBox()
          const list = await menu.boundingBox()
          if (anchor === null || list === null) throw new Error('review file menu disappeared during drag')
          return Math.max(
            Math.abs(anchor.x - before.x - delta.x), Math.abs(anchor.y - before.y - delta.y),
            Math.abs(list.x - anchor.x), Math.abs(list.y - anchor.y - anchor.height - 4),
          )
        }).toBeLessThanOrEqual(1)
      } finally {
        await page.mouse.up()
      }
    }
    await page.keyboard.press('Escape')
    await floating.locator('[data-dockkit-float-dock]').click()
    await floating.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps edge gestures inside either diff column and accepts reverse scrolling', async () => {
    const review = page.locator('[data-changes-review]')
    await review.getByRole('button', { name: '自动换行' }).click()
    const body = review.locator('[data-review-view="split"]:not([data-review-wrap])')
    await body.waitFor({ state: 'visible' })
    // A scrollable parent makes escaped edge gestures observable without native trackpad rebound.
    const layout = await page.addStyleTag({ content: `
      [data-changes-review] { height: 220px !important; }
      [data-review-view="split"] { display: block; max-width: 220px; }
      [data-review-view="split"] > div { width: 160px; height: 60px; margin: 160px; }
    ` })
    onTestFinished(async () => {
      await layout.evaluate(element => element.parentNode!.removeChild(element))
      await body.evaluate((element) => { element.scrollTo(0, 0) })
      await review.getByRole('button', { name: '自动换行' }).click()
    })
    const input = await page.context().newCDPSession(page)
    try {
      for (const side of ['left', 'right']) {
        const column = review.locator(`[data-diff-side="${side}"]`)
        for (const axis of ['x', 'y'] as const) {
          for (const end of [false, true]) {
            const parentPosition = await body.evaluate((element) => {
              const x = (element.scrollWidth - element.clientWidth) / 2
              const y = (element.scrollHeight - element.clientHeight) / 2
              element.scrollTo(x, y)
              return { x: element.scrollLeft, y: element.scrollTop }
            })
            expect(parentPosition.x).toBeGreaterThan(0)
            expect(parentPosition.y).toBeGreaterThan(0)
            const edge = await column.evaluate((element, { axis, end }) => {
              const maximum = axis === 'x'
                ? element.scrollWidth - element.clientWidth
                : element.scrollHeight - element.clientHeight
              element.scrollTo(axis === 'x' && end ? maximum : 0, axis === 'y' && end ? maximum : 0)
              return { maximum, offset: end ? maximum : 0 }
            }, { axis, end })
            expect(edge.maximum).toBeGreaterThan(0)
            const position = () => column.evaluate((element, axis) => axis === 'x' ? element.scrollLeft : element.scrollTop, axis)
            await expect.poll(position).toBe(edge.offset)
            const box = await column.boundingBox()
            if (box === null) throw new Error('diff column has no visible bounds')
            const gesture = { x: box.x + box.width / 2, y: box.y + box.height / 2, gestureSourceType: 'mouse' as const }
            const distance = end ? -80 : 80
            // CDP acknowledges the completed gesture, including default scrolling, before observation.
            await input.send('Input.synthesizeScrollGesture', {
              ...gesture, xDistance: axis === 'x' ? distance : 0, yDistance: axis === 'y' ? distance : 0,
            })
            expect(await body.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))).toEqual(parentPosition)
            expect(await position()).toBe(edge.offset)
            await input.send('Input.synthesizeScrollGesture', {
              ...gesture, xDistance: axis === 'x' ? -distance : 0, yDistance: axis === 'y' ? -distance : 0,
            })
            await expect.poll(position).not.toBe(edge.offset)
          }
        }
      }
    } finally {
      await input.detach()
    }
  })

  it('fills empty alignment rows across a mixed comparison’s scrollable columns', async () => {
    const preview = await page.context().newPage()
    onTestFinished(async () => { await preview.close() })
    await preview.route('**/api/changes.diff?*', route => route.fulfill({ json: {
      kind: 'text', path: 'notes.txt', display: 'notes.txt', before: true, after: true, coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-before', '+after', '+extra'] }],
    } }))
    await preview.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await preview.locator('[data-changed-files]').getByRole('button', { name: '查看 notes.txt 的改动' }).click()
    const review = preview.locator('[data-changes-review]')
    await review.locator('[data-review-view="split"]').waitFor({ state: 'visible' })
    const emptyRowLayout = await preview.addStyleTag({ content: `
      [data-diff-side="left"] { width: 90px; }
      [data-diff-side="right"] { width: 120px; }
    ` })
    try {
      const left = review.locator('[data-diff-side="left"]')
      const emptyRow = left.locator('[data-diff-line="add"]')
      const maximum = await left.evaluate(element => element.scrollWidth - element.clientWidth)
      expect(maximum).toBeGreaterThan(0)
      await left.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      await expect.poll(() => left.evaluate(element => element.scrollLeft)).toBe(maximum)
      const fill = await emptyRow.evaluate((row) => {
        const column = row.closest('[data-diff-side]')!
        const columnBox = column.getBoundingClientRect()
        const rowBox = row.getBoundingClientRect()
        const y = rowBox.top + rowBox.height / 2
        return {
          rowWidth: rowBox.width,
          contentWidth: column.scrollWidth,
          background: getComputedStyle(row).backgroundColor,
          coversViewport: [columnBox.left + 4, columnBox.right - 4].every(x =>
            document.elementFromPoint(x, y)?.closest('[data-diff-line]') === row),
        }
      })
      expect(fill.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(fill.rowWidth).toBeGreaterThanOrEqual(fill.contentWidth - 0.5)
      expect(fill.coversViewport).toBe(true)
    } finally {
      await emptyRowLayout.evaluate(element => element.parentNode!.removeChild(element))
      await review.locator('[data-diff-side]').evaluateAll((elements) => {
        for (const element of elements) element.scrollLeft = 0
      })
    }
  })

  it.skipIf(MODE === 'record')('replays the workspace and the Chinese conversation', async () => {
    await assertFinalWorkspaceSnapshot(DIR, cwd, { ignoredRootEntries: ['.git'] })
    const aria = await captureExpandedTurnProcessAria(page, '[data-chat-flow]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
  })

  it('preserves filename endings when the review narrows and updates the fade after resizing or selecting another file', async () => {
    const preview = await page.context().newPage()
    onTestFinished(async () => { await preview.close() })
    const previewTripwire = watchConsole(preview)
    const prefix = 'src/components/review/' + 'long-filename-'.repeat(8)
    const names = [`${prefix}before.ts`, `${prefix}after.ts`] as const
    // Project long display names into a separate page; recorded paths, comparisons, and Session data stay intact.
    await preview.route('**/api/changes.summary?*', async (route) => {
      const response = await route.fetch()
      const summary = await response.json() as ChangesSummary
      await route.fulfill({ response, json: {
        ...summary, files: summary.files.map((file, index) => ({ ...file, display: names[index] ?? file.display })),
      } })
    })
    await preview.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await preview.locator('[data-changed-files]').getByRole('button', { name: '在侧边栏查看本轮改动' }).click()
    const review = preview.locator('[data-changes-review]')
    const selector = review.getByRole('button', { name: '选择要查看的文件' })
    const label = selector.locator('[data-path-label]')
    const layout = await preview.addStyleTag({ content: '[data-sidebar-right-panel] { width: 340px !important; }' })
    const resize = async (width: number) => {
      await layout.evaluate((element, width) => {
        element.textContent = `[data-sidebar-right-panel] { width: ${width}px !important; }`
      }, width)
    }
    const metrics = () => label.evaluate((element) => {
      const text = element.firstElementChild!
      const box = element.getBoundingClientRect()
      const textBox = text.getBoundingClientRect()
      const filename = text.lastElementChild!
      const suffix = document.createRange()
      const node = filename.firstChild!
      suffix.setStart(node, Math.max(0, node.textContent!.length - 'before.ts'.length))
      suffix.setEnd(node, node.textContent!.length)
      const suffixBox = suffix.getBoundingClientRect()
      return {
        clipped: element.hasAttribute('data-path-clipped'), mask: getComputedStyle(element).maskImage,
        left: textBox.left - box.left, right: box.right - textBox.right,
        suffixVisible: suffixBox.left >= box.left && suffixBox.right <= box.right + 0.5,
        directoryColor: getComputedStyle(text.firstElementChild!).color,
        nameColor: getComputedStyle(filename).color,
      }
    })
    await expect.poll(async () => (await metrics()).clipped).toBe(true)
    const clipped = await metrics()
    expect(clipped.left).toBeLessThan(0)
    expect(Math.abs(clipped.right)).toBeLessThanOrEqual(0.5)
    expect(clipped.suffixVisible).toBe(true)
    expect(clipped.mask).toContain('linear-gradient')
    expect(clipped.directoryColor).not.toBe(clipped.nameColor)
    expect(await label.getAttribute('title')).toBe(names[0])
    const controls = await selector.evaluate((button) => {
      const header = button.parentElement!.parentElement!
      const bounds = header.getBoundingClientRect()
      const caret = button.querySelector('svg')!
      const counts = button.parentElement!.nextElementSibling!
      return [caret, counts, ...header.querySelectorAll('[data-review-tool]')].map((element) => {
        const box = element.getBoundingClientRect()
        return box.width > 0 && box.left >= bounds.left && box.right <= bounds.right
      })
    })
    expect(controls.every(Boolean)).toBe(true)
    await selector.click()
    await preview.getByRole('menuitem').filter({ hasText: names[1] }).click()
    await expect.poll(() => label.getAttribute('title')).toBe(names[1])
    expect((await metrics()).suffixVisible).toBe(true)
    await resize(1400)
    await expect.poll(async () => (await metrics()).clipped).toBe(false)
    expect((await metrics()).left).toBeCloseTo(0, 1)
    expect((await metrics()).mask).toBe('none')
    await resize(340)
    await expect.poll(async () => (await metrics()).clipped).toBe(true)
    await selector.click()
    await preview.getByRole('menuitem').filter({ hasText: 'src/util.ts' }).click()
    await expect.poll(() => label.getAttribute('title')).toBe('src/util.ts')
    await expect.poll(async () => (await metrics()).clipped).toBe(false)
    expect((await metrics()).left).toBeCloseTo(0, 1)
    expect((await metrics()).mask).toBe('none')
    expect(previewTripwire.pageErrors).toEqual([])
    expect(previewTripwire.warnings).toEqual([])
  })

})
