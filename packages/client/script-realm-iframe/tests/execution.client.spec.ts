// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { ScriptRealmId } from '@deepseek-ai/dsh-client-script-realm/client'
import { createIFrameScriptRealmFactory, IFrameScriptRealm } from '../src/client/iframe.ts'

const owned: IFrameScriptRealm[] = []
const frames: HTMLIFrameElement[] = []
const failedDisposals = new Set<IFrameScriptRealm>()

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    for (const realm of owned.splice(0)) {
      if (failedDisposals.has(realm)) await expect(realm.dispose()).rejects.toMatchObject({ stage: 'dispose' })
      else await realm.dispose()
    }
  } finally {
    failedDisposals.clear()
    for (const frame of frames.splice(0)) frame.remove()
  }
})

async function fixture() {
  const controller = new AbortController()
  const realm = await createIFrameScriptRealmFactory({ document }).create({ id: 'execution' as ScriptRealmId, signal: controller.signal })
  owned.push(realm)
  const frame = document.querySelector<HTMLIFrameElement>('iframe[data-realm="execution"]')!
  frames.push(frame)
  return { realm, controller, frame }
}

function pendingScript(realm: IFrameScriptRealm): HTMLScriptElement {
  const script = realm.document.querySelector('script')
  if (script === null) throw new Error('script was not appended')
  return script
}

it('creates an independent global environment and preserves exposed reference identity', async () => {
  const { realm, frame } = await fixture()
  expect(frame.hidden).toBe(true)
  expect(frame.tabIndex).toBe(-1)
  expect(frame.getAttribute('aria-hidden')).toBe('true')
  expect(realm.window).not.toBe(window)
  expect(realm.document).not.toBe(document)
  expect(Reflect.get(realm.window, 'Array')).not.toBe(Array)
  expect(realm.document.title).toBe('realm-iframe-execution')
  const shared = { marker: 1 }
  await realm.expose({ shared })
  expect(Reflect.get(realm.window, 'shared')).toBe(shared)
  expect(Object.getOwnPropertyDescriptor(realm.window, 'shared')).toMatchObject({ writable: false, configurable: false })
  await expect(realm.expose({ another: 1, shared })).rejects.toMatchObject({ stage: 'expose', realmId: realm.id })
  expect(Reflect.has(realm.window, 'another')).toBe(false)
  await expect(realm.expose({ document })).rejects.toMatchObject({ stage: 'expose' })
})

it('reports a host that prevents exposing additional globals', async () => {
  const { realm } = await fixture()
  const isExtensible = Object.isExtensible
  vi.spyOn(Object, 'isExtensible').mockImplementation(value => value === realm.window ? false : isExtensible(value))
  await expect(realm.expose({ shared: 1 })).rejects.toMatchObject({ stage: 'expose', cause: { message: 'ScriptRealm globals are not extensible' } })
  expect(Reflect.has(realm.window, 'shared')).toBe(false)
})

it('settles loading only on its script event and removes the carrier element', async () => {
  const { realm } = await fixture()
  const task = realm.execute({ url: '/plugin.js' })
  const script = pendingScript(realm)
  const expected = new URL('/plugin.js', document.baseURI).href
  expect(script.src).toBe(expected)
  expect(script.async).toBe(true)
  let finished = false
  void task.then(() => { finished = true })
  realm.window.dispatchEvent(new ErrorEvent('error', { filename: 'https://unrelated.invalid/other.js', message: 'unrelated' }))
  await Promise.resolve()
  expect(finished).toBe(false)
  script.dispatchEvent(new Event('load'))
  await task
  expect(finished).toBe(true)
  expect(script.isConnected).toBe(false)
  expect(realm.document.querySelector('script')).toBeNull()
})

it('rejects a failed script fetch and removes its load listeners', async () => {
  const { realm } = await fixture()
  const task = realm.execute({ url: '/missing.js' })
  const failure = expect(task).rejects.toMatchObject({ stage: 'execute', url: new URL('/missing.js', document.baseURI).href })
  const script = pendingScript(realm)
  script.dispatchEvent(new Event('error'))
  await failure
  expect(script.isConnected).toBe(false)
  script.dispatchEvent(new Event('load'))
  await realm.dispose()
})

it.each([true, false])('reports matching execution errors with an error object: %s', async (withError) => {
  const { realm } = await fixture()
  const task = realm.execute({ url: '/throws.js' })
  const cause = new Error('script execution failed')
  const failure = expect(task).rejects.toMatchObject({ stage: 'execute', cause: withError ? cause : 'script execution failed' })
  const script = pendingScript(realm)
  realm.window.dispatchEvent(new ErrorEvent('error', { filename: script.src, message: cause.message, ...(withError ? { error: cause } : {}) }))
  await failure
  expect(script.isConnected).toBe(false)
})

