import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

it('keeps disabled packages visible and offers recovery without a running backend', async () => {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  let enabled = true
  let ready = false
  const disableAll = vi.fn(async () => { enabled = false; ready = true })
  const toggle = vi.fn(async (_name: string, active: boolean) => { enabled = active })
  const api = {
    locale: async () => resolveDesktopLocale('en'),
    backend: { status: async () => ready ? { phase: 'ready' } : { phase: 'error', message: 'plugin requires Cordis ^2.0.0' }, retry: vi.fn() },
    plugins: { list: async () => [{ name: 'example-plugin', version: '1.0.0', enabled }], disableAll, toggle },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  try {
    runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toContain('example-plugin')
    expect(document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(false)
    expect(document.querySelector('#startup-error')?.textContent).toBe('plugin requires Cordis ^2.0.0')
    document.querySelector<HTMLButtonElement>('#disable-all')?.click()
    await expect.poll(() => document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(true)
    expect(disableAll).toHaveBeenCalledOnce()
    expect(document.querySelector('#plugins li')?.textContent).toMatchInlineSnapshot('"example-plugin1.0.0 · DisabledEnableUpdateRemove"')
    document.querySelector<HTMLButtonElement>('#plugins li button')?.click()
    await expect.poll(() => toggle.mock.calls).toEqual([['example-plugin', true]])
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toBe('example-plugin1.0.0DisableUpdateRemove')
  } finally { dom.window.close() }
})
