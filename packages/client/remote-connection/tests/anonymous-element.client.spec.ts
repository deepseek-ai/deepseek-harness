// @vitest-environment jsdom
/** Public custom elements own their work across connection and document suspension. */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { definePairingElement } from '../src/anonymous/element.ts'
import { mountPairing } from '../src/anonymous/pairing.ts'
import { pairingLocales, pairingMethodLabels } from '../src/anonymous/locales.ts'
import { pairingStyles } from '../src/anonymous/styles.ts'

const recovery = { requestTtlMs: 10000, pollIntervalMs: 1000, requestTimeoutMs: 5000, maxRetries: 2, retryMaxDelayMs: 2000 }
const DevicePairingElement = definePairingElement(mountPairing, pairingLocales, pairingMethodLabels, pairingStyles, recovery)
type PairingElement = InstanceType<typeof DevicePairingElement>

const ticket = {
  id: 'c647d366-084c-4b7e-9c10-592dd355a4fb', secret: 'a'.repeat(43), code: 'ABCD2345',
  authority: 'https://host.example', sourceIp: '192.0.2.17', expiresInMs: 10000, pollIntervalMs: 1000,
}
const request = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', request)
  request.mockReset().mockImplementation(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Missing creation credentials')
    const held = JSON.parse(init.body) as { id: string; secret: string }
    return new Response(JSON.stringify({ ...ticket, ...held }))
  })
  document.head.innerHTML = '<base href="https://host.example/tools/dsh/">'
})

afterEach(() => {
  document.body.replaceChildren()
  document.head.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function mount(): PairingElement {
  const element = document.createElement('dsh-device-pairing')
  if (!(element instanceof DevicePairingElement)) throw new Error('Pairing element is not defined')
  document.body.append(element)
  return element
}

async function create(element: PairingElement): Promise<void> {
  element.querySelector<HTMLButtonElement>('#auth-pair-request')!.click()
  await vi.advanceTimersByTimeAsync(0)
}

it('defines and mounts independently of authenticated Client modules, with instance-owned styles', () => {
  const element = mount()
  expect(element.querySelector('h2')?.textContent).toBe('Pair this device')
  expect(element.querySelectorAll('style')).toHaveLength(1)
  expect(element.querySelector('button')?.classList.contains('dsh-device-pairing-button')).toBe(true)
  expect(element.querySelector('button')?.classList.contains('dsh-device-pairing-primary')).toBe(true)
  expect(element.querySelector('button')?.textContent).toBe('Request to pair')
  expect(element.querySelector('p')?.textContent).toContain('Settings → Remote connection')
  expect(element.querySelector('p')?.closest('[hidden]')).toBeNull()
  expect(request).not.toHaveBeenCalled()
  element.connectedCallback()
  expect(element.querySelectorAll('section')).toHaveLength(1)
  element.remove()
  expect(element.childNodes).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['zh-CN', '配对此设备', '申请配对'],
  ['de-DE', 'Pair this device', 'Kopplung anfordern'],
  ['unknown', 'Pair this device', 'Request to pair'],
])('selects public copy for browser language %s without the application locale service', (language, title, label) => {
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language)
  const element = mount()
  expect(element.querySelector('h2')?.textContent).toBe(title)
  expect(element.querySelector('button')?.textContent).toBe(label)
})

it('aborts an unfinished creation on removal and reconnects without accepting its late ticket', async () => {
  const pending = Promise.withResolvers<Response>()
  request.mockReturnValueOnce(pending.promise)
  const element = mount()
  await create(element)
  const signal = request.mock.calls[0]?.[1]?.signal
  element.remove()
  expect(signal?.aborted).toBe(true)
  document.body.append(element)
  pending.resolve(new Response(JSON.stringify(ticket)))
  await vi.advanceTimersByTimeAsync(0)
  expect(element.querySelector<HTMLElement>('#auth-pair-panel')?.hidden).toBe(true)
  expect(element.textContent).not.toContain('ABCD 2345')
  expect(vi.getTimerCount()).toBe(0)
  await create(element)
  expect(request).toHaveBeenCalledTimes(2)
  expect(element.querySelector('#auth-pair-code')?.textContent).toBe('ABCD 2345')
  element.remove()
  expect(vi.getTimerCount()).toBe(0)
  window.dispatchEvent(new Event('pageshow'))
  expect(request).toHaveBeenCalledTimes(2)
})

it('retains the private ticket across BFCache suspension and resumes its status read', async () => {
  const element = mount()
  await create(element)
  window.dispatchEvent(new Event('pagehide'))
  expect(element.isConnected).toBe(true)
  expect(element.querySelector('#auth-pair-code')?.textContent).toBe('ABCD 2345')
  expect(vi.getTimerCount()).toBe(0)
  request.mockResolvedValueOnce(new Response('{"status":"pending"}'))
  window.dispatchEvent(new Event('pageshow'))
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]?.[0]).toEqual(new URL('https://host.example/tools/dsh/pairing/status'))
  expect(request.mock.calls[1]?.[1]?.body).toBe(request.mock.calls[0]?.[1]?.body)
  expect(element.querySelector('#auth-pair-panel')?.getAttribute('data-state')).toBe('waiting')
})

it('waits for a browsing context before mounting an adopted element', () => {
  const doc = document.implementation.createHTMLDocument('Detached document')
  const element = document.createElement('dsh-device-pairing')
  doc.adoptNode(element)
  doc.body.append(element)
  expect(element.childNodes).toHaveLength(0)
  expect(request).not.toHaveBeenCalled()
  document.adoptNode(element)
  document.body.append(element)
  expect(element.querySelector('#auth-pair-request')).not.toBeNull()
})

it('navigates to the clean application URL after collecting approval and stops polling', async () => {
  const original = window.location.href
  onTestFinished(() => { window.history.replaceState(null, '', original) })
  const base = new URL('.', original)
  document.head.replaceChildren()
  window.history.replaceState(null, '', `${base.href}#waiting`)
  const element = mount()
  await create(element)
  request.mockResolvedValueOnce(new Response('{"status":"completed"}'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(window.location.href).toBe(base.href)
  expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(10000)
  expect(request).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
