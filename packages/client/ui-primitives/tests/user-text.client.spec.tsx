// @vitest-environment jsdom
/**
 * Inline projection of sent user text: decoration never breaks a single-line
 * message (bubble regression), and wire session forms fold to their label
 * (queue-row readability).
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { projectUserText } from '../src/user-text.tsx'

const project = (
  text: string,
  labels: readonly string[] = [],
  slashNames: readonly string[] = [],
  slashKind: 'skill' | 'command' = 'skill',
) =>
  render(<div data-host>{projectUserText(text, labels, slashNames, slashKind)}</div>).container.querySelector('[data-host]')!

describe('projectUserText', () => {
  it('keeps a decorated single-line message on one line: every part is inline', () => {
    const host = project('反反复复 /dsh-acp-test @执行几个命令测试', ['执行几个命令测试'], ['dsh-acp-test'])
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.textContent).toBe('反反复复 /dsh-acp-test 执行几个命令测试')
    const chips = host.querySelectorAll('[data-ref-chip]')
    expect([...chips].map(c => c.getAttribute('data-ref-chip'))).toEqual(['skill', 'session'])
    // The whitespace between tokens survives as its own inline run.
    const runs = [...host.querySelectorAll('span')].filter(s => !s.hasAttribute('data-ref-chip') && s.closest('[data-ref-chip]') === null)
    expect(runs.map(r => r.textContent)).toEqual(['反反复复 ', ' '])
  })

  it('folds the wire session form to its label with the session glyph', () => {
    const host = project('看看 @[查看并分析图片](dsh-session:InNlc3Npb24tNDM0) 的结论')
    const chip = host.querySelector('[data-ref-chip="session"]')!
    expect(chip.textContent).toBe('查看并分析图片')
    expect(chip.getAttribute('title')).toBe('@[查看并分析图片](dsh-session:InNlc3Npb24tNDM0)')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(host.textContent).toBe('看看 查看并分析图片 的结论')
  })

  it('prefers the wire fold over the bare-token scan on the same range', () => {
    const host = project('@[a](dsh-session:x)', [])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(1)
    expect(host.querySelector('[data-ref-chip="session"]')!.textContent).toBe('a')
  })

  it('decorates recall-associated labels, files, folders, and quoted paths', () => {
    const host = project('@会话一 说 @src/deep/file.txt 与 @dir/ 与 @"a b.md"', ['会话一'])
    const kinds = [...host.querySelectorAll('[data-ref-chip]')].map(c =>
      [c.getAttribute('data-ref-chip'), c.textContent])
    expect(kinds).toEqual([
      ['session', '会话一'],
      ['file', 'file.txt'],
      ['folder', 'dir'],
      ['file', 'a b.md'],
    ])
  })

  it('repeated recall labels decorate every occurrence once', () => {
    const host = project('@再看 前情 @再看', ['再看', '再看'])
    expect(host.querySelectorAll('[data-ref-chip="session"]').length).toBe(2)
  })

  it('keeps a punctuation-glued slash token plain and skips degenerate tokens', () => {
    // The host skill gesture ends at whitespace or the text end, so `/plan。`
    // never loads a skill; the bubble must not suggest otherwise.
    const host = project('用 /plan。 试试 @。', [], ['plan'])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe('用 /plan。 试试 @。')
  })

  it('decorates a slash token only when the host resolved it as a skill in that step', () => {
    const bare = project('/123')
    expect(bare.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(bare.textContent).toBe('/123')
    const unresolved = project('用 /plan 看看')
    expect(unresolved.querySelectorAll('[data-ref-chip]').length).toBe(0)
    const resolved = project('用 /plan 看看', [], ['plan'])
    expect([...resolved.querySelectorAll('[data-ref-chip]')].map(c => [c.getAttribute('data-ref-chip'), c.textContent]))
      .toEqual([['skill', '/plan']])
  })

  it('marks a resolved slash token as a command chip when the caller says so', () => {
    const host = project('/goal ship it\nsecond line', [], ['goal'], 'command')
    const chips = [...host.querySelectorAll('[data-ref-chip]')]
    expect(chips.map(c => [c.getAttribute('data-ref-chip'), c.textContent])).toEqual([['command', '/goal']])
    expect(host.textContent).toBe('/goal ship it\nsecond line')
  })

  it('leaves slash paths undecorated even for a resolved name: a /name token ends at whitespace', () => {
    const text = '测试一下ui，不用管我：\n/nfs-hg/xxx/yyy 与 /root-dir/ 和 /plan.md'
    const host = project(text, [], ['nfs-hg', 'root-dir', 'plan'])
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe(text)
  })

  it('prefers the longer recall label when one nests inside another', () => {
    const host = project('@会话一 收尾', ['会话', '会话一'])
    const chips = [...host.querySelectorAll('[data-ref-chip="session"]')]
    expect(chips.map(c => c.textContent)).toEqual(['会话一'])
    expect(host.textContent).toBe('会话一 收尾')
  })

  it('falls back to the raw quoted label when the path has no basename', () => {
    const host = project('看 @"/" 下面')
    const chip = host.querySelector('[data-ref-chip="file"]')!
    expect(chip.textContent).toBe('"/"')
  })

  it('renders undecorated text as one inline run', () => {
    const host = project('纯文本，无引用')
    expect(host.querySelectorAll('div').length).toBe(0)
    expect(host.querySelectorAll('[data-ref-chip]').length).toBe(0)
    expect(host.textContent).toBe('纯文本，无引用')
  })
})
