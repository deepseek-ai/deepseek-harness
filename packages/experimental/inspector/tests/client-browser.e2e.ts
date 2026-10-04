import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { chromium, type Browser, type Page } from 'playwright'
import WebSocket, { type RawData } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'
import { publishCordisTree } from '../src/shared/cordis/publisher.ts'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const clientBundlePath = join(packageDirectory, 'lib/client.js')
const clientSourceMapPath = join(packageDirectory, 'lib/client.js.map')
const built = existsSync(clientBundlePath) && existsSync(clientSourceMapPath)

interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown>
  readonly error?: { message: string }
}

class BrowserTestCdpClient {
  private nextId = 0
  private readonly pending = new Map<number, (message: CdpMessage) => void>()
  private readonly events: CdpMessage[] = []
  private readonly waiters = new Set<() => void>()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(rawText(data)) as CdpMessage
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message)
        return
      }
      this.events.push(message)
      for (const waiter of [...this.waiters]) waiter()
    })
  }

  static async connect(url: string): Promise<BrowserTestCdpClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    return new BrowserTestCdpClient(socket)
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP call timed out: ${method}`))
      }, 5_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(message)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  waitForEvent(method: string, predicate: (message: CdpMessage) => boolean): Promise<CdpMessage> {
    const existing = this.events.find(event => event.method === method && predicate(event))
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(new Error(`CDP event timed out: ${method}`))
      }, 5_000)
      const check = (): void => {
        const event = this.events.find(candidate => candidate.method === method && predicate(candidate))
        if (event === undefined) return
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve(event)
      }
      this.waiters.add(check)
    })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>((resolve) => { this.socket.once('close', () => { resolve() }) })
    this.socket.close()
    await closed
  }
}

describe.skipIf(!built)('Inspector built Client in Chromium', () => {
  let inspector: InspectorHandle | undefined
  let server: Server | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let cdp: BrowserTestCdpClient | undefined

  afterEach(async () => {
    await page?.evaluate(() => {
      const state = Reflect.get(globalThis, '__INSPECTOR_BROWSER_TEST__') as { dispose?: () => void } | undefined
      state?.dispose?.()
    }).catch(() => {})
    await cdp?.close()
    await browser?.close()
    await inspector?.close()
    if (server !== undefined) await new Promise<void>((resolve) => { server!.close(() => { resolve() }) })
    page = undefined
    cdp = undefined
    browser = undefined
    inspector = undefined
    server = undefined
  })

  it('preserves Chrome node identities across recursive and shallower Cordis expansion', async (test) => {
    const host = new Context()
    test.onTestFinished(async () => { await host.fiber.dispose() })
    const outer = await host.plugin({
      name: 'browser-tree-outer',
      apply(ctx: Context) { ctx.plugin({ name: 'browser-tree-inner', apply() {} }) },
    })
    inspector = await startInspector({ port: 0, captureFetch: false, startupTimeoutMs: test.task.timeout })
    const stopObserving = publishCordisTree(host, inspector.source, { maxNodes: 100, maxBytes: 64 * 1024 })
    test.onTestFinished(stopObserving)
    browser = await chromium.launch({ executablePath: chromium.executablePath() })
    page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.goto(inspector.endpoint.devtoolsFrontendUrl)
    await page.getByRole('treeitem').first().waitFor()

    // Chrome's Elements view retains DOMNode objects while getSubtree requests missing descendants.
    const result: unknown = await page.evaluate(`(async () => {
      const SDK = await import('./core/sdk/sdk.js')
      const model = SDK.TargetManager.TargetManager.instance().models(SDK.DOMModel.DOMModel)[0]
      const host = model.existingDocument().children()[0]
      const root = host.children()[0]
      const outer = root.children().find(node => node.getAttribute('uid') === ${JSON.stringify(String(outer.uid))})
      const before = outer.children()
      await host.getSubtree(100, true)
      const owned = outer.children()?.[0]
      const inner = owned?.children()?.[0]
      const innerContext = inner?.children()?.[0]
      await host.getSubtree(1, true)
      return {
        before,
        sameRoot: host.children()[0] === root,
        sameFiber: root.children().find(node => node.id === outer.id) === outer,
        sameOwned: outer.children()?.[0] === owned,
        sameInner: owned?.children()?.[0] === inner,
        sameInnerContext: inner?.children()?.[0] === innerContext,
        names: [owned, inner, innerContext].map(node => node?.nodeName() ?? null),
      }
    })()`)
    expect(result).toEqual({
      before: null,
      sameRoot: true,
      sameFiber: true,
      sameOwned: true,
      sameInner: true,
      sameInnerContext: true,
      names: ['CONTEXT', 'FIBER', 'CONTEXT'],
    })
    expect(errors).toEqual([])
  })

  it('forwards Console values and exposes the built bundle as read-only source', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false, maxClientSourceBytes: 1_000_000 })
    const bundle = await readFile(clientBundlePath)
    const sourceMap = await readFile(clientSourceMapPath)
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/client.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
        response.end(bundle)
        return
      }
      if (url.pathname === '/client.js.map') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(sourceMap)
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(browserFixture(inspector!.endpoint.client))
    })
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as import('node:net').AddressInfo).port

    browser = await chromium.launch()
    page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${String(port)}/`)
    await page.waitForFunction(() => Reflect.get(globalThis, '__INSPECTOR_BROWSER_TEST__') !== undefined)

    cdp = await BrowserTestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')
    const contextEvent = await cdp.waitForEvent('Runtime.executionContextCreated', (event) => {
      const context = event.params?.context as Record<string, unknown> | undefined
      return String(context?.name).startsWith('Client —')
    })
    const context = contextEvent.params?.context as Record<string, unknown>
    const contextId = context.id
    const uniqueContextId = context.uniqueId
    const sourceId = asRecord(context.auxData).sourceId
    expect(contextId).toBeTypeOf('number')
    expect(uniqueContextId).toBeTypeOf('string')
    expect(sourceId).toBeTypeOf('string')

    const evaluated = await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.__inspectorConsoleEvaluation = { answer: 6 * 7 }',
      objectGroup: 'console',
      includeCommandLineAPI: true,
      silent: false,
      returnByValue: false,
      generatePreview: true,
      userGesture: true,
      awaitPromise: false,
      replMode: true,
      allowUnsafeEvalBlockedByCSP: false,
      uniqueContextId,
    })
    expect(evaluated.error).toBeUndefined()
    expect(asRecord(evaluated.result?.result).objectId).toMatch(/^runtime:/u)
    expect(await page.evaluate(() => Reflect.get(globalThis, '__inspectorConsoleEvaluation') as unknown)).toEqual({
      answer: 42,
    })

    await page.evaluate(() => {
      const value = { browser: true, nested: { ready: true } }
      Reflect.set(globalThis, '__inspectorBrowserValue', value)
      console.log(value, 'browser-client-console')
      setTimeout(() => { throw new Error('browser-client-exception') }, 0)
    })
    const consoleEvent = await cdp.waitForEvent('Runtime.consoleAPICalled', event =>
      event.params?.executionContextId === contextId && hasArgument(event, 'browser-client-console'))
    const args = consoleEvent.params?.args
    if (!Array.isArray(args)) throw new Error('Client Console event has no arguments')
    expect((consoleEvent.params?.stackTrace as { callFrames?: unknown[] } | undefined)?.callFrames?.length)
      .toBeGreaterThan(0)
    const objectId = asRecord(args[0]).objectId
    expect(String(objectId)).toMatch(/^runtime:/u)
    const properties = await cdp.call('Runtime.getProperties', { objectId, ownProperties: true })
    expect(propertyValue(properties, 'browser')).toBe(true)
    const exception = await cdp.waitForEvent('Runtime.exceptionThrown', (event) => {
      const details = event.params?.exceptionDetails as Record<string, unknown> | undefined
      return details !== undefined
        && details.executionContextId === contextId
        && String((details.exception as Record<string, unknown> | undefined)?.description).includes('browser-client-exception')
    })
    const exceptionDetails = exception.params?.exceptionDetails as Record<string, unknown>
    expect((exceptionDetails.stackTrace as { callFrames?: unknown[] } | undefined)?.callFrames?.length)
      .toBeGreaterThan(0)

    const enabled = await cdp.call('Debugger.enable')
    expect(enabled.error).toBeUndefined()
    expect(enabled.result?.debuggerId).toBeTypeOf('string')
    const script = await cdp.waitForEvent('Debugger.scriptParsed', event =>
      String(event.params?.url).includes('/client.js?rev=browser-test'))
    expect(script.params).toMatchObject({ executionContextId: contextId, buildId: '' })
    const scriptId = script.params?.scriptId
    const content = await cdp.call('Debugger.getScriptSource', { scriptId })
    expect(String(content.result?.scriptSource)).toContain('ClientInspectorSource')
    expect((await cdp.call('Debugger.setBreakpointByUrl', {
      url: script.params?.url,
      lineNumber: 0,
    })).error?.message).toContain('Client native debugging is unavailable')

    const duplicateContext = cdp.waitForEvent('Runtime.executionContextCreated', (event) => {
      const candidate = event.params?.context as Record<string, unknown> | undefined
      return String(candidate?.name).startsWith('Client —') && candidate?.id !== contextId
    })
    const popup = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate(() => {
        if (window.open(location.href, '_blank') === null) throw new Error('duplicate tab was blocked')
      }),
    ]).then(([opened]) => opened)
    await popup.waitForFunction(() => Reflect.get(globalThis, '__INSPECTOR_BROWSER_TEST__') !== undefined)
    const duplicate = (await duplicateContext).params?.context as Record<string, unknown>
    expect(asRecord(duplicate.auxData).sourceId).not.toBe(sourceId)
    await cdp.call('Debugger.disable')
    await popup.evaluate(async () => {
      const state = Reflect.get(globalThis, '__INSPECTOR_BROWSER_TEST__') as { dispose?: () => Promise<void> } | undefined
      await state?.dispose?.()
    })
    await popup.close()
  }, 20_000)
})

