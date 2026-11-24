// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { changeRequestReference } from '../src/markdown/change-request-link.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

const PULL = 'https://github.com/octo/demo/pull/7'
const MERGE = 'https://gitlab.com/group/sub/project/-/merge_requests/3'

/** Render settled Markdown and read each anchor's text, title, and destination. */
function anchors(text: string, streaming = false): { text: string | null; title: string | null; href: string | null }[] {
  const view = render(<MarkdownText text={text} streaming={streaming} />)
  return [...view.container.querySelectorAll('a')].map(anchor => ({
    text: anchor.textContent, title: anchor.getAttribute('title'), href: anchor.getAttribute('href'),
  }))
}

describe('Markdown change request references', () => {
  it.each([
    ['a bare pull request URL', `see ${PULL} now`, PULL, 'octo/demo#7'],
    ['a trailing slash', `see ${PULL}/ now`, `${PULL}/`, 'octo/demo#7'],
    ['an autolink', `see <${PULL}> now`, PULL, 'octo/demo#7'],
    ['a link whose text is its URL', `see [${PULL}](${PULL}) now`, PULL, 'octo/demo#7'],
    ['a merge request in a subgroup', `see ${MERGE} now`, MERGE, 'group/sub/project!3'],
    ['a reference-style link written as its URL', `see [${PULL}]\n\n[${PULL}]: ${PULL}`, PULL, 'octo/demo#7'],
  ])('draws %s as its reference titled with the URL', (_name, markdown, href, reference) => {
    expect(anchors(markdown)).toEqual([{ text: reference, title: href, href }])
  })

  it('reads the repository at text weight and the number at link weight', () => {
    const view = render(<MarkdownText text={PULL} />)
    const repository = view.container.querySelector('a span:not(svg *)')
    expect(repository?.textContent).toBe('octo/demo')
    expect(repository?.nextSibling?.textContent).toBe('#7')
  })

  it.each([
    ['author-written text', `[this PR](${PULL})`, 'this PR'],
    ['a number the author wrote', `[#7](${PULL})`, '#7'],
    ['the changed files page', `${PULL}/files`, `${PULL}/files`],
    ['a comment fragment', `${PULL}#issuecomment-1`, `${PULL}#issuecomment-1`],
    ['a query string', `${PULL}?notification_referrer_id=NT_x`, `${PULL}?notification_referrer_id=NT_x`],
    ['an issue', 'https://github.com/octo/demo/issues/7', 'https://github.com/octo/demo/issues/7'],
    ['another host', 'https://git.corp.example/octo/demo/pull/7', 'https://git.corp.example/octo/demo/pull/7'],
    ['emphasized link text', `[*${PULL}*](${PULL})`, PULL],
  ])('keeps %s as written', (_name, markdown, text) => {
    expect(anchors(markdown).map(anchor => [anchor.text, anchor.title])).toEqual([[text, null]])
  })

  it('keeps a URL written as inline code', () => {
    const view = render(<MarkdownText text={`\`${PULL}\``} />)
    expect(view.container.querySelector('code a')?.textContent).toBe(PULL)
  })

  it('keeps the URL while the message streams and draws the reference once it settles', () => {
    expect(anchors(`see ${PULL} now`, true)).toEqual([{ text: PULL, title: null, href: PULL }])
    expect(anchors(`see ${PULL} now`)).toEqual([{ text: 'octo/demo#7', title: PULL, href: PULL }])
  })
})

describe('changeRequestReference', () => {
  it.each([
    ['https://github.com:8443/octo/demo/pull/7'],
    ['https://user:token@github.com/octo/demo/pull/7'],
    ['ftp://github.com/octo/demo/pull/7'],
    ['https://github.com/octo/demo/pull/07'],
    ['https://github.com/octo/demo/pull/0'],
    ['https://github.com/octo/de%20mo/pull/7'],
    ['https://github.com/octo/demo/extra/pull/7'],
    ['https://gitlab.com/project/-/merge_requests/3'],
    ['https://www.github.com/octo/demo/pull/7'],
    ['not a url'],
  ])('reads no reference from %s', (href) => {
    expect(changeRequestReference(href, href)).toBeUndefined()
  })

  it('reads a reference only when the text spells the destination', () => {
    expect(changeRequestReference(PULL, ` ${PULL}/ `)).toEqual({ repository: 'octo/demo', number: '#7' })
    expect(changeRequestReference(PULL, 'octo/demo#7')).toBeUndefined()
  })
})
