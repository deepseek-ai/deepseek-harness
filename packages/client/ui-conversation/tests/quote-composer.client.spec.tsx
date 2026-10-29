// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import {
  KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND, REDO_COMMAND, UNDO_COMMAND,
  $getRoot, $getSelection, $isRangeSelection, $nodesOfType,
} from 'lexical'
import type { DraftSnapshot } from '../src/client/contract/draft-editor.ts'
import type { SubmitOutcome } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import {
  QuoteNode, QuoteNodeView, REMOVE_QUOTE_COMMAND,
} from '../src/client/input/editor/QuoteNode.tsx'
import { $selectDetectSpan } from '../src/client/input/editor/span-map.ts'

const quote = 'selected source text'

function bench(quoteInsertionAllowed?: () => boolean) {
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const shell = new SessionInputShell({
    actx: {} as Context,
    defaultSink: sink,
    commandAttachments: {
      serialize: () => Promise.resolve([]),
      release: () => {},
      unsupportedNotice: () => 'unsupported',
    },
    quoteRemoveLabel: () => 'Remove quote',
    ...(quoteInsertionAllowed === undefined ? {} : { quoteInsertionAllowed }),
  })
  return { shell, sink }
}

function quoteKeys(shell: SessionInputShell): string[] {
  return shell.editor.getEditorState().read(() => $nodesOfType(QuoteNode).map(node => node.getKey()))
}

