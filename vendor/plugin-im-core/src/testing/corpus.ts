/**
 * Shared corpus — the content that `runConformance()` renders offline and that adapter goldens are recorded from.
 *
 * Three shapes of content:
 * - {@link corpusCases}: one case per vocabulary element and variant (plus the combination cases), small enough for a
 *   readable golden diff;
 * - {@link minimalContent}: the smallest tree that needs one tag / variant, used by conformance for the per-registered
 *   key check;
 * - {@link streamingScripts}: sequences of states of *one* logical message, i.e. what a stream driver sees from
 *   `open` to `close`.
 *
 * Everything is a factory: elements are mutable objects and the render engine keeps per-render state, so every call
 * returns fresh trees.
 */

import {
  type Element, elementInfo, type Fragment, h, normalize, type Tag, variantKey, variantsOf,
} from '@deepseek-ai/satori-element'

export interface CorpusCase {
  /** Stable kebab-case id: golden key and e2e marker suffix. */
  name: string
  /** One-line description for reports. */
  title: string
  /** Message content; the runner applies `normalize()`. */
  content: Fragment
}

export interface StreamScript {
  name: string
  title: string
  /** Successive states of one logical message: `states[0]` opens the stream, the last one closes it. */
  states: readonly Fragment[]
  /** Tick interval the runner should use (ms); the scheduler clamps it to the mode's own floor. */
  intervalMs?: number
}

const onClick = () => {}
const onSelect = () => {}

/**
 * One set of form controls: a form with a text field, a checkbox, a single select, a multiple select and a submit
 * button. The multiple one lives in the form on purpose — a platform reports it only through the submit.
 */
function formControls() {
  return h('form', { name: 'order' },
    h('input', { name: 'title', label: 'Title', placeholder: 'Type a title', value: 'Untitled' }),
    h('input', { name: 'agree', type: 'checkbox', label: 'I agree', value: true }),
    h('select', { id: 'sel-size', name: 'size', placeholder: 'Size', onSelect },
      h('option', { value: 's' }, 'Small'),
      h('option', { value: 'l', selected: true }, 'Large')),
    h('select', { name: 'tags', multiple: true, value: ['a'] },
      h('option', { value: 'a' }, 'Alpha'),
      h('option', { value: 'b' }, 'Beta')),
    h('button', { type: 'submit', id: 'btn-submit', onClick }, 'Send'))
}

/** Case content of `title-and-quote` and friends: envelope elements are direct root children. */
function envelope(title: string | undefined, quote: string | undefined, body: Element[]) {
  return [
    ...quote ? [h('quote', { id: quote })] : [],
    ...title ? [h('title', { subtitle: 'subtitle text' }, title)] : [],
    ...body,
  ]
}

