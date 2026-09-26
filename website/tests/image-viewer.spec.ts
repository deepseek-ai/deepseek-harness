/** @vitest-environment jsdom */
/** Image loading, accessible controls, and ownership of the shared documentation viewer. */
import assert from 'node:assert/strict'
import type { PanzoomOptions } from '@panzoom/panzoom'
import { getByRole, queryAllByRole, queryByRole, waitFor } from '@testing-library/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageViewer } from '../.vitepress/theme/image-viewer.ts'
import { MediaViewer } from '../.vitepress/theme/media-viewer.ts'
import { installMermaidViewer, type MermaidViewer } from '../.vitepress/theme/mermaid-viewer.ts'

const panzoom = vi.hoisted(() => ({ create: vi.fn<(element: HTMLElement, options: PanzoomOptions) => unknown>() }))
vi.mock('@panzoom/panzoom', () => ({ default: panzoom.create }))

function controller(scale: number) {
  return {
    destroy: vi.fn(), setOptions: vi.fn(), zoom: vi.fn(), pan: vi.fn(),
    zoomIn: vi.fn(), zoomOut: vi.fn(), zoomWithWheel: vi.fn(), getScale: vi.fn(() => scale),
  }
}

let viewer: ImageViewer | undefined
let mermaid: MermaidViewer | undefined
let media: MediaViewer
let language = 'en-US'
let overflow: string
const controllers: ReturnType<typeof controller>[] = []
const disconnects: ReturnType<typeof vi.fn>[] = []
const dialogMethods = new Map(['showModal', 'close'].map(name => [
  name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
]))

beforeEach(() => {
  panzoom.create.mockReset().mockImplementation((_element, options) => {
    const instance = controller(options.startScale ?? 1)
    controllers.push(instance)
    return instance
  })
  language = 'en-US'
  overflow = document.body.style.overflow
  document.body.innerHTML = '<main id="VPContent" class="vp-doc"></main>'
  document.body.style.overflow = 'auto'
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1032)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(632)
  vi.spyOn(SVGSVGElement.prototype, 'viewBox', 'get').mockReturnValue({ baseVal: { width: 2000, height: 3000 } } as SVGAnimatedRect)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = true
    this.querySelector<HTMLButtonElement>('[autofocus]')?.focus()
  } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  } })
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    constructor() { disconnects.push(this.disconnect) }
    observe(): void {}
  })
  media = new MediaViewer(document, () => language)
})

afterEach(() => {
  viewer?.dispose()
  mermaid?.dispose()
  media.close()
  viewer = undefined
  mermaid = undefined
  controllers.length = 0
  disconnects.length = 0
  document.body.replaceChildren()
  document.body.style.overflow = overflow
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [name, descriptor] of dialogMethods) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  }
})

function required<T>(value: T | null | undefined): T {
  assert(value != null)
  return value
}

function imageState(image: HTMLImageElement, complete = true) {
  const state = { complete, width: 1600, height: 800, currentSrc: '' }
  vi.spyOn(image, 'complete', 'get').mockImplementation(() => state.complete)
  vi.spyOn(image, 'naturalWidth', 'get').mockImplementation(() => state.width)
  vi.spyOn(image, 'naturalHeight', 'get').mockImplementation(() => state.height)
  vi.spyOn(image, 'currentSrc', 'get').mockImplementation(() => state.currentSrc)
  return state
}

function render(complete = true) {
  const container = document.createElement('p')
  const image = document.createElement('img')
  image.src = 'https://docs.example/provider.png'
  image.alt = 'DeepSeek API settings'
  container.append(image)
  required(document.querySelector('main')).append(container)
  return { image, container, state: imageState(image, complete) }
}

function install(): ImageViewer {
  viewer = new ImageViewer(document, () => language, media)
  return viewer
}

function entry(): HTMLElement {
  return getByRole(document.body, 'button', { name: 'View image fullscreen: DeepSeek API settings' })
}

function open(): HTMLDialogElement {
  entry().click()
  return getByRole(document.body, 'dialog', { name: 'DeepSeek API settings' }) as HTMLDialogElement
}

function enlarged(dialog: HTMLElement): HTMLImageElement {
  return required(dialog.querySelector('.dsh-media-paper')?.shadowRoot?.querySelector('img'))
}

