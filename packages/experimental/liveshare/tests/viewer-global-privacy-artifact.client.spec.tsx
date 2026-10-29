// @vitest-environment jsdom
/** Assembled viewer page privacy against the production Owner reader; ordinary Session data uses a scripted Owner. */
import type { ClientConnectionRpc, ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PrivacyOwnerModule, PrivacyOwnerReader } from './viewer-privacy-bridge.ts'
import { parseViewerRequest } from '../src/viewer-channel.ts'
import type { ViewerAnswer, ViewerCallRequest } from '../src/viewer-channel.ts'
import { createFixtureFaces } from './viewer-fixture.client.ts'
import type { FixtureWorld } from './viewer-fixture.client.ts'
import { installViewerInputFixture, promptEcho } from './viewer-input-fixture.client.ts'
import type { ViewerInputFixture } from './viewer-input-fixture.client.ts'
import { installViewerRelay } from './viewer-relay.client.ts'

/** The generated contribution is a build artifact; the mount boundary is what this face test covers. */
vi.mock('@deepseek-ai/dsh-experimental-liveshare/remote', () => ({ default: { package: '@deepseek-ai/dsh-experimental-liveshare', methods: {} } }))

const blockedEndpoints = ['settings/describe', 'credentials/describe', 'agentPresets/list', 'agentPresets/read']
const sentinels = ['SYNTHETIC_SECRET_NEVER_RETURN', 'private-provider.invalid', '/fixture/private-root', 'private-tenant']

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
}

/** Relay bridge preserving the production reader's HTTP status and body for global reads. */
function installPrivacyRelay(owner: FixtureWorld, reader: PrivacyOwnerReader) {
  const answers: { endpoint: string; answer: ViewerAnswer }[] = []
  const ordinaryCalls: string[] = []
  const responseStatuses: number[] = []
  const pending = new Set<Promise<Response>>()
  const answeredRequests = new WeakMap<ViewerCallRequest, ViewerAnswer>()
  const rpc: ClientConnectionRpc = {
    async call(channel, endpoint, payload, signal) {
      if (!blockedEndpoints.includes(endpoint)) {
        ordinaryCalls.push(endpoint)
        return owner.rpc.call(channel, endpoint, payload, signal)
      }
      const request = parseViewerRequest(payload)
      if (request?.op !== 'call') throw new Error('privacy relay: global call has no viewer envelope')
      const answer = await reader.answer(request, signal)
      answeredRequests.set(payload as ViewerCallRequest, answer)
      answers.push({ endpoint, answer })
      // The reader owns this wire JSON: the Owner Gateway's response envelope. The Relay decodes its
      // ordinary Connection result only.
      return (answer.body as { readonly result: Awaited<ReturnType<ClientConnectionRpc['call']>> }).result
    },
    ...(owner.rpc.open === undefined ? {} : { open: owner.rpc.open }),
  }
  const stopScriptedRelay = installViewerRelay({
    owner: rpc,
    other: async (url) => {
      if (url.includes('/__liveshare/context')) return Response.json({
        shareId: 'share-1', sessionId: 'fx-alpha', ownerDisplayName: 'Owner',
        capabilities: { readOnly: true, sessionMode: 'write' },
      })
      if (url.endsWith('/health')) return Response.json({ release_id: 'release-7' })
      throw new Error(`privacy relay: unexpected request ${url}`)
    },
  })
  const scriptedFetch = globalThis.fetch
  const answerRead = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('/__share/rpc')) return scriptedFetch(input, init)
    const request = parseViewerRequest(JSON.parse(typeof init?.body === 'string' ? init.body : ''))
    if (request?.op !== 'call') return scriptedFetch(input, init)
    const endpoint = request.path.replace(/^\/api\//u, '')
    if (!blockedEndpoints.includes(endpoint)) return scriptedFetch(input, init)
    await rpc.call('/api', endpoint, request, init?.signal ?? undefined)
    const answer = answeredRequests.get(request)
    if (answer === undefined) throw new Error('privacy relay: missing Owner answer')
    const response = Response.json(answer.body, { status: answer.status })
    responseStatuses.push(response.status)
    return response
  }
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const result = answerRead(input, init)
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    return result
  })
  return {
    answers, ordinaryCalls, responseStatuses,
    async dispose() {
      await stopScriptedRelay()
      await Promise.all([...pending])
    },
  }
}

