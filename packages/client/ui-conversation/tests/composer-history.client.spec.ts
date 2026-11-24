// @vitest-environment jsdom
/** Prompt recall from the loaded Session history through the real input shell and the composer keymap. */
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { fireEvent } from '@testing-library/react'
import {
  $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, CLEAR_HISTORY_COMMAND, createEditor, KEY_ARROW_UP_COMMAND,
  UNDO_COMMAND,
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CommandClaim, InputTriggerController, SubmitOutcome } from '../src/client/contract/input.ts'
import { registerComposerKeymap } from '../src/client/input/editor/keymap.ts'
import { installDraftKeymap } from '../src/client/input/editor/view-binding.ts'
import { SessionInputShell, type SessionInputDeps } from '../src/client/input/facade.ts'

/** A loaded event window; `prompt` appends one durable user message, newest last. */
function history() {
  const events = new MutableSessionEventSource()
  // Starts above zero so a test can prepend an older page.
  let seq = 10
  const message = (content: readonly ContentBlock[], source: MessageSource = { kind: 'user' }): void => {
    events.append({ type: 'event', event: {
      type: 'user/message', seq: SessionSeq(seq++), time: 0, surfaceOp: 'append',
      data: createUserMessage({ content: [...content], source }),
    } })
  }
  return { events, message, prompt: (text: string) => { message([{ type: 'text', text }]) } }
}

function makeShell(overrides: Partial<SessionInputDeps> = {}): SessionInputShell {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const shell = new SessionInputShell({
    actx: ctx,
    defaultSink: () => Promise.resolve<SubmitOutcome>({ kind: 'success' }),
    commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
    ...overrides,
  })
  onTestFinished(() => { shell.dispose() })
  return shell
}

function withPrompts(...prompts: readonly string[]) {
  const h = history()
  for (const text of prompts) h.prompt(text)
  return { ...h, shell: makeShell({ events: h.events }) }
}

function triggers(claim: CommandClaim): InputTriggerController {
  return {
    lexicon: createSnapshotStore(new Map()),
    launcher: createSnapshotStore<string | null>(null),
    track: () => {},
    arbitrate: () => 'pass',
    onSpace: () => false,
    serializeReference: (_source, ref) => Promise.resolve(ref),
    adjudicate: () => Promise.resolve(undefined),
    resolveClaim: () => Promise.resolve(claim),
    openReference: () => false,
    toggleSource: () => {},
  }
}

async function undo(shell: SessionInputShell): Promise<string> {
  shell.editor.dispatchCommand(UNDO_COMMAND, undefined)
  await setImmediate()
  return shell.snapshot.draft
}

