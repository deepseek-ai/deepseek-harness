import { describe, expect, it } from 'vitest'
import { h, normalize, normalizeChildren, NormalizeError, parse, reservedTags, tags } from '@deepseek-ai/satori-element'

const xml = (content: Parameters<typeof normalize>[0]) => normalize(content).toString()

function errorOf(fn: () => unknown): NormalizeError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(NormalizeError)
    return error as NormalizeError
  }
  throw new Error('expected a NormalizeError')
}

describe('normalize: root', () => {
  it('wraps plain strings into message > p as literal text (no markup parsing)', () => {
    expect(xml('hello <b>x</b>')).toBe('<message><p>hello &lt;b&gt;x&lt;/b&gt;</p></message>')
  })

  it('unwraps a single message root and keeps its key', () => {
    const root = h('message', { key: 'm1' }, 'a')
    const out = normalize(root)
    expect(out.type).toBe('message')
    expect(out.key).toBe('m1')
    expect(out.toString()).toBe('<message><p>a</p></message>')
  })

  it('accepts empty content', () => {
    expect(xml([])).toBe('<message/>')
    expect(xml('')).toBe('<message/>')
  })

  it('rejects a nested message', () => {
    const error = errorOf(() => normalize(['a', h('message', 'b')]))
    expect(error.message).toMatch(/only allowed as the root/)
    expect(error.path).toBe('message/message[1]')
  })

  it('does not mutate the input', () => {
    const input = h('message', 'a', h('b', 'x'), h('ul', 'item'))
    const before = input.toString()
    normalize(input)
    expect(input.toString()).toBe(before)
  })

  it('is idempotent', () => {
    const once = normalize([
      h('quote', { id: 'q' }), 'intro ', h('b', 'bold'), h('ul', h('li', 'one', h('ol', 'two'))),
      h('table', h('tr', h('th', 'a'), h('td', 'b'))), h('details', 'body', h('summary', 's')), h('img', { src: 'x' }),
      h('title', 'T'),
    ])
    expect(normalize(once).toString()).toBe(once.toString())
  })
})

describe('normalize: <p> wrapping', () => {
  it('wraps inline runs between blocks and drops whitespace-only runs', () => {
    expect(xml(['a', h('b', 'b'), h('hr'), '  \n ', h('hr'), 'c', h('br'), 'd']))
      .toBe('<message><p>a<b>b</b></p><hr/><hr/><p>c<br/>d</p></message>')
  })

  it('wraps inside every flow container', () => {
    expect(xml(h('ul', h('li', 'x')))).toBe('<message><ul><li><p>x</p></li></ul></message>')
    expect(xml(h('blockquote', 'x', h('hr')))).toBe('<message><blockquote><p>x</p><hr/></blockquote></message>')
    expect(xml(h('table', h('tr', h('th', 'h'), h('td', 'x')))))
      .toBe('<message><table><tr><th><p>h</p></th><td><p>x</p></td></tr></table></message>')
    expect(xml(h('details', 'x'))).toBe('<message><details><p>x</p></details></message>')
  })

  it('keeps media and buttons as blocks at flow level and inline inside phrasing', () => {
    expect(xml(['see ', h('img', { src: 'a.png' }), 'after']))
      .toBe('<message><p>see </p><img src="a.png"/><p>after</p></message>')
    expect(xml(h('p', 'see ', h('img', { src: 'a.png' }))))
      .toBe('<message><p>see <img src="a.png"/></p></message>')
    expect(xml(['x', h('button', { type: 'link', href: 'https://e.x' }, 'go')]))
      .toBe('<message><p>x</p><button type="link" href="https://e.x">go</button></message>')
  })

  it('merges adjacent text and drops empty text', () => {
    const out = normalize(h('p', 'a', '', 'b', 1, h('b', 'c', 'd')))
    const p = out.children[0]!
    expect(p.children.map(c => c.type)).toEqual(['text', 'b'])
    expect(p.toString()).toBe('<p>ab1<b>cd</b></p>')
  })

  it('wraps stray list content into <li> and drops whitespace', () => {
    expect(xml(h('ul', ' ', h('li', 'a'), 'b', h('b', 'c'), h('li', 'd'))))
      .toBe('<message><ul><li><p>a</p></li><li><p>b<b>c</b></p></li><li><p>d</p></li></ul></message>')
  })

  it('collapses text-only containers', () => {
    expect(xml(h('pre', { lang: 'ts' }, 'a', h('br'), 'b'))).toBe('<message><pre lang="ts">a\nb</pre></message>')
    expect(xml(h('p', h('code', 'x', 'y')))).toBe('<message><p><code>xy</code></p></message>')
  })
})