describe('QuoteNode composer lifecycle', () => {
  it('preserves the draft when its Session cannot accept an inserted quote', () => {
    let allowed = false
    const { shell } = bench(() => allowed)
    shell.setDraft('base ')
    const before = shell.draftSnapshot
    expect(shell.insertQuote(quote)).toBe(false)
    expect(shell.draftSnapshot).toBe(before)
    allowed = true
    expect(shell.insertQuote(quote)).toBe(true)
  })

  it('renders quote text as a non-interactive container and keeps close accessible', () => {
    const dispatchCommand = vi.fn((_command: unknown, _payload: unknown) => true)
    const parentKeyDown = vi.fn()
    const editor = { dispatchCommand } as never
    const view = render(
      <div onKeyDown={parentKeyDown}>
        <QuoteNodeView
          editor={editor}
          nodeKey={'quote-key'}
          text={quote}
          labels={{ remove: 'Remove quote' }}
        />
      </div>,
    )
    const text = view.container.querySelector<HTMLElement>('[data-quote-preview]')!
    expect(text.getAttribute('role')).toBeNull()
    expect(text.getAttribute('tabindex')).toBeNull()
    expect(text.getAttribute('title')).toBeNull()
    fireEvent.click(text)
    expect(dispatchCommand).not.toHaveBeenCalled()
    fireEvent.keyDown(view.getByRole('button', { name: 'Remove quote' }), { key: 'Enter' })
    expect(parentKeyDown).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Remove quote' }))
    expect(dispatchCommand).toHaveBeenCalledWith(REMOVE_QUOTE_COMMAND, 'quote-key')
    expect(view.queryByRole('link')).toBeNull()
  })

  it('persists through DraftSnapshot restore as an atomic quote', () => {
    const first = bench().shell
    const mirrored: DraftSnapshot[] = []
    first.bindDraftPersistence((document) => { mirrored.push(document) })
    expect(first.insertQuote(quote)).toBe(true)
    const persisted = mirrored.at(-1)
    expect(persisted).toEqual({ text: '> selected source text ', references: [], quotes: [{ offset: 0, length: 22, text: quote }] })

    const restored = bench().shell
    restored.setDraft(persisted as DraftSnapshot)
    restored.editor.getEditorState().read(() => {
      const [node] = $nodesOfType(QuoteNode)
      expect(node?.getQuoteText()).toBe(quote)
      expect(node?.isKeyboardSelectable()).toBe(false)
      expect(node?.createDOM({ namespace: 'quote', theme: {} }).getAttribute('contenteditable')).toBe('false')
    })
  })

  it('treats insert, close removal, Backspace, undo, and redo as whole-node operations', async () => {
    const direct = bench().shell
    direct.insertQuote(quote)
    expect(direct.editor.dispatchCommand(
      KEY_BACKSPACE_COMMAND,
      new KeyboardEvent('keydown', { key: 'Backspace' }),
    )).toBe(true)
    await vi.waitFor(() => { expect(quoteKeys(direct)).toHaveLength(0) })
    expect(direct.snapshot.draft).toBe('')
    direct.editor.dispatchCommand(UNDO_COMMAND, undefined)
    await vi.waitFor(() => { expect(quoteKeys(direct)).toHaveLength(1) })

    const { shell } = bench()
    shell.setDraft('base ')
    shell.insertQuote(quote)
    expect(quoteKeys(shell)).toHaveLength(1)
    await Promise.resolve()
    shell.editor.dispatchCommand(UNDO_COMMAND, undefined)
    await vi.waitFor(() => { expect(quoteKeys(shell)).toHaveLength(0) })
    shell.editor.dispatchCommand(REDO_COMMAND, undefined)
    await vi.waitFor(() => { expect(quoteKeys(shell)).toHaveLength(1) })

    const [key] = quoteKeys(shell)
    shell.editor.update(() => {
      expect($selectDetectSpan({ start: 6, end: 6 })).toBe(true)
    }, { discrete: true })
    expect(shell.editor.dispatchCommand(
      KEY_BACKSPACE_COMMAND,
      new KeyboardEvent('keydown', { key: 'Backspace' }),
    )).toBe(true)
    await vi.waitFor(() => { expect(quoteKeys(shell)).toHaveLength(0) })
    shell.editor.dispatchCommand(UNDO_COMMAND, undefined)
    await vi.waitFor(() => { expect(quoteKeys(shell)).toHaveLength(1) })
    shell.editor.update(() => {
      expect($selectDetectSpan({ start: 5, end: 5 })).toBe(true)
    }, { discrete: true })
    expect(shell.editor.dispatchCommand(
      KEY_DELETE_COMMAND,
      new KeyboardEvent('keydown', { key: 'Delete' }),
    )).toBe(true)
    await vi.waitFor(() => { expect(quoteKeys(shell)).toHaveLength(0) })
    shell.editor.dispatchCommand(UNDO_COMMAND, undefined)
    await vi.waitFor(() => { expect(quoteKeys(shell)).toHaveLength(1) })
    shell.editor.dispatchCommand(REMOVE_QUOTE_COMMAND, key!)
    await vi.waitFor(() => { expect(quoteKeys(shell)).toHaveLength(0) })
    expect(shell.snapshot.draft).toBe('base ')
    shell.editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection) && selection.isCollapsed()).toBe(true)
    })

    const empty = bench().shell
    empty.insertQuote(quote)
    const [emptyKey] = quoteKeys(empty)
    empty.editor.dispatchCommand(REMOVE_QUOTE_COMMAND, emptyKey!)
    await vi.waitFor(() => { expect(quoteKeys(empty)).toHaveLength(0) })
    expect(empty.snapshot.draft).toBe('')
  })

  it('sends selected quotes as ordinary Markdown text', async () => {
    const { shell, sink } = bench()
    shell.insertQuote(quote)
    shell.paste('answer')
    shell.submit('queue')
    expect(sink).toHaveBeenCalledWith(
      '> selected source text\n\nanswer', [], 'queue', expect.any(AbortSignal), expect.any(Function),
    )
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('') })
    shell.editor.getEditorState().read(() => { expect($getRoot().getTextContent()).toBe('') })
  })

  it('keeps adjacent quotes separated in model text', () => {
    const { shell, sink } = bench()
    shell.insertQuote('first')
    shell.insertQuote('second')
    shell.submit('queue')
    expect(sink).toHaveBeenCalledWith('> first\n\n> second', [], 'queue', expect.any(AbortSignal), expect.any(Function))
  })

  it('keeps the complete rich document in the editor when a send fails', async () => {
    let settle!: (outcome: { kind: 'error'; text: string }) => void
    const { shell, sink } = bench()
    sink.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    shell.insertQuote(quote)
    shell.paste('answer')
    const submitted = shell.draftSnapshot

    shell.submit('queue')
    expect(shell.snapshot.phase).toBe('sending')
    expect(shell.draftSnapshot).toEqual(submitted)
    settle({ kind: 'error', text: 'retry' })

    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.draftSnapshot).toEqual(submitted)
    expect(quoteKeys(shell)).toHaveLength(1)
    expect(shell.notices.getSnapshot()).toMatchObject({ level: 'error', text: 'retry' })
  })

  it('mirrors the cleared draft through the Session lifetime once the Host accepts it', async () => {
    let settle!: (outcome: { kind: 'success' }) => void
    const { shell, sink } = bench()
    sink.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    const mirrored: DraftSnapshot[] = []
    shell.bindDraftPersistence((document) => { mirrored.push(document) })
    shell.insertQuote(quote)
    const submitted = shell.draftSnapshot
    shell.submit('queue')
    expect(mirrored.at(-1)).toEqual(submitted)
    settle({ kind: 'success' })
    await vi.waitFor(() => { expect(mirrored.at(-1)).toEqual({ text: '', references: [] }) })
  })
})
