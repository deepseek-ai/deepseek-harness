// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { webCardModel, webFetchHref } from '../src/client/tool/models/web-card-model.ts'
import { GenericToolCard } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { WebRow, webToolview } from '../src/client/tool/toolviews/web-row.tsx'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)


const t = makeTranslate(zh, commonZh)

const SEARCH_ARGS = '{"queries":["deepseek harness"]}'
const FETCH_ARGS = '{"url":"https://example.com/page"}'

interface SearchMeta {
  sources: { url: string; title?: string; snippet?: string; publishedAt?: string }[]
  truncated: boolean
  answer?: string
}

interface FetchMeta {
  url: string
  statusCode: number
  truncated: boolean
}

/** Persisted web_search result metadata. */
const searchMeta = (over?: Partial<SearchMeta>): SearchMeta => ({
  truncated: false,
  answer: 'A short answer.',
  sources: [
    { url: 'https://example.com/a', title: 'Titled', snippet: 'excerpt', publishedAt: '2026-07-01' },
    { url: 'https://plain.example.org/b' },
  ],
  ...over,
})

/** Persisted web_fetch result metadata. */
const fetchMeta = (over?: Partial<FetchMeta>): FetchMeta => ({
  url: 'https://example.com/page', statusCode: 200, truncated: false, ...over,
})

const runningSearch = (over?: Partial<StartedToolCall>): StartedToolCall => ({
  phase: 'start' as const, callId: 'c1', name: 'web_search', argsRaw: SEARCH_ARGS,
  turn: 1, step: 1, time: 1_000, subCalls: [], ...over,
})

const settledSearch = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'web_search', argsRaw: SEARCH_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'search text' }], isError: false,
  meta: searchMeta(), subCalls: [], ...over,
})

const settledFetch = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 11, time: 2_000, callId: 'c2',
  call: { name: 'web_fetch', argsRaw: FETCH_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'fetch body' }], isError: false,
  meta: fetchMeta(), subCalls: [], ...over,
})

describe('webCardModel', () => {
  it('derives a search card from result metadata, projecting every source field', () => {
    expect(webCardModel(settledSearch())).toEqual({
      kind: 'search',
      answer: 'A short answer.',
      truncated: false,
      sources: [
        { url: 'https://example.com/a', title: 'Titled', snippet: 'excerpt', publishedAt: '2026-07-01' },
        { url: 'https://plain.example.org/b' },
      ],
    })
  })

  it('carries the search truncation flag and an absent answer', () => {
    const model = webCardModel(settledSearch({ meta: { truncated: true, sources: [] } }))
    expect(model).toEqual({ kind: 'search', answer: undefined, truncated: true, sources: [] })
  })

  it('derives a fetch card from result metadata', () => {
    expect(webCardModel(settledFetch())).toEqual({
      kind: 'fetch', url: 'https://example.com/page', statusCode: 200, truncated: false,
    })
    expect(webCardModel(settledFetch({ meta: fetchMeta({ statusCode: 404, truncated: true }) })))
      .toEqual({ kind: 'fetch', url: 'https://example.com/page', statusCode: 404, truncated: true })
  })

  it('returns null for a running call, since the web card is result-only', () => {
    expect(webCardModel(runningSearch())).toBeNull()
  })

  it('returns null for missing calls, errors, malformed args/meta, unrelated tools, and children', () => {
    expect(webCardModel(settledSearch({ call: null }))).toBeNull()
    expect(webCardModel(settledSearch({ isError: true }))).toBeNull()
    expect(webCardModel(settledSearch({ call: { name: 'web_search', argsRaw: '{' } }))).toBeNull()
    expect(webCardModel(settledSearch({ meta: undefined }))).toBeNull()
    expect(webCardModel(settledSearch({ meta: { sources: [], truncated: 'yes' } }))).toBeNull()
    expect(webCardModel(settledSearch({ call: { name: 'echo', argsRaw: '{}' } }))).toBeNull()
    expect(webCardModel(settledSearch({ parentCallId: 'parent' }))).toBeNull()
  })

  it('accepts open-root extensions while validating declared web arguments', () => {
    expect(webCardModel(settledSearch({
      call: { name: 'web_search', argsRaw: '{"queries":["deepseek"],"extension":1}' },
    }))).not.toBeNull()
    expect(webCardModel(settledSearch({
      call: { name: 'web_search', argsRaw: '{"queries":[7]}' },
    }))).toBeNull()
    expect(webCardModel(settledFetch({
      call: { name: 'web_fetch', argsRaw: '{"url":" "}' },
    }))).toBeNull()
  })
})

describe('webFetchHref', () => {
  it('returns only an http(s) web_fetch URL', () => {
    expect(webFetchHref(settledFetch())).toBe('https://example.com/page')
    expect(webFetchHref(settledFetch({ call: { name: 'web_fetch', argsRaw: '{"url":"http://a.test/"}' } })))
      .toBe('http://a.test/')
    expect(webFetchHref(settledFetch({ call: { name: 'web_fetch', argsRaw: '{"url":"javascript:alert(1)"}' } })))
      .toBeUndefined()
    expect(webFetchHref(settledFetch({ call: { name: 'web_fetch', argsRaw: '{"url":"not a url"}' } }))).toBeUndefined()
    expect(webFetchHref(settledFetch({ call: { name: 'web_fetch', argsRaw: '{"url":1}' } }))).toBeUndefined()
    expect(webFetchHref(settledFetch({ call: null }))).toBeUndefined()
    expect(webFetchHref(settledSearch())).toBeUndefined()
  })
})

