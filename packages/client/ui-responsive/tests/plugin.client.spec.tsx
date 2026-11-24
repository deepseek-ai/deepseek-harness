// @vitest-environment jsdom
/**
 * Standard page props reach Slot components through the production renderer and withdraw with the service fiber.
 */
import { act, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as uiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import UiResponsiveService from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'ui-responsive.test.probe': { kind: 'list'; scope: 'root'; owner: { query: string } }
  }
}

const SLOT = 'ui-responsive.test.probe'
type ProbeProps = PropsRuntime<typeof SLOT>

/** One stubbed `MediaQueryList`: its answer and its registered `change` listeners. */
interface StubList {
  readonly media: string
  matches: boolean
  readonly listeners: Set<() => void>
}

/**
 * Stub `window.matchMedia`, recording every list it creates with an initial answer of false.
 * @returns the created lists and the stub.
 */
function stubMatchMedia() {
  const lists: StubList[] = []
  const matchMedia = vi.fn((media: string) => {
    const list: StubList = { media, matches: false, listeners: new Set() }
    lists.push(list)
    return {
      media,
      get matches() { return list.matches },
      addEventListener: (type: string, listener: () => void) => { if (type === 'change') list.listeners.add(listener) },
      removeEventListener: (type: string, listener: () => void) => { if (type === 'change') list.listeners.delete(listener) },
    }
  })
  vi.stubGlobal('matchMedia', matchMedia)
  return { lists, matchMedia }
}

/** Change one stubbed list's answer and notify its listeners, as the browser does. */
function change(list: StubList, matches: boolean): void {
  act(() => {
    list.matches = matches
    for (const listener of [...list.listeners]) listener()
  })
}

function MediaProbe({ query, useMediaQuery }: ProbeProps) {
  return <span>{useMediaQuery(query) ? 'match' : 'miss'}</span>
}

function MobileProbe({ useMobile }: ProbeProps) {
  return <span>{useMobile() ? 'mobile' : 'desktop'}</span>
}

function PresenceProbe({ useMediaQuery, useMobile, useDocumentPortal, useDocumentViewport }: ProbeProps) {
  return <span>{[useMediaQuery, useMobile, useDocumentPortal, useDocumentViewport].map(hook => typeof hook).join('/')}</span>
}

function DocumentProbe({ useDocumentPortal, useDocumentViewport }: ProbeProps) {
  const Portal = useDocumentPortal()
  const { width, height } = useDocumentViewport()
  return <Portal><output>{width}×{height}</output></Portal>
}