describe('loaded prompt recall', () => {
  it('steps through loaded prompts from an empty draft and returns to it past the newest', () => {
    const { shell } = withPrompts('first', 'second')
    expect(shell.recallHistory('newer')).toBe(false)
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('second')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('first')
    expect(shell.recallHistory('older')).toBe(false)
    expect(shell.recallHistory('newer')).toBe(true)
    expect(shell.snapshot.draft).toBe('second')
    expect(shell.recallHistory('newer')).toBe(true)
    expect(shell.snapshot.draft).toBe('')
    expect(shell.recallHistory('newer')).toBe(false)
  })

  it('recalls nothing without an event window or loaded prompts', () => {
    expect(makeShell().recallHistory('older')).toBe(false)
    expect(withPrompts().shell.recallHistory('older')).toBe(false)
  })

  it('never replaces typed text', () => {
    const { shell } = withPrompts('sent')
    shell.setDraft('typed')
    expect(shell.recallHistory('older')).toBe(false)
    expect(shell.snapshot.draft).toBe('typed')
  })

  it('ends browsing once a recalled prompt is edited', () => {
    const { shell } = withPrompts('first', 'second')
    expect(shell.recallHistory('older')).toBe(true)
    shell.paste(' edited')
    expect(shell.recallHistory('older')).toBe(false)
    expect(shell.recallHistory('newer')).toBe(false)
    expect(shell.snapshot.draft).toBe('second edited')
    shell.setDraft('')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('second')
  })

  it('ends browsing when the draft is replaced programmatically', () => {
    const { shell } = withPrompts('sent')
    expect(shell.recallHistory('older')).toBe(true)
    shell.setDraft('replacement')
    expect(shell.recallHistory('newer')).toBe(false)
    expect(shell.snapshot.draft).toBe('replacement')
  })

  it('undoes each step as an ordinary edit, back to the empty draft', async () => {
    const { shell } = withPrompts('first', 'second')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.recallHistory('older')).toBe(true)
    shell.paste(' edited')
    expect(await undo(shell)).toBe('first')
    expect(shell.recallHistory('newer')).toBe(false)
    expect(await undo(shell)).toBe('second')
    expect(await undo(shell)).toBe('')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('second')
  })

  it('keeps an undo target after a submission cut the history', async () => {
    const h = history()
    const shell = makeShell({ events: h.events })
    shell.setDraft('sent')
    shell.submit()
    await setImmediate()
    h.prompt('sent')
    expect(shell.snapshot.draft).toBe('')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('sent')
    expect(await undo(shell)).toBe('')
  })

  it('undoes the first step to the existing empty paragraph after the history was cut', async () => {
    const { shell } = withPrompts('sent')
    shell.setDraft('draft')
    shell.setDraft('')
    shell.editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
    expect(shell.recallHistory('older')).toBe(true)
    expect(await undo(shell)).toBe('')
  })

  it('recalls only human prompts with text, as plain text, and folds consecutive repeats', () => {
    const h = history()
    h.prompt('older')
    h.prompt('again')
    h.prompt('again')
    h.message([{ type: 'text', text: 'injected context' }], { kind: 'retry' } as MessageSource)
    h.message([{ type: 'text', text: '' }])
    h.message([{ type: 'text', text: 'see ' }, { type: 'reasoning', text: 'not prompt text ' }, { type: 'text', text: '@src/a.ts' }])
    const shell = makeShell({ events: h.events })
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('see @src/a.ts')
    expect(shell.snapshot.occurrences).toHaveLength(0)
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('again')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('older')
    expect(shell.recallHistory('older')).toBe(false)
  })

  it('keeps its place when a prompt is appended or an older page loads while browsing', () => {
    const h = history()
    h.prompt('A')
    h.prompt('B')
    const shell = makeShell({ events: h.events })
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('B')
    h.prompt('C')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('A')
    expect(shell.recallHistory('newer')).toBe(true)
    expect(shell.snapshot.draft).toBe('B')
    expect(shell.recallHistory('newer')).toBe(true)
    expect(shell.snapshot.draft).toBe('C')
    h.events.prepend([{ type: 'event', event: {
      type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'older page' }], source: { kind: 'user' } }),
    } }], false)
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('B')
  })

  it('stays on a folded repeat when its newest copy is appended while browsing', () => {
    const h = history()
    h.prompt('A')
    h.prompt('B')
    const shell = makeShell({ events: h.events })
    expect(shell.recallHistory('older')).toBe(true)
    h.prompt('B')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('A')
  })

  it('stops browsing when the shown prompt left the window', () => {
    const h = history()
    h.prompt('A')
    const shell = makeShell({ events: h.events })
    expect(shell.recallHistory('older')).toBe(true)
    h.events.replace([], false)
    expect(shell.recallHistory('older')).toBe(false)
    expect(shell.snapshot.draft).toBe('A')
  })

  it('reads the window as it is when the arrow arrives', () => {
    const h = history()
    const shell = makeShell({ events: h.events })
    expect(shell.recallHistory('older')).toBe(false)
    h.prompt('arrived later')
    expect(shell.recallHistory('older')).toBe(true)
    expect(shell.snapshot.draft).toBe('arrived later')
  })

  it('replaces a claimed command draft and cancels its pending chip restore', async () => {
    const claim: CommandClaim = { name: 'goal', token: '/goal ', submit: () => Promise.resolve({ kind: 'success' }) }
    const pending = Promise.withResolvers<CommandClaim | undefined>()
    const h = history()
    h.prompt('plain')
    const shell = makeShell({ events: h.events, inputTriggers: () => ({ ...triggers(claim), resolveClaim: () => pending.promise }) })
    shell.setDraft({ text: '', references: [], command: { token: '/goal ' } })
    expect(shell.recallHistory('older')).toBe(true)
    pending.resolve(claim)
    await setImmediate()
    expect(shell.draftSnapshot).toEqual({ text: 'plain', references: [] })
    expect(shell.snapshot.phase).toBe('plain')
  })

  it('recalls through the key command after its update commits', async () => {
    const { shell } = withPrompts('sent')
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.append(root)
    onTestFinished(() => { shell.editor.setRootElement(null); root.remove() })
    shell.editor.setRootElement(root)
    onTestFinished(registerComposerKeymap(shell.editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {}, recallHistory: direction => shell.recallHistory(direction),
      canSubmit: () => true, submit: () => {}, intakeFiles: () => {}, pasteText: () => {},
    }))
    window.getSelection()?.collapse(root.firstElementChild ?? root, 0)
    expect(fireEvent.keyDown(root, { key: 'ArrowUp' })).toBe(false)
    await setImmediate()
    expect(shell.snapshot.draft).toBe('sent')
  })

  it('refuses while a submission holds the draft and after disposal', async () => {
    let release: (outcome: SubmitOutcome) => void = () => {}
    const claim: CommandClaim = {
      name: 'goal', token: '/goal ',
      submit: () => new Promise<SubmitOutcome>((resolve) => { release = resolve }),
    }
    const { shell } = withPrompts('sent')
    shell.setDraft('/goal ')
    shell.beginCommand(claim, { start: 0, end: 6, draftRev: shell.snapshot.draftRev })
    shell.submit()
    expect(shell.snapshot.phase).toBe('submitting')
    expect(shell.recallHistory('older')).toBe(false)
    release({ kind: 'success' })
    await setImmediate()
    shell.dispose()
    expect(shell.recallHistory('older')).toBe(false)
  })
})

