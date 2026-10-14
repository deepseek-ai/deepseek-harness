/** Terminal status positioning relative to the command's first visual line. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/TerminalBlock.module.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

it('centers the status dot on one command line rather than the wrapped prompt height', () => {
  const state = /\.runState\s*\{([^{}]*)\}/.exec(css)?.[1]
  const prompt = /\.promptLine\s*\{([^{}]*)\}/.exec(css)?.[1]
  expect(state).toBeDefined()
  expect(prompt).toBeDefined()
  expect(state).toContain('top: calc(var(--dsl-terminal-line-height) / 2)')
  expect(state).toContain('transform: translateY(-50%)')
  expect(prompt).toContain('line-height: var(--dsl-terminal-line-height)')
})
