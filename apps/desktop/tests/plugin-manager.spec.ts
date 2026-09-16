import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'

it('keeps disabled packages visible without an in-page recovery panel', async () => {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  let enabled = false
  const toggle = vi.fn(async (_name: string, active: boolean) => { enabled = active })
  const api = {
    locale: async () => resolveDesktopLocale('en'),
    plugins: { list: async () => [{ name: 'example-plugin', version: '1.0.0', enabled }], toggle },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  try {
    runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toContain('example-plugin')
    expect(document.querySelector('#recovery')).toBeNull()
    expect(document.querySelector('#plugins li')?.textContent).toMatchInlineSnapshot('"example-plugin1.0.0 · DisabledEnableUpdateRemove"')
    document.querySelector<HTMLButtonElement>('#plugins li button')?.click()
    await expect.poll(() => toggle.mock.calls).toEqual([['example-plugin', true]])
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toBe('example-plugin1.0.0DisableUpdateRemove')
  } finally { dom.window.close() }
})

it.each(['en', 'zh-CN'])('updates through the inline form, including the installed version (%s)', async (language) => {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  const locale = resolveDesktopLocale(language)
  const update = vi.fn(async () => {})
  Object.defineProperty(dom.window, 'dshDesktop', { value: {
    locale: async () => locale,
    plugins: { list: async () => [{ name: 'example-plugin', version: '1.0.0', enabled: true }], update },
  } })
  try {
    runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toContain('example-plugin')
    const updateButton = () => document.querySelectorAll<HTMLButtonElement>('#plugins li button')[1]!
    const form = document.querySelector<HTMLFormElement>('#update-form')!
    const version = document.querySelector<HTMLInputElement>('#update-version')!
    updateButton().click()
    expect(form.hidden).toBe(false)
    expect(version.value).toBe('1.0.0')
    expect(document.activeElement).toBe(version)
    expect(document.querySelector('#update-label')?.textContent).toBe(locale.messages.targetVersion.replace('{name}', 'example-plugin'))
    expect(document.querySelector('#update-cancel')?.textContent).toBe(locale.messages.cancel)
    if (language === 'en') {
      expect({ label: document.querySelector('#update-label')?.textContent,
        actions: [...form.querySelectorAll('button')].map(button => button.textContent) }).toMatchInlineSnapshot(`
          {
            "actions": [
              "Update",
              "Cancel",
            ],
            "label": "Enter the target version for example-plugin",
          }
        `)
    }
    document.querySelector<HTMLButtonElement>('#update-cancel')!.click()
    expect(form.hidden).toBe(true)
    expect(document.activeElement).toBe(updateButton())
    expect(update).not.toHaveBeenCalled()
    for (const target of ['1.0.0', '^2.0.0']) {
      updateButton().click()
      version.value = target
      form.requestSubmit()
      await expect.poll(() => document.querySelector('#status')?.textContent).toBe(locale.messages.operationComplete)
      expect(update).toHaveBeenLastCalledWith('example-plugin', target)
      expect(form.hidden).toBe(true)
    }
    expect(update).toHaveBeenCalledTimes(2)
  } finally { dom.window.close() }
})