describe('documentation image viewer', () => {
  it('adds one entry after a delayed image loads and removes it when loading fails', async () => {
    const { image, state } = render(false)
    install()
    expect(queryAllByRole(document.body, 'button')).toHaveLength(0)
    state.complete = true
    image.dispatchEvent(new Event('load'))
    const trigger = entry()
    required(viewer).refresh()
    await waitFor(() => { expect(queryAllByRole(document.body, 'button')).toHaveLength(1) })
    expect(entry()).toBe(trigger)
    state.width = 0
    image.dispatchEvent(new Event('error'))
    expect(queryAllByRole(document.body, 'button')).toHaveLength(0)
    expect(image.classList.contains('dsh-image-zoomable')).toBe(false)
    image.click()
    trigger.click()
    expect(queryByRole(document.body, 'dialog')).toBeNull()
  })

  it('leaves linked, decorative, inline, grouped, and failed images unchanged', () => {
    const root = required(document.querySelector('main'))
    root.innerHTML = [
      '<p><a href="https://example.com"><img alt="Linked screenshot"></a></p>',
      '<p><img alt=""></p>',
      '<p><img alt="   "></p>',
      '<p><img alt="Decorative" role="presentation"></p>',
      '<p><img alt="Decorative" role="none"></p>',
      '<p aria-hidden="true"><img alt="Hidden"></p>',
      '<p><img alt="Opt out" data-no-zoom></p>',
      '<div data-no-zoom><p><img alt="Container opt out"></p></div>',
      '<p>Inline <img alt="Badge"></p>',
      '<p><img alt="First"><img alt="Second"></p>',
      '<img alt="Outside paragraph">',
      '<div class="mermaid"><p><img alt="Diagram image"></p></div>',
      '<p><img alt="Failed"></p>',
    ].join('')
    for (const image of root.querySelectorAll('img')) {
      const state = imageState(image)
      if (image.alt === 'Failed') state.height = 0
    }
    const original = root.innerHTML
    install()
    expect(root.innerHTML).toBe(original)
    expect(queryAllByRole(root, 'button')).toHaveLength(0)
  })

  it.each([
    { locale: 'en-US', title: 'DeepSeek API settings', name: 'View image fullscreen: DeepSeek API settings', trigger: 'image' },
    { locale: 'zh-CN', title: 'DeepSeek API 配置', name: '全屏查看图片：DeepSeek API 配置', trigger: 'button' },
  ])('opens the loaded image with accessible controls in $locale', async ({ locale, title, name, trigger }) => {
    const { image, state } = render()
    language = locale
    image.alt = title
    state.currentSrc = 'https://docs.example/provider@2x.png'
    install()
    const button = getByRole(document.body, 'button', { name })
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    if (trigger === 'image') image.click()
    else button.click()
    const dialog = getByRole(document.body, 'dialog', { name: title })
    const clone = enlarged(dialog)
    expect(clone).not.toBe(image)
    expect(clone.src).toBe(state.currentSrc)
    expect(clone.alt).toBe(title)
    expect(clone.style.width).toBe('1600px')
    expect(clone.style.height).toBe('800px')
    expect(clone.draggable).toBe(false)
    expect(panzoom.create.mock.calls[0]?.[1]).toMatchObject({ startScale: 0.625, minScale: 0.3125 })
    expect(document.body.style.overflow).toBe('hidden')
    await expect(`${button.outerHTML}\n${dialog.outerHTML}\n${clone.outerHTML}\n`)
      .toMatchFileSnapshot(`./expected/image-viewer.${locale}.html`)
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
    expect(document.body.style.overflow).toBe('auto')
  })

  it('centers the original size and includes its control in the keyboard focus cycle', () => {
    render()
    install()
    const dialog = open()
    const original = getByRole(dialog, 'button', { name: /^Original size \(100%\), currently / })
    expect(original.textContent).toBe('63%')
    expect(original.getAttribute('aria-label')).toBe('Original size (100%), currently 63%')
    original.click()
    const current = required(controllers[0])
    expect(current.zoom).toHaveBeenCalledWith(1, { animate: false })
    expect(current.pan).toHaveBeenCalledWith(0, 0, { animate: false })
    current.getScale.mockReturnValue(1)
    required(dialog.querySelector('.dsh-media-paper')).dispatchEvent(new Event('panzoomchange'))
    expect(original.textContent).toBe('100%')
    expect(original.getAttribute('aria-label')).toBe('Original size (100%), currently 100%')
    const controls = ['Zoom out', 'Original size (100%), currently 100%', 'Zoom in', 'Fit view', 'Viewer help', 'Close']
    expect(document.activeElement).toBe(getByRole(dialog, 'button', { name: 'Close' }))
    for (const name of controls) {
      const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
      dialog.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(getByRole(dialog, 'button', { name }))
    }
    for (const name of controls.slice(0, -1).reverse().concat('Close')) {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))
      expect(document.activeElement).toBe(getByRole(dialog, 'button', { name }))
    }
  })

  it.each(['image', 'diagram'])('replaces an active %s view without leaking its controls or scroll lock', (first) => {
    render()
    required(document.querySelector('main')).insertAdjacentHTML('beforeend', '<div class="mermaid"><svg viewBox="0 0 2000 3000"></svg></div>')
    install()
    mermaid = installMermaidViewer(document, () => language, media)
    const imageTrigger = entry()
    const diagramTrigger = getByRole(document.body, 'button', { name: 'View diagram fullscreen' })
    const [oldTrigger, newTrigger] = first === 'image' ? [imageTrigger, diagramTrigger] : [diagramTrigger, imageTrigger]
    oldTrigger.click()
    const oldDialog = getByRole(document.body, 'dialog')
    const oldZoom = getByRole(oldDialog, 'button', { name: 'Zoom in' })
    newTrigger.click()
    const dialog = getByRole(document.body, 'dialog')
    expect(dialog).not.toBe(oldDialog)
    expect(queryAllByRole(document.body, 'dialog')).toHaveLength(1)
    expect(required(controllers[0]).destroy).toHaveBeenCalledOnce()
    expect(required(disconnects[0])).toHaveBeenCalledOnce()
    expect(document.body.style.overflow).toBe('hidden')
    expect(document.activeElement).toBe(getByRole(dialog, 'button', { name: 'Close' }))
    oldZoom.click()
    expect(required(controllers[0]).zoomIn).not.toHaveBeenCalled()
    if (first === 'image') required(viewer).refresh()
    else required(mermaid).refresh()
    expect(getByRole(document.body, 'dialog')).toBe(dialog)
    expect(document.body.style.overflow).toBe('hidden')
    expect(queryByRole(dialog, 'button', { name: /^Original size \(100%\), currently / }) === null).toBe(first === 'image')
    getByRole(dialog, 'button', { name: 'Close' }).click()
    expect(document.activeElement).toBe(newTrigger)
    expect(document.body.style.overflow).toBe('auto')
    expect(required(controllers[1]).destroy).toHaveBeenCalledOnce()
    expect(required(disconnects[1])).toHaveBeenCalledOnce()
  })

  it.each(['src', 'srcset'])('closes stale content after %s changes and opens the replacement', async (attribute) => {
    const { image, state } = render()
    install()
    const oldTrigger = entry()
    open()
    const replacement = 'https://docs.example/replacement.png'
    if (attribute === 'srcset') state.currentSrc = replacement
    image.setAttribute(attribute, attribute === 'srcset' ? `${replacement} 2x` : replacement)
    await waitFor(() => { expect(queryByRole(document.body, 'dialog')).toBeNull() })
    expect(document.body.style.overflow).toBe('auto')
    expect(required(controllers[0]).destroy).toHaveBeenCalledOnce()
    oldTrigger.click()
    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(entry()).not.toBe(oldTrigger)
    expect(enlarged(open()).src).toBe(replacement)
  })

  it('closes stale content when currentSrc changes after the srcset mutation', async () => {
    const { image, state } = render()
    state.currentSrc = image.src
    install()
    const oldTrigger = entry()
    const dialog = open()
    const replacement = 'https://docs.example/provider@2x.png'
    image.srcset = `${replacement} 2x`
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(getByRole(document.body, 'dialog')).toBe(dialog)
    expect(enlarged(dialog).src).toBe(state.currentSrc)

    state.currentSrc = replacement
    image.dispatchEvent(new Event('load'))
    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(document.body.style.overflow).toBe('auto')
    expect(required(controllers[0]).destroy).toHaveBeenCalledOnce()
    expect(entry()).not.toBe(oldTrigger)
    oldTrigger.click()
    expect(queryByRole(document.body, 'dialog')).toBeNull()
    expect(enlarged(open()).src).toBe(replacement)
  })

  it.each(['refresh', 'dispose', 'remove', 'error'] as const)('releases an open image on %s', async (action) => {
    const { image, container, state } = render()
    install()
    const trigger = entry()
    const dialog = open()
    const zoom = getByRole(dialog, 'button', { name: 'Zoom in' })
    if (action === 'remove') container.remove()
    else if (action === 'error') {
      state.width = 0
      image.dispatchEvent(new Event('error'))
    } else required(viewer)[action]()
    await waitFor(() => { expect(queryByRole(document.body, 'dialog')).toBeNull() })
    expect(document.body.style.overflow).toBe('auto')
    expect(required(controllers[0]).destroy).toHaveBeenCalledOnce()
    expect(required(disconnects[0])).toHaveBeenCalledOnce()
    zoom.click()
    expect(required(controllers[0]).zoomIn).not.toHaveBeenCalled()
    if (action === 'refresh') expect(document.activeElement).toBe(trigger)
    else {
      expect(image.classList.contains('dsh-image-zoomable')).toBe(false)
      expect(container.classList.contains('dsh-image-container')).toBe(false)
      image.click()
      trigger.click()
      expect(queryByRole(document.body, 'dialog')).toBeNull()
    }
    required(viewer).dispose()
    expect(required(controllers[0]).destroy).toHaveBeenCalledOnce()
  })

  it('refreshes localized entry names and stops enhancing new and delayed images after disposal', async () => {
    const ready = render()
    const pending = render(false)
    install()
    const trigger = entry()
    language = 'zh-CN'
    ready.image.alt = 'API 配置'
    required(viewer).refresh()
    expect(getByRole(document.body, 'button', { name: '全屏查看图片：API 配置' })).toBe(trigger)
    required(viewer).dispose()
    pending.state.complete = true
    pending.image.dispatchEvent(new Event('load'))
    render()
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
    expect(queryAllByRole(document.body, 'button')).toHaveLength(0)
    ready.image.click()
    pending.image.click()
    trigger.click()
    expect(panzoom.create).not.toHaveBeenCalled()
  })
})
