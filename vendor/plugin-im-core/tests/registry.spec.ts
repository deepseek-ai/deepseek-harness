import { describe, expect, it } from 'vitest'
import { type Element, h, normalize, type Tag, tags, variantTable } from '@deepseek-ai/satori-element'
import {
  type Bot, ElementRegistry, MAX_FALLBACK_STEPS, type Mode,
  type RenderContext, type RenderReport, transform,
} from '@deepseek-ai/cordis-plugin-im-core'

// ---- fixtures -----------------------------------------------------------------------------------------------------

interface S { node: string; draft: string; payload: string }

const bot = {} as Bot
const target = { chat: { id: 'c', type: 'group' as const } }

function modeOf(elements: ElementRegistry<S, any>, extra: Partial<Mode<S>> = {}): Mode<S> {
  return {
    id: 'fake',
    elements,
    limits: {},
    assemble: nodes => [nodes.join('\n')],
    serialize: msg => msg.draft,
    ...extra,
  }
}

function run(mode: Mode<S>, content: Parameters<typeof normalize>[0]) {
  return transform(normalize(content), { bot, target, mode })
}

/** The minimal fake mode of the acceptance criteria: text / p / br only. */
function minimal() {
  return new ElementRegistry<S>()
    .register('text', el => el.attrs.content)
    .register('p', (el, ctx) => ctx.render(el.children).join(''))
    .register('br', () => '\n')
}

function tagged(el: Element, ctx: RenderContext<S>): string {
  if (el.type === 'text') return el.attrs.content
  if (el.type === 'br') return '\n'
  return `<${el.type}>${ctx.render(el.children).join('')}</${el.type}>`
}

/** Every tag registered with a tagging handler declaring all variants except `missing` (`tag.variant`). */
function everything(missing?: string) {
  const registry = new ElementRegistry<S>() as ElementRegistry<S, any>
  for (const tag of tags) {
    const variants = ((variantTable as Record<string, readonly string[]>)[tag] ?? []).filter(v => `${tag}.${v}` !== missing)
    registry.register(tag as never, tagged as never, { variants } as never)
  }
  return registry
}

function textsOf(el: Element, out: string[] = []): string[] {
  if (el.type === 'text') out.push(el.attrs.content)
  for (const child of el.children) textsOf(child, out)
  return out
}

/** Longest fallback chain in a report (a variant strip keeps the path, outputs append `>`). */
function maxSteps(report: RenderReport): number {
  const steps: number[] = []
  report.degraded.forEach((entry, j) => {
    let best = 0
    for (let i = 0; i < j; i++) {
      const prev = report.degraded[i]!.path
      if (entry.path === prev || entry.path.startsWith(`${prev}>`)) best = Math.max(best, steps[i]!)
    }
    steps.push(best + 1)
  })
  return Math.max(0, ...steps)
}

const onClick = () => {}

