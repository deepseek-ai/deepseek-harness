// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CHAT_SEARCH_MAX_LINES, searchCardModel } from '../src/client/tool/models/search-card-model.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { SearchRow, searchToolview } from '../src/client/tool/toolviews/search-row.tsx'

type SearchRowProps = Parameters<typeof SearchRow>[0]

afterEach(cleanup)

const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)

/** The rendered search card's kind attribute, so a render site cannot silently drop it. */
function searchKindOf(container: HTMLElement): string | null {
  return container.querySelector('[data-search]')?.getAttribute('data-search') ?? null
}

/** The rendered result rows of the search card, one string per visible row. */
function searchRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-search] [class^="_line_"]')].map(row => row.textContent ?? '')
}

const SID = 's1' as SessionId

const GREP_ARGS = '{"pattern":"foo","path":"src"}'
const GLOB_ARGS = '{"pattern":"**/*.ts","path":"src"}'

interface MatchesMeta {
  shape: 'matches'
  files: { path: string; matches: { lineNumber: number; line: string }[] }[]
  truncated: boolean
  total: number
}

interface PathsMeta {
  shape: 'paths'
  paths: string[]
  truncated: boolean
  total: number
}

/** Persisted grep metadata: matches grouped by file. */
const matchesMeta = (over?: Partial<MatchesMeta>): MatchesMeta => ({
  shape: 'matches',
  files: [
    { path: 'a.ts', matches: [{ lineNumber: 12, line: 'const foo = 1' }, { lineNumber: 40, line: 'return foo' }] },
    { path: 'b.ts', matches: [{ lineNumber: 7, line: 'foo()' }] },
  ],
  truncated: false, total: 3, ...over,
})

/** Persisted glob metadata: a flat path list. */
const pathsMeta = (over?: Partial<PathsMeta>): PathsMeta => ({
  shape: 'paths', paths: ['src/a.ts', 'src/b.ts'], truncated: false, total: 2, ...over,
})

const runningGrep = (over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'grep', argsRaw: GREP_ARGS,
  turn: 1, step: 1, time: 1_000, subCalls: [], ...over,
})

const settledGrep = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'grep', argsRaw: GREP_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'a.ts\n  Line 12: const foo = 1' }], isError: false,
  meta: matchesMeta(), subCalls: [], ...over,
})

const settledGlob = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 11, time: 2_000, callId: 'c2',
  call: { name: 'glob', argsRaw: GLOB_ARGS },
  callTime: 1_000,
  content: [{ type: 'text', text: 'src/a.ts\nsrc/b.ts' }], isError: false,
  meta: pathsMeta(), subCalls: [], ...over,
})

