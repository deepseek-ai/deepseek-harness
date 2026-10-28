/** CSS checks for the Turn tail slot and the running status's entrance after admitted steering. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')

describe('Turn tail slot spacing', () => {
  it('gives a Turn duration control its gap without a transition while rows fold', () => {
    const view = read('ChatView.module.css')
    expect(view).toMatch(new RegExp(String.raw`\.column\[data-chat-motion\] > :global\(\[data-slot="conversation\.chat\.flow"\]\) > \[data-chat-flow-kind="turn-process"\] \{\s*transition: none;`))
  })

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

describe('Running status entrance after admitted steering', () => {
  const row = String.raw`calc\(24px \+ var\(--dsh-content-font-delta, 0px\)\)`

  it('enters its new slot from one slot higher, outside reduced motion', () => {
    const view = read('ChatView.module.css')
    expect(view).toMatch(new RegExp(String.raw`@media \(prefers-reduced-motion: no-preference\) \{\s*:where\(\.column > [^{]*\[data-chat-flow-kind="steering"\]\) \+ \.running \{\s*`
      + String.raw`animation: running-enters-slot 140ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\);`))
    expect(view).toMatch(new RegExp(String.raw`@keyframes running-enters-slot \{\s*from \{\s*opacity: 0;\s*`
      + String.raw`translate: 0 calc\(-44px - var\(--dsh-content-font-delta, 0px\)\);\s*\}\s*40% \{\s*opacity: 1;`))
  })

  it('is the only status move, and an input fold changes only its duration', () => {
    const view = read('ChatView.module.css')
    const normalize = (selector: string) => selector.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
    // Structure alone names the move, so lifting the switch never adds an animation name and replays it.
    const moves = [...view.matchAll(/([^{}]+)\{\s*animation: running-[\w-]+ /g)].map(match => normalize(match[1]!))
    expect(moves).toHaveLength(1)
    expect(moves[0]).toMatch(/^:where\(/)
    expect(moves[0]).not.toMatch(/data-input-fold/)
    const switches = [...view.matchAll(/([^{}]+)\{\s*animation-duration: 0s;\s*\}/g)].map(match => normalize(match[1]!))
    expect(switches).toEqual(['.column[data-input-fold] .running'])
  })

  it('sizes the first output rows to one font-scaled row', () => {
    expect(read('ReasoningRow.module.css')).toMatch(new RegExp(String.raw`\.root:not\(\[data-expanded\]\) \{[^}]*height: ${row};`))
    expect(read('ChatGroupSeat.module.css')).toMatch(new RegExp(String.raw`\.title \{[^}]*line-height: ${row};`))
    expect(read('AssistantMarkdown.module.css')).toMatch(new RegExp(String.raw`\.root \{[^}]*line-height: ${row};`))
  })
})