it('reports an invalid script address before creating a carrier element', async () => {
  const { realm } = await fixture()
  await expect(realm.execute({ url: 'http://[' })).rejects.toMatchObject({ stage: 'execute', url: 'http://[' })
  expect(realm.document.querySelector('script')).toBeNull()
})

it('cleans script listeners when the host refuses script insertion', async () => {
  const { realm } = await fixture()
  const failure = new Error('script insertion refused')
  vi.spyOn(realm.document.head, 'append').mockImplementation(() => { throw failure })
  await expect(realm.execute({ url: '/blocked.js' })).rejects.toMatchObject({ stage: 'execute', cause: failure })
  expect(realm.document.querySelector('script')).toBeNull()
  await realm.dispose()
})

it.each(['abort', 'dispose'] as const)('cancels pending execution on %s and does not accept more work', async (action) => {
  const { realm, controller, frame } = await fixture()
  const first = realm.execute({ url: '/first.js' })
  const firstScript = pendingScript(realm)
  const second = realm.execute({ url: '/second.js' })
  const error = new Error('caller cancelled')
  const firstFailure = expect(first).rejects.toMatchObject({ stage: 'execute', cause: action === 'abort' ? error : { message: 'ScriptRealm disposed' } })
  const secondFailure = expect(second).rejects.toMatchObject({ stage: 'execute' })
  if (action === 'abort') controller.abort(error)
  else await realm.dispose()
  await Promise.all([firstFailure, secondFailure])
  expect(frame.isConnected).toBe(false)
  expect(firstScript.isConnected).toBe(false)
  firstScript.dispatchEvent(new Event('load'))
  await expect(realm.expose({ late: 1 })).rejects.toMatchObject({ stage: 'expose' })
  await expect(realm.execute({ url: '/late.js' })).rejects.toMatchObject({ stage: 'execute', url: '/late.js' })
  const disposal = realm.dispose()
  expect(realm.dispose()).toBe(disposal)
  await disposal
})

it('retains a disposal error while stopping pending work', async () => {
  const { realm, frame } = await fixture()
  const failure = new Error('frame removal refused')
  vi.spyOn(frame, 'remove').mockImplementation(() => { throw failure })
  failedDisposals.add(realm)
  const task = realm.dispose()
  await expect(task).rejects.toMatchObject({ stage: 'dispose', cause: failure })
  expect(realm.dispose()).toBe(task)
  await expect(realm.execute({ url: '/late.js' })).rejects.toMatchObject({ stage: 'execute' })
})

it('does not allocate an iframe for an already-aborted creation', async () => {
  const controller = new AbortController()
  const failure = new Error('cancel before allocation')
  controller.abort(failure)
  const create = vi.spyOn(document, 'createElement')
  await expect(createIFrameScriptRealmFactory({ document }).create({ id: 'cancelled' as ScriptRealmId, signal: controller.signal })).rejects.toMatchObject({ stage: 'create', cause: failure })
  expect(create).not.toHaveBeenCalled()
})

it.each(['window', 'document', 'cancel'] as const)('removes the partially created frame when readiness fails: %s', async (failure) => {
  const controller = new AbortController()
  const append = document.body.append.bind(document.body)
  let created: HTMLIFrameElement | undefined
  vi.spyOn(document.body, 'append').mockImplementation((...nodes) => {
    append(...nodes)
    const frame = nodes[0]
    if (!(frame instanceof HTMLIFrameElement)) throw new Error('expected iframe')
    created = frame
    frames.push(frame)
    if (failure === 'cancel') controller.abort(new Error('cancel during readiness'))
    else vi.spyOn(frame, failure === 'window' ? 'contentWindow' : 'contentDocument', 'get').mockReturnValue(null)
  })
  await expect(createIFrameScriptRealmFactory({ document }).create({ id: 'not-ready' as ScriptRealmId, signal: controller.signal })).rejects.toMatchObject({ stage: 'create' })
  expect(created).toBeDefined()
  expect(created!.isConnected).toBe(false)
})

it('rejects direct construction after caller cancellation', () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const frame = document.createElement('iframe')
  frames.push(frame)
  document.body.append(frame)
  expect(() => new IFrameScriptRealm(frame, frame.contentWindow!, frame.contentDocument!, document,
    { id: 'cancelled' as ScriptRealmId, signal: controller.signal })).toThrow('cancelled')
})


it('retains a completed load if the inserting carrier subsequently throws', async () => {
  const { realm } = await fixture()
  const append = realm.document.head.append.bind(realm.document.head)
  vi.spyOn(realm.document.head, 'append').mockImplementation((...nodes) => {
    append(...nodes)
    const script = nodes[0]
    if (typeof script === 'string' || script === undefined) throw new Error('expected script node')
    script.dispatchEvent(new Event('load'))
    throw new Error('carrier threw after completing the load')
  })
  await expect(realm.execute({ url: '/completed.js' })).resolves.toBeUndefined()
  expect(realm.document.querySelector('script')).toBeNull()
  await realm.dispose()
})