describe('normalize: envelope', () => {
  it('hoists quote then title to the front of the root', () => {
    expect(xml(['body', h('title', { theme: 'info' }, 'T'), h('quote', { id: 'm1' })]))
      .toBe('<message><quote id="m1"/><title theme="info">T</title><p>body</p></message>')
  })

  it('rejects duplicates', () => {
    expect(errorOf(() => normalize([h('quote', { id: 'a' }), h('quote', { id: 'b' })])).message)
      .toMatch(/at most one <quote>/)
    expect(errorOf(() => normalize([h('title', 'a'), h('title', 'b')])).message).toMatch(/at most one <title>/)
  })

  it('rejects envelope elements below the root', () => {
    const quote = errorOf(() => normalize(h('blockquote', h('quote', { id: 'a' }))))
    expect(quote.message).toMatch(/<quote> is only allowed directly inside <message>/)
    expect(quote.path).toBe('message/blockquote[0]/quote[0]')
    expect(errorOf(() => normalize(h('p', h('title', 'x')))).message).toMatch(/<title> is only allowed/)
    expect(errorOf(() => normalize(h('ul', h('li', h('title', 'x'))))).message).toMatch(/<title> is only allowed/)
  })

  it('rejects quote content and a missing id', () => {
    expect(errorOf(() => normalize(h('quote', { id: 'a' }, 'quoted text'))).message).toMatch(/takes no children/)
    expect(errorOf(() => normalize(parse('<quote/>'))).message).toMatch(/requires a non-empty "id"/)
  })

  it('hoists summary to the front of details and keeps it single', () => {
    expect(xml(h('details', { open: true }, 'body', h('summary', 'S'))))
      .toBe('<message><details open><summary>S</summary><p>body</p></details></message>')
    expect(errorOf(() => normalize(h('details', h('summary', 'a'), h('summary', 'b')))).message).toMatch(/at most one/)
    expect(errorOf(() => normalize(h('summary', 'a'))).message).toMatch(/only allowed directly inside <details>/)
  })
})