function browserFixture(bootstrap: InspectorHandle['endpoint']['client']): string {
  const boot = {
    rev: 'browser-test',
    entries: [{
      id: '@deepseek-ai/dsh-experimental-inspector',
      url: '/client.js?rev=browser-test',
      rev: 'browser-test',
    }],
  }
  return `<!doctype html>
<title>Inspector Browser Client</title>
<script>
globalThis.__DSH_INSPECTOR__ = ${JSON.stringify(bootstrap)};
globalThis.__DSH_BOOT__ = ${JSON.stringify(boot)};
globalThis.__ModuleLoader__ = { load(registration) { globalThis.__INSPECTOR_REGISTRATION__ = registration; } };
</script>
<script src="/client.js?rev=browser-test"></script>
<script type="module">
const registration = globalThis.__INSPECTOR_REGISTRATION__;
const disposers = [];
const root = {
  __inspectorContext: true,
  registry: new Map(),
  events: { _hooks: {} },
  async effect(callback) { const dispose = await callback(); disposers.push(dispose); return dispose; },
  on() { return () => {}; },
  inject() { return { dispose() {} }; },
  provide(name, value) { this[name] = value; return () => { delete this[name]; }; },
};
root.root = root;
const cordis = { Context: { is(value) { return value?.__inspectorContext === true; } } };
const plugin = registration.factory(specifier => {
  if (specifier === '@deepseek-ai/cordis') return cordis;
  throw new Error('Unexpected Client bundle dependency ' + specifier);
});
await plugin.apply(root);
globalThis.__INSPECTOR_BROWSER_TEST__ = {
  async dispose() { for (const dispose of disposers.reverse()) await dispose(); },
};
</script>`
}

function hasArgument(event: CdpMessage, value: unknown): boolean {
  const args = event.params?.args
  return Array.isArray(args) && args.some(argument => asRecord(argument).value === value)
}

function propertyValue(response: CdpMessage, name: string): unknown {
  const result = response.result?.result
  if (!Array.isArray(result)) throw new Error('Runtime.getProperties returned no property list')
  const property = result.map(asRecord).find(candidate => candidate.name === name)
  return asRecord(property?.value).value
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a record')
  return value as Readonly<Record<string, unknown>>
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}
