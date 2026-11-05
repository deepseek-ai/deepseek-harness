import { describe, expect, it } from 'vitest'
import { h, normalize, parse, toText } from '@deepseek-ai/satori-element'

describe('toText', () => {
  it('projects strings and inline formatting', () => {
    expect(toText('plain')).toBe('plain')
    expect(toText(h('p', 'a ', h('b', 'bold'), ' ', h('code', 'x()'), h('br'), 'next'))).toBe('a bold x()\nnext')
  })

  it('renders mentions as @name', () => {
    expect(toText(h('p', h('at', { type: 'user', id: 'ou_1', name: 'Alice' }), ' hi'))).toBe('@Alice hi')
    expect(toText(h('at', { type: 'user', id: 'ou_1' }))).toBe('@ou_1')
    expect(toText(h('at', { type: 'role', id: 'r', name: 'admins' }))).toBe('@admins')
    expect(toText([h('at', { type: 'all' }), ' ', h('at', { type: 'here' })])).toBe('@all @here')
    expect(toText([h('channel', { id: 'c1', name: 'general' }), ' ', h('emoji', { id: '1', name: 'smile' })]))
      .toBe('#general :smile:')
  })

  it('renders links with their target', () => {
    expect(toText(h('a', { href: 'https://e.x' }, 'site'))).toBe('site (https://e.x)')
    expect(toText(h('a', { href: 'https://e.x' }, 'https://e.x'))).toBe('https://e.x')
    expect(toText(h('a', { href: 'https://e.x' }))).toBe('https://e.x')
  })

  it('separates blocks by newlines and omits the quote envelope', () => {
    const content = normalize([
      h('quote', { id: 'm1' }), h('title', { subtitle: 'sub' }, 'Title'), 'para', h('h2', 'Head'), h('hr'),
      h('pre', { lang: 'ts' }, 'line1\nline2\n'),
    ])
    expect(toText(content)).toBe('Title\nsub\npara\nHead\n---\nline1\nline2')
  })

  it('renders lists with markers, checkboxes and nesting', () => {
    expect(toText(h('ul', h('li', 'a'), h('li', 'b')))).toBe('• a\n• b')
    expect(toText(h('ol', { start: 3 }, h('li', 'x'), h('li', 'y')))).toBe('3. x\n4. y')
    expect(toText(h('ul', h('li', { checked: true }, 'done'), h('li', { checked: false }, 'todo')))).toBe('• ☑ done\n• ☐ todo')
    const nested = normalize(h('ul', h('li', 'a', h('ol', h('li', 'b'), h('li', 'c'))), h('li', 'd')))
    expect(toText(nested)).toBe('• a\n  1. b\n  2. c\n• d')
  })

  it('renders blockquotes and details', () => {
    expect(toText(h('blockquote', h('p', 'a'), h('p', 'b')))).toBe('> a\n> b')
    expect(toText(normalize(h('details', 'body', h('summary', 'More'))))).toBe('More\nbody')
  })

  it('renders tables row by row', () => {
    const table = h('table',
      h('tr', h('th', 'name'), h('th', 'value')),
      h('tr', h('td', 'a'), h('td', h('code', '1'))),
      h('tr', h('td', 'b'), h('td', h('p', 'x'), h('p', 'y'))))
    expect(toText(table)).toBe('name | value\na | 1\nb | x y')
    expect(toText(normalize(table))).toBe('name | value\na | 1\nb | x y')
  })

  it('renders media, buttons and inbound wrappers', () => {
    expect(toText(normalize([
      'look', h('img', { src: 'a.png', alt: 'cat' }), h('img', { src: 'b.png' }), h('file', { src: 'f', name: 'r.pdf' }),
      h('audio', { src: 'a' }), h('video', { src: 'v', name: 'clip' }),
    ]))).toBe('look\n[image: cat]\n[image]\n[file: r.pdf]\n[audio]\n[video: clip]')
    expect(toText(h('button-group',
      h('button', { type: 'action', id: 'ok' }, 'OK'),
      h('button', { type: 'input', text: '/stop' })))).toBe('[OK] [/stop]')
    expect(toText(h('p', 'press ', h('button', { type: 'link', href: 'https://e.x' }, 'here')))).toBe('press [here]')
    expect(toText(h('forward', { id: 'f' }))).toBe('[forward]')
    expect(toText(h('raw', { platform: 'lark', type: 'sticker' }, '[sticker]'))).toBe('[sticker]')
  })

  it('projects form controls as the labels and options a reader would have used', () => {
    const form = h('form', { name: 'order' },
      h('input', { name: 'title', label: 'Title' }),
      h('input', { name: 'notes', placeholder: 'Notes' }),
      h('input', { name: 'agree', type: 'checkbox', label: 'I agree', value: true }),
      h('input', { name: 'plain', type: 'checkbox', label: 'Unchecked' }),
      h('select', { id: 'sel', placeholder: 'Size' },
        h('option', { value: 's' }, 'Small'), h('option', { value: 'l' }, 'Large')),
      h('select', { id: 'empty' }, h('option', { value: 'only' }, 'Only')),
      h('button', { type: 'submit', id: 'go' }, 'Send'))
    expect(toText(normalize(form))).toBe(
      '[Title]\n[Notes]\n☑ I agree\n☐ Unchecked\n[Size: Small / Large]\n[选择: Only]\n[Send]')
  })

  it('projects markdown as its source and tolerates unknown or reserved tags', () => {
    expect(toText(h.markdown('a\n\n**b**'))).toBe('a\n\n**b**')
    expect(toText(parse('x<sup>2</sup> <lark:card>c</lark:card>'))).toBe('x2 c')
  })

  it('conserves every text of a normalized tree', () => {
    const content = normalize([
      h('title', 'T'), 'p1 ', h('s', 's1'), h('blockquote', 'q1'), h('ul', h('li', 'l1', h('ul', h('li', 'l2')))),
      h('table', h('tr', h('td', 'c1'))), h('details', h('summary', 's2'), 'd1'), h('small', 'm1'),
      h('span', { color: 'info' }, 'sp1'), h('spoiler', 'x1'),
    ])
    const text = toText(content)
    for (const word of ['T', 'p1', 's1', 'q1', 'l1', 'l2', 'c1', 's2', 'd1', 'm1', 'sp1', 'x1']) expect(text).toContain(word)
  })
})
