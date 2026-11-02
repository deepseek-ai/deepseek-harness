import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'

it.each(['welcome', 'update-dialog', 'mandatory-update'].flatMap(document => [false, true].map(dark => ({ document, dark }))))(
  '$document applies the initial app palette and follows changes (dark=$dark)', ({ document, dark }) => {
    const dom = new JSDOM(readFileSync(new URL(`../renderer/${document}.html`, import.meta.url), 'utf8'), { runScripts: 'outside-only' })
    const palette = Object.assign(new dom.window.EventTarget(), { matches: dark, media: '(prefers-color-scheme: dark)',
      onchange: null, addListener: vi.fn(), removeListener: vi.fn() })
    const remove = vi.spyOn(palette, 'removeEventListener')
    dom.window.matchMedia = vi.fn(() => palette)
    try {
      expect(dom.window.document.querySelectorAll('script[src="shell-theme.js"]')).toHaveLength(1)
      runInContext(readFileSync(new URL('../renderer/shell-theme.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
      expect(dom.window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
      expect(dom.window.document.body.hasAttribute('data-ds-dark-theme')).toBe(dark)
      palette.matches = !dark
      palette.dispatchEvent(new dom.window.Event('change'))
      expect(dom.window.document.body.hasAttribute('data-ds-dark-theme')).toBe(!dark)
      dom.window.dispatchEvent(new dom.window.Event('pagehide'))
      expect(remove).toHaveBeenCalledWith('change', expect.any(Function))
      palette.matches = dark
      palette.dispatchEvent(new dom.window.Event('change'))
      expect(dom.window.document.body.hasAttribute('data-ds-dark-theme')).toBe(!dark)
    } finally { dom.window.close() }
  })