describe('searchCardModel', () => {
  it('derives a matches card from grep result metadata', () => {
    expect(searchCardModel(settledGrep())).toEqual({
      recovery: undefined,
      card: {
        kind: 'matches',
        files: [
          { path: 'a.ts', matches: [{ lineNumber: 12, line: 'const foo = 1' }, { lineNumber: 40, line: 'return foo' }] },
          { path: 'b.ts', matches: [{ lineNumber: 7, line: 'foo()' }] },
        ],
        truncated: false, total: 3,
      },
    })
  })

  it('derives a paths card from glob result metadata, carrying the truncation signal', () => {
    // Empty block content isolates the truncation signal from the recovery arm.
    expect(searchCardModel(settledGlob({ content: [], meta: pathsMeta({ truncated: true, total: 20 }) }))).toEqual({
      recovery: undefined,
      card: { kind: 'paths', paths: ['src/a.ts', 'src/b.ts'], truncated: true, total: 20 },
    })
  })

  it('returns null for running, missing calls, errors, malformed args, unrelated tools, and children', () => {
    expect(searchCardModel(runningGrep())).toBeNull()
    expect(searchCardModel(settledGrep({ call: null }))).toBeNull()
    expect(searchCardModel(settledGrep({ isError: true }))).toBeNull()
    expect(searchCardModel(settledGrep({ call: { name: 'grep', argsRaw: '{' } }))).toBeNull()
    expect(searchCardModel(settledGrep({ call: { name: 'echo', argsRaw: '{}' } }))).toBeNull()
    expect(searchCardModel(settledGrep({ parentCallId: 'parent' }))).toBeNull()
  })

  it('returns null for metadata whose shape does not match the tool', () => {
    expect(searchCardModel(settledGrep({ meta: { shape: 'future', truncated: false, total: 0 } }))).toBeNull()
    expect(searchCardModel(settledGrep({ meta: pathsMeta() }))).toBeNull()
    expect(searchCardModel(settledGlob({ meta: matchesMeta() }))).toBeNull()
  })

  it('validates declared search argument fields and accepts open-root extensions', () => {
    expect(searchCardModel(settledGrep({
      call: { name: 'grep', argsRaw: '{"pattern":"foo","include":7}' },
    }))).toBeNull()
    expect(searchCardModel(settledGrep({
      call: { name: 'grep', argsRaw: '{"pattern":"foo","include":"!*.ts"}' },
    }))).toBeNull()
    expect(searchCardModel(settledGlob({
      call: { name: 'glob', argsRaw: '{"pattern":"**/*.ts","path":7}' },
    }))).toBeNull()
    expect(searchCardModel(settledGrep({
      call: { name: 'grep', argsRaw: '{"pattern":"foo","extension":1}' },
    }))).not.toBeNull()
  })

  it('returns null for a known shape whose structured shape is missing or malformed', () => {
    const noFiles = { shape: 'matches', truncated: false, total: 0 }
    expect(searchCardModel(settledGrep({ meta: noFiles }))).toBeNull()
    const badFile = {
      shape: 'matches', truncated: false, total: 1,
      files: [{ path: 'a.ts', matches: [{ lineNumber: 'x', line: 1 }] }],
    }
    expect(searchCardModel(settledGrep({ meta: badFile }))).toBeNull()
    const noPaths = { shape: 'paths', truncated: false, total: 0 }
    expect(searchCardModel(settledGlob({ meta: noPaths }))).toBeNull()
    const badPaths = {
      shape: 'paths', truncated: false, total: 1, paths: [42],
    }
    expect(searchCardModel(settledGlob({ meta: badPaths }))).toBeNull()
  })

  it('surfaces the recovery text only when the result was capped', () => {
    const recovery = 'a.ts\n  12: const foo = 1\n\n(Full grep result stored at: spill://grep-1. Read it to see every match.)'
    // The recovery locator lives in raw tool/result content and is surfaced only
    // when metadata says the card was capped.
    const capped = searchCardModel(settledGrep({
      content: [{ type: 'text', text: recovery }],
      meta: matchesMeta({ truncated: true, total: 42 }),
    }))
    expect(capped?.recovery).toBe(recovery)
    // Not capped: the card holds every match, so the raw content adds nothing and
    // is dropped.
    const whole = searchCardModel(settledGrep({
      content: [{ type: 'text', text: recovery }],
      meta: matchesMeta({ truncated: false }),
    }))
    expect(whole?.recovery).toBeUndefined()
    // Capped but the block carries no text: nothing to surface.
    const noText = searchCardModel(settledGrep({ content: [], meta: matchesMeta({ truncated: true, total: 42 }) }))
    expect(noText?.recovery).toBeUndefined()
  })
})

