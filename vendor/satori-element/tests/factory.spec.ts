import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  type Attrs, type ButtonCallback, type Element, type ElementKey, elementInfo, Fragment, h, isElement, type JSX, jsx,
  normalize, reservedTags, type Tag, tags, toText, variantsOf,
} from '@deepseek-ai/satori-element'

describe('h', () => {
  it('builds runtime elements with typed attrs', () => {
    const el = h('a', { href: 'https://e.x' }, 'site')
    expect(el.type).toBe('a')
    expect(el.attrs.href).toBe('https://e.x')
    expect(el.toString()).toBe('<a href="https://e.x">site</a>')
    expect(isElement(el)).toBe(true)
  })

  it('accepts children without attrs for tags whose attrs are optional', () => {
    expect(h('b', 'x', h('i', 'y')).toString()).toBe('<b>x<i>y</i></b>')
    expect(h('p', [['a', ['b']], 'c']).toString()).toBe('<p>abc</p>')
  })

  it('skips holes, stringifies numbers and drops undefined attrs', () => {
    const show = false as boolean
    const name: string | undefined = undefined
    const el = h('p', show && h('b', 'no'), null, undefined, true, 42, h('at', { type: 'user', id: 'u', name }))
    expect(el.toString()).toBe('<p>42<at type="user" id="u"/></p>')
    expect('name' in el.children[1]!.attrs).toBe(false)
  })

  it('moves key out of attrs', () => {
    const el = h('p', { key: 'k1' }, 'x')
    expect(el.key).toBe('k1')
    expect('key' in el.attrs).toBe(false)
  })

  it('flattens fragments', () => {
    const frag = jsx(Fragment, { children: ['a', h('b', 'b')] })
    expect(h('p', frag).toString()).toBe('<p>a<b>b</b></p>')
    expect(normalize(frag).toString()).toBe('<message><p>a<b>b</b></p></message>')
  })

  it('has text and markdown helpers', () => {
    expect(h.text('t').toString()).toBe('t')
    expect(h.markdown('**x**').attrs.content).toBe('**x**')
  })

  it('keeps onClick callbacks as attributes', () => {
    const onClick: ButtonCallback = () => {}
    const el = h('button', { type: 'action', id: 'ok', onClick }, 'OK')
    expect(el.attrs.type === 'action' && el.attrs.onClick).toBe(onClick)
  })
})

describe('jsx runtime', () => {
  it('builds intrinsic elements, keys and markdown children', () => {
    expect(jsx('b', { children: ['x', 1] }).toString()).toBe('<b>x1</b>')
    expect(jsx('p', { children: 'x' }, 'k').key).toBe('k')
    expect(jsx('markdown', { children: 'src' }).attrs).toEqual({ content: 'src' })
  })

  it('calls function components eagerly', () => {
    const Bold = (props: { label: string }) => h('b', props.label)
    expect(jsx(Bold, { label: 'x' }).toString()).toBe('<b>x</b>')
    const Many = () => ['a', h('i', 'b')]
    expect(h('p', jsx(Many, null)).toString()).toBe('<p>a<i>b</i></p>')
  })
})

describe('category table', () => {
  it('covers every tag, none of them reserved', () => {
    expect(tags.length).toBe(Object.keys(elementInfo).length)
    for (const tag of reservedTags) expect(tags).not.toContain(tag)
    expect(elementInfo.spoiler.tier).toBe(2)
    expect(elementInfo.img.position).toBe('any')
    expect(elementInfo.li.parents).toEqual(['ul', 'ol'])
  })
})

// ---- type tests (checked by tsconfig.host.json; vitest only runs them) -------------------------------------------

describe('types', () => {
  it('types attrs per tag', () => {
    h('a', { href: 'x' })
    // @ts-expect-error -- href is required
    h('a', {})
    // @ts-expect-error -- a requires attrs, children-only form is not allowed
    h('a', 'text')
    // @ts-expect-error -- unknown attribute
    h('b', { bold: true })
    // @ts-expect-error -- unknown tag
    h('strong', 'x')
    // @ts-expect-error -- T3 tags are not in the vocabulary
    h('sup', '2')
    // @ts-expect-error -- at.type is a fixed union
    h('at', { type: 'everyone' })
    // @ts-expect-error -- theme is a semantic palette value
    h('title', { theme: 'red' }, 'x')
    // @ts-expect-error -- span colors come from the palette
    h('span', { color: '#ff0000' }, 'x')
    // @ts-expect-error -- img src is required
    h('img', { alt: 'x' })
    // @ts-expect-error -- ol.start is a number
    h('ol', { start: '1' })
  })

  it('types the button union', () => {
    h('button', { type: 'action', id: 'ok', data: 'v', onClick: () => {} }, 'OK')
    h('button', { type: 'link', href: 'https://e.x' }, 'open')
    h('button', { type: 'input', text: '/stop', send: true })
    // @ts-expect-error -- action buttons need an id
    h('button', { type: 'action' }, 'OK')
    // @ts-expect-error -- link buttons have no onClick
    h('button', { type: 'link', href: 'x', onClick: () => {} })
    // @ts-expect-error -- input buttons need text
    h('button', { type: 'input' })
  })

  it('narrows the Element union by type', () => {
    const el = h('a', { href: 'x' }) as Element
    if (el.type === 'a') expectTypeOf(el.attrs.href).toEqualTypeOf<string>()
    if (el.type === 'at') expectTypeOf(el.attrs.type).toEqualTypeOf<'user' | 'all' | 'here' | 'role'>()
    expectTypeOf(h('p')).toEqualTypeOf<Element<'p'>>()
    expectTypeOf(normalize('x')).toEqualTypeOf<Element<'message'>>()
    expectTypeOf(variantsOf(h('at', { type: 'all' }))).toEqualTypeOf<readonly ('user' | 'all' | 'here' | 'role')[]>()
    expectTypeOf(variantsOf(h('p'))).toEqualTypeOf<readonly never[]>()
    expectTypeOf(toText).returns.toEqualTypeOf<string>()
  })

  it('types capability keys', () => {
    const keys: ElementKey[] = ['element.p', 'element.at.all', 'element.button.inline', 'element.button-group']
    // @ts-expect-error -- not a declared variant
    const bad: ElementKey = 'element.at.everyone'
    // @ts-expect-error -- p has no variants
    const bad2: ElementKey = 'element.p.lang'
    void keys; void bad; void bad2
  })

  it('types JSX intrinsic props', () => {
    const ok: JSX.IntrinsicElements['a'] = { href: 'x', children: ['a', h('b', 'b'), null, false] }
    const md: JSX.IntrinsicElements['markdown'] = { children: '**x**' }
    // @ts-expect-error -- href is required in JSX too
    const bad: JSX.IntrinsicElements['a'] = { children: 'x' }
    // @ts-expect-error -- unknown attribute in JSX
    const bad2: JSX.IntrinsicElements['p'] = { align: 'center' }
    const tag: Tag = 'button-group'
    const attrs: Attrs<'td'> = { align: 'right', key: 'k' }
    void ok; void md; void bad; void bad2; void tag; void attrs
  })
})
