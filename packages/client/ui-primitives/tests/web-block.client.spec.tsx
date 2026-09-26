// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LinkIconMedium, WebBlock as LocalizedWebBlock } from '../src/index.ts'
import type {
  WebFetchBlockProps, WebSearchBlockProps, WebSourceView,
} from '../src/index.ts'
import { webBlockLabels } from './labels.client.ts'

type WebBlockProps =
  | Omit<WebSearchBlockProps, 'labels'>
  | Omit<WebFetchBlockProps, 'labels'>

function WebSearchBlock(props: Omit<WebSearchBlockProps, 'labels'>) {
  return <LocalizedWebBlock {...props} labels={webBlockLabels} />
}

function WebFetchBlock(props: Omit<WebFetchBlockProps, 'labels'>) {
  return <LocalizedWebBlock {...props} labels={webBlockLabels} />
}

function WebBlock(props: WebBlockProps) {
  return props.kind === 'search'
    ? <WebSearchBlock {...props} />
    : <WebFetchBlock {...props} />
}

afterEach(cleanup)

/** The path data of the mark a `url` link leads with for one destination. */
function glyphMark(href: string | undefined): string | null {
  const { container } = render(<LinkIconMedium kind="url" href={href} />)
  return container.querySelector('path')!.getAttribute('d')
}

function sources(count: number): WebSourceView[] {
  return Array.from({ length: count }, (_value, index) => ({
    url: `https://site-${index}.example.com/page`,
    title: `Source ${index}`,
  }))
}

describe('WebBlock search card', () => {
  it('renders the answer above the citation list', () => {
    const view = render(<WebBlock kind="search" answer="**Answer** text" sources={sources(2)} truncated={false} />)
    expect(view.getByText('Answer')).toBeTruthy()
    expect(view.getByText('Source 0')).toBeTruthy()
    expect(view.getByText('Source 1')).toBeTruthy()
  })

  it('omits the answer block when there is no answer', () => {
    const view = render(<WebBlock kind="search" sources={sources(1)} truncated={false} />)
    expect(view.container.querySelector('[class^="_answer_"]')).toBeNull()
    const empty = render(<WebBlock kind="search" answer="" sources={sources(1)} truncated={false} />)
    expect(empty.container.querySelector('[class^="_answer_"]')).toBeNull()
  })

  it('shows the empty-state note when a search returns no answer and no sources', () => {
    const view = render(<WebBlock kind="search" sources={[]} truncated={false} />)
    expect(view.getByText('未找到结果')).toBeTruthy()
    // The empty note replaces the source list, not an empty <ol>.
    expect(view.container.querySelector('ol')).toBeNull()
  })

  it('shows the source list, not the empty note, when a source is present', () => {
    const view = render(<WebBlock kind="search" sources={sources(1)} truncated={false} />)
    expect(view.container.querySelector('ol')).toBeTruthy()
    expect(view.queryByText('未找到结果')).toBeNull()
  })

  it('shows the source list when an empty source list still carries an answer', () => {
    const view = render(<WebBlock kind="search" answer="Just an answer" sources={[]} truncated={false} />)
    expect(view.getByText('Just an answer')).toBeTruthy()
    expect(view.queryByText('未找到结果')).toBeNull()
  })

  it('labels a source by its title, and by hostname when the title is absent', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'https://example.com/a', title: 'Titled' },
      { url: 'https://plain.example.org/b' },
      { url: 'https://empty.example.net/c', title: '' },
    ]} />)
    expect(view.getByText('Titled')).toBeTruthy()
    // No title / empty title: the hostname labels the link.
    expect(view.getByText('plain.example.org')).toBeTruthy()
    expect(view.getByText('empty.example.net')).toBeTruthy()
  })

  it('labels a source by the raw url when it parses to an empty hostname', () => {
    // file:/data:/javascript: URLs parse but have no hostname; the label must
    // fall back to the raw URL so it is never blank (and the link stays plain
    // text since the protocol is not http(s)).
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'file:///etc/passwd' },
    ]} />)
    expect(view.getByText('file:///etc/passwd')).toBeTruthy()
  })

  it('renders a source as a safe external anchor for an http(s) url', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'https://example.com/a', title: 'Titled' },
    ]} />)
    const anchor = view.getByText('Titled') as HTMLAnchorElement
    expect(anchor.tagName).toBe('A')
    expect(anchor.getAttribute('href')).toBe('https://example.com/a')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it("leads a source and a fetched url on a known site with that site's mark", () => {
    /** The mark a link leads with, as its path data. */
    const mark = (element: Element): string | null => element.querySelector('a svg path')!.getAttribute('d')
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'https://github.com/org/repo', title: 'Repo' },
    ]} />)
    expect(mark(view.container)).toBe(glyphMark('https://github.com/a'))
    // An unmapped host keeps the globe, as does the fetch card's URL.
    expect(mark(render(<WebBlock kind="search" sources={sources(1)} truncated={false} />).container))
      .toBe(glyphMark(undefined))
    expect(mark(render(<WebBlock kind="fetch" url="https://news.ycombinator.com/item?id=1" statusCode={200} truncated={false} />).container))
      .toBe(glyphMark('https://news.ycombinator.com/item?id=2'))
  })

  it('renders a non-http url as plain text with no href, and its raw text label when unparseable', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'javascript:alert(1)', title: 'Dangerous' },
      { url: 'not a url' },
    ]} />)
    const unsafe = view.getByText('Dangerous')
    expect(unsafe.tagName).toBe('SPAN')
    expect(unsafe.getAttribute('href')).toBeNull()
    // An unparseable url is not a link and cannot yield a hostname, so its raw
    // text is the label.
    const raw = view.getByText('not a url')
    expect(raw.tagName).toBe('SPAN')
  })

  it('shows a source snippet and publication date when present, and omits them when absent or empty', () => {
    const view = render(<WebBlock kind="search" truncated={false} sources={[
      { url: 'https://a.example.com', title: 'A', snippet: 'excerpt', publishedAt: '2026-07-01' },
      { url: 'https://b.example.com', title: 'B', snippet: '', publishedAt: '' },
      { url: 'https://c.example.com', title: 'C' },
    ]} />)
    expect(view.getByText('excerpt')).toBeTruthy()
    expect(view.getByText('2026-07-01')).toBeTruthy()
    // The empty-string and absent arms both draw nothing beyond the link.
    expect(view.container.querySelectorAll('[class^="_snippet_"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[class^="_published_"]')).toHaveLength(1)
  })

  it('shows the truncated indicator only when the list was capped by the tool', () => {
    const on = render(<WebBlock kind="search" sources={sources(1)} truncated />)
    expect(on.getByText('来源列表已截断')).toBeTruthy()
    cleanup()
    const off = render(<WebBlock kind="search" sources={sources(1)} truncated={false} />)
    expect(off.queryByText('来源列表已截断')).toBeNull()
  })

  it('renders every source in one <ol> with no expand control', () => {
    // The card shows the whole list the tool returned, with no head/tail
    // collapse and no expand button. jsdom does not resolve the CSS Modules
    // layout, so the scroll geometry the `.sources` max-height produces is
    // pinned by the assembled browser case in apps/web/tests/web-search-round.e2e.ts,
    // not here.
    const view = render(<WebBlock kind="search" sources={sources(30)} truncated={false} />)
    expect(view.container.querySelectorAll('li[class^="_source_"]')).toHaveLength(30)
    expect(view.container.querySelector('[aria-expanded]')).toBeNull()
    expect(view.container.querySelector('button')).toBeNull()
    // Every direct child of the <ol> is a source <li> (no marker-less expander).
    const ol = view.container.querySelector('ol')!
    expect([...ol.children].every(child => child.tagName === 'LI')).toBe(true)
  })

  it('numbers every source by its 1-based citation index via <li value>', () => {
    const view = render(<WebBlock kind="search" sources={sources(4)} truncated={false} />)
    const items = [...view.container.querySelectorAll('li[class^="_source_"]')]
    expect(items.map(li => li.getAttribute('value'))).toEqual(['1', '2', '3', '4'])
  })
})

