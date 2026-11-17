// @vitest-environment jsdom
/** Deterministic layout endpoints exercise scroll geometry without jsdom's absent layout engine. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createPluginHeaderRef } from '../src/client/header-scroll.ts'

type PartName = 'title' | 'intro' | 'toolbar' | 'tabs'
interface Box { x: number; y: number; width: number; height: number }
interface Layout {
  width: number
  resting: { height: number; parts: Partial<Record<PartName, Box>> }
  compact: { height: number; parts: Partial<Record<PartName, Box>> }
}

function box(x: number, y: number, width: number, height: number): Box {
  return { x, y, width, height }
}

function wide(tabs = true): Layout {
  return {
    width: 960,
    resting: {
      height: tabs ? 140 : 90,
      parts: {
        title: box(0, 28, 120, 28), intro: box(0, 60, 320, 20), toolbar: box(600, 28, 220, 32),
        ...tabs ? { tabs: box(0, 100, 240, 30) } : {},
      },
    },
    compact: {
      height: 64,
      parts: {
        title: box(0, 16, 120, 28), intro: box(0, 0, 0, 0), toolbar: box(600, 16, 220, 32),
        ...tabs ? { tabs: box(0, 16, 180, 30) } : {},
      },
    },
  }
}

function narrow(): Layout {
  return {
    width: 320,
    resting: {
      height: 210,
      parts: {
        title: box(0, 28, 120, 28), intro: box(0, 60, 280, 20),
        toolbar: box(0, 90, 280, 32), tabs: box(0, 160, 280, 30),
      },
    },
    compact: {
      height: 70,
      parts: {
        title: box(0, 16, 120, 28), intro: box(0, 0, 0, 0),
        toolbar: box(200, 16, 80, 32), tabs: box(0, 16, 160, 30),
      },
    },
  }
}

function harness() {
  const fontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')
  const fonts = new EventTarget()
  const releases: (() => void)[] = []
  onTestFinished(() => {
    for (const release of releases.reverse()) release()
    if (fontsDescriptor === undefined) Reflect.deleteProperty(document, 'fonts')
    else Object.defineProperty(document, 'fonts', fontsDescriptor)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })

  const resizes: ControlledResize[] = []
  const mutations: ControlledMutation[] = []
  class ControlledResize implements ResizeObserver {
    observe = vi.fn<(target: Element, options?: ResizeObserverOptions) => void>()
    unobserve = vi.fn<(target: Element) => void>()
    disconnect = vi.fn<() => void>()
    constructor(private readonly callback: ResizeObserverCallback) { resizes.push(this) }
    deliver(): void { this.callback([], this) }
  }
  class ControlledMutation implements MutationObserver {
    observe = vi.fn<(target: Node, options?: MutationObserverInit) => void>()
    disconnect = vi.fn<() => void>()
    takeRecords(): MutationRecord[] { return [] }
    constructor(private readonly callback: MutationCallback) { mutations.push(this) }
    deliver(): void { this.callback([], this) }
  }
  vi.stubGlobal('ResizeObserver', ControlledResize)
  vi.stubGlobal('MutationObserver', ControlledMutation)

  function fixture(initial: Layout = wide(), ref = createPluginHeaderRef()) {
    const body = document.createElement('div')
    const bar = document.createElement('div')
    const header = document.createElement('header')
    const content = document.createElement('div')
    const index = releases.length
    const elements = new Map<PartName, HTMLDivElement>()
    for (const name of Object.keys(initial.resting.parts) as PartName[]) {
      const part = document.createElement('div')
      part.dataset.pluginHeaderPart = name
      part.id = `header-${index}-${name}`
      if (name === 'toolbar' || name === 'intro') {
        const button = document.createElement('button')
        button.id = `header-${index}-${name}-button`
        button.textContent = name
        part.append(button)
      } else part.textContent = name
      header.append(part)
      elements.set(name, part)
    }
    bar.append(header)
    content.textContent = 'Plugin cards'
    body.append(bar, content)
    document.body.append(body)
    releases.push(() => { ref(null); body.remove() })
    const state = { layout: initial }
    const clones: HTMLDivElement[] = []
    const measurements: {
      compact: boolean
      inert: boolean
      ariaHidden: string | null
      ids: number
      styles: number
      natural: boolean
      scrolled: boolean
      connected: boolean
      width: string
    }[] = []
    vi.spyOn(bar, 'getBoundingClientRect').mockImplementation(() => new DOMRect(50, 100, state.layout.width, state.layout.resting.height))
    const cloneNode = bar.cloneNode.bind(bar)
    vi.spyOn(bar, 'cloneNode').mockImplementation((deep) => {
      const clone = cloneNode(deep) as HTMLDivElement
      clones.push(clone)
      const cloneHeader = clone.querySelector('header')!
      // A different viewport origin ensures only header-relative coordinates drive the live controls.
      vi.spyOn(cloneHeader, 'getBoundingClientRect').mockImplementation(() => {
        measurements.push({
          compact: clone.hasAttribute('data-compact'), inert: clone.inert,
          ariaHidden: clone.getAttribute('aria-hidden'), ids: clone.querySelectorAll('[id]').length,
          styles: clone.querySelectorAll('[data-plugin-header-part][style]').length,
          natural: clone.hasAttribute('data-natural'), scrolled: clone.hasAttribute('data-scrolled'),
          connected: clone.isConnected, width: clone.style.width,
        })
        return new DOMRect(180, 240, state.layout.width, 0)
      })
      vi.spyOn(clone, 'getBoundingClientRect').mockImplementation(() =>
        new DOMRect(180, 240, state.layout.width, endpoint().height))
      function endpoint() { return clone.hasAttribute('data-compact') ? state.layout.compact : state.layout.resting }
      for (const name of elements.keys()) {
        const part = clone.querySelector<HTMLElement>(`[data-plugin-header-part="${name}"]`)!
        vi.spyOn(part, 'getBoundingClientRect').mockImplementation(() => {
          const bounds = endpoint().parts[name]!
          return new DOMRect(180 + bounds.x, 240 + bounds.y, bounds.width, bounds.height)
        })
      }
      return clone
    })
    function part(name: PartName): HTMLDivElement {
      const element = elements.get(name)
      if (element === undefined) throw new Error(`Fixture has no ${name}`)
      return element
    }
    function scroll(top: number): void {
      body.scrollTop = top
      body.dispatchEvent(new Event('scroll'))
    }
    return { body, bar, header, content, state, clones, measurements, part, scroll, ref, attach: () => { ref(bar) } }
  }
  return { fonts, resizes, mutations, fixture }
}

describe('plugin header scroll geometry', () => {
  it.each([0, 12, 600])('clamps each trajectory and reverses without using a %ipx scroll range', (range) => {
    const h = harness(), f = h.fixture()
    Object.defineProperties(f.body, { clientHeight: { value: 500 }, scrollHeight: { value: 500 + range } })
    f.attach()
    expect(f.bar.style.getPropertyValue('--plugin-header-travel')).toBe('84px')
    expect(f.bar.style.getPropertyValue('--plugin-header-rest-height')).toBe('140px')
    expect(f.body.style.getPropertyValue('--plugin-header-scroll-padding')).toBe('72px')
    f.scroll(6)
    expect(f.part('toolbar').style.translate).toBe('0px -6px')
    expect(f.part('tabs').style.translate).toBe('0px -6px')
    expect(f.bar.hasAttribute('data-compact')).toBe(false)
    expect(f.bar.hasAttribute('data-scrolled')).toBe(true)
    f.scroll(20)
    expect(f.part('toolbar').style.translate).toBe('0px -12px')
    expect(f.part('tabs').style.translate).toBe('0px -20px')
    expect(f.bar.style.getPropertyValue('--plugin-header-paint-height')).toBe('120px')
    f.scroll(83)
    expect(f.bar.hasAttribute('data-compact')).toBe(false)
    f.scroll(84)
    expect(f.bar.hasAttribute('data-compact')).toBe(true)
    expect(f.part('title').style.translate).toBe('0px -56px')
    expect(f.part('intro').style.translate).toBe('0px -80px')
    expect(f.part('tabs').style.translate).toBe('0px -84px')
    f.scroll(1_000)
    expect(f.part('tabs').style.translate).toBe('0px -84px')
    expect(f.bar.style.getPropertyValue('--plugin-header-paint-height')).toBe('64px')
    f.scroll(6)
    expect(f.part('toolbar').style.translate).toBe('0px -6px')
    expect(f.part('intro').inert).toBe(false)
    expect(f.bar.hasAttribute('data-compact')).toBe(false)
    f.scroll(-10)
    expect(f.part('tabs').style.translate).toBe('0px 0px')
    expect(f.bar.hasAttribute('data-scrolled')).toBe(false)
    expect(f.bar.style.getPropertyValue('--plugin-header-paint-height')).toBe('140px')
    expect(f.bar.style.getPropertyValue('--plugin-header-rest-height')).toBe('140px')
    expect(f.body.scrollHeight - f.body.clientHeight).toBe(range)
    expect(f.content.style.cssText).toBe('')
  })

  it('accounts for a layout scrollbar without retaining its sizing property after detachment', () => {
    const h = harness(), f = h.fixture()
    Object.defineProperties(f.body, { offsetWidth: { value: 960 }, clientWidth: { value: 955 } })
    f.attach()
    expect(f.body.style.getPropertyValue('--plugin-page-scrollbar-width')).toBe('5px')
    f.ref(null)
    expect(f.body.style.getPropertyValue('--plugin-page-scrollbar-width')).toBe('')
  })

  it('interpolates narrow wrapped controls to their measured horizontal and width endpoints', () => {
    const h = harness(), f = h.fixture(narrow())
    f.attach()
    expect(f.part('toolbar').style.getPropertyValue('--plugin-part-y')).toBe('90px')
    expect(f.part('toolbar').style.getPropertyValue('--plugin-part-width')).toBe('280px')
    f.scroll(37)
    expect(f.part('toolbar').style.translate).toBe('100px -37px')
    expect(f.part('toolbar').style.width).toBe('180px')
    f.scroll(144)
    expect(f.part('toolbar').style.translate).toBe('200px -74px')
    expect(f.part('toolbar').style.width).toBe('80px')
    expect(f.part('tabs').style.translate).toBe('0px -144px')
    expect(f.part('tabs').style.width).toBe('160px')
    expect(f.bar.style.getPropertyValue('--plugin-header-paint-height')).toBe('70px')
    f.scroll(0)
    expect(f.part('toolbar').style.translate).toBe('0px 0px')
    expect(f.part('toolbar').style.width).toBe('280px')
    expect(f.part('tabs').style.width).toBe('280px')
  })

  it('clips the no-tabs intro beneath the pinned title and restores interaction when scrolling back', () => {
    const h = harness(), f = h.fixture(wide(false))
    f.attach()
    f.scroll(16)
    expect(f.part('title').style.translate).toBe('0px -12px')
    expect(f.part('intro').style.clipPath).toBe('inset(0% 0 0)')
    expect(f.part('intro').inert).toBe(false)
    f.scroll(26)
    expect(f.part('intro').style.translate).toBe('0px -26px')
    expect(f.part('intro').style.clipPath).toBe('inset(50% 0 0)')
    expect(f.part('intro').inert).toBe(false)
    f.scroll(36)
    expect(f.part('intro').style.clipPath).toBe('inset(100% 0 0)')
    expect(f.part('intro').inert).toBe(true)
    expect(f.bar.hasAttribute('data-compact')).toBe(true)
    f.scroll(0)
    expect(f.part('intro').style.clipPath).toBe('inset(0% 0 0)')
    expect(f.part('intro').inert).toBe(false)
  })

  it('scrolls the tabs intro fully out without the no-tabs clipping treatment', () => {
    const h = harness(), f = h.fixture()
    f.part('intro').style.clipPath = 'inset(100% 0 0)'
    f.attach()
    f.scroll(79)
    expect(f.part('intro').style.clipPath).toBe('')
    expect(f.part('intro').inert).toBe(false)
    f.scroll(80)
    expect(f.part('intro').style.translate).toBe('0px -80px')
    expect(f.part('intro').inert).toBe(true)
    f.scroll(40)
    expect(f.part('intro').inert).toBe(false)
    expect(f.part('intro').style.translate).toBe('0px -40px')
  })

  it.each(['resize', 'mutation', 'font'] as const)('remeasures changed endpoints on %s without replacing focused controls', (event) => {
    const h = harness(), f = h.fixture()
    const button = f.part('toolbar').querySelector('button')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    f.attach()
    f.scroll(144)
    button.focus()
    f.state.layout = narrow()
    if (event === 'resize') h.resizes[0]!.deliver()
    else if (event === 'mutation') h.mutations[0]!.deliver()
    else h.fonts.dispatchEvent(new Event('loadingdone'))
    expect(f.part('toolbar').style.translate).toBe('200px -74px')
    expect(f.part('toolbar').style.width).toBe('80px')
    expect(f.bar.style.getPropertyValue('--plugin-header-rest-height')).toBe('210px')
    expect(f.body.style.getPropertyValue('--plugin-header-scroll-padding')).toBe('78px')
    expect(document.activeElement).toBe(button)
    expect(f.part('toolbar').querySelector('button')).toBe(button)
    button.click()
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(f.clones).toHaveLength(2)
    expect(f.clones.every(clone => !clone.isConnected)).toBe(true)
    expect(f.body.querySelector('[data-measuring]')).toBeNull()
    expect(f.measurements.slice(-2)).toEqual([false, true].map(compact => ({
      compact, inert: true, ariaHidden: 'true', ids: 0, styles: 0,
      natural: false, scrolled: false, connected: true, width: '320px',
    })))
    const ids = [...f.body.querySelectorAll('[id]')].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(h.resizes[0]!.observe).toHaveBeenCalledWith(f.body)
    expect(h.mutations[0]!.observe).toHaveBeenCalledWith(f.header, {
      childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'],
    })
  })

  it('removes the inert measurement copy when a compact layout read fails', () => {
    const h = harness(), f = h.fixture()
    const failure = new Error('Layout read interrupted')
    const resting = f.state.layout.resting
    Object.defineProperty(f.state, 'layout', {
      get: () => ({
        width: 960,
        resting,
        get compact(): Layout['compact'] { throw failure },
      }),
    })
    expect(() => { f.attach() }).toThrow(failure)
    expect(f.clones).toHaveLength(1)
    expect(f.clones[0]!.isConnected).toBe(false)
    expect(f.body.querySelector('[data-measuring]')).toBeNull()
    expect(h.resizes).toHaveLength(0)
    expect(h.mutations).toHaveLength(0)
  })

  it('disconnects observers and listeners and ignores callbacks already queued before detachment', () => {
    const h = harness(), f = h.fixture()
    f.attach()
    f.scroll(20)
    const before = f.bar.outerHTML
    f.ref(null)
    expect(h.resizes[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(h.mutations[0]!.disconnect).toHaveBeenCalledTimes(1)
    expect(f.body.style.getPropertyValue('--plugin-header-scroll-padding')).toBe('')
    f.state.layout = narrow()
    f.scroll(144)
    h.resizes[0]!.deliver()
    h.mutations[0]!.deliver()
    h.fonts.dispatchEvent(new Event('loadingdone'))
    expect(f.bar.outerHTML).toBe(before)
    expect(f.clones).toHaveLength(1)
    f.ref(null)
    expect(h.resizes[0]!.disconnect).toHaveBeenCalledTimes(1)
  })

  it('rebinds one ref without allowing the old element or its callbacks to change the replacement', () => {
    const h = harness(), ref = createPluginHeaderRef(), first = h.fixture(wide(), ref), second = h.fixture(narrow(), ref)
    first.attach()
    first.scroll(20)
    const oldMarkup = first.bar.outerHTML
    second.attach()
    second.scroll(37)
    const newMarkup = second.bar.outerHTML
    first.scroll(144)
    h.resizes[0]!.deliver()
    h.mutations[0]!.deliver()
    expect(first.bar.outerHTML).toBe(oldMarkup)
    expect(second.bar.outerHTML).toBe(newMarkup)
    expect(first.body.style.getPropertyValue('--plugin-header-scroll-padding')).toBe('')
    expect(second.body.style.getPropertyValue('--plugin-header-scroll-padding')).toBe('78px')
    expect(first.clones).toHaveLength(1)
    expect(second.clones).toHaveLength(1)
  })

  it('keeps two mounted refs independent when scrolling, remeasuring, and disposing either instance', () => {
    const h = harness(), first = h.fixture(), second = h.fixture(narrow())
    first.attach()
    second.attach()
    first.scroll(20)
    expect(second.part('toolbar').style.translate).toBe('0px 0px')
    second.scroll(37)
    expect(first.part('toolbar').style.translate).toBe('0px -12px')
    expect(second.part('toolbar').style.translate).toBe('100px -37px')
    first.ref(null)
    const oldMarkup = first.bar.outerHTML
    second.state.layout = wide()
    h.fonts.dispatchEvent(new Event('loadingdone'))
    expect(first.bar.outerHTML).toBe(oldMarkup)
    expect(first.clones).toHaveLength(1)
    expect(second.clones).toHaveLength(2)
    expect(second.part('toolbar').style.translate).toBe('0px -12px')
    expect(second.body.style.getPropertyValue('--plugin-header-scroll-padding')).toBe('72px')
    expect(h.resizes[1]!.disconnect).not.toHaveBeenCalled()
    second.scroll(0)
    expect(second.part('toolbar').style.translate).toBe('0px 0px')
  })
})