describe('chat row search body (GenericToolCard fallback)', () => {
  const ownerProps = (block: RunningToolCall | ToolResultNode, toolName: string): GenericToolCardProps => ({
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    callId: 'c1', toolName, block, openFile: vi.fn(), t,
  })
  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('the expanded body is the grouped matches, capped tighter than the panel', () => {
    expect(CHAT_SEARCH_MAX_LINES).toBeLessThan(16)
    const view = render(<GenericToolCard {...ownerProps(settledGrep(), 'grep')} />)
    // Collapsed: the one-line summary row only, no card.
    expect(view.queryByText(/const foo = 1/)).toBeNull()
    toggleRow(view)
    expect(searchRows(view.container)).toContain('12: const foo = 1')
    expect(view.getByText('a.ts')).toBeTruthy()
    expect(searchKindOf(view.container)).toBe('matches')
    // The args JSON body the generic path would have shown is gone.
    expect(view.queryByText(/"pattern"/)).toBeNull()
  })

  it('the glob fallback expands to the flat path card', () => {
    const view = render(<GenericToolCard {...ownerProps(settledGlob(), 'glob')} />)
    toggleRow(view)
    expect(view.getByText('src/a.ts')).toBeTruthy()
    expect(searchKindOf(view.container)).toBe('paths')
  })

  it('a non-search result keeps the args-JSON text body', () => {
    const view = render(<GenericToolCard {...ownerProps(settledGrep({
      meta: undefined,
    }), 'grep')} />)
    toggleRow(view)
    expect(view.getByText(/"pattern"/)).toBeTruthy()
    expect(searchKindOf(view.container)).toBeNull()
  })

  it('the expanded body shows the recovery footer below a capped card', () => {
    const recovery = 'a.ts\n  12: const foo = 1\n\n(Full grep result stored at: spill://grep-1. Read it to see every match.)'
    const view = render(<GenericToolCard {...ownerProps(settledGrep({
      content: [{ type: 'text', text: recovery }],
      meta: matchesMeta({ truncated: true, total: 42 }),
    }), 'grep')} />)
    toggleRow(view)
    expect(searchKindOf(view.container)).toBe('matches')
    expect(view.getByText(/Full grep result stored at: spill:\/\/grep-1/)).toBeTruthy()
  })
})