/** One case per vocabulary element/variant plus the combination cases. */
export function corpusCases(): CorpusCase[] {
  return [
    {
      name: 'text',
      title: 'plain text with CJK and emoji',
      content: h('p', 'Hello world, 你好，世界 🚀 — plain text stays plain.'),
    },
    {
      name: 'inline-marks',
      title: 'bold, italic, underline, strikethrough and inline code',
      content: h('p', 'plain ', h('b', 'bold'), ' ', h('i', 'italic'), ' ', h('u', 'underline'), ' ', h('s', 'strike'),
        ' ', h('code', 'const x = 1')),
    },
    {
      name: 'spoiler',
      title: 'spoiler around hidden text (T2)',
      content: h('p', 'before ', h('spoiler', 'hidden text'), ' after'),
    },
    {
      name: 'link',
      title: 'a link with a readable label',
      content: h('p', 'see ', h('a', { href: 'https://example.com/docs' }, 'the documentation'), ' for details'),
    },
    {
      name: 'at-user',
      title: 'mention of a user',
      content: h('p', h('at', { type: 'user', id: 'u-alice', name: 'Alice' }), ' please take a look'),
    },
    {
      name: 'at-all',
      title: 'mention of everyone',
      content: h('p', h('at', { type: 'all' }), ' build is green again'),
    },
    {
      name: 'at-here',
      title: 'mention of everyone online',
      content: h('p', h('at', { type: 'here' }), ' standup in five minutes'),
    },
    {
      name: 'at-role',
      title: 'mention of a role',
      content: h('p', h('at', { type: 'role', id: 'r-admins', name: 'Admins' }), ' please review'),
    },
    {
      name: 'channel',
      title: 'channel reference (T2)',
      content: h('p', 'moved the discussion to ', h('channel', { id: 'c-general', name: 'general' })),
    },
    {
      name: 'emoji',
      title: 'custom emoji (T2)',
      content: h('p', 'nice work ', h('emoji', { id: 'e-party', name: 'party' }), '!'),
    },
    {
      name: 'span-color',
      title: 'colored span (T2, variant color)',
      content: h('p', 'status: ', h('span', { color: 'danger' }, 'failed')),
    },
    {
      name: 'line-break',
      title: 'hard line break inside a paragraph',
      content: h('p', 'first line', h('br'), 'second line'),
    },
    {
      name: 'headings',
      title: 'all six heading levels',
      content: [
        h('h1', 'Heading one'), h('h2', 'Heading two'), h('h3', 'Heading three'),
        h('h4', 'Heading four'), h('h5', 'Heading five'), h('h6', 'Heading six'),
      ],
    },
    {
      name: 'list-unordered',
      title: 'unordered list',
      content: h('ul', h('li', 'first item'), h('li', 'second item'), h('li', 'third item')),
    },
    {
      name: 'list-ordered',
      title: 'ordered list with a start offset',
      content: h('ol', { start: 3 }, h('li', 'third item'), h('li', 'fourth item')),
    },
    {
      name: 'list-checked',
      title: 'task list (variant li.checked)',
      content: h('ul', h('li', { checked: true }, 'done task'), h('li', { checked: false }, 'open task')),
    },
    {
      name: 'list-nested',
      title: 'nested list (variant li.nested)',
      content: h('ul', h('li', 'parent item', h('ul', h('li', 'child item'), h('li', 'second child')))),
    },
    {
      name: 'blockquote',
      title: 'quote block with a nested quote',
      content: h('blockquote', h('p', 'quoted line', h('br'), 'second quoted line'), h('blockquote', 'deeper quote')),
    },
    {
      name: 'code-block',
      title: 'fenced code block with a language (variant pre.lang)',
      content: h('pre', { lang: 'ts' }, 'const answer = 42\nconsole.log(answer)'),
    },
    {
      name: 'code-block-plain',
      title: 'code block without a language',
      content: h('pre', 'no language here\nsecond line'),
    },
    {
      name: 'divider',
      title: 'horizontal rule between paragraphs',
      content: [h('p', 'above the line'), h('hr'), h('p', 'below the line')],
    },
    {
      name: 'table',
      title: 'table with a right-aligned column (variant table.align)',
      content: h('table',
        h('tr', h('th', 'Name'), h('th', { align: 'right' }, 'Qty')),
        h('tr', h('td', 'apple'), h('td', '3')),
        h('tr', h('td', 'banana'), h('td', h('p', '7'), h('p', 'second paragraph')))),
    },
    {
      name: 'table-cells',
      title: 'table cells holding blocks (variant td.block)',
      content: h('table',
        h('tr', h('th', 'Section'), h('th', 'Details')),
        h('tr', h('td', 'first'), h('td', h('p', 'paragraph one'), h('p', 'paragraph two')))),
    },
    {
      name: 'details',
      title: 'collapsible details with a summary',
      content: h('details', h('summary', 'More information'), h('p', 'hidden body text')),
    },
    {
      name: 'small',
      title: 'small print',
      content: h('small', 'fine print note'),
    },
    {
      name: 'image',
      title: 'block image with alt text',
      content: h('img', { src: 'https://example.com/media/block.png', alt: 'block image', width: 320, height: 200 }),
    },
    {
      name: 'image-inline',
      title: 'image inside a paragraph (variant img.inline)',
      content: h('p', 'text before ', h('img', { src: 'https://example.com/media/inline.png', alt: 'inline image' }),
        ' text after'),
    },
    {
      name: 'media',
      title: 'audio, video and file attachments',
      content: [
        h('audio', { src: 'https://example.com/media/voice.opus', name: 'voice.opus', duration: 3000 }),
        h('video', { src: 'https://example.com/media/clip.mp4', name: 'clip.mp4', duration: 12000 }),
        h('file', { src: 'https://example.com/media/report.pdf', name: 'report.pdf', size: 20480 }),
      ],
    },
    {
      name: 'buttons',
      title: 'button group with action, link and input buttons',
      content: h('button-group',
        h('button', { type: 'action', id: 'btn-stop', onClick }, 'Stop'),
        h('button', { type: 'link', href: 'https://example.com/open' }, 'Open'),
        h('button', { type: 'input', text: '/compact' }, 'Compact')),
    },
    {
      name: 'button-theme',
      title: 'standalone action button with a theme (variant button.theme)',
      content: h('button', { type: 'action', id: 'btn-danger', theme: 'danger', onClick }, 'Delete everything'),
    },
    {
      name: 'button-inline',
      title: 'button inside a paragraph (variant button.inline)',
      content: h('p', 'run ', h('button', { type: 'input', text: '/status' }, 'Status'), ' to check'),
    },
    {
      name: 'form',
      title: 'form with a text field, a checkbox, a select and a submit button',
      content: [formControls()],
    },
    {
      name: 'title',
      title: 'message title with a subtitle',
      content: envelope('Release notes', undefined, [h('p', 'body of the titled message')]),
    },
    {
      name: 'quote',
      title: 'quote reply',
      content: envelope(undefined, 'quote-1', [h('p', 'answer that quotes another message')]),
    },
    {
      name: 'fallback',
      title: 'ordered alternatives: the first one the platform renders natively',
      content: [
        h('fallback', h('h3', 'headline as a heading'), h('p', h('b', 'headline in bold'))),
        h('p', 'body below the alternative'),
      ],
    },
    {
      name: 'title-and-quote',
      title: 'title and quote in one message',
      content: envelope('Weekly digest', 'quote-2', [h('p', 'both envelope elements at once')]),
    },
    {
      name: 'markdown-input',
      title: 'markdown element rendered by its contribution',
      content: h.markdown('**bold** text\n\n- item one\n- item two\n\n```ts\nconst x = 1\n```'),
    },
    {
      name: 'forward',
      title: 'merged-forward placeholder (inbound only)',
      content: envelope(undefined, undefined, [h('forward', { id: 'forward-1' }), h('p', 'message after the forward')]),
    },
    {
      name: 'raw',
      title: 'raw platform payload with fallback text (inbound only)',
      content: envelope(undefined, undefined, [h('raw', { platform: 'fake', type: 'card' }, 'raw fallback text')]),
    },
    {
      name: 'long-cjk',
      title: 'long CJK text with punctuation and emoji',
      content: h('p', '这是一段很长的中文内容，用来验证换行、标点符号（包括全角括号）以及 emoji 😀🎉 在处理过程中不会丢失。'
        + '第二句话继续说明：表格、列表、代码块等元素在平台不支持时应当降级为文本，而不是被丢弃。'),
    },
    {
      name: 'everything',
      title: 'every element of the vocabulary in one message',
      content: everything(),
    },
  ]
}