function corpus() {
  return h('message',
    h('quote', { id: 'q1' }),
    h('title', { subtitle: 'sub-title' }, 'Title text'),
    h('p', 'plain ', h('b', 'bold'), h('i', 'italic'), h('u', 'under'), h('s', 'strike'), h('spoiler', 'secret'),
      h('code', 'inline-code'), h('a', { href: 'https://x.test/a' }, 'link-text'),
      h('at', { type: 'user', id: 'u1', name: 'Alice' }), h('at', { type: 'all' }), h('at', { type: 'here' }),
      h('at', { type: 'role', id: 'r1', name: 'Admins' }), h('channel', { id: 'c1', name: 'general' }),
      h('emoji', { id: 'e1', name: 'smile' }), h('span', { color: 'danger' }, 'red-text'), h('br'), 'after-br',
      h('img', { src: 'https://x.test/inline.png', alt: 'inline-alt' })),
    h('h1', 'Heading one'), h('h2', 'Heading two'), h('h3', 'Heading three'),
    h('h4', 'Heading four'), h('h5', 'Heading five'), h('h6', 'Heading six'),
    h('ul', h('li', 'item-a'), h('li', { checked: true }, 'task-done'), h('li', h('p', 'parent'), h('ul', h('li', 'child')))),
    h('ol', { start: 3 }, h('li', 'third'), h('li', 'fourth')),
    h('blockquote', h('p', 'quoted', h('br'), 'second-line'), h('blockquote', 'deeper')),
    h('pre', { lang: 'ts' }, 'const x = 1\nconst y = 2'),
    h('hr'),
    h('table', h('tr', h('th', 'Name'), h('th', { align: 'right' }, 'Qty')), h('tr', h('td', 'apple'), h('td', '3'))),
    h('table',
      h('tr', h('th', 'Column-A'), h('th', 'Column-B'), h('th', 'Column-C'), h('th', 'Column-D'), h('th', 'Column-E')),
      h('tr', h('td', 'value-a'), h('td', 'value-b'), h('td', h('p', 'value-c'), h('p', 'more-c')), h('td', 'value-d'), h('td', 'value-e'))),
    h('details', h('summary', 'More info'), h('p', 'hidden-body')),
    h('small', 'fine-print'),
    h('img', { src: 'https://x.test/a.png', alt: 'block-alt' }),
    h('audio', { src: 'https://x.test/a.opus', name: 'voice.opus' }),
    h('video', { src: 'satori:x/video', name: 'clip.mp4' }),
    h('file', { src: 'https://x.test/f.pdf', name: 'report.pdf' }),
    h('button-group',
      h('button', { type: 'action', id: 'b1', onClick }, 'Press-me'),
      h('button', { type: 'link', href: 'https://x.test/l' }, 'Open-link'),
      h('button', { type: 'input', text: '/stop' }, 'Stop-input')),
    h('button', { type: 'action', id: 'b2', theme: 'danger' }, 'Lone-button'),
    h('forward', { id: 'f1' }),
    h('raw', { platform: 'x', type: 'y' }, 'raw-text'),
    h.markdown('**md-bold** text'),
  )
}

// ---- tests --------------------------------------------------------------------------------------------------------