describe('history arrow routing', () => {
  function bench(...lines: readonly string[]) {
    const editor = createEditor({ namespace: 'history-arrows', onError: (error) => { throw error } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.append(root)
    onTestFinished(() => { editor.setRootElement(null); root.remove() })
    editor.setRootElement(root)
    onTestFinished(registerPlainText(editor))
    const recallHistory = vi.fn<(direction: 'older' | 'newer') => boolean>(() => true)
    const arbitrate = vi.fn((): 'consumed' | 'pass' => 'pass')
    onTestFinished(registerComposerKeymap(editor, {
      arbitrate, space: () => false, dismissPopup: () => {}, recallHistory,
      canSubmit: () => true, submit: () => {}, intakeFiles: () => {}, pasteText: () => {},
    }))
    editor.update(() => {
      for (const line of lines) {
        const paragraph = $createParagraphNode()
        for (const [index, part] of line.split('\n').entries()) {
          if (index > 0) paragraph.append($createLineBreakNode())
          if (part !== '') paragraph.append($createTextNode(part))
        }
        $getRoot().append(paragraph)
      }
    }, { discrete: true })
    /** Collapse the DOM caret at a child offset of one paragraph, or inside that child's text. */
    const caret = (line: number, offset = 0, child?: number): void => {
      const block = root.children.item(line)
      if (block === null) throw new Error(`missing line ${String(line)}`)
      const text = child === undefined ? undefined : block.childNodes.item(child)?.firstChild
      if (child !== undefined && (text === undefined || text === null)) throw new Error(`missing text ${String(child)}`)
      window.getSelection()?.collapse(text ?? block, offset)
    }
    const key = (name: 'ArrowUp' | 'ArrowDown', init: KeyboardEventInit = {}): boolean =>
      fireEvent.keyDown(root, { key: name, ...init })
    return { root, recallHistory, arbitrate, caret, key }
  }

  it('recalls on unmodified arrows the menu passes and consumes the key', () => {
    const b = bench('draft')
    b.caret(0, 5, 0)
    expect(b.key('ArrowUp')).toBe(false)
    expect(b.recallHistory).toHaveBeenLastCalledWith('older')
    expect(b.key('ArrowDown')).toBe(false)
    expect(b.recallHistory).toHaveBeenLastCalledWith('newer')
    b.recallHistory.mockReturnValue(false)
    expect(b.key('ArrowUp')).toBe(true)
  })

  it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }])(
    'leaves %j arrows to the browser', (init) => {
      const b = bench('draft')
      b.caret(0, 5, 0)
      expect(b.key('ArrowUp', init)).toBe(true)
      expect(b.recallHistory).not.toHaveBeenCalled()
    },
  )

  it('lets an open menu consume the arrow first', () => {
    const b = bench('draft')
    b.caret(0, 5, 0)
    b.arbitrate.mockReturnValue('consumed')
    expect(b.key('ArrowUp')).toBe(false)
    expect(b.recallHistory).not.toHaveBeenCalled()
  })

  it('recalls only with a collapsed caret at the draft end', () => {
    const b = bench('top', '', 'bottom')
    b.caret(0, 0, 0)
    expect(b.key('ArrowUp')).toBe(true)
    b.caret(1)
    expect(b.key('ArrowDown')).toBe(true)
    b.caret(2, 3, 0)
    expect(b.key('ArrowUp')).toBe(true)
    b.caret(2, 0, 0)
    window.getSelection()?.extend(window.getSelection()?.anchorNode ?? b.root, 6)
    expect(b.key('ArrowUp')).toBe(true)
    expect(b.recallHistory).not.toHaveBeenCalled()
    b.caret(2, 6, 0)
    expect(b.key('ArrowUp')).toBe(false)
    expect(b.key('ArrowDown')).toBe(false)
    expect(b.recallHistory).toHaveBeenCalledTimes(2)
  })

  it('treats the end after typed line breaks as the draft end', () => {
    const b = bench('a\n\nb')
    // Children: text a, <br>, <br>, text b.
    b.caret(0, 2)
    expect(b.key('ArrowUp')).toBe(true)
    b.caret(0, 1, 3)
    expect(b.key('ArrowUp')).toBe(false)
    expect(b.recallHistory).toHaveBeenCalledOnce()
  })

  it('treats an empty draft as at its end and a missing or outside selection as not', () => {
    const b = bench('')
    b.caret(0)
    expect(b.key('ArrowUp')).toBe(false)
    window.getSelection()?.removeAllRanges()
    expect(b.key('ArrowDown')).toBe(true)
    const outside = document.createElement('span')
    document.body.append(outside)
    onTestFinished(() => { outside.remove() })
    window.getSelection()?.collapse(outside, 0)
    expect(b.key('ArrowDown')).toBe(true)
    expect(b.recallHistory).toHaveBeenCalledOnce()
  })

  it('does not recall without a mounted root to read the caret from', () => {
    const b = bench('draft')
    b.caret(0, 5, 0)
    const editor = createEditor({ namespace: 'detached', onError: (error) => { throw error } })
    const recallHistory = vi.fn(() => true)
    onTestFinished(registerComposerKeymap(editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {}, recallHistory,
      canSubmit: () => true, submit: () => {}, intakeFiles: () => {}, pasteText: () => {},
    }))
    editor.update(() => { $getRoot().append($createParagraphNode()) }, { discrete: true })
    expect(editor.dispatchCommand(KEY_ARROW_UP_COMMAND, new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe(false)
    expect(recallHistory).not.toHaveBeenCalled()
  })

  it.each([
    { locked: true, machineBusy: false, recalls: false },
    { locked: false, machineBusy: true, recalls: false },
    { locked: false, machineBusy: false, recalls: true },
  ])(
    'the view gate passes recall through only when open: %j', ({ recalls, ...gate }) => {
      const editor = createEditor({ namespace: 'gated', onError: (error) => { throw error } })
      const root = document.createElement('div')
      root.contentEditable = 'true'
      document.body.append(root)
      onTestFinished(() => { editor.setRootElement(null); root.remove() })
      editor.setRootElement(root)
      onTestFinished(registerPlainText(editor))
      const shell = makeShell()
      const recallHistory = vi.spyOn(shell, 'recallHistory')
      onTestFinished(installDraftKeymap(editor, shell, {
        current: {
          ...gate, canSteerQueue: false, running: false, steeringAvailable: false, busyEnter: 'queue',
          intakeFiles: () => {}, uploadsPending: false, uploadsHeldText: '', showToast: () => {}, canAcceptDrop: false,
        },
      }))
      window.getSelection()?.collapse(root.firstElementChild ?? root, 0)
      expect(fireEvent.keyDown(root, { key: 'ArrowUp' })).toBe(true)
      expect(recallHistory).toHaveBeenCalledTimes(recalls ? 1 : 0)
    },
  )
})
