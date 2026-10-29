/** Hover capability checks for client stylesheets. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { atRuleBlock, packageFiles, packageStylesheets } from './stylesheet-scan.ts'

function unguardedHover(source: string): string[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const spans = [...css.matchAll(/@media\s+\(hover:\s*hover\)(?:\s+and\s+[^{}]+)?\s*\{/g)].map((match) => {
    const block = atRuleBlock(css.slice(match.index), match[0].slice(0, -1).trim())!
    return { start: match.index + block.start, end: match.index + block.end }
  })
  return [...css.matchAll(/[^{}]*:hover[^{}]*\{/g)]
    .filter((match) => {
      const offset = match.index + match[0].indexOf(':hover')
      return !spans.some(span => span.start < offset && offset < span.end)
    })
    .map(match => match[0].slice(0, -1).trim())
}

it('rejects unguarded hover and queries that also match devices without hover', () => {
  for (const source of [
    '.button:hover { color: red; }',
    '@media (min-width: 800px) { .button:hover { color: red; } }',
    '@media (any-hover: hover) { .button:hover { color: red; } }',
    '@media (hover: hover), (pointer: coarse) { .button:hover { color: red; } }',
  ]) expect(unguardedHover(source)).toEqual(['.button:hover'])
  expect(unguardedHover(`
    @media (hover: hover) { .button:hover { color: red; } }
    .button:focus-visible { outline: auto; }
    @media (min-width: 800px) {
      @media (hover: hover) and (prefers-reduced-motion: no-preference) {
        .row:has(.button:hover) { color: blue; }
      }
    }
  `)).toEqual([])
})

it('limits every client hover selector to hover-capable primary input', () => {
  const clientRoots = packageFiles(name => name === 'package.json').flatMap((file) => {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dsh?: { client?: object } }
    return manifest.dsh?.client === undefined ? [] : [file.slice(0, -'package.json'.length)]
  })
  const files = packageStylesheets().filter(file => file.includes('/packages/client/') || clientRoots.some(root => file.startsWith(root)))
  expect(files.length).toBeGreaterThan(0)
  const failures = files.flatMap(file => unguardedHover(readFileSync(file, 'utf8')).map(selector => `${file}: ${selector}`))
  expect(failures).toEqual([])
})