describe('transform with the minimal text/p/br mode', () => {
  it('renders every vocabulary element and conserves all text', () => {
    const mode = modeOf(minimal())
    const input = normalize(corpus())
    const result = transform(input, { bot, target, mode })
    expect(result.msgs).toHaveLength(1)
    const out = result.msgs[0]!
    for (const text of textsOf(input)) expect(out).toContain(text)
    for (const extra of ['@Alice', '@所有人', '@Admins', '#general', ':smile:', '[图片: block-alt] (https://x.test/a.png)',
      'voice.opus', 'clip.mp4', 'report.pdf', '/stop', '[合并转发]', '(https://x.test/a)']) {
      expect(out).toContain(extra)
    }
    expect(out).not.toContain('satori:x/video')
    expect(result.quote).toBe('q1')
    // the action button had no native handler: no callback, an interaction-dropped entry instead
    expect(result.actions).toEqual([])
    expect(result.report.dropped.map(d => d.what)).toEqual(['button:b1', 'button:b2'])
  })

  it('reports every non-native input element at its path (or under a lowered ancestor)', () => {
    const mode = modeOf(minimal())
    const input = normalize(corpus())
    const { report } = transform(input, { bot, target, mode })
    const paths = new Set(report.degraded.map(entry => entry.path))
    const walk = (el: Element, path: string, covered: boolean) => {
      const reported = paths.has(path)
      if (!['message', 'text', 'p', 'br', 'quote'].includes(el.type)) {
        expect(reported || covered, `${el.type} at ${path}`).toBe(true)
      }
      el.children.forEach((child, i) => walk(child, `${path}/${child.type}[${i}]`, covered || reported))
    }
    walk(input, 'message', false)
    expect(report.degraded.find(entry => entry.tag === 'b' && !entry.path.includes('>'))).toMatchObject({ path: 'message/p[2]/b[1]', via: 'text' })
    expect(report.degraded.find(entry => entry.tag === 'title')).toMatchObject({ path: 'message/title[1]', via: 'p+small' })
    // fallback output is addressed below its origin
    expect(report.degraded.some(entry => entry.tag === 'small' && entry.path === 'message/title[1]>/small[1]')).toBe(true)
    expect(report.summary()).toContain('已降级')
    expect(report.summary()).toContain('按钮不可点击')
  })

  it('every core fallback chain terminates in ≤ 4 steps', () => {
    const mode = modeOf(minimal())
    const inline: Tag[] = ['b', 'i', 'u', 's', 'spoiler', 'code', 'a', 'at', 'channel', 'emoji', 'span']
    const sample = (tag: Tag): Element => {
      switch (tag) {
        case 'a': return h('p', h('a', { href: 'https://x.test' }, 'x'))
        case 'at': return h('p', h('at', { type: 'user', id: 'u' }))
        case 'channel': return h('p', h('channel', { id: 'c' }))
        case 'emoji': return h('p', h('emoji', { id: 'e' }))
        case 'li': return h('ul', h('li', { checked: false }, 'x', h('ul', h('li', 'y'))))
        case 'tr': case 'th': case 'td': return h('table', h('tr', h('th', 'h')), h('tr', h('td', h('p', 'a'), h('pre', 'b'))))
        case 'summary': return h('details', h('summary', 'x'), 'y')
        case 'img': case 'audio': case 'video': case 'file': return h(tag, { src: 'https://x.test/m' })
        case 'button': return h('button', { type: 'input', text: '/x', theme: 'danger' }, 'x')
        case 'button-group': return h('button-group', h('button', { type: 'action', id: 'a' }, 'x'))
        case 'form': return h('form', { name: 'f' }, h('input', { name: 'a' }), h('button', { type: 'submit', id: 's' }, 'x'))
        case 'input': return h('form', { name: 'f' }, h('input', { name: 'a', label: 'x' }))
        case 'select': return h('select', { id: 's' }, h('option', { value: 'v' }, 'x'))
        case 'option': return h('select', { id: 's' }, h('option', { value: 'v' }, 'x'))
        case 'title': return h('title', { subtitle: 's' }, 'x')
        case 'forward': return h('forward', { id: 'f' })
        case 'hr': return h('hr')
        case 'raw': return h('raw', { platform: 'p', type: 't' }, 'x')
        case 'ol': return h('ol', h('li', 'x'))
        case 'ul': return h('ul', h('li', 'x', h('ol', h('li', 'y'))))
        case 'blockquote': return h('blockquote', h('blockquote', h('ul', h('li', 'x'))))
        case 'table': return h('table', h('tr', h('th', 'h'), h('th', 'i')), h('tr', h('td', 'a'), h('td', 'b')))
        case 'pre': return h('pre', { lang: 'ts' }, 'x')
        case 'details': return h('details', h('summary', h('b', 'x')), h('h1', 'y'))
        default: return inline.includes(tag) ? h('p', h(tag as 'b', 'x')) : h(tag as 'p', 'x')
      }
    }
    const checked: Tag[] = []
    for (const tag of tags) {
      if (['message', 'text', 'p', 'br', 'quote', 'markdown', 'fallback', 'case'].includes(tag)) continue
      const { report } = run(mode, sample(tag))
      // structural children (li, tr, th, td, summary, option) are consumed by their container's fallback
      const owner = ({
        li: 'ul', tr: 'table', th: 'table', td: 'table', summary: 'details', option: 'select',
      } as Record<string, string>)[tag] ?? tag
      expect(report.degraded.some(entry => entry.tag === owner), tag).toBe(true)
      expect(maxSteps(report), tag).toBeLessThanOrEqual(4)
      checked.push(tag)
    }
    expect(checked.length).toBeGreaterThan(35)
  })
})

