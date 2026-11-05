import { describe, expect, it } from 'vitest'
import {
  type Element, type ElementKey, h, keysOf, normalize, type VariantMap, variantKey, variantsOf, variantTable,
} from '@deepseek-ai/satori-element'

interface Case { el: Element; ancestors?: Element[] }

const p = h('p')

/**
 * One positive case per VariantMap entry. The mapped type makes a new VariantMap entry a compile error here until
 * a case is added (vendor tests are type-checked by tsconfig.host.json).
 */
const positive: { [K in keyof VariantMap]: Record<VariantMap[K], Case> } = {
  at: {
    user: { el: h('at', { type: 'user', id: 'u1' }) },
    all: { el: h('at', { type: 'all' }) },
    here: { el: h('at', { type: 'here' }) },
    role: { el: h('at', { type: 'role', id: 'r1' }) },
  },
  li: {
    checked: { el: h('li', { checked: false }, 'task') },
    nested: { el: h('li', h('p', 'a'), h('ul', h('li', 'b'))) },
  },
  pre: { lang: { el: h('pre', { lang: 'ts' }, 'x') } },
  span: { color: { el: h('span', { color: 'danger' }, 'x') } },
  table: { align: { el: h('table', h('tr', h('th', { align: 'center' }, 'a'))) } },
  td: { block: { el: h('td', h('p', 'a'), h('ul', h('li', 'b'))) } },
  img: { inline: { el: h('img', { src: 'x' }), ancestors: [h('message'), p] } },
  button: {
    action: { el: h('button', { type: 'action', id: 'b' }, 'go') },
    link: { el: h('button', { type: 'link', href: 'https://e.x' }, 'go') },
    input: { el: h('button', { type: 'input', text: '/help' }, 'help') },
    submit: { el: h('button', { type: 'submit', id: 'b' }, 'go') },
    theme: { el: h('button', { type: 'action', id: 'b', theme: 'info' }, 'go') },
    inline: { el: h('button', { type: 'action', id: 'b' }, 'go'), ancestors: [h('message'), p] },
  },
  input: { checkbox: { el: h('input', { name: 'agree', type: 'checkbox' }) } },
  select: { multiple: { el: h('select', { id: 's', multiple: true }, h('option', { value: 'a' }, 'A')) } },
}

describe('variantsOf', () => {
  it('reports every VariantMap entry for its positive case', () => {
    for (const [tag, cases] of Object.entries(positive)) {
      expect(Object.keys(cases).sort()).toEqual([...variantTable[tag as keyof VariantMap]].sort())
      for (const [variant, { el, ancestors }] of Object.entries(cases) as [string, Case][]) {
        expect(el.type).toBe(tag)
        expect(variantsOf(el, ancestors)).toContain(variant)
      }
    }
  })

  it('reports nothing for plain instances', () => {
    expect(variantsOf(h('li', 'x'))).toEqual([])
    expect(variantsOf(h('pre', 'x'))).toEqual([])
    expect(variantsOf(h('pre', { lang: '' }, 'x'))).toEqual([])
    expect(variantsOf(h('span', 'x'))).toEqual([])
    expect(variantsOf(h('span', { color: 'default' }, 'x'))).toEqual([])
    expect(variantsOf(h('table', h('tr', h('td', { align: 'left' }, 'x'))))).toEqual([])
    expect(variantsOf(h('td', h('p', 'x')))).toEqual([])
    expect(variantsOf(h('img', { src: 'x' }))).toEqual([])
    expect(variantsOf(h('img', { src: 'x' }), [h('message')])).toEqual([])
    expect(variantsOf(h('button', { type: 'link', href: 'x', theme: 'default' }, 'go'))).toEqual(['link'])
    expect(variantsOf(h('input', { name: 'a' }))).toEqual([])
    expect(variantsOf(h('input', { name: 'a', type: 'text' }))).toEqual([])
    expect(variantsOf(h('select', { id: 's' }, h('option', { value: 'a' }, 'A')))).toEqual([])
    expect(variantsOf(h('b', 'x'))).toEqual([])
  })

  it('takes td.block and li.nested from normalized structure', () => {
    const root = normalize(h('table', h('tr', h('td', 'one'), h('td', 'a', h('hr')))))
    const row = root.children[0]!.children[0]!
    expect(row.children.map(cell => variantsOf(cell))).toEqual([[], ['block']])
    const list = normalize(h('ul', h('li', 'a', h('ol', h('li', 'b')))))
    expect(variantsOf(list.children[0]!.children[0]!)).toEqual(['nested'])
  })

  it('lists button variants in VariantMap order', () => {
    expect(variantsOf(h('button', { type: 'input', text: 'x', theme: 'danger' }, 'x'), [p])).toEqual(['input', 'theme', 'inline'])
  })
})

describe('variantKey / keysOf', () => {
  it('builds capability keys', () => {
    const key: ElementKey = variantKey('at', 'all')
    expect(key).toBe('element.at.all')
    expect(variantKey('p')).toBe('element.p')
    expect(keysOf(h('pre', { lang: 'ts' }, 'x'))).toEqual(['element.pre', 'element.pre.lang'])
    expect(keysOf(h('img', { src: 'x' }), [p])).toEqual(['element.img', 'element.img.inline'])
  })
})
