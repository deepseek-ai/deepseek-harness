/**
 * macOS app-region subtraction, asserted against dockkit.module.css on disk: an
 * embedder may pin the surface at the window's top edge (the right sidebar does),
 * so the strip row marks itself `data-window-drag` in markup (TabPanel) and ui-web
 * base.css drags the row over its own box. Electron composes app-regions from
 * geometry in DOM order — every box that must stay usable subtracts itself from
 * that row. The divider must be listed explicitly: it is a plain div, so base.css's
 * interactive-element subtraction never matches it, and an unsubtracted vertical
 * divider's top run would drag the window instead of resizing the split.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Comments are stripped so a rule's captured selector is exactly its selector.
const css = readFileSync(resolve(import.meta.dirname, '../src/components/dockkit.module.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** The sheet's app-region rules, as `[selector, value]` in source order. */
const regionRules = [...css.matchAll(/(?<sel>[^{}]+)\{(?<body>[^{}]*)\}/g)]
  .map(match => [match.groups!['sel']!.trim(), match.groups!['body']!] as const)
  .filter(([, body]) => body.includes('-webkit-app-region'))
  .map(([selector, body]) => [
    selector,
    /-webkit-app-region:\s*([^;]+);/.exec(body)?.[1]?.trim(),
  ] as const)

describe('macOS app-region ownership', () => {
  it('subtracts the chip run, strip-end chrome, pane body, and divider, and declares no drag itself', () => {
    // The strip row's drag is the markup mark's job: a sheet that declares it
    // here would drag the same box twice and hide the row from the ownership gate.
    expect(regionRules).toHaveLength(1)

    const [selector, value] = regionRules[0]!
    expect(value).toBe('no-drag')
    for (const part of ['.stripTabs', '.stripChrome', '.paneBody', '.divider']) {
      expect(selector, part).toContain(`:global(html[data-platform='darwin']) ${part}`)
    }
  })

  it('scopes the subtraction to the darwin root', () => {
    // A floating panel lives beside #root, where ui-web base.css subtracts it, so
    // the strip's drag must never reach a non-macOS host.
    for (const [selector] of regionRules) {
      expect(selector).toContain("html[data-platform='darwin']")
    }
  })
})
