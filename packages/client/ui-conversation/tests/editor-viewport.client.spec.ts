// @vitest-environment jsdom
/** Composer caret visibility across page scrolling and virtual-keyboard viewport changes. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { DraftEditorRuntime } from '../src/client/input/editor/runtime.ts'

function fixture(viewport: { height: number; offsetTop: number; pageTop: number } | undefined, pageScroll: number) {
  // jsdom has no visual viewport or Range geometry; use the browser measurements
  // while leaving Lexical's DOM selection and scrolling decisions intact.
  vi.stubGlobal('visualViewport', viewport)
  vi.stubGlobal('scrollY', pageScroll)
  vi.stubGlobal('innerHeight', 600)
  const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
  const geometry = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  let caret = new DOMRect(20, 169, 0, 26)
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => caret,
  })
  const root = document.createElement('div')
  root.setAttribute('contenteditable', 'true')
  root.tabIndex = 0
  root.getBoundingClientRect = () => new DOMRect(0, 0, 400, 1000)
  document.body.append(root)
  const runtime: DraftEditorRuntime = new DraftEditorRuntime({
    onUpdate: () => { runtime.refreshProjection() },
    quoteLabels: () => ({ remove: 'Remove quote' }),
    openReference: () => false,
    lexicon: () => new Map(), resolveLexicon: () => undefined,
  })
  const dispose = runtime.register()
  onTestFinished(() => {
    dispose()
    root.remove()
    scrollBy.mockRestore()
    if (geometry === undefined) Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
    else Object.defineProperty(Range.prototype, 'getBoundingClientRect', geometry)
    vi.unstubAllGlobals()
  })
  runtime.editor.setRootElement(root)
  root.focus({ preventScroll: true })
  scrollBy.mockClear()
  return {
    scrollBy,
    typeAt(top: number): void {
      caret = new DOMRect(20, top, 0, 26)
      runtime.setDraft('a')
    },
  }
}

it('keeps a visible caret still after Safari pans the page above the keyboard', () => {
  const f = fixture({ height: 376, offsetTop: 196, pageTop: 196 }, 196)
  f.typeAt(169)
  expect(f.scrollBy).not.toHaveBeenCalled()
})

it('reveals a caret below the keyboard after the page has scrolled', () => {
  const f = fixture({ height: 376, offsetTop: 196, pageTop: 196 }, 196)
  f.typeAt(410)
  expect(f.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 60)
})

it('retains visual viewport panning relative to an already scrolled page', () => {
  const f = fixture({ height: 376, offsetTop: 150, pageTop: 350 }, 200)
  f.typeAt(100)
  expect(f.scrollBy).toHaveBeenCalledExactlyOnceWith(0, -50)
})

it('uses the window height when the browser has no visual viewport', () => {
  const f = fixture(undefined, 200)
  f.typeAt(630)
  expect(f.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 56)
})
