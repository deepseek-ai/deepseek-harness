import { describe, expect, it } from 'vitest'
import { type Element, h, normalize, normalizeChildren, type Tag, tags, toText } from '@deepseek-ai/satori-element'
import {
  coreFallbacks, createRenderReport, defaultFallback, type Fallback, INTERACTION_DROPPED,
  mergeRenderReports, preservingVariants, type RenderReport,
} from '@deepseek-ai/cordis-plugin-im-core'

/** A `renders()` answering `true` for exactly the given element keys, as a mode registry would. */
function rendersWith(...supported: string[]) {
  return (key: string) => supported.includes(key)
}

/** Apply the core fallback of the (only) element of `content` placed in `parent`, normalized like the engine does. */
function lower(content: Element, options: { variant?: string; renders?: string[]; parent?: Tag; report?: RenderReport } = {}) {
  const parent = options.parent ?? 'message'
  const [el] = normalizeChildren(content, parent)
  const fallback = defaultFallback(el!.type) as Fallback<Tag>
  const report = options.report ?? createRenderReport()
  const output = fallback(el as never, {
    renders: rendersWith(...options.renders ?? []), ...options.variant !== undefined && { variant: options.variant }, ancestors: [h('message')], report,
  })
  return normalizeChildren(output as never, parent)
}

const text = (nodes: Element[]) => toText(nodes)
const xml = (nodes: Element[]) => nodes.map(node => node.toString()).join('')

