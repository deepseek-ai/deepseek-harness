/** CSS checks for the Turn tail slot and the running status's move below a Step's first output. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')

describe('Turn tail slot spacing', () => {
  it('combines the flow and footer offsets around turn-tail content', () => {
    expect(read('ChatView.module.css')).toMatch(/margin-top:\s*var\(--dsh-chat-flow-gap, 4px\)/)
    const tail = read('TurnTailNodeView.module.css')
    expect(tail).toMatch(/\.root\s*\{[^}]*gap:\s*16px/s)
    expect(tail).toMatch(/\.actions\s*\{[^}]*margin-top:\s*4px/s)
  })

  it('keeps process rows inside and outside a group on the same gap', () => {
    const group = read('ChatGroupSeat.module.css')
    expect(group).toMatch(/\.body \{[^}]*--dsh-chat-flow-gap: 4px;/s)
    expect(group).toMatch(/margin-top:\s*var\(--dsh-chat-flow-gap, 4px\)/)
  })

  it('keeps the tail slot above a marked steering batch start and out of neighbour gaps', () => {
    const view = read('ChatView.module.css')
    const marked = String.raw`:has\(> \[data-slot="conversation\.chat\.node"\] > \[data-chat-steering-batch`
    expect(view).toMatch(new RegExp(String.raw`\.flowItem${marked}="start"\]\)\s*\{\s*--dsh-chat-flow-gap:\s*calc\(44px \+ var\(--dsh-content-font-delta, 0px\)\);`))
    expect(view).toMatch(new RegExp(String.raw`:not\(\.running\):not\(${marked}\]\)\)\s*\{\s*--dsh-chat-flow-gap:\s*12px;`))
    expect(view).toMatch(new RegExp(String.raw`:not\(\.running\):not\(\[data-submission-echo\], \[data-pending-steering\]\):not\(${marked}\]\)\)\s*\{\s*--dsh-chat-flow-gap:\s*16px;`))
  })

  it('keeps echoes after a running Turn\'s empty control at the input gap', () => {
    const view = read('ChatView.module.css')
    const header = view.slice(view.indexOf('/* The Turn header has 16px clearance'))
    const rule = header.slice(0, header.indexOf('}') + 1)
    const empty = String.raw`:empty, :has(> [data-slot="conversation.chat.node"]:empty)`
    // A visible control keeps its 16px clearance for every following row, echoes included.
    expect(rule).toContain(String.raw`[data-chat-flow-kind="turn-process"]:not(${empty}) + :not([hidden])`)
    // After any control, including an empty running one, the 16px clearance skips local echoes,
    // which stay at the input gap until their durable rows replace them.
    expect(rule).toContain(String.raw`[data-chat-flow-kind="turn-process"] + :not([hidden]):not(.flowItem:is(${empty}))`
      + ':not(.running):not([data-submission-echo], [data-pending-steering])')
  })
})

describe('Running status move below the first output', () => {
  const row = String.raw`calc\(24px \+ var\(--dsh-content-font-delta, 0px\)\)`
  const travel = (gap: number) => String.raw`--dsh-running-follow: calc\(${gap}px \+ 24px \+ var\(--dsh-content-font-delta, 0px\)\);`

  it('travels the first output row gap plus one font-scaled row', () => {
    const view = read('ChatView.module.css')
    // A process row or group header after a mid-Turn input: the default sits on the single-class
    // status rule, the lowest-specificity selector, so each variant below outranks it.
    expect(view).toMatch(new RegExp(String.raw`\n\.running \{[^}]*${travel(4)}`))
    expect(view.match(/--dsh-running-follow: calc\(/g)).toHaveLength(3)
    // A response keeps its 12px clearance.
    expect(view).toMatch(new RegExp(String.raw`\)\)\)\)\[data-chat-group-part="response"\] ~ \.running \{\s*${travel(12)}`))
    // A new Turn's first output follows the empty running process control at its 16px clearance.
    expect(view).toMatch(new RegExp(String.raw`> \[data-chat-flow-kind="turn-process"\] \+ :nth-last-child\(2 of [^{]*\) ~ \.running \{\s*${travel(16)}`))
  })

  it('slides the status from where it stood, like the steering entrance, outside reduced motion', () => {
    const view = read('ChatView.module.css')
    expect(view).toMatch(new RegExp(String.raw`@media \(prefers-reduced-motion: no-preference\) \{\s*:where\(\.column > [^{]*\[data-chat-group-key\]\s*\)\) ~ \.running \{\s*`
      + String.raw`animation: running-follows-output 110ms cubic-bezier\(0\.4, 0, 0\.2, 1\);`))
    expect(view).toMatch(new RegExp(String.raw`@keyframes running-follows-output \{\s*from \{\s*opacity: 0;\s*`
      + String.raw`translate: 0 calc\(-1 \* var\(--dsh-running-follow\)\);\s*\}\s*40% \{\s*opacity: 1;`))
  })

  it('lets input folds and the pinned tail change only the duration of a status move', () => {
    const view = read('ChatView.module.css')
    const normalize = (selector: string) => selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
    // Structure alone names each move, so a switch turning off never adds an animation name and replays a
    // finished move. The structure sits in :where() so the switch rules outrank it.
    const moves = [...view.matchAll(/([^{}]+)\{\s*animation: running-(?:enters-slot|follows-output) /g)].map(match => normalize(match[1]!))
    expect(moves).toHaveLength(2)
    for (const selector of moves) {
      expect(selector).toMatch(/^:where\(/)
      expect(selector).not.toMatch(/data-input-fold|data-chat-tail-pinned/)
    }
    // An input fold zeroes both moves; the pinned tail zeroes only the first-output slide, whose structure it
    // repeats, and leaves the entrance after admitted steering at its duration.
    const slide = moves.find(selector => selector.includes('[data-chat-group-key]'))!
    expect(slide.endsWith(') ~ .running')).toBe(true)
    const slideStructure = slide.slice(':where('.length, -') ~ .running'.length)
    const switches = [...view.matchAll(/([^{}]+)\{\s*animation-duration: 0s;\s*\}/g)].map(match => normalize(match[1]!))
    expect(switches).toEqual([
      '.column[data-input-fold] .running',
      `${slideStructure.replace(/^\.column/, '.column[data-chat-tail-pinned]')} ~ .running`,
    ])
    expect(view.match(/data-chat-tail-pinned/g)).toHaveLength(1)
  })

  it('sizes every first-output row to the travelled row height', () => {
    expect(read('ReasoningRow.module.css')).toMatch(new RegExp(String.raw`\.root:not\(\[data-expanded\]\) \{[^}]*height: ${row};`))
    expect(read('ChatGroupSeat.module.css')).toMatch(new RegExp(String.raw`\.title \{[^}]*line-height: ${row};`))
    expect(read('AssistantMarkdown.module.css')).toMatch(new RegExp(String.raw`\.root \{[^}]*line-height: ${row};`))
  })
})