describe('Assembled viewer page global configuration privacy', () => {
  it.each([
    { authority: 'loopback', origin: 'http://localhost:3000', language: 'en-US', locale: 'en', send: 'Send message', earlier: 'Load earlier' },
    { authority: 'public', origin: 'https://viewer.example.test', language: 'zh-CN', locale: 'zh', send: '发送消息', earlier: '加载更早' },
  ])('keeps $authority settings private without losing Session grants or presentation', async ({ authority, origin, language, locale, send, earlier }) => {
    // Vitest's jsdom environment exposes its JSDOM instance; reconfigure changes the actual page authority.
    const jsdom = Reflect.get(globalThis, 'jsdom') as { reconfigure(options: { url: string }): void }
    const savedUrl = location.href
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
    const existingHead = new Set(document.head.children)
    let input: ViewerInputFixture | undefined = undefined
    let owner: FixtureWorld | undefined = undefined
    let reader: PrivacyOwnerReader | undefined = undefined
    let relay: ReturnType<typeof installPrivacyRelay> | undefined = undefined
    onTestFinished(async () => {
      try { await input?.dispose() } finally {
        try { await relay?.dispose() } finally {
          try { reader?.close() } finally {
            owner?.dispose()
            cleanup()
            vi.unstubAllGlobals()
            if (originalFetch === undefined) Reflect.deleteProperty(globalThis, 'fetch')
            else Object.defineProperty(globalThis, 'fetch', originalFetch)
            document.body.replaceChildren()
            for (const node of [...document.head.children]) if (!existingHead.has(node)) node.remove()
            jsdom.reconfigure({ url: savedUrl })
          }
        }
      }
    })
    jsdom.reconfigure({ url: `${origin}/?shareId=share-1&fixture&fixturePresented=1` })
    input = installViewerInputFixture()
    Object.defineProperty(navigator, 'languages', { configurable: true, value: [language] })
    Object.defineProperty(navigator, 'language', { configurable: true, value: language })
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('EventSource', class { addEventListener(): void {} close(): void {} })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => { callback(0) }, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(id) })
    const container = document.createElement('div')
    container.id = 'root'
    document.body.replaceChildren(container)
    owner = createFixtureFaces({
      presented: true, controlledReply: true, viewerSourceGrant: () => ({ sessionMode: 'write' }),
    })
    const dispatch = vi.fn(async () => Response.json({
      result: { ok: true, value: { secret: sentinels.join('|') } },
    }))
    const ownerModulePath = './viewer-privacy-owner.ts'
    const { createPrivacyOwnerReader } = await vi.importActual<PrivacyOwnerModule>(ownerModulePath)
    reader = createPrivacyOwnerReader(dispatch)
    relay = installPrivacyRelay(owner, reader)
    await act(async () => { await input?.mount(container, { shareId: 'share-1', sessionId: 'fx-alpha' }) })
    await waitFor(() => { expect(document.querySelector('[data-sample="bash"]')).not.toBeNull() }, { timeout: 30_000 })

    const context = input.context()
    expect(context.get('connection')?.isLoopback).toBe(authority === 'loopback')
    expect(context.get('remote')?.$host.isLoopback).toBe(authority === 'loopback')
    const transport = Reflect.get(globalThis, '__DSH_TRANSPORT__') as { readonly ownsHost?: boolean }
    expect(transport.ownsHost).toBeUndefined()
    const forms = context.get('configForms')
    if (forms === undefined) throw new Error('assembled viewer page configuration forms did not activate')
    await act(async () => { await forms.describe().ensure() })
    expect(relay.answers.filter(item => item.endpoint === 'settings/describe').length).toBeGreaterThan(0)
    expect(forms.describe().getSnapshot().view).toBeUndefined()
    expect(forms.describe().getSnapshot().error).toContain('settings/describe')

    // Direct callers still cross the production viewer transport; absence of Settings UI is not enforcement.
    const connection = context.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error('assembled viewer page Connection did not activate')
    const denialCount = relay.answers.length
    // The Owner Gateway refuses each one through remote access: the share's provider names the
    // page's read-only reason, and the RPC answer is an ordinary response carrying that failure.
    for (const endpoint of blockedEndpoints) {
      const result = await connection.rpc.call('/api', endpoint, { args: { agentPreset: 'private-preset' } })
      expect(result).toMatchObject({
        ok: false, error: { code: 'remote-access/denied', details: { reason: 'liveshare/read-only' } },
      })
    }
    expect(relay.answers).toHaveLength(denialCount + blockedEndpoints.length)
    expect(relay.answers.map(item => item.endpoint)).toEqual(expect.arrayContaining(blockedEndpoints))
    for (const { answer } of relay.answers) {
      expect(answer).toMatchObject({
        status: 200, body: { type: 'server-response', result: { ok: false, error: { code: 'remote-access/denied' } } },
      })
    }
    expect(relay.responseStatuses).toEqual(relay.answers.map(() => 200))
    expect(dispatch).not.toHaveBeenCalled()
    expect(relay.ordinaryCalls.filter(endpoint => blockedEndpoints.includes(endpoint))).toEqual([])
    expect(forms.describe().getSnapshot().view).toBeUndefined()
    for (const sentinel of sentinels) {
      expect(JSON.stringify(relay.answers)).not.toContain(sentinel)
      expect(JSON.stringify(forms.describe().getSnapshot())).not.toContain(sentinel)
      expect(document.body.textContent).not.toContain(sentinel)
    }
    expect(screen.queryByRole('button', { name: /^(设置|Settings)$/u })).toBeNull()
    expect(context.get('theme')?.getTheme().preference).toBe('system')
    expect(context.get('locale')?.getLocale().active).toBe(locale)
    expect(document.documentElement.lang).toBe(locale === 'zh' ? 'zh-CN' : 'en')
    expect(document.documentElement.style.colorScheme).toMatch(/^(light|dark)$/u)
    expect(document.body.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    expect(document.body.textContent).toContain('问题 51：fixture 历史消息')
    expect(document.querySelector('pre.shiki code')).not.toBeNull()
    const delivered = document.querySelector<HTMLElement>('[data-presented-files-row]')
    if (delivered === null) throw new Error('assembled viewer page delivered-file card is missing')
    expect(within(delivered).getByText('demo.txt')).toBeDefined()
    await waitFor(() => {
      expect([...document.querySelectorAll<HTMLImageElement>('img')].some(image =>
        image.src.startsWith('data:image/png') || image.src.startsWith('blob:'))).toBe(true)
    }, { timeout: 15_000 })
    await waitFor(() => { expect(document.querySelector('[data-liveshare-viewer-seat="model"]')?.textContent).toMatch(/deepseek/iu) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: earlier })) })
    await waitFor(() => { expect(document.body.textContent).toContain('问题 50') }, { timeout: 15_000 })
    expect(relay.ordinaryCalls).toEqual(expect.arrayContaining(['session/page', 'session/attachment', 'session/modelCatalog']))

    expect(context.get('remoteAccess')?.source('session', 'fx-alpha', 'session/prompt').getSnapshot()).toBe(true)
    const stopLabel = locale === 'zh' ? '停止生成' : 'Stop generating'
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: stopLabel })) })
    await waitFor(() => { expect(owner?.cancellations).toEqual(['fx-alpha']) })
    const text = `privacy ${authority}: real input sender remains granted`
    await input.send('fx-alpha', text, send)
    await waitFor(() => { expect(owner?.prompts).toHaveLength(1) })
    const request = owner.prompts[0]
    if (request === undefined) throw new Error('scripted Owner received no prompt')
    expect(request).toMatchObject({ sessionId: 'fx-alpha', content: [{ type: 'text', text }] })
    promptEcho(owner.history('fx-alpha'), request)
    await act(async () => { owner?.completeReply('fx-alpha') })
    await waitFor(() => { expect(document.body.textContent).toContain(`回声：${text}`) }, { timeout: 15_000 })
    expect(dispatch).not.toHaveBeenCalled()
  }, 180_000)
})
