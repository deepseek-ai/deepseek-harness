/** External browser/Stagehand fixture; DSH registries, tools, and result logging remain real. */

import type { ModelConfig } from '@browserbasehq/stagehand'
import { z } from 'zod'

/** Explicit offline configuration; fixture AI calls never access a model provider. */
export const nativeModel = { modelName: 'openai/gpt-5.4-mini', apiKey: 'fixture-model-key' } as const satisfies ModelConfig

/** Valid PNG for the real attachment admission path. */
export const screenshotBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

/** Controllable external operations and acquired browser handles. */
export const fixture: {
  browsers: FixtureBrowser[]
  models: ModelConfig[]
  inference?: () => Promise<void>
  result?: unknown
  connections: Map<string, FixtureBrowser>
  createError?: Error
  create?: (model: ModelConfig) => Promise<void>
  navigate?: (page: FixturePage) => Promise<void>
  browserClose?: () => Promise<void>
  actResult?: { success: boolean; message: string }
  interrupt?: Promise<void>
  stagehandClose?: () => void | Promise<void>
  screenshot?: () => Promise<void>
} = { browsers: [], models: [], connections: new Map() }

/** Reset fixture state after the previous test has closed its contexts. */
export function resetFixture(): void {
  fixture.browsers = []
  fixture.models = []
  delete fixture.inference
  delete fixture.result
  fixture.connections.clear()
  delete fixture.createError
  delete fixture.create
  delete fixture.navigate
  delete fixture.browserClose
  delete fixture.actResult
  delete fixture.interrupt
  delete fixture.stagehandClose
  delete fixture.screenshot
}

/** A browser tab with only the operations exercised by the provider. */
export class FixturePage {
  currentURL = 'about:blank'
  constructor(readonly owner: FixtureBrowser, readonly pageId: string) {}
  async goto(url: string): Promise<void> { this.currentURL = url; await this.owner.track(Promise.resolve(fixture.navigate?.(this))) }
  async url(): Promise<string> { return this.currentURL }
  async title(): Promise<string> { return 'Fixture heading' }
  async screenshot(): Promise<Buffer> {
    await this.owner.track(Promise.race([fixture.screenshot?.(), this.owner.connectionClosed.then(() => { throw new Error('Fixture connection closed') })]))
    return Buffer.from(screenshotBase64, 'base64')
  }
  async close(): Promise<void> { this.owner.pages = this.owner.pages.filter(page => page !== this) }
}

/** Acquired browser with independently owned tabs and close state. */
export class FixtureBrowser {
  readonly pending = new Set<Promise<unknown>>()
  pages: FixturePage[] = []
  active: FixturePage
  closed = false
  stagehandClosed = false
  connectionClosed: Promise<void> = new Promise(() => {})
  readonly context = {
    pages: async (): Promise<FixturePage[]> => this.pages,
    activePage: async (): Promise<FixturePage | undefined> => this.pages.includes(this.active) ? this.active : this.pages[0],
    newPage: async (url?: string): Promise<FixturePage> => {
      const page = new FixturePage(this, `tab-${this.pages.length + 1}`)
      if (url) page.currentURL = url
      this.pages.push(page)
      this.active = page
      return page
    },
    setActivePage: async (page: FixturePage): Promise<void> => { this.active = page },
  }
  constructor(readonly origin: 'launched' | 'connected', readonly options: unknown) {
    this.active = new FixturePage(this, 'tab-1')
    this.pages.push(this.active)
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(() => { this.pending.delete(operation) }, () => { this.pending.delete(operation) })
    return operation
  }
  async close(): Promise<void> { await fixture.browserClose?.(); this.closed = true }
}

/** Only the external SDK acquisition operations are mocked. */
export const localBrowser = {
  async launch(options: unknown): Promise<FixtureBrowser> {
    const browser = new FixtureBrowser('launched', options)
    fixture.browsers.push(browser)
    return browser
  },
  async connect(options: unknown): Promise<FixtureBrowser> {
    const existing = fixture.connections.get((options as { cdpUrl: string }).cdpUrl)
    if (existing !== undefined) return existing
    const browser = new FixtureBrowser('connected', options)
    fixture.browsers.push(browser)
    return browser
  },
}

/** Native wrapper with an independent model and drainable external operations. */
export class Stagehand {
  private readonly closed: PromiseWithResolvers<void> = Promise.withResolvers()
  constructor(readonly browser: FixtureBrowser, readonly model: ModelConfig) { browser.connectionClosed = this.closed.promise }
  static async create(options: { browser: FixtureBrowser; model: ModelConfig }): Promise<Stagehand> {
    fixture.models.push(options.model)
    await fixture.create?.(options.model)
    if (fixture.createError) throw fixture.createError
    return new Stagehand(options.browser, options.model)
  }
  async close(): Promise<void> {
    await fixture.stagehandClose?.()
    await Promise.allSettled(this.browser.pending)
    this.browser.stagehandClosed = true
    this.closed.resolve()
  }
  async extract(_instruction: string, schemaOrOptions: unknown, _options?: unknown): Promise<unknown> {
    await this.browser.track(Promise.race([
      Promise.resolve(fixture.inference?.()),
      (fixture.interrupt ?? this.closed.promise).then(() => { throw new Error('Fixture browser disconnected') }),
    ]))
    const result = fixture.result ?? { extraction: 'Fixture heading' }
    return { data: schemaOrOptions instanceof z.ZodType ? schemaOrOptions.parse(result) : result }
  }
  async observe(instruction: string, options: unknown): Promise<unknown> { return this.extract(instruction, options) }
  async act(instruction: string, options: unknown): Promise<{ data: { success: boolean; message: string } }> {
    await this.extract(instruction, options)
    return { data: fixture.actResult ?? { success: true, message: 'Fixture action completed' } }
  }
}