/** Release the fixed test props and supply the document rendered by this suite. */
async function bench(page: Document = document): Promise<SlotTestRuntime> {
  const runtime = await SlotTestRuntime.create()
  await runtime.releaseResponsiveSource()
  runtime.ctx.reflect.provide('uiRenderer', { mountDocument: page, mount: () => () => {} })
  await runtime.declare({ [SLOT]: { kind: 'list', scope: 'root' } })
  return runtime
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('keeps the Host entry empty', () => { applyHost() })

describe('useMediaQuery', () => {
  it('reads the current answer on first render and rerenders when it changes', async () => {
    const { lists } = stubMatchMedia()
    const runtime = await bench()
    try {
      await runtime.mount(UiResponsiveService)
      runtime.slots.register({ name: SLOT, id: 'probe' }, MediaProbe)
      const view = runtime.renderSlot(SLOT, { query: '(max-width: 640px)' })
      expect(view.container.textContent).toBe('miss')
      const [list] = lists
      if (list === undefined) throw new Error('expected one media query list')
      change(list, true)
      expect(view.container.textContent).toBe('match')
      change(list, false)
      expect(view.container.textContent).toBe('miss')
    } finally {
      await runtime.dispose()
    }
  })

  it('shares one list per query and removes its listener after the last reader unmounts', async () => {
    const { lists, matchMedia } = stubMatchMedia()
    const runtime = await bench()
    try {
      await runtime.mount(UiResponsiveService)
      const disposeFirst = runtime.slots.register({ name: SLOT, id: 'first' }, MediaProbe)
      const disposeSecond = runtime.slots.register({ name: SLOT, id: 'second' }, MediaProbe)
      const view = runtime.renderSlot(SLOT, { query: '(prefers-reduced-motion: reduce)' })
      expect(view.container.textContent).toBe('missmiss')
      expect(matchMedia).toHaveBeenCalledTimes(1)
      const [list] = lists
      if (list === undefined) throw new Error('expected one media query list')
      expect(list.media).toBe('(prefers-reduced-motion: reduce)')
      expect(list.listeners.size).toBe(2)
      change(list, true)
      expect(view.container.textContent).toBe('matchmatch')

      disposeFirst()
      await runtime.flush()
      expect(view.container.textContent).toBe('match')
      expect(list.listeners.size).toBe(1)
      disposeSecond()
      await runtime.flush()
      expect(view.container.textContent).toBe('')
      expect(list.listeners.size).toBe(0)
      expect(matchMedia).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('moves a reader to the list of the query it reads next', async () => {
    const { lists } = stubMatchMedia()
    const runtime = await bench()
    try {
      await runtime.mount(UiResponsiveService)
      runtime.slots.register({ name: SLOT, id: 'probe' }, MediaProbe)
      const view = runtime.renderSlot(SLOT, { query: '(max-width: 640px)' })
      view.update({ query: '(hover: none)' })
      const [narrow, touch] = lists
      if (narrow === undefined || touch === undefined) throw new Error('expected one list per query')
      expect(touch.media).toBe('(hover: none)')
      expect(narrow.listeners.size).toBe(0)
      expect(touch.listeners.size).toBe(1)
      change(narrow, true)
      expect(view.container.textContent).toBe('miss')
      change(touch, true)
      expect(view.container.textContent).toBe('match')
    } finally {
      await runtime.dispose()
    }
  })
})

describe('useMobile', () => {
  it.each([true, false])('answers isMobileDevice() (%s)', async (mobile) => {
    vi.spyOn(uiPrimitives, 'isMobileDevice').mockReturnValue(mobile)
    const runtime = await bench()
    try {
      await runtime.mount(UiResponsiveService)
      runtime.slots.register({ name: SLOT, id: 'probe' }, MobileProbe)
      const view = runtime.renderSlot(SLOT, { query: '' })
      expect(view.container.textContent).toBe(mobile ? 'mobile' : 'desktop')
    } finally {
      await runtime.dispose()
    }
  })
})

describe('service lifetime', () => {
  it('uses the renderer mount for both props and reacts only to a resize of that window', async () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const page = frame.contentDocument!
    const runtime = await bench(page)
    try {
      let width = 800
      Object.defineProperties(page.documentElement, { clientWidth: { get: () => width }, clientHeight: { value: 600 } })
      await runtime.mount(UiResponsiveService)
      runtime.slots.register({ name: SLOT, id: 'probe' }, DocumentProbe)
      const view = runtime.renderSlot(SLOT, { query: '' })
      expect(view.container.querySelector('output')).toBeNull()
      const output = page.body.querySelector('output')!
      expect(output.textContent).toBe('800×600')
      width = 980
      fireEvent.resize(window)
      expect(output.textContent).toBe('800×600')
      fireEvent.resize(frame.contentWindow!)
      expect(output.textContent).toBe('980×600')
      expect(page.body.querySelector('output')).toBe(output)
    } finally {
      await runtime.dispose()
      frame.remove()
    }
  })

  it('reports a document hook read without a mounted browsing context instead of using the plugin window', async () => {
    const runtime = await bench(document.implementation.createHTMLDocument())
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await runtime.mount(UiResponsiveService)
      runtime.slots.register({ name: SLOT, id: 'probe' }, DocumentProbe)
      const view = runtime.renderSlot(SLOT, { query: '' })
      expect(view.container.querySelector('[data-slot-error]')).not.toBeNull()
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('crashed'),
        expect.objectContaining({ message: 'ui-responsive: document hooks require a mounted application window' }))
    } finally {
      await runtime.dispose()
    }
  })

  it('starts a plugin that injects it only after publishing, and unloads that plugin with it', async () => {
    stubMatchMedia()
    const runtime = await bench()
    const started = vi.fn()
    const stopped = vi.fn()
    try {
      const consumer = runtime.ctx.plugin({
        name: 'ui-responsive.test.consumer',
        inject: ['uiResponsive'],
        apply(ctx) {
          started()
          ctx.effect(() => stopped, 'ui-responsive test: consumer lifetime')
        },
      })
      await runtime.flush()
      expect(started).not.toHaveBeenCalled()
      const provider = await runtime.mount(UiResponsiveService)
      await consumer.await()
      expect(runtime.ctx.get('uiResponsive')).toBeInstanceOf(UiResponsiveService)
      expect(started).toHaveBeenCalledOnce()
      await provider.dispose()
      expect(stopped).toHaveBeenCalledOnce()
      expect(runtime.ctx.get('uiResponsive')).toBeUndefined()
    } finally {
      await runtime.dispose()
    }
  })

  it('withdraws its standard props on disposal and publishes them again after a reload', async () => {
    stubMatchMedia()
    const runtime = await bench()
    try {
      const first = await runtime.mount(UiResponsiveService)
      runtime.slots.register({ name: SLOT, id: 'probe' }, PresenceProbe)
      const view = runtime.renderSlot(SLOT, { query: '' })
      expect(view.container.textContent).toBe('function/function/function/function')
      await first.dispose()
      expect(view.container.textContent).toBe('undefined/undefined/undefined/undefined')
      await runtime.mount(UiResponsiveService)
      expect(view.container.textContent).toBe('function/function/function/function')
    } finally {
      await runtime.dispose()
    }
  })
})