/** The combination case: at least one instance of every outbound tag, in document order. */
export function everything(): Fragment {
  return envelope('Everything at once', 'quote-everything', [
    h('p', 'plain ', h('b', 'bold'), h('i', 'italic'), h('u', 'under'), h('s', 'strike'), h('spoiler', 'secret'),
      h('code', 'inline-code'), h('a', { href: 'https://example.com/everything' }, 'link-text'),
      h('at', { type: 'user', id: 'u-alice', name: 'Alice' }), h('at', { type: 'all' }), h('at', { type: 'here' }),
      h('at', { type: 'role', id: 'r-admins', name: 'Admins' }),
      h('channel', { id: 'c-general', name: 'general' }), h('emoji', { id: 'e-party', name: 'party' }),
      h('span', { color: 'success' }, 'green-text'), h('br'), 'after the break',
      h('img', { src: 'https://example.com/media/inline.png', alt: 'inline image' })),
    h('h1', 'Heading one'), h('h2', 'Heading two'), h('h3', 'Heading three'), h('h4', 'Heading four'),
    h('h5', 'Heading five'), h('h6', 'Heading six'),
    h('ul', h('li', 'first item'), h('li', { checked: true }, 'done task'),
      h('li', 'parent item', h('ul', h('li', 'child item')))),
    h('ol', { start: 3 }, h('li', 'third item'), h('li', 'fourth item')),
    h('blockquote', h('p', 'quoted line'), h('blockquote', 'deeper quote')),
    h('pre', { lang: 'ts' }, 'const answer = 42'),
    h('hr'),
    h('table',
      h('tr', h('th', 'Name'), h('th', { align: 'right' }, 'Qty')),
      h('tr', h('td', 'apple'), h('td', h('p', '3'), h('p', 'second paragraph')))),
    h('details', h('summary', 'More information'), h('p', 'hidden body text')),
    h('small', 'fine print note'),
    h('img', { src: 'https://example.com/media/block.png', alt: 'block image' }),
    h('audio', { src: 'https://example.com/media/voice.opus', name: 'voice.opus' }),
    h('video', { src: 'https://example.com/media/clip.mp4', name: 'clip.mp4' }),
    h('file', { src: 'https://example.com/media/report.pdf', name: 'report.pdf' }),
    h('button-group',
      h('button', { type: 'action', id: 'btn-stop', onClick }, 'Stop'),
      h('button', { type: 'link', href: 'https://example.com/open' }, 'Open'),
      h('button', { type: 'input', text: '/compact' }, 'Compact')),
    h('p', 'run ', h('button', { type: 'input', text: '/status' }, 'Status'), ' to check'),
    h('button', { type: 'action', id: 'btn-danger', theme: 'danger', onClick }, 'Delete everything'),
    formControls(),
    h('forward', { id: 'forward-1' }),
    h('raw', { platform: 'fake', type: 'card' }, 'raw fallback text'),
  ])
}