describe('core fallback table', () => {
  it('covers every tag except the base tags and the root', () => {
    // allback and its case candidates are resolved by the engine itself, never through the core table.
    const missing = tags.filter(tag => !defaultFallback(tag))
    expect(missing.sort()).toEqual(['br', 'case', 'fallback', 'message', 'p', 'text'])
    expect(Object.keys(coreFallbacks)).not.toContain('text')
    expect(preservingVariants.has('pre.lang')).toBe(true)
  })

  it('inline styles keep their children', () => {
    for (const tag of ['b', 'i', 'u', 's', 'spoiler', 'code'] as const) {
      expect(xml(lower(h(tag, 'x'), { parent: 'p' }))).toBe('x')
    }
    expect(xml(lower(h('span', { color: 'danger' }, 'x'), { parent: 'p' }))).toBe('x')
    expect(lower(h('span', { color: 'danger' }, 'x'), { parent: 'p', variant: 'color' })[0]!.attrs).toEqual({})
  })

  it('links, mentions, channels and emoji become text', () => {
    expect(text(lower(h('a', { href: 'https://a.test' }, 'site'), { parent: 'p' }))).toBe('site (https://a.test)')
    expect(text(lower(h('a', { href: 'https://a.test' }, 'https://a.test'), { parent: 'p' }))).toBe('https://a.test')
    expect(xml(lower(h('a', { href: 'https://a.test' }, h('b', 'bold')), { parent: 'p' }))).toBe('<b>bold</b> (https://a.test)')
    expect(text(lower(h('at', { type: 'user', id: 'u1' }), { parent: 'p' }))).toBe('@u1')
    expect(text(lower(h('at', { type: 'user', id: 'u1', name: 'Bob' }), { parent: 'p', variant: 'user' }))).toBe('@Bob')
    expect(text(lower(h('at', { type: 'all' }), { parent: 'p', variant: 'all' }))).toBe('@所有人')
    expect(text(lower(h('at', { type: 'here' }), { parent: 'p' }))).toBe('@在线成员')
    expect(text(lower(h('channel', { id: 'c1' }), { parent: 'p' }))).toBe('#c1')
    expect(text(lower(h('emoji', { id: '1', name: 'smile' }), { parent: 'p' }))).toBe(':smile:')
    expect(text(lower(h('emoji', { id: '14', name: '微笑' }), { parent: 'p' }))).toBe('[微笑]')
  })

  it('headings go to the next lower supported level, else bold paragraphs', () => {
    expect(xml(lower(h('h2', { key: 'k' }, 'x'), { renders: ['element.h4', 'element.h5'] }))).toBe('<h4>x</h4>')
    expect(lower(h('h2', { key: 'k' }, 'x'), { renders: ['element.h4'] })[0]!.key).toBe('k')
    expect(xml(lower(h('h2', 'x'), { renders: ['element.h1'] }))).toBe('<p><b>x</b></p>')
    expect(xml(lower(h('h6', 'x')))).toBe('<p><b>x</b></p>')
  })

  it('lists become prefixed paragraphs with boxes and indentation', () => {
    const list = h('ol', { start: 2 },
      h('li', 'two', h('ul', h('li', { checked: true }, 'sub'), h('li', 'sub2'))),
      h('li', h('pre', 'code'), h('p', 'after')),
      h('li'))
    expect(text(lower(list))).toBe(['2. two', '  ☑ sub', '  ◦ sub2', '3.', 'code', '  after', '4.'].join('\n'))
    expect(text(lower(h('ul', h('li', { checked: false }, 'todo'), h('li', 'plain'))))).toBe('☐ todo\n• plain')
  })

  it('li variants keep the item', () => {
    const [checked] = lower(h('li', { checked: true, key: 'k' }, 'done'), { parent: 'ul', variant: 'checked' })
    expect(checked!.type).toBe('li')
    expect(checked!.key).toBe('k')
    expect(checked!.attrs).toEqual({})
    expect(toText(checked!.children)).toBe('☑ done')
    const [boxOnly] = lower(h('li', { checked: false }, h('pre', 'x')), { parent: 'ul', variant: 'checked' })
    expect(xml(boxOnly!.children)).toBe('<p>☐</p><pre>x</pre>')
    const [nested] = lower(h('li', 'a', h('ul', h('li', 'b'))), { parent: 'ul', variant: 'nested' })
    expect(xml(nested!.children)).toBe('<p>a</p><p>  ◦ b</p>')
    expect(xml(lower(h('li', 'a'), { parent: 'ul' }))).toBe('<li><p>a</p></li>')
  })

  it('blockquotes prefix every line, nested quotes stack the prefix', () => {
    const quote = h('blockquote', h('p', 'a', h('br'), 'b'), h('blockquote', 'c'), h('ul', h('li', 'd')), h('pre', 'e'))
    expect(text(lower(quote))).toBe('> a\n> b\n> > c\n> • d\ne')
  })

  it('pre drops its language, then becomes paragraph lines', () => {
    const [stripped] = lower(h('pre', { lang: 'ts', key: 'k' }, 'x'), { variant: 'lang' })
    expect(stripped!.type).toBe('pre')
    expect(stripped!.attrs).toEqual({})
    expect(stripped!.key).toBe('k')
    expect(xml(lower(h('pre', 'a\n  b\n')))).toBe('<p>a<br/>  b</p>')
    expect(lower(h('pre'))).toEqual([])
  })

  it('hr, small, details, summary and title', () => {
    expect(text(lower(h('hr')))).toBe('────────')
    expect(text(lower(h('small', 'fine')))).toBe('— fine')
    expect(xml(lower(h('details', h('summary', 'S'), 'body')))).toBe('<p><b>▸ S</b></p><p>body</p>')
    expect(xml(lower(h('details', 'body')))).toBe('<p>body</p>')
    expect(xml(lower(h('details', h('summary'), 'body')))).toBe('<p>body</p>')
    expect(xml(lower(h('summary', 'S'), { parent: 'details' }))).toBe('<p><b>S</b></p>')
    expect(xml(lower(h('title', { subtitle: 'sub' }, 'T')))).toBe('<p><b>T</b></p><small>sub</small>')
    expect(xml(lower(h('title', { subtitle: 'sub' })))).toBe('<small>sub</small>')
    expect(lower(h('quote', { id: 'q' }))).toEqual([])
  })

  it('narrow tables become a monospace grid with alignment and CJK widths', () => {
    const table = h('table',
      h('tr', h('th', '名称'), h('th', { align: 'right' }, 'n'), h('th', { align: 'center' }, 'c')),
      h('tr', h('td', 'a'), h('td', '10'), h('td', 'x')))
    const [pre] = lower(table)
    expect(pre!.type).toBe('pre')
    expect(toText(pre!)).toBe(['名称 |  n | c', '-----+----+--', 'a    | 10 | x'].join('\n'))
    const headless = h('table', h('tr', h('td', 'a'), h('td', 'b')))
    expect(toText(lower(headless))).toBe('a | b')
  })

  it('wide tables become "header: value" rows', () => {
    const cells = (tag: 'th' | 'td', prefix: string) => ['1', '2', '3', '4', '5'].map(n => h(tag, `${prefix}${n}`))
    const table = h('table', h('tr', ...cells('th', 'H')), h('tr', ...cells('td', 'v')))
    expect(text(lower(table))).toBe('H1: v1\nH2: v2\nH3: v3\nH4: v4\nH5: v5')
    const long = h('table', h('tr', h('td', 'a'.repeat(30)), h('td', h('b', 'b'.repeat(20)))))
    expect(xml(lower(long))).toBe(`<p>${'a'.repeat(30)} | <b>${'b'.repeat(20)}</b></p>`)
    const blocks = h('table', h('tr', h('th', 'H')), h('tr', h('td', h('p', 'x'), h('ul', h('li', 'y')))))
    expect(text(lower(blocks))).toBe('H: x\n• y')
    const headerOnly = h('table', ...[h('tr', ...cells('th', 'H'))])
    expect(text(lower(headerOnly))).toBe('H1 | H2 | H3 | H4 | H5')
    expect(lower(h('table'))).toEqual([])
  })

  it('table variants keep the table', () => {
    const table = h('table', h('tr', h('td', { align: 'center', key: 'c' }, 'x')))
    const [stripped] = lower(table, { variant: 'align' })
    expect(stripped!.type).toBe('table')
    const cell = stripped!.children[0]!.children[0]!
    expect(cell.attrs).toEqual({})
    expect(cell.key).toBe('c')
    const [td] = lower(h('td', h('p', 'a'), h('pre', 'b\nc')), { parent: 'tr', variant: 'block' })
    expect(xml([td!])).toBe('<td><p>a<br/>b<br/>c</p></td>')
    // whole-element fallbacks of structural children are never applied by the engine (the container falls back);
    // they still return their content
    const ctx = { renders: rendersWith(), ancestors: [], report: createRenderReport() }
    expect(xml(normalizeChildren(defaultFallback('td')!(normalizeChildren(h('td', 'a'), 'tr')[0] as never, ctx) as never, 'message'))).toBe('<p>a</p>')
    expect(xml(normalizeChildren(defaultFallback('tr')!(normalizeChildren(h('tr', h('td', 'a'), h('td', 'b')), 'table')[0] as never, ctx) as never, 'message'))).toBe('<p>a | b</p>')
  })

  it('media become labelled text; audio/video prefer <file> when supported', () => {
    expect(text(lower(h('img', { src: 'https://x.test/a.png', alt: 'cat' })))).toBe('[图片: cat] (https://x.test/a.png)')
    expect(text(lower(h('img', { src: 'satori:lark/1/resource/k' })))).toBe('[图片]')
    expect(text(lower(h('img', { src: 'https://x.test/i.png' }), { parent: 'p', variant: 'inline' }))).toBe('[图片] (https://x.test/i.png)')
    expect(xml(lower(h('audio', { src: 'https://x.test/a.mp3', name: 'a.mp3' }), { renders: ['element.file'] })))
      .toBe('<file src="https://x.test/a.mp3" name="a.mp3"/>')
    expect(text(lower(h('audio', { src: 'data:audio/ogg;base64,AA' })))).toBe('[语音]')
    expect(text(lower(h('video', { src: 'https://x.test/v.mp4', name: 'v' })))).toBe('[视频: v] (https://x.test/v.mp4)')
    expect(lower(h('video', { src: 'https://x.test/v.mp4' }), { renders: ['element.file'] })[0]!.type).toBe('file')
    expect(text(lower(h('file', { src: 'base64:AA', name: 'f.txt' })))).toBe('[文件: f.txt]')
  })

  it('buttons become links, input text or bracketed labels (reported as dropped)', () => {
    const report = createRenderReport()
    expect(xml(lower(h('button', { type: 'link', href: 'https://x.test' }, 'Go'), { report }))).toBe('<p><a href="https://x.test">Go</a></p>')
    expect(xml(lower(h('button', { type: 'link', href: 'https://x.test' }), { parent: 'p', report }))).toBe('<a href="https://x.test">https://x.test</a>')
    expect(xml(lower(h('button', { type: 'input', text: '/stop' }, 'Stop'), { parent: 'p', report }))).toBe('Stop <code>/stop</code>')
    expect(xml(lower(h('button', { type: 'input', text: '/stop' }, '/stop'), { parent: 'p', report }))).toBe('<code>/stop</code>')
    expect(report.dropped).toEqual([])
    expect(text(lower(h('button', { type: 'action', id: 'ok' }, 'OK'), { parent: 'p', report }))).toBe('[OK]')
    expect(text(lower(h('button', { type: 'action', id: 'ok' }), { parent: 'p', report, variant: 'action' }))).toBe('[ok]')
    expect(report.dropped).toEqual([
      { what: 'button:ok', reason: INTERACTION_DROPPED }, { what: 'button:ok', reason: INTERACTION_DROPPED },
    ])
    const onClick = () => {}
    const [themed] = lower(h('button', { type: 'action', id: 'x', theme: 'danger', onClick }, 'X'), { variant: 'theme' })
    expect(themed!.type).toBe('button')
    expect(themed!.attrs).toEqual({ type: 'action', id: 'x', onClick })
    // Lowering the theme keeps the presentation attributes a mode without themes may still read.
    const styled = { size: 'small', width: 'fill', icon: 'done_outlined', confirm: { title: 'T', text: 'X' }, variant: 'laser' } as const
    const [kept] = lower(h('button', { type: 'action', id: 'x', theme: 'info', onClick, ...styled }, 'X'), { variant: 'theme' })
    expect(kept!.attrs).toEqual({ type: 'action', id: 'x', onClick, ...styled })
  })

  it('button groups splice their buttons, inline when buttons are not native', () => {
    const group = h('button-group', h('button', { type: 'link', href: 'https://a.test' }, 'A'), h('button', { type: 'input', text: '/b' }, 'B'))
    expect(lower(group, { renders: ['element.button'] }).map(node => node.type)).toEqual(['button', 'button'])
    const [p] = lower(group)
    expect(p!.type).toBe('p')
    expect(p!.children.map(node => node.type)).toEqual(['button', 'text', 'button'])
  })

  it('form controls become labelled text and report the lost interaction', () => {
    const report = createRenderReport()
    expect(xml(lower(h('input', { name: 'title', label: 'Title' }), { report }))).toBe('<p>[Title]</p>')
    expect(xml(lower(h('input', { name: 'notes', placeholder: 'Notes' }), { report }))).toBe('<p>[Notes]</p>')
    expect(xml(lower(h('input', { name: 'agree', type: 'checkbox', label: 'I agree', value: true }), { report })))
      .toBe('<p>☑ I agree</p>')
    expect(xml(lower(h('select', { id: 'sel', placeholder: 'Size' }, h('option', { value: 's' }, 'Small')), { report })))
      .toBe('<p>[Size: Small]</p>')
    expect(report.dropped.map(entry => entry.what)).toEqual(['input:title', 'input:notes', 'input:agree', 'select:sel'])
    expect(report.dropped.every(entry => entry.reason === INTERACTION_DROPPED)).toBe(true)
    expect(report.summary()).toContain('按钮不可点击')
  })

  it('a form keeps its children; a lost submit keeps its click', () => {
    expect(xml(lower(h('form', { name: 'order' }, h('p', 'body')), {}))).toBe('<p>body</p>')
    const [submit] = lower(h('button', { type: 'submit', id: 'go' }, 'Send'), { variant: 'submit' })
    expect(submit).toMatchObject({ type: 'button', attrs: { type: 'action', id: 'go' } })
    expect(preservingVariants.has('button.submit')).toBe(true)
  })

  it('markdown (its literal source without the markdown service), forward and raw', () => {
    const md = defaultFallback('markdown')!(h.markdown('**x**'), { renders: rendersWith(), ancestors: [], report: createRenderReport() })
    expect(xml(normalizeChildren(md as never, 'message'))).toBe('<p>**x**</p>')
    expect(text(lower(h('forward', { id: 'f' })))).toBe('[合并转发]')
    expect(text(lower(h('raw', { platform: 'p', type: 't' }, 'fallback text')))).toBe('fallback text')
  })

  it('never loses text across the table', () => {
    const content = normalize(h('message',
      h('table', h('tr', h('th', 'alpha'), h('th', 'beta')), h('tr', h('td', 'gamma'), h('td', 'delta'))),
      h('ul', h('li', 'epsilon', h('ol', h('li', 'zeta')))),
      h('blockquote', 'eta'),
      h('details', h('summary', 'theta'), 'iota')))
    const out = toText(content.children.flatMap(child => lower(child)))
    for (const word of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota']) expect(out).toContain(word)
  })
})

describe('render report', () => {
  it('starts empty with an empty summary', () => {
    const report = createRenderReport()
    expect(report).toMatchObject({ degraded: [], moved: [], split: 0, folded: 0, dropped: [], fallbacks: [] })
    expect(report.summary()).toBe('')
    expect(report.summary('en')).toBe('')
  })

  it('summarizes in zh and en, ignoring degradations inside fallback output', () => {
    const report = createRenderReport()
    report.degraded.push(
      { tag: 'table', via: 'pre', path: 'message/table[0]' },
      { tag: 'pre', via: 'p', path: 'message/table[0]>/pre[0]' },
      { tag: 'table', via: 'pre', path: 'message/table[3]' },
      { tag: 'at', variant: 'all', via: 'text', path: 'message/p[1]/at[0]' },
    )
    report.dropped.push({ what: 'button:a', reason: INTERACTION_DROPPED }, { what: 'quote', reason: 'unsupported' })
    report.moved.push({ tag: 'img', reason: 'own paragraph', path: 'message/p[1]/img[2]' }, { tag: 'button', reason: 'keyboard', path: 'x' })
    report.split = 2
    report.folded = 1
    expect(report.summary()).toBe('表格、提及（所有人）已降级；按钮不可点击；已省略quote；2 处元素已移位；已拆分为 3 条消息；已折叠 1 个面板')
    expect(report.summary('en')).toBe('degraded: table, mention (all); buttons are not clickable; dropped: quote; 2 elements moved; split into 3 messages; 1 panel folded')
  })

  it('merges reports into a new one', () => {
    const a = createRenderReport()
    a.degraded.push({ tag: 'b', via: 'text', path: 'p' })
    a.split = 1
    const b = createRenderReport()
    b.dropped.push({ what: 'x', reason: 'y' })
    b.moved.push({ tag: 'img', reason: 'r', path: 'q' })
    b.folded = 2
    b.split = 1
    const merged = mergeRenderReports(a, b)
    expect(merged).not.toBe(a)
    expect(merged).toMatchObject({ degraded: a.degraded, dropped: b.dropped, moved: b.moved, split: 2, folded: 2 })
    expect(merged.summary('en')).toBe('degraded: bold; dropped: x; 1 element moved; split into 3 messages; 2 panels folded')
    expect(a.split).toBe(1)
  })
})