describe('chat row web body', () => {
  const ownerProps = (block: StartedToolCall | ToolResultNode, toolName: string): ToolCallOwnerProps => ({
    useDisclosure, callId: block.callId, toolName, ...('kind' in block ? { phase: 'result' as const, block: block } : { phase: block.phase, block: block }), openFile: vi.fn(), loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
  })
  // WebRow reads only toolName/block off the full runtime share plus the locale
  // seat; the standard kit is unused, so the cast supplies the owner slice and
  // `t` alone (as BashRow's tests do for the terminal card).
  const rowProps = (block: StartedToolCall | ToolResultNode, toolName: string): Parameters<typeof WebRow>[0] =>
    ({ ...ownerProps(block, toolName), t } as unknown as Parameters<typeof WebRow>[0])

  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('the WebRow collapses to the summary row, expanding to the full search card', () => {
    const globe = render(<IconGlobeOutlineRegular />).container.querySelector('svg')!.outerHTML
    const view = render(<WebRow {...rowProps(settledSearch(), 'web_search')} />)
    // Collapsed: the summary row alone, no card in the DOM.
    expect(view.getByText('网页搜索')).toBeTruthy()
    expect(view.container.querySelector('svg')?.outerHTML).toBe(globe)
    expect(view.queryByText('Titled')).toBeNull()
    expect(view.container.querySelector('[data-web]')).toBeNull()
    toggleRow(view)
    // Expanded: the resident search card with every source field.
    expect(view.getByText('Titled')).toBeTruthy()
    expect(view.getByText('excerpt')).toBeTruthy()
    // hostname fallback for the source with no title
    expect(view.getByText('plain.example.org')).toBeTruthy()
  })

  it('the WebRow expands to the fetch card, titled Fetch', () => {
    const view = render(<WebRow {...rowProps(settledFetch(), 'web_fetch')} />)
    expect(view.getByText('网页获取')).toBeTruthy()
    expect(view.container.querySelector('[data-web]')).toBeNull()
    toggleRow(view)
    // The url shows as the card's link; scope to the card.
    const card = view.container.querySelector('[data-web="fetch"]')
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/page')
    expect(view.getByText('HTTP 200')).toBeTruthy()
  })

  it('the collapsed WebRow summary opens the fetch URL in a new tab without expanding', () => {
    const view = render(<WebRow {...rowProps(settledFetch(), 'web_fetch')} />)
    const link = view.getByRole('link', { name: 'https://example.com/page' })
    expect(link.getAttribute('href')).toBe('https://example.com/page')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    // jsdom does not implement navigation; cancel it after the row's handlers run.
    link.addEventListener('click', (event) => { event.preventDefault() })
    fireEvent.click(link)
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(view.container.querySelector('[data-web]')).toBeNull()
  })

  it('a failed web fetch keeps its plain error summary', () => {
    const view = render(<WebRow {...rowProps(settledFetch({ isError: true }), 'web_fetch')} />)
    expect(view.queryByRole('link')).toBeNull()
  })

  it('a running web call is the summary row alone, with nothing to expand', () => {
    const view = render(<WebRow {...rowProps(runningSearch(), 'web_search')} />)
    expect(view.getByText('网页搜索')).toBeTruthy()
    expect(view.queryByText('Titled')).toBeNull()
    // No card material and no expandable body: clicking the row reveals nothing.
    expect(view.container.querySelector('[data-expandable]')).toBeNull()
    expect(view.container.querySelector('[data-web]')).toBeNull()
  })

  it('a failed web call keeps the summary row without the card', () => {
    const view = render(<WebRow {...rowProps(settledSearch({
      isError: true,
    }), 'web_search')} />)
    expect(view.getByText('网页搜索')).toBeTruthy()
    expect(view.container.querySelector('[data-web]')).toBeNull()
    // The row reflects the error state so the summary line still reads as failed.
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="error"] svg')).not.toBeNull()
  })

  it('the GenericToolCard fallback does not promote an unknown tool from metadata alone', () => {
    const view = render(<GenericToolCard {...ownerProps(settledSearch({
      call: { name: 'fx-web', argsRaw: SEARCH_ARGS },
    }), 'fx-web')} t={t} />)
    toggleRow(view)
    expect(view.container.querySelector('[data-web]')).toBeNull()
    expect(view.getByText('search text')).toBeTruthy()
  })

  it('the GenericToolCard fallback keeps the plain row for a non-web call', () => {
    const view = render(<GenericToolCard {...ownerProps(settledSearch({
      call: { name: 'echo', argsRaw: '{}' },
      meta: undefined,
    }), 'echo')} t={t} />)
    expect(view.container.querySelector('[data-web]')).toBeNull()
  })
})

describe('web toolview registration', () => {
  it('registers one WebRow under both web_search and web_fetch', () => {
    const registered: { key: string; locale: unknown; component: unknown }[] = []
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => Iterable<() => void>) => {
          for (const _dispose of callback()) { /* exhaust transactional setup */ }
          return () => undefined
        },
        register: (options: { name: string; key: string; locale?: string }, component: unknown) => {
          registered.push({ key: options.key, locale: options.locale, component })
          return () => {}
        },
      },
    } as unknown as import('@deepseek-ai/cordis').Context
    webToolview.apply(ctx)
    expect(registered.map(r => r.key)).toEqual(['web_search', 'web_fetch'])
    // Both keys claim the conversation locale seat ToolRow's body copy needs.
    expect(registered.map(r => r.locale)).toEqual(['conversation', 'conversation'])
    // One component under both keys, not two thin rows.
    expect(registered[0]?.component).toBe(WebRow)
    expect(registered[1]?.component).toBe(WebRow)
    expect(webToolview.inject).toEqual(['slots'])
  })
})