describe('variants', () => {
  it('lowers every declared variant of a registered tag in ≤ 4 steps and reports it', () => {
    const samples: Record<string, Element> = {
      'at.user': h('p', h('at', { type: 'user', id: 'u', name: 'U' })),
      'at.all': h('p', h('at', { type: 'all' })),
      'at.here': h('p', h('at', { type: 'here' })),
      'at.role': h('p', h('at', { type: 'role', id: 'r' })),
      'li.checked': h('ul', h('li', { checked: true }, 'x')),
      'li.nested': h('ul', h('li', 'x', h('ul', h('li', 'y')))),
      'pre.lang': h('pre', { lang: 'ts' }, 'x'),
      'span.color': h('p', h('span', { color: 'info' }, 'x')),
      'table.align': h('table', h('tr', h('td', { align: 'center' }, 'x'))),
      'td.block': h('table', h('tr', h('td', h('p', 'x'), h('p', 'y')))),
      'img.inline': h('p', 'a', h('img', { src: 'https://x.test/i.png' })),
      'button.action': h('button', { type: 'action', id: 'a' }, 'x'),
      'button.link': h('button', { type: 'link', href: 'https://x.test' }, 'x'),
      'button.input': h('button', { type: 'input', text: '/x' }, 'x'),
      'button.submit': h('form', { name: 'f' }, h('button', { type: 'submit', id: 's' }, 'x')),
      'button.theme': h('button', { type: 'link', href: 'https://x.test', theme: 'danger' }, 'x'),
      'button.inline': h('p', 'a', h('button', { type: 'link', href: 'https://x.test' }, 'x')),
      'input.checkbox': h('form', { name: 'f' }, h('input', { name: 'a', type: 'checkbox', label: 'x' })),
      'select.multiple': h('select', { id: 's', multiple: true }, h('option', { value: 'v' }, 'x')),
    }
    for (const [tag, variants] of Object.entries(variantTable)) {
      for (const variant of variants) {
        const key = `${tag}.${variant}`
        const sample = samples[key]
        expect(sample, key).toBeDefined()
        const { report, msgs } = run(modeOf(everything(key)), sample!)
        expect(report.degraded.some(entry => entry.tag === tag && entry.variant === variant), key).toBe(true)
        expect(maxSteps(report), key).toBeLessThanOrEqual(4)
        expect(msgs[0], key).not.toBe('')
      }
    }
  })

  it('pre[lang] strips the language and keeps the native <pre>', () => {
    const seen: (string | undefined)[] = []
    const elements = minimal().register('pre', (el, ctx) => {
      seen.push(el.attrs.lang)
      return `PRE(${ctx.text(el.children)})`
    })
    const { msgs, report } = run(modeOf(elements), h('pre', { lang: 'ts' }, 'let a'))
    expect(msgs).toEqual(['PRE(let a)'])
    expect(seen).toEqual([undefined])
    expect(report.degraded).toEqual([{ tag: 'pre', variant: 'lang', via: 'strip', path: 'message/pre[0]' }])
    expect(report.summary()).toBe('代码块（语言）已降级')
    expect(report.summary('en')).toBe('degraded: code block (lang)')
  })

  it('pre[lang] renders natively when the variant is declared', () => {
    const elements = minimal().register('pre', el => `PRE[${el.attrs.lang}]`, { variants: ['lang'] })
    const { msgs, report } = run(modeOf(elements), h('pre', { lang: 'ts' }, 'x'))
    expect(msgs).toEqual(['PRE[ts]'])
    expect(report.degraded).toEqual([])
  })

  it('an undeclared variant lowers the element, a declared one renders natively', () => {
    const content = h('p', h('at', { type: 'user', id: 'u1' }), ' ', h('at', { type: 'all' }))
    const partial = modeOf(minimal().register('at', el => `<@${el.attrs.id ?? el.attrs.type}>`, { variants: ['user'] }))
    expect(run(partial, content).msgs).toEqual(['<@u1> @所有人'])
    expect(run(partial, content).report.degraded)
      .toEqual([{ tag: 'at', variant: 'all', via: 'text', path: 'message/p[0]/at[2]' }])
    const full = modeOf(minimal().register('at', el => `<@${el.attrs.id ?? el.attrs.type}>`, { variants: ['user', 'all'] }))
    expect(run(full, content).msgs).toEqual(['<@u1> <@all>'])
  })

  it('img in phrasing position needs img.inline (ancestors are passed to variantsOf)', () => {
    const ancestors: string[][] = []
    const elements = minimal().register('img', (el, ctx) => {
      ancestors.push(ctx.ancestors.map(a => a.type))
      return `IMG(${el.attrs.src})`
    })
    const { msgs } = run(modeOf(elements), h('message', h('img', { src: 'https://x.test/b.png' }), h('p', 'a ', h('img', { src: 'https://x.test/i.png' }))))
    expect(msgs).toEqual(['IMG(https://x.test/b.png)\na [图片] (https://x.test/i.png)'])
    expect(ancestors).toEqual([['message']])
  })

  it('h3 falls back to the next lower supported heading', () => {
    const elements = minimal().register('h5', (el, ctx) => `H5(${ctx.render(el.children).join('')})`)
    const { msgs, report } = run(modeOf(elements), h('message', h('h3', 'x'), h('h6', 'y')))
    expect(msgs).toEqual(['H5(x)\ny'])
    expect(report.degraded.map(e => [e.tag, e.via])).toEqual([['h3', 'h5'], ['h6', 'p'], ['b', 'text']])
  })
})

