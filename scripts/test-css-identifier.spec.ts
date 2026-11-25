/** CSS identifier serialization agrees with the stylesheets lightningcss writes and reads. */
import { transform } from 'lightningcss'
import { describe, expect, it } from 'vitest'
import { cssIdentifier } from './test-css-identifier.ts'

/** Compile one rule for the class and collect the class names lightningcss reads from it. */
function compile(selector: string): { code: string; classes: string[] } {
  const classes: string[] = []
  const { code } = transform({
    filename: 'identifier.css', code: Buffer.from(`.${selector}{color:red}`), minify: true,
    visitor: { Selector(components) { for (const component of components) if (component.type === 'class') classes.push(component.name) } },
  })
  return { code: code.toString(), classes }
}

describe('cssIdentifier', () => {
  it.each([
    ['root', 'root'],
    ['-5fpAG_root', '-\\35 fpAG_root'],
    ['_5fpAG_root', '_5fpAG_root'],
    ['--5x', '--5x'],
    ['5ab', '\\35 ab'],
    ['-', '\\-'],
    ['a.b', 'a\\.b'],
    ['a\u0001b', 'a\\1 b'],
  ])('writes %s as lightningcss does, and lightningcss reads the name back', (name, written) => {
    expect(cssIdentifier(name)).toBe(written)
    expect(compile(written)).toEqual({ code: `.${written}{color:red}`, classes: [name] })
  })

  it('replaces NUL with U+FFFD, as CSS reads an escaped NUL', () => {
    expect(cssIdentifier('a\0b')).toBe('a\uFFFDb')
  })
})
