import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

const file = join(import.meta.dirname, '../renderer/policy-login-loading.html')
const html = readFileSync(file, 'utf8')

/** Load the packaged placeholder the way the login window does: a local document with a query. */
function open(query = ''): Document {
  const dom = new JSDOM(html, {
    url: `${pathToFileURL(file).href}${query}`,
    runScripts: 'dangerously',
  })
  return dom.window.document
}

it('renders the login placeholder label from the main-process query', () => {
  const document = open(`?label=${encodeURIComponent('正在加载登录页面…')}`)
  expect(document.getElementById('label')?.textContent).toBe('正在加载登录页面…')
  const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
  // The placeholder must not be able to reach anything, so its own policy
  // forbids every source but the inline style and reader.
  expect(policy).toContain("default-src 'none'")
  expect(policy).not.toContain('http')
})

it('leaves the label empty when no query supplies one', () => {
  expect(open().getElementById('label')?.textContent).toBe('')
})