describe('structural containers', () => {
  it('a list whose <li> has no handler falls back as a whole', () => {
    const elements = minimal().register('ul', () => 'UL')
    const { msgs, report } = run(modeOf(elements), h('ul', h('li', 'a'), h('li', 'b')))
    expect(msgs).toEqual(['• a\n• b'])
    expect(report.degraded).toEqual([{ tag: 'ul', via: 'p', path: 'message/ul[0]' }])
  })

  it('li[checked] keeps the native list and prefixes a box', () => {
    const elements = minimal()
      .register('ul', (el, ctx) => `UL{${ctx.render(el.children).join('|')}}`)
      .register('li', (el, ctx) => `LI(${ctx.render(el.children).join('')})`)
    const { msgs, report } = run(modeOf(elements), h('ul', h('li', { checked: true }, 'done'), h('li', { checked: false }, 'todo')))
    expect(msgs).toEqual(['UL{LI(☑ done)|LI(☐ todo)}'])
    expect(report.degraded.map(e => [e.tag, e.variant, e.path])).toEqual([
      ['li', 'checked', 'message/ul[0]/li[0]'], ['li', 'checked', 'message/ul[0]/li[1]'],
    ])
  })

  it('a button group with a non-native button falls back to standalone buttons', () => {
    const elements = minimal()
      .register('button-group', () => 'GROUP')
      .register('button', (el, ctx) => `BTN(${ctx.text(el.children)})`, { variants: ['link'] })
    const { msgs, report } = run(modeOf(elements), h('button-group',
      h('button', { type: 'link', href: 'https://x.test' }, 'go'), h('button', { type: 'action', id: 'a' }, 'act')))
    expect(msgs).toEqual(['BTN(go)\n[act]'])
    expect(report.degraded.map(e => [e.tag, e.variant ?? null])).toEqual([['button-group', null], ['button', 'action']])
    expect(report.dropped).toEqual([{ what: 'button:a', reason: 'interaction-dropped' }])
  })
})

describe('overrides, purity and guards', () => {
  it('mode overrides win over the core table', () => {
    const elements = minimal().fallback('hr', () => '* * *').fallback('pre', (_el, { variant }) => `custom:${variant ?? '-'}`)
    const { msgs, report } = run(modeOf(elements), h('message', h('hr'), h('pre', { lang: 'ts' }, 'x')))
    expect(msgs).toEqual(['* * *\ncustom:-'])
    expect(report.degraded.map(e => e.via)).toEqual(['mode:p', 'mode:p'])
  })

  it('handlers, fallbacks and assemble returning promises throw', () => {
    const asyncHandler = minimal().register('b', (async () => 'B') as never)
    expect(() => run(modeOf(asyncHandler), h('p', h('b', 'x')))).toThrow(/returned a promise/)
    const asyncFallback = minimal().fallback('b', (async () => 'B') as never)
    expect(() => run(modeOf(asyncFallback), h('p', h('b', 'x')))).toThrow(/returned a promise/)
    const asyncAssemble = modeOf(minimal(), { assemble: (async () => ['x']) as never })
    expect(() => run(asyncAssemble, 'x')).toThrow(/returned a promise/)
  })

  it('detects fallback loops', () => {
    const elements = minimal().fallback('b', el => el)
    expect(() => run(modeOf(elements), h('p', h('b', 'x')))).toThrow(new RegExp(`exceeds ${MAX_FALLBACK_STEPS} steps`))
  })

  it('rejects a fallback output that does not fit its parent', () => {
    const elements = minimal().fallback('b', () => h('hr'))
    expect(() => run(modeOf(elements), h('p', h('b', 'x')))).toThrow(/not allowed in <p>/)
  })

  it('a mode without a base tag handler fails loudly', () => {
    const elements = new ElementRegistry<S>().register('text', el => el.attrs.content)
    expect(() => run(modeOf(elements), 'x')).toThrow(/base tag <p>/)
  })

  it('transform rejects a non-normalized root', () => {
    const mode = modeOf(minimal())
    expect(() => transform(h('p', 'x') as never, { bot, target, mode })).toThrow(/normalized <message>/)
  })
})