describe('normalize: rejections', () => {
  it('rejects every T3 tag', () => {
    for (const tag of reservedTags) {
      const error = errorOf(() => normalize(parse(`<${tag}>x</${tag}>`)))
      expect(error.message).toBe(`<${tag}> is reserved (T3) and not supported in v1 (at message/${tag}[0])`)
    }
    expect(errorOf(() => normalize(h('p', parse('<sup>2</sup>')))).path).toBe('message/p[0]/sup[0]')
  })

  it('rejects aliases with a hint and unknown tags', () => {
    expect(errorOf(() => normalize(parse('<strong>x</strong>'))).message).toMatch(/unknown element <strong>; use <b>/)
    expect(errorOf(() => normalize(parse('<image src="x"/>'))).message).toMatch(/use <img>/)
    expect(errorOf(() => normalize(parse('<sharp id="1"/>'))).message).toMatch(/use <channel>/)
    expect(errorOf(() => normalize(parse('<lark:card/>'))).message).toMatch(/unknown element <lark:card>/)
    expect(errorOf(() => normalize(parse('<i18n path="x"/>'))).message).toMatch(/unknown element <i18n>/)
  })

  it('rejects blocks inside phrasing content', () => {
    expect(errorOf(() => normalize(h('p', 'a', h('ul', 'b')))).message).toMatch(/block <ul> inside inline content of <p>/)
    expect(errorOf(() => normalize(h('b', h('p', 'x')))).message).toMatch(/block <p> inside inline content of <b>/)
    expect(errorOf(() => normalize(h('h1', h('hr')))).path).toBe('message/h1[0]/hr[0]')
  })

  it('rejects structural misuse of lists, tables and button groups', () => {
    expect(errorOf(() => normalize(h('li', 'x'))).message).toMatch(/<li> is only allowed directly inside <ul> or <ol>/)
    expect(errorOf(() => normalize(h('table', 'x'))).message).toMatch(/<table> only contains <tr>, got <text>/)
    expect(errorOf(() => normalize(h('table', h('tr', h('p', 'x'))))).message).toMatch(/<tr> only contains <th> or <td>/)
    expect(errorOf(() => normalize(h('button-group', h('b', 'x')))).message).toMatch(/only contains <button>/)
    expect(errorOf(() => normalize(h('pre', h('b', 'x')))).message).toMatch(/<pre> only contains text/)
    expect(errorOf(() => normalize(h('p', h('br', 'x')))).message).toMatch(/<br> takes no children/)
  })

  it('validates required attributes', () => {
    expect(errorOf(() => normalize(parse('<a>x</a>'))).message).toMatch(/<a> requires a non-empty "href"/)
    expect(errorOf(() => normalize(parse('<img/>'))).message).toMatch(/<img> requires a non-empty "src"/)
    expect(errorOf(() => normalize(parse('<at id="1"/>'))).message).toMatch(/<at> type must be/)
    expect(errorOf(() => normalize(parse('<at type="user"/>'))).message).toMatch(/requires an "id"/)
    expect(xml(parse('<at type="all"/>'))).toBe('<message><p><at type="all"/></p></message>')
    expect(errorOf(() => normalize(parse('<button type="action">x</button>'))).message).toMatch(/requires "id"/)
    expect(errorOf(() => normalize(parse('<button type="link">x</button>'))).message).toMatch(/requires "href"/)
    expect(errorOf(() => normalize(parse('<button type="input">x</button>'))).message).toMatch(/requires "text"/)
    expect(errorOf(() => normalize(parse('<button>x</button>'))).message).toMatch(/type must be action/)
  })

  it('checks the optional button presentation attributes', () => {
    const ok = h('button', {
      type: 'action', id: 'b', size: 'small', width: 96, icon: 'done_outlined', tip: 't', disabledTip: 'd',
      confirm: { title: 'T', text: 'X' }, variant: 'primary_filled',
    }, 'go')
    expect(normalize(ok).children[0]!.attrs).toMatchObject({ width: 96, variant: 'primary_filled' })
    expect(normalize(h('button', { type: 'link', href: 'https://e.x', width: 'fill' }, 'go'))).toBeDefined()
    const bad = (attrs: Record<string, unknown>) =>
      errorOf(() => normalize(h('button', { type: 'action', id: 'b', ...attrs } as never, 'go'))).message
    expect(bad({ size: 'huge' })).toMatch(/size must be tiny/)
    expect(bad({ width: 0 })).toMatch(/width must be default/)
    expect(bad({ width: 'wide' })).toMatch(/width must be default/)
    expect(bad({ variant: 'ghost' })).toMatch(/variant must be/)
    expect(bad({ icon: '' })).toMatch(/icon must be a non-empty string/)
    expect(bad({ confirm: { title: 'T' } })).toMatch(/confirm requires/)
    expect(errorOf(() => normalize(h('button-group', { width: 'half' } as never))).message).toMatch(/width must be auto/)
    expect(errorOf(() => normalize(h('button-group', { align: 'top' } as never))).message).toMatch(/align must be left/)
  })

  it('validates nothing extra for a plain button', () => {
    expect(xml(h('button', { type: 'action', id: 'b' }, 'go'))).toBe('<message><button type="action" id="b">go</button></message>')
  })

  it('rejects unbuilt function components', () => {
    const component = { type: 'component', attrs: {}, children: [] }
    expect(errorOf(() => normalize(component as never)).message).toMatch(/function components/)
  })
})

describe('normalize: markdown', () => {
  it('keeps <markdown> as one element between the blocks of flow content, its source unparsed', () => {
    expect(xml(['x', h.markdown('a\n**b**'), h('hr')]))
      .toBe('<message><p>x</p><markdown content="a\n**b**"/><hr/></message>')
  })

  it('keeps <markdown> inside phrasing content', () => {
    expect(xml(h('p', 'say: ', h.markdown('hi')))).toBe('<message><p>say: <markdown content="hi"/></p></message>')
  })

  it('accepts text children as the source', () => {
    const [markdown] = normalize(parse('<markdown>text child</markdown>')).children
    expect(markdown).toMatchObject({ type: 'markdown', attrs: { content: 'text child' }, children: [] })
  })
})