describe('SearchRow keyed card', () => {
  const rowProps = (block: RunningToolCall | ToolResultNode, toolName: string): SearchRowProps => ({
    callId: 'c1', toolName, block, openFile: vi.fn(), sessionId: SID, t,
  } as unknown as SearchRowProps)

  /** The whole summary row is the expand toggle (ToolRow's unified interaction). */
  const toggleRow = (view: { container: HTMLElement }) => {
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
  }

  it('collapses to the summary row; expanding reveals the grep card', () => {
    const view = render(<SearchRow {...rowProps(settledGrep(), 'grep')} />)
    expect(view.getByText('Grep')).toBeTruthy()
    expect(view.queryByText('Search')).toBeNull()
    // Collapsed: the card is not in the DOM until the row is expanded.
    expect(searchKindOf(view.container)).toBeNull()
    expect(view.queryByText(/const foo = 1/)).toBeNull()
    toggleRow(view)
    expect(searchRows(view.container)).toContain('12: const foo = 1')
    expect(searchKindOf(view.container)).toBe('matches')
    // The card's copy control lives inside the expanded body.
    expect(view.getByText('复制')).toBeTruthy()
  })

  it('expands to the glob path card', () => {
    const view = render(<SearchRow {...rowProps(settledGlob(), 'glob')} />)
    expect(view.getByText('Glob')).toBeTruthy()
    expect(view.queryByText('Search')).toBeNull()
    expect(searchKindOf(view.container)).toBeNull()
    toggleRow(view)
    expect(view.getByText('src/a.ts')).toBeTruthy()
    expect(searchKindOf(view.container)).toBe('paths')
  })

  it('agrees with the summary row about the run state', () => {
    const runningView = render(<SearchRow {...rowProps(runningGrep(), 'grep')} />)
    expect(runningView.container.querySelector('[data-variant="search"]')?.getAttribute('data-state')).toBe('running')
    // No result metadata yet, so no card even once material could expand.
    expect(searchKindOf(runningView.container)).toBeNull()
    cleanup()
    const errorView = render(<SearchRow {...rowProps(settledGrep({
      isError: true,
    }), 'grep')} />)
    expect(errorView.container.querySelector('[data-variant="search"]')?.getAttribute('data-state')).toBe('error')
  })

  it('surfaces the result text through the Output section when an errored search has no card', () => {
    // Failed search metadata cannot select a success card; the row keeps the
    // first error line collapsed and the full text once expanded.
    const view = render(<SearchRow {...rowProps(settledGrep({
      isError: true,
      content: [{ type: 'text', text: 'grep: invalid regular expression' }],
    }), 'grep')} />)
    expect(searchKindOf(view.container)).toBeNull()
    // Error state: the first line is the collapsed summary.
    expect(view.getByText('grep: invalid regular expression')).toBeTruthy()
    toggleRow(view)
    // Now in ToolRow's Output section too (the kept summary makes it appear twice).
    expect(view.container.querySelector('[data-error]')?.textContent).toBe('grep: invalid regular expression')
  })

  it('surfaces the result text for a settled non-error call with no card once expanded', () => {
    // Missing metadata keeps a successful result on ToolRow's raw Output path.
    const view = render(<SearchRow {...rowProps(settledGrep({
      isError: false, meta: undefined,
      content: [{ type: 'text', text: 'nested run_code output line' }],
    }), 'grep')} />)
    expect(view.container.querySelector('[data-variant="search"]')?.getAttribute('data-state')).toBe('ok')
    expect(searchKindOf(view.container)).toBeNull()
    // Collapsed: the ok row shows its args summary, not the output text.
    expect(view.queryByText('nested run_code output line')).toBeNull()
    toggleRow(view)
    expect(view.getByText('nested run_code output line')).toBeTruthy()
  })

  it('renders the recovery footer below the card when the search was capped', () => {
    const recovery = 'a.ts\n  12: const foo = 1\n\n(Full grep result stored at: spill://grep-1. Read it to see every match.)'
    const view = render(<SearchRow {...rowProps(settledGrep({
      content: [{ type: 'text', text: recovery }],
      meta: matchesMeta({ truncated: true, total: 42 }),
    }), 'grep')} />)
    toggleRow(view)
    expect(searchKindOf(view.container)).toBe('matches')
    expect(view.getByText(/Full grep result stored at: spill:\/\/grep-1/)).toBeTruthy()
  })

  it('shows no recovery footer for an uncapped search', () => {
    const view = render(<SearchRow {...rowProps(settledGrep(), 'grep')} />)
    toggleRow(view)
    expect(searchKindOf(view.container)).toBe('matches')
    expect(view.container.textContent).not.toMatch(/stored at/)
  })

  it('falls back to the error name/code when an errored result has no text block', () => {
    const view = render(<SearchRow {...rowProps(settledGrep({
      isError: true, content: [],
      error: { name: 'ToolError', code: 'timeout' },
    }), 'grep')} />)
    // Error state: the derived name/code line is the collapsed summary.
    expect(view.getByText('ToolError: timeout')).toBeTruthy()
  })

  it('keeps the args-derived summary beside the metadata-derived card', () => {
    const view = render(<SearchRow {...rowProps(settledGrep(), 'grep')} />)
    expect(view.getByText('foo')).toBeTruthy()
  })

  it('registers the one row component under both grep and glob keys', () => {
    const registered: { key: unknown; locale: unknown; component: unknown }[] = []
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => Iterable<() => void>) => {
          for (const _dispose of callback()) { /* exhaust transactional setup */ }
          return () => undefined
        },
        register: (options: { name: string; key: string; locale?: string }, component: unknown) => {
          registered.push({ key: options.key, locale: options.locale, component })
          return () => undefined
        },
      },
    } as never
    searchToolview.apply(ctx)
    expect(registered.map(r => r.key)).toEqual(['grep', 'glob'])
    // Both keys claim the conversation locale seat ToolRow's body copy needs.
    expect(registered.map(r => r.locale)).toEqual(['conversation', 'conversation'])
    // One component, two keys.
    expect(registered[0]!.component).toBe(SearchRow)
    expect(registered[1]!.component).toBe(SearchRow)
    expect(searchToolview.inject).toEqual(['slots'])
  })
})