describe('WebBlock fetch card', () => {
  it('renders the fetched url as a safe external anchor and its HTTP status', () => {
    const view = render(<WebBlock kind="fetch" url="https://example.com/page" statusCode={200} truncated={false} />)
    const anchor = view.getByText('https://example.com/page') as HTMLAnchorElement
    expect(anchor.tagName).toBe('A')
    expect(anchor.getAttribute('href')).toBe('https://example.com/page')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer')
    expect(view.getByText('HTTP 200')).toBeTruthy()
  })

  it('renders a non-http fetch url as plain text with no href', () => {
    const view = render(<WebBlock kind="fetch" url="file:///etc/passwd" statusCode={200} truncated={false} />)
    const label = view.getByText('file:///etc/passwd')
    expect(label.tagName).toBe('SPAN')
    expect(label.getAttribute('href')).toBeNull()
  })

  it('shows the truncated indicator only when the content was cut', () => {
    const on = render(<WebBlock kind="fetch" url="https://example.com" statusCode={200} truncated />)
    expect(on.getByText('内容已截断')).toBeTruthy()
    cleanup()
    const off = render(<WebBlock kind="fetch" url="https://example.com" statusCode={200} truncated={false} />)
    expect(off.queryByText('内容已截断')).toBeNull()
  })

  it('carries a non-200 status verbatim', () => {
    const view = render(<WebBlock kind="fetch" url="https://example.com/missing" statusCode={404} truncated={false} />)
    expect(view.getByText('HTTP 404')).toBeTruthy()
  })
})
