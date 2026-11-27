/** Wrapping of the risk confirmation's description as CSS text. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/RiskConfirmation.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

it('wraps a description that quotes an unbroken path or command inside the dialog', () => {
  const description = /\.description\s*\{([^{}]*)\}/.exec(css)?.[1]
  expect(description).toBeDefined()
  expect(description).toContain('overflow-wrap: anywhere')
})