describe('normalize: form controls', () => {
  it('keeps a form and its controls in document order', () => {
    const [form] = normalize(parse(
      '<form name="order"><input name="title" label="Title"/>interstitial'
      + '<select id="sel" name="size"><option value="s">Small</option></select>'
      + '<button type="submit" id="go">Send</button></form>')).children
    expect(form).toMatchObject({ type: 'form', attrs: { name: 'order' } })
    expect(form!.children.map(child => child.type)).toEqual(['input', 'p', 'select', 'button'])
    expect(form!.children[2]!.children.map(child => child.type)).toEqual(['option'])
  })

  it('wraps controls at flow level and rejects them inside phrasing content', () => {
    expect(xml([h('p', 'before'), h('input', { name: 'a' })])).toBe('<message><p>before</p><input name="a"/></message>')
    expect(errorOf(() => normalize(h('p', 'x', h('input', { name: 'a' })))).message)
      .toMatch(/block <input> inside inline content/)
    expect(errorOf(() => normalize(h('p', 'x', h('select', { id: 's' })))).message)
      .toMatch(/block <select> inside inline content/)
  })

  it('validates the form key, the control name and each option value', () => {
    expect(errorOf(() => normalize(parse('<form><input name="a"/></form>'))).message)
      .toMatch(/<form> requires a non-empty "name"/)
    expect(errorOf(() => normalize(parse('<input/>'))).message)
      .toMatch(/<input> requires a "name" \(feeds its form\) or an "id" \(reports its toggle\)/)
    // A checkbox may report its own toggles instead of feeding a form, but only a checkbox has a toggle callback.
    expect(normalize(h('input', { type: 'checkbox', id: 'c', onChange: () => {} })).children).toHaveLength(1)
    expect(errorOf(() => normalize(h('input', { name: 'a', onChange: () => {} }))).message)
      .toMatch(/<input> onChange needs type="checkbox"/)
    expect(errorOf(() => normalize(h('input', { name: 'a', type: 'checkbox', onChange: () => {} }))).message)
      .toMatch(/requires an "id"/)
    expect(errorOf(() => normalize(parse('<select/>'))).message)
      .toMatch(/<select> requires an "id" \(reports its pick\) or a "name" \(feeds its form\)/)
    // Either channel alone is enough: an id reports the pick, a name feeds the enclosing form.
    expect(normalize(parse('<select id="s"><option value="a">A</option></select>')).children).toHaveLength(1)
    expect(normalize(parse('<select name="s"><option value="a">A</option></select>')).children).toHaveLength(1)
    expect(errorOf(() => normalize(parse('<select id="s"><option>A</option></select>'))).message)
      .toMatch(/<option> requires a non-empty "value"/)
    expect(errorOf(() => normalize(parse('<select id="s"><p>x</p></select>'))).message)
      .toMatch(/<select> only contains <option>, got <p>/)
    expect(errorOf(() => normalize(parse('<option value="a">A</option>'))).message)
      .toMatch(/<option> is only allowed directly inside <select>/)
  })

  it('validates the input mode, its bounds and the value type each mode takes', () => {
    expect(errorOf(() => normalize(parse('<input name="a" type="date"/>'))).message)
      .toMatch(/<input> type must be text \| multiline \| password \| checkbox/)
    expect(errorOf(() => normalize(parse('<input name="a" maxLength="0"/>'))).message).toMatch(/positive integer/)
    expect(errorOf(() => normalize(h('input', { name: 'a', value: true }))).message).toMatch(/value must be a string/)
    expect(errorOf(() => normalize(parse('<input name="a" type="checkbox" value="yes"/>'))).message)
      .toMatch(/value must be a boolean/)
    expect(normalize(h('input', { name: 'a', type: 'checkbox', value: true })).children[0]!.attrs)
      .toMatchObject({ name: 'a', type: 'checkbox', value: true })
  })

  it('validates the arity of a select initial value', () => {
    expect(normalize(parse('<select id="s" value="a"/>')).children[0]).toMatchObject({ type: 'select', attrs: { value: 'a' } })
    expect(errorOf(() => normalize(parse('<select id="s" multiple="true" value="a"/>'))).message)
      .toMatch(/value must be string\[\]/)
    expect(normalize(h('select', { id: 's', multiple: true, value: ['a', 'b'] })).children).toHaveLength(1)
  })
})

describe('normalize: plain element objects', () => {
  it('accepts { type, attrs, children } objects (e.g. deserialized content)', () => {
    const plain = { type: 'p', attrs: {}, children: [{ type: 'text', attrs: { content: 'x' }, children: [] }] }
    expect(xml(plain as never)).toBe('<message><p>x</p></message>')
  })
})

describe('normalizeChildren', () => {
  it('normalizes fallback output in the context of a given parent', () => {
    expect(normalizeChildren(['a', h('b', 'b')], 'li').map(String)).toEqual(['<p>a<b>b</b></p>'])
    expect(normalizeChildren(['a', h('b', 'b')], 'p').map(String)).toEqual(['a', '<b>b</b>'])
    expect(() => normalizeChildren(h('hr'), 'span')).toThrow(NormalizeError)
  })

  it('knows every tag', () => {
    for (const tag of tags) expect(() => normalizeChildren([], tag)).not.toThrow()
  })
})