/** Successive states of one message: what a `StreamDriver` sees between `open` and `close`. */
export function streamingScripts(): StreamScript[] {
  const initialState = h('p', 'Reading the workspace')
  return [
    {
      name: 'growing-text',
      title: 'an answer that grows token by token',
      intervalMs: 300,
      states: [
        initialState,
        h('p', 'Reading the workspace and the tests'),
        h('p', 'Reading the workspace and the tests; found three files to change'),
        h('p', 'Reading the workspace and the tests; found three files to change. Patching them now.'),
      ],
    },
    {
      name: 'growing-list',
      title: 'a status list that gains items',
      intervalMs: 300,
      states: [
        h('ul', h('li', 'read the design')),
        h('ul', h('li', 'read the design'), h('li', 'patch the code')),
        h('ul', h('li', 'read the design'), h('li', 'patch the code'), h('li', 'run the tests')),
        h('ul', h('li', 'read the design'), h('li', 'patch the code'), h('li', 'run the tests'),
          h('li', { checked: true }, 'report')),
      ],
    },
    {
      name: 'activity-summary',
      title: 'summary renderer shape: title, status and a growing list',
      intervalMs: 300,
      states: [
        [h('title', {}, 'Task **T08**'), h('p', 'working…')],
        [h('title', {}, 'Task **T08**'), h('p', 'working…'), h('ul', h('li', 'read the docs'))],
        [h('title', {}, 'Task **T08**'), h('p', 'working…'), h('ul', h('li', 'read the docs'), h('li', 'write the code'))],
        [h('title', {}, 'Task **T08**'), h('p', 'done'), h('ul', h('li', { checked: true }, 'read the docs'),
          h('li', { checked: true }, 'write the code'))],
      ],
    },
    {
      name: 'non-prefix-change',
      title: 'a late state rewrites earlier content (the replace path)',
      intervalMs: 300,
      states: [
        h('p', 'Checking the build'),
        h('p', 'Checking the build: 2 failures'),
        h('p', 'Build is green'),
        h('p', 'Build is green, ready to merge'),
      ],
    },
    {
      name: 'media-appears',
      title: 'an image appears mid-stream (prepare stays idempotent)',
      intervalMs: 300,
      states: [
        h('p', 'Rendering the screenshot'),
        h('p', 'Rendering the screenshot: done'),
        [h('p', 'Rendering the screenshot: done'), h('img', { src: 'https://example.com/media/shot.png', alt: 'screenshot' })],
      ],
    },
    {
      name: 'final-shorter',
      title: 'the final state is shorter than the last tick',
      intervalMs: 300,
      states: [
        h('p', 'Collecting intermediate results'),
        h('p', 'Collecting intermediate results: 12 of 12'),
        h('p', 'All 12 results collected.'),
      ],
    },
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal trees

/** Tags that never reach the registry: the root, the envelope `quote` and the input-only `markdown`. */
const NO_TREE: ReadonlySet<Tag> = new Set<Tag>(['message', 'quote', 'markdown'])

/**
 * The parent chain an element needs to stand in the tree (`li` → ['ul'], `td` → ['table', 'tr']), derived from the
 * content model. Conformance uses it to tell "this mode cannot render the tag" from "the container degraded first".
 */
export function minimalParents(tag: Tag): Tag[] {
  const chain: Tag[] = []
  let parent = elementInfo[tag].parents?.[0]
  while (parent) {
    chain.unshift(parent)
    parent = elementInfo[parent].parents?.[0]
  }
  return chain
}

/**
 * The smallest content tree that needs `tag` (and `variant`, when given), including the containers the content model
 * requires. Without a variant, an element tagged with its first variant is returned for `at` and `button` (which
 * always report one).
 */
export function minimalContent(tag: Tag, variant?: string): Fragment {
  if (NO_TREE.has(tag)) throw new Error(`minimalContent: <${tag}> is never rendered from content (no minimal tree)`)
  const first = variant ?? undefined
  switch (tag) {
    case 'title': return h('title', {}, 'Minimal title')
    case 'fallback': return h('fallback', h('p', 'minimal alternative'))
    case 'case': return h('fallback', h('p', 'minimal case'))
    case 'text': return h('p', 'minimal text')
    case 'p': return h('p', 'minimal paragraph')
    case 'b': return h('p', h('b', 'minimal bold'))
    case 'i': return h('p', h('i', 'minimal italic'))
    case 'u': return h('p', h('u', 'minimal underline'))
    case 's': return h('p', h('s', 'minimal strike'))
    case 'spoiler': return h('p', h('spoiler', 'minimal spoiler'))
    case 'code': return h('p', h('code', 'minimal code'))
    case 'a': return h('p', h('a', { href: 'https://example.com/a' }, 'minimal link'))
    case 'at': {
      switch (first ?? 'user') {
        case 'all': return h('p', h('at', { type: 'all' }))
        case 'here': return h('p', h('at', { type: 'here' }))
        case 'role': return h('p', h('at', { type: 'role', id: 'r-admins', name: 'Admins' }))
        default: return h('p', h('at', { type: 'user', id: 'u-alice', name: 'Alice' }))
      }
    }
    case 'channel': return h('p', h('channel', { id: 'c-general', name: 'general' }))
    case 'emoji': return h('p', h('emoji', { id: 'e-party', name: 'party' }))
    case 'span': return h('p', h('span', { color: 'danger' }, 'minimal colored text'))
    case 'br': return h('p', 'first line', h('br'), 'second line')
    case 'h1': return h('h1', 'Minimal heading')
    case 'h2': return h('h2', 'Minimal heading')
    case 'h3': return h('h3', 'Minimal heading')
    case 'h4': return h('h4', 'Minimal heading')
    case 'h5': return h('h5', 'Minimal heading')
    case 'h6': return h('h6', 'Minimal heading')
    case 'ul': return h('ul', h('li', 'minimal item'))
    case 'ol': return h('ol', { start: 1 }, h('li', 'minimal item'))
    case 'li': {
      if (first === 'checked') return h('ul', h('li', { checked: true }, 'minimal task'))
      if (first === 'nested') return h('ul', h('li', 'minimal parent', h('ul', h('li', 'minimal child'))))
      return h('ul', h('li', 'minimal item'))
    }
    case 'blockquote': return h('blockquote', h('p', 'minimal quote'))
    case 'pre': return h('pre', first === 'lang' ? { lang: 'ts' } : {}, 'minimal code line')
    case 'hr': return [h('p', 'above'), h('hr'), h('p', 'below')]
    case 'table':
      return first === 'align'
        ? h('table', h('tr', h('th', { align: 'right' }, 'Header')), h('tr', h('td', 'cell')))
        : h('table', h('tr', h('th', 'Header')), h('tr', h('td', 'cell')))
    case 'tr': return h('table', h('tr', h('th', 'Header'), h('td', 'cell')))
    case 'th': return h('table', h('tr', h('th', 'Header')))
    case 'td':
      return first === 'block'
        ? h('table', h('tr', h('td', h('p', 'first block'), h('p', 'second block'))))
        : h('table', h('tr', h('td', 'cell')))
    case 'details': return h('details', h('summary', 'Minimal summary'), h('p', 'minimal body'))
    case 'summary': return h('details', h('summary', 'Minimal summary'), h('p', 'minimal body'))
    case 'small': return h('small', 'minimal small print')
    case 'img':
      return first === 'inline'
        ? h('p', 'before ', h('img', { src: 'https://example.com/media/minimal.png', alt: 'minimal image' }), ' after')
        : h('img', { src: 'https://example.com/media/minimal.png', alt: 'minimal image' })
    case 'audio': return h('audio', { src: 'https://example.com/media/minimal.opus', name: 'minimal.opus' })
    case 'video': return h('video', { src: 'https://example.com/media/minimal.mp4', name: 'minimal.mp4' })
    case 'file': return h('file', { src: 'https://example.com/media/minimal.pdf', name: 'minimal.pdf' })
    case 'button': {
      switch (first) {
        case 'link': return h('button', { type: 'link', href: 'https://example.com/open' }, 'Minimal link')
        case 'input': return h('button', { type: 'input', text: '/status' }, 'Minimal input')
        case 'submit': return h('form', { name: 'form-minimal' }, h('button', { type: 'submit', id: 'btn-minimal', onClick }, 'Minimal submit'))
        case 'theme': return h('button', { type: 'action', id: 'btn-minimal', theme: 'danger', onClick }, 'Minimal themed')
        case 'inline': return h('p', 'before ', h('button', { type: 'action', id: 'btn-minimal', onClick }, 'Minimal action'), ' after')
        default: return h('button', { type: 'action', id: 'btn-minimal', onClick }, 'Minimal action')
      }
    }
    case 'button-group':
      return h('button-group', h('button', { type: 'action', id: 'btn-minimal', onClick }, 'Minimal action'))
    case 'form': return formControls()
    case 'input':
      return first === 'checkbox'
        ? h('form', { name: 'form-minimal' }, h('input', { name: 'agree', type: 'checkbox', label: 'Minimal checkbox' }))
        : h('form', { name: 'form-minimal' }, h('input', { name: 'field', label: 'Minimal field' }))
    case 'select':
      return first === 'multiple'
        ? h('select', { id: 'sel-minimal', multiple: true, onSelect },
          h('option', { value: 'a' }, 'Minimal choice'), h('option', { value: 'b' }, 'Other choice'))
        : h('select', { id: 'sel-minimal', onSelect }, h('option', { value: 'a' }, 'Minimal choice'))
    case 'option': return h('select', { id: 'sel-minimal', onSelect }, h('option', { value: 'a' }, 'Minimal choice'))
    case 'forward': return h('forward', { id: 'forward-minimal' })
    case 'raw': return h('raw', { platform: 'fake', type: 'card' }, 'raw fallback text')
    default: throw new Error(`minimalContent: no minimal tree for <${tag}>`)
  }
}

/**
 * Element keys (`element.<tag>[.<variant>]`) the corpus exercises, computed from the content trees: this is what
 * the coverage self-check compares against the vocabulary, so a new case keeps it honest.
 */
export function corpusKeys(cases: readonly CorpusCase[] = corpusCases()): string[] {
  const keys = new Set<string>(['element.message', 'element.markdown'])
  for (const item of cases) {
    const root = normalize(item.content)
    const walk = (el: Element, ancestors: Element[]) => {
      if (el.type === 'message') {
        for (const child of el.children) walk(child, ancestors)
        return
      }
      keys.add(variantKey(el.type))
      for (const variant of variantsOf(el, ancestors)) keys.add(variantKey(el.type, variant as never))
      const inner = [...ancestors, el]
      for (const child of el.children) walk(child, inner)
    }
    walk(root, [])
  }
  return [...keys]
}