describe('envelope and actions', () => {
  it('hoists quote and passes the title to assemble when the registry declares the envelope tag', () => {
    let title: string | undefined
    const mode = modeOf(minimal().envelope('title'), {
      assemble: (nodes, envelope, ctx) => {
        title = envelope.title && ctx.render(envelope.title.children).join('')
        return [nodes.join('\n')]
      },
    })
    const result = run(mode, h('message', h('quote', { id: 'm1' }), h('title', 'Head'), 'body'))
    expect(result).toMatchObject({ msgs: ['body'], quote: 'm1', actions: [] })
    expect(title).toBe('Head')
    expect(result.report.degraded).toEqual([])
  })

  it('loweres a title the mode does not take into its envelope', () => {
    const result = run(modeOf(minimal()), h('message', h('title', 'Head'), 'body'))
    expect(result.msgs).toEqual(['Head\nbody'])
    expect(result.report.degraded.map(entry => entry.tag)).toEqual(['title', 'b'])
  })

  it('hoists the quote of the root even when no mode declares anything about it', () => {
    const result = run(modeOf(minimal()), h('message', h('quote', { id: 'm1' }), 'body'))
    expect(result.quote).toBe('m1')
    expect(result.msgs).toEqual(['body'])
  })

  it('collects the interaction callbacks of natively rendered controls only', () => {
    const a = () => {}
    const b = () => {}
    const c = () => {}
    const elements = minimal()
      .register('button', (el, ctx) => `[${ctx.text(el.children)}]`, { variants: ['action', 'submit', 'link'] })
      .register('select', (el, ctx) => `{${ctx.text(el.children)}}`, { variants: ['multiple'] })
      .register('option', (el, ctx) => ctx.text(el.children))
    const { actions } = run(modeOf(elements), h('message',
      h('button', { type: 'action', id: 'x', onClick: a }, 'X'),
      h('button', { type: 'action', id: 'x', onClick: b }, 'X again'),
      h('button', { type: 'action', id: 'y' }, 'no callback'),
      h('button', { type: 'link', href: 'https://e.x' }, 'link'),
      h('button', { type: 'submit', id: 's', onClick: c }, 'submit'),
      h('select', { id: 'sel', onSelect: c }, h('option', { value: 'v' }, 'V')),
      h('p', 'in text ', h('button', { type: 'action', id: 'z', onClick: b }, 'inline'))))
    expect(actions).toEqual([
      { kind: 'button', id: 'x', callback: a },
      { kind: 'button', id: 's', callback: c },
      { kind: 'select', id: 'sel', callback: c },
    ])
  })
})

