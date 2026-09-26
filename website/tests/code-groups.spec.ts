/** Native code-group markup remains isolated when local search copies a section. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { createMarkdownRenderer } from 'vitepress'
import { expect, it } from 'vitest'
import { codeGroupFallbackHead, isolateCodeGroupRadios } from '../.vitepress/code-groups.ts'

const source = '::: code-group\n\n```sh [Linux/macOS]\n. .venv/bin/activate\n```\n\n```powershell [Windows PowerShell]\n.venv\\Scripts\\Activate.ps1\n```\n\n:::\n'

it('keeps the page selection when a search excerpt selects the same named radio', async () => {
  const md = await createMarkdownRenderer(import.meta.dirname, { config: isolateCodeGroupRadios })
  const html = md.render(source)
  const dom = new JSDOM(`<main>${html}</main><aside></aside>`)
  try {
    const { document } = dom.window
    const pageRadios = document.querySelectorAll<HTMLInputElement>('main input')
    const excerpt = document.querySelector('aside')
    assert(pageRadios[0] && pageRadios[1] && excerpt)
    pageRadios[1].checked = true

    // Search remounts the compiled page, reusing its generated radio names and IDs.
    excerpt.innerHTML = html
    expect(pageRadios[1].checked).toBe(true)
    const excerptRadio = excerpt.querySelector<HTMLInputElement>('input')
    assert(excerptRadio)
    excerptRadio.checked = true

    expect(pageRadios[0].checked).toBe(false)
    expect(pageRadios[1].checked).toBe(true)
    expect(excerptRadio.checked).toBe(true)
    expect(pageRadios[0].name).toBe(excerptRadio.name)
    expect(pageRadios[0].form).not.toBeNull()
    expect(pageRadios[0].form).not.toBe(excerptRadio.form)
    expect(document.querySelector('main .tabs')?.hasAttribute('@submit.prevent')).toBe(true)
    expect([...document.querySelectorAll('main code')].map(code => code.textContent)).toEqual([
      '. .venv/bin/activate', '.venv\\Scripts\\Activate.ps1',
    ])
    expect(document.querySelectorAll('main .blocks > .active')).toHaveLength(1)
  } finally {
    dom.window.close()
  }
})

it('exposes both commands without client handlers in MPA output', async () => {
  const md = await createMarkdownRenderer(import.meta.dirname, { config: isolateCodeGroupRadios })
  const nativeStyles = readFileSync(new URL('../node_modules/vitepress/dist/client/theme-default/styles/components/vp-code-group.css', import.meta.url), 'utf8')
  const fallback = codeGroupFallbackHead(true)
  const dom = new JSDOM(`<style>${nativeStyles}</style>${md.render(source)}`)
  try {
    const { document } = dom.window
    const blocks = [...document.querySelectorAll<HTMLElement>('.blocks > div')]
    expect(blocks.map(block => dom.window.getComputedStyle(block).display)).toEqual(['block', 'none'])
    for (const [tag, , content] of fallback) {
      const element = document.createElement(tag)
      element.textContent = content ?? ''
      document.head.append(element)
    }
    expect(blocks.map(block => dom.window.getComputedStyle(block).display)).toEqual(['block', 'block'])
    const controls = [...document.querySelectorAll<HTMLElement>('.tabs, button.copy')]
    expect(controls).toHaveLength(3)
    expect(controls.every(control => dom.window.getComputedStyle(control).display === 'none')).toBe(true)
    expect(blocks.map(block => block.querySelector('code')?.textContent)).toEqual([
      '. .venv/bin/activate', '.venv\\Scripts\\Activate.ps1',
    ])
    expect(codeGroupFallbackHead(false)).toEqual([])
  } finally {
    dom.window.close()
  }
})
