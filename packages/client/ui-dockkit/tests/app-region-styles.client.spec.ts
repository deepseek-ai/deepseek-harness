/**
 * macOS app-region subtraction, asserted against dockkit.module.css on disk: an
 * embedder may pin the surface at the window's top edge (the right sidebar does),
 * so the strip row marks itself `data-window-drag` in markup (TabPanel) and ui-web
 * base.css drags the row over its own box. Electron composes app-regions from
 * geometry in DOM order — pane boxes are excluded before marked strip rows add
 * their geometry back. The divider must be listed explicitly: it is a plain div
 * outside a drag row, so base.css's scoped controls rule cannot exclude it. An
 * unsubtracted vertical divider's top run would drag the window instead of
 * resizing the split.
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

it('keeps Windows floating headers 20px below the caption, including restored positions', () => {
  const captionRule = css.split(':global(html[data-windows-titlebar]) .float')[1]?.split('}')[0]
  expect(captionRule).toContain('--dsh-dockkit-float-top: calc(var(--dsh-windows-titlebar-height) + 20px);')
  expect(css).toMatch(/:global\(html\[data-windows-titlebar\]\[data-fullscreen\]\) \.float\s*\{\s*--dsh-dockkit-float-top: 20px;/)
})

it('clamps a resting floating panel\'s position and size into the viewport and below the caption floor', () => {
  const floatRule = /(?:^|\})\s*\.float\s*\{(?<body>[^}]*)\}/.exec(css)?.groups?.['body']
  expect(floatRule).toContain('left: max(0px, min(var(--dsh-dockkit-float-x), 100vw - var(--dsh-dockkit-float-width)));')
  expect(floatRule).toContain(
    'top: max(var(--dsh-dockkit-float-top, 0px), min(var(--dsh-dockkit-float-y), 100dvh - var(--dsh-dockkit-float-height)));',
  )
  expect(floatRule).toContain('width: min(var(--dsh-dockkit-float-width), 100vw);')
  expect(floatRule).toContain('height: min(var(--dsh-dockkit-float-height), 100dvh - var(--dsh-dockkit-float-top, 0px));')
})

describe('macOS app-region ownership', () => {
  it('subtracts panes, strip-end chrome, floats, and dividers without declaring drag', () => {
    // The strip row's drag is the markup mark's job: a sheet that declares it
    // here would drag the same box twice and hide the row from the ownership gate.
    expect(regionRules).toHaveLength(1)

    const [selector, value] = regionRules[0]!
    expect(value).toBe('no-drag')
    for (const part of ['.pane', '.stripChrome', '.float', '.divider']) {
      expect(selector, part).toContain(`:global(:where(html[data-platform='darwin'])) ${part}`)
    }
  })

  it('scopes the subtraction to the darwin root', () => {
    for (const [selector] of regionRules) {
      expect(selector).toContain("html[data-platform='darwin']")
    }
  })
})