describe('fallback alternatives', () => {
  it('renders the first candidate whose whole subtree is native', () => {
    const elements = minimal().register('b', (el, ctx) => `B(${ctx.text(el.children)})`)
    const content = h('message', h('fallback', h('h3', 'x'), h('p', h('b', 'x')), h.text('x')))
    const { msgs, report } = run(modeOf(elements), content)
    expect(msgs).toEqual(['B(x)'])
    expect(report.fallbacks).toEqual([{ path: 'message/fallback[0]', candidate: 1 }])
    expect(report.degraded).toEqual([])
  })

  it('takes several nodes of one candidate as a unit', () => {
    const elements = minimal().register('b', (el, ctx) => `B(${ctx.text(el.children)})`)
    const content = h('message', h('fallback',
      [h('p', h('b', 'one')), h('p', h('b', 'two'))],
      h('p', 'plain')))
    const { msgs, report } = run(modeOf(elements), content)
    expect(msgs).toEqual(['B(one)\nB(two)'])
    expect(report.fallbacks).toEqual([])
  })

  it('lowers the last candidate when none is native', () => {
    const { msgs, report } = run(modeOf(minimal()), h('message', h('fallback', h('h3', 'a'), h('blockquote', 'b'))))
    expect(msgs).toEqual(['> b'])
    expect(report.fallbacks).toEqual([{ path: 'message/fallback[0]', candidate: 1 }])
    expect(report.degraded.map(entry => entry.tag)).toEqual(['blockquote'])
  })

  it('counts a nested fallback as native when one of its own candidates is', () => {
    const content = h('message', h('fallback', h('fallback', h('h3', 'a'), h('p', 'inner')), h('p', 'outer')))
    const { msgs, report } = run(modeOf(minimal()), content)
    expect(msgs).toEqual(['inner'])
    expect(report.fallbacks.map(entry => entry.candidate)).toEqual([1])
  })

  it('renders a fallback of phrasing content inside its paragraph', () => {
    const elements = minimal().register('b', (el, ctx) => `B(${ctx.text(el.children)})`)
    const content = h('message', h('p', 'a ', h('fallback', h('code', 'x'), h('b', 'x')), ' b'))
    const { msgs, report } = run(modeOf(elements), content)
    expect(msgs).toEqual(['a B(x) b'])
    expect(report.fallbacks).toEqual([{ path: 'message/p[0]/fallback[1]', candidate: 1 }])
  })
})
describe('render context', () => {
  it('stableId uses keys and structural paths, stable across variant strips', () => {
    const ids: string[] = []
    const elements = minimal()
      .register('pre', (el, ctx) => {
        ids.push(ctx.stableId(el))
        return 'PRE'
      })
      .register('blockquote', (el, ctx) => {
        ids.push(ctx.stableId(el), ...el.children.map(child => ctx.stableId(child)))
        return ctx.render(el.children).join('')
      })
    run(modeOf(elements), h('message',
      h('pre', { lang: 'ts' }, 'a'),
      h('blockquote', { key: 'k1' }, h('p', 'x'), h('pre', { key: 'k2' }, 'y'))))
    expect(ids).toEqual(['message/pre[0]', '#k1', '#k1/p[0]', '#k2', '#k2'])
  })

  it('exposes limits, text, resources and what the registry renders', () => {
    let seen: unknown
    const elements = minimal().register('img', (el, ctx) => {
      const ref = ctx.resource('image', el.attrs.src, { name: 'n' })
      seen = {
        ref: [ref.kind, ref.src, ref.meta],
        limit: ctx.limit('limit.text.chars'),
        mode: ctx.mode,
        renders: [ctx.renders('element.img'), ctx.renders('element.table'), ctx.renders('element.img.inline')],
      }
      return 'IMG'
    })
    run(modeOf(elements, { limits: { 'limit.text.chars': 10 } }), h('img', { src: 'https://x.test/a.png' }))
    expect(seen).toEqual({
      ref: ['image', 'https://x.test/a.png', { name: 'n' }],
      limit: 10,
      mode: 'fake',
      renders: [true, false, false],
    })
  })

  it('handlers may render descendants directly and registry.transform works with foreign contexts', () => {
    const elements = minimal()
      .register('table', (el, ctx) => el.children.map(row => row.children.map(cell => ctx.render(cell.children).join('')).join(',')).join(';'))
      .register('tr', () => 'TR')
      .register('td', () => 'TD')
    const mode = modeOf(elements)
    expect(run(mode, h('table', h('tr', h('td', 'a'), h('td', h('b', 'b'))))).msgs).toEqual(['a,b'])

    const report = transform(normalize('x'), { bot, target, mode }).report
    const ctx = { bot, target, mode: 'fake', limits: {}, report, ancestors: [], renders: () => true, limit: () => undefined } as unknown as RenderContext<S>
    expect(elements.transform([h('p', 'q', h('b', 'r'))], ctx)).toEqual(['qr'])
    expect(report.degraded.map(e => e.path)).toEqual(['~/p[0]/b[1]'])
  })
})
