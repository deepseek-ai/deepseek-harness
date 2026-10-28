// @vitest-environment jsdom
/**
 * Scenario-chain integration (scenarios A/C/D/H/I): the real per-session
 * InputTriggerController pipeline over a real session scope (Client Sessions over
 * a listed host session) + a command source implementing the decision
 * table's relevant cells + the real SessionInput machine (scoped-event
 * listeners wired the way the hub does) + the real InputBar. ui-commands
 * itself is not a dependency of this package; the source below is the
 * decision-table contract at the `InputTriggerSource` boundary.
 */
import './control-row-dom.ts'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  $createTextNode, $getRoot, $isElementNode, BEFORE_INPUT_COMMAND, COMMAND_PRIORITY_LOW, DELETE_CHARACTER_COMMAND,
  UNDO_COMMAND,
} from 'lexical'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  ClientSessionContext, SubmitEnvelope,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {
  CommandClaim, PickOutcome, SubmitAttachment, SubmitOutcome,
} from '../src/client/contract/input.ts'
import {
  allowAllAccess, bindSnapshotSelector, conversationSnapshot, makeTranslate, sessionSnapshot, SlotTestRuntime,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { $replaceDetectSpanWithText } from '../src/client/input/editor/span-map.ts'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import { zh } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

// jsdom implements no Range geometry (Lexical's scroll-into-view measures the
// caret with one once the surface is genuinely contenteditable).
Range.prototype.getBoundingClientRect = () => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}),
})


afterEach(cleanup)

/** Directory row driving kind derivation (input? = leadingInput, else execute). */
interface FakeCommand {
  name: string
  description: string
  input?: { hint: string; attachments?: boolean }
}

/** Decision-table source over an in-memory directory (menu/space/enter columns for leadingInput + execute). */
function commandSource(
  commands: FakeCommand[],
  execute: (line: string, images?: readonly SubmitAttachment[]) => Promise<SubmitOutcome>,
) {
  const resolve = (name: string): FakeCommand | undefined => commands.find(c => c.name === name)
  const leadingClaim = (desc: FakeCommand): CommandClaim => ({
    name: desc.name,
    token: `/${desc.name} `,
    ...(desc.input !== undefined ? { hint: desc.input.hint } : {}),
    ...(desc.input?.attachments === true ? { attachments: true } : {}),
    submit: (args, _actx, images) => execute(`/${desc.name} ${args}`, images),
  })
  const executed: string[] = []
  const envelopes: SubmitEnvelope[] = []
  return {
    executed,
    envelopes,
    source: {
      trigger: '/' as const,
      name: 'command',
      candidates: (_session: ClientSessionContext, req: { query: string; position: string }) =>
        Promise.resolve(commands
          .filter(c => c.name.startsWith(req.query))
          .filter(c => req.position === 'leading' || c.input === undefined)
          .map(c => ({ name: c.name, description: c.description, ...(c.input !== undefined ? { hint: c.input.hint } : {}) }))),
      onPick: (pick: { candidate: { name: string } }): PickOutcome => {
        const desc = resolve(pick.candidate.name)
        if (desc === undefined) return undefined
        if (desc.input !== undefined) return { claim: leadingClaim(desc) }
        executed.push(`/${desc.name}`)
        void execute(`/${desc.name}`)
        return 'handled'
      },
      matchSpace: (_session: ClientSessionContext, token: string): PickOutcome => {
        const desc = resolve(token.slice(1))
        if (desc?.input === undefined) return undefined
        return { claim: leadingClaim(desc) }
      },
      matchEnter: (_session: ClientSessionContext, line: string, _signal: AbortSignal, envelope: SubmitEnvelope): Promise<PickOutcome> => {
        envelopes.push(envelope)
        const trimmed = line.trim()
        const ws = trimmed.search(/\s/)
        const token = ws === -1 ? trimmed : trimmed.slice(0, ws)
        const desc = resolve(token.slice(1))
        if (desc === undefined) return Promise.resolve(undefined)
        if (desc.input !== undefined) return Promise.resolve({ claim: leadingClaim(desc) })
        if (ws !== -1) return Promise.resolve(undefined) // execute with trailing → default sink
        executed.push(trimmed)
        void execute(trimmed)
        return Promise.resolve('handled')
      },
    },
  }
}

const COMMANDS: FakeCommand[] = [
  { name: 'goal', description: '设定目标', input: { hint: '目标内容' } },
  { name: 'compact', description: '压缩上下文' },
  { name: 'vision', description: '识别图片', input: { hint: '想问什么', attachments: true } },
]

const PNG: SubmitAttachment = { type: 'image', mediaType: 'image/png', data: 'AA==' }

/** Real scope bench: a Controller-owned Session scope + InputTriggerController + shell listeners. */
async function scopedBench(register?: (inputTriggers: InputTriggerService) => void) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const ctx = runtime.ctx
  const sessionId = 'scenario-s1' as SessionId
  await runtime.sessions.add({ id: sessionId, summary: { cwd: '/w/a' } })
  const reference = runtime.sessions.retain(sessionId)
  await reference.ready
  onTestFinished(() => { reference.release() })
  await ctx.plugin(InputTriggerService).await()
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
  register?.(inputTriggers)
  const actx = runtime.sessions.scope(sessionId)!
  const controller = inputTriggers.sessionOf(actx)
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const serialize = vi.fn((ids: readonly DraftAttachmentId[]) => Promise.resolve(ids.map(() => PNG)))
  const release = vi.fn()
  const shell = new SessionInputShell({ actx, inputTriggers: () => controller, defaultSink: sink, commandAttachments: { serialize, release, unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported` } })
  actx.effect(() => {
    shell.refreshLexiconSubscription()
    return () => { shell.dispose() }
  }, 'test input shell')
  // The hub's listener wiring, verbatim.
  actx.on('slash/input-begin-command', req => shell.beginCommand(req.claim, req.span) ? true : undefined)
  actx.on('slash/input-insert-reference', req => shell.insertReference(req.reference, req.span) ? true : undefined)
  actx.on('slash/input-consume-token', req => shell.consumeToken(req.guard) ? true : undefined)
  const wiring = shell
  const sessionStore = createSnapshotStore<SessionSnapshot>(sessionSnapshot(sessionId))
  const barProps: InputBarProps = {
    usePanelInfo: selector => selector({ activePanelId: null }),
    sessionId,
    SessionProvider: ({ children }) => children,
    useSession: bindSnapshotSelector(sessionStore),
    useSessions: bindSnapshotSelector(createSnapshotStore({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      projectionsBySession: {}, currentAddress: undefined,
    })),
    useSessionStatus: bindSnapshotSelector(
      createSnapshotStore<SessionStatusSnapshot>(new Map()),
    ),
    useSessionRetainInfo: () => undefined,
    useResource,
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })),
    ...allowAllAccess,
    useProjection: (() => undefined),
    useConversation: bindSnapshotSelector(createSnapshotStore(conversationSnapshot())),
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    addFiles: () => null,
    useFileUploads: bindSnapshotSelector(createSnapshotStore({})),
    retryFileUpload: undefined,
    removeAttachment: () => {},
    // Every id resolves so the bar's registry prune never drops a test image.
    resolveDraftAttachments: ids => ids.map(id => ({
      kind: 'image' as const, id,
      file: new File([Uint8Array.of(1)], `${id}.png`, { type: 'image/png' }),
      previewUrl: `blob:${id}`,
    })),
    useBusyEnter: bindSnapshotSelector(createSnapshotStore<'queue' | 'steer'>('queue')),
    toggleCommandMenu: (selection) => {
      const snapshot = shell.snapshot
      controller.toggleSource('command', {
        trigger: '/',
        query: '',
        quoted: false,
        position: snapshot.draft.slice(0, selection.start).trim() === '' ? 'leading' : 'inline',
        span: { ...selection, draftRev: snapshot.draftRev },
      })
    },
    useNotices: bindSnapshotSelector(shell.notices),
    useLexicon: bindSnapshotSelector(shell.lexicon),
    useMenuLauncher: bindSnapshotSelector(controller.launcher),
    renderSlot: (() => null) as InputBarProps['renderSlot'],
    stop: vi.fn(),
    useStopShortcut: bindSnapshotSelector(createSnapshotStore<readonly string[]>([])),
    t: makeTranslate(zh, commonZh),
    variant: 'composer',
  }
  const view = render(<InputBar {...barProps} />)
  const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
  const type = (text: string): void => {
    act(() => { shell.setDraft(text) })
  }
  /** Press Space and let the claim the key handler applied commit (Lexical commits it on the next microtask). */
  const space = async (): Promise<void> => {
    fireEvent.keyDown(textarea, { key: ' ', keyCode: 32 })
    await act(async () => {})
  }
  /** Type at the live caret, as keyboard input after the claimed chip does. */
  const append = (text: string): void => {
    act(() => { shell.actions.insertText(text, shell.actions.captureInsertion()) })
  }
  /** Dispatch one character deletion and commit it (the command's update lands on the next flush). */
  const deleteCharacter = (isBackward: boolean): void => {
    act(() => {
      shell.editor.dispatchCommand(DELETE_CHARACTER_COMMAND, isBackward)
      shell.editor.update(() => {}, { discrete: true })
    })
  }
  /** Delete one detect span through the editor, as a Backspace over it does. */
  const erase = (start: number, end: number): void => {
    act(() => {
      shell.editor.update(() => { $replaceDetectSpanWithText({ start, end }, '') }, { discrete: true })
    })
  }
  return {
    runtime, inputTriggers, controller, shell, wiring, view, textarea,
    type, space, append, erase, deleteCharacter, sink, serialize, release,
  }
}

async function bench(executeImpl?: (line: string) => Promise<SubmitOutcome>) {
  const execute = vi.fn(executeImpl ?? ((line: string) =>
    Promise.resolve({ kind: 'success' as const, text: `已执行 ${line}` })))
  const { source, executed, envelopes } = commandSource(COMMANDS, execute)
  const base = await scopedBench((inputTriggers) => { inputTriggers.registerSource(source) })
  return { ...base, execute, executed, envelopes }
}

describe('scenario A: menu-pick /goal, type args, enter submits', () => {
  it('runs the whole claim chain through the real pipeline', async () => {
    const b = await bench()
    b.type('/go')
    // Candidates land async; the menu opens with the goal row.
    await vi.waitFor(() => {
      const menu = b.controller.menu.getSnapshot()
      expect(menu.open).toBe(true)
      expect(menu.groups[0]?.items.map((i: { name: string }) => i.name)).toContain('goal')
    })
    // Pointer pick (menu path executes through the bound target inside the pipeline).
    act(() => { b.controller.pick('command', 0) })
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.shell.snapshot.draft).toBe('/goal ')
    expect(b.view.container.querySelector('[data-composer-command]')?.textContent).toBe('/goal')
    // The zh dictionary owns a hint.goal entry, which overrides the machine's raw hint (production behavior).
    expect(b.textarea.style.getPropertyValue('--dsh-composer-hint')).toBe(JSON.stringify('输入目标，智能体将持续执行'))
    // Continue typing args; hint drops; claim holds.
    b.append('发布 v1')
    expect(b.shell.snapshot.phase).toBe('claimed')
    // Enter: submitting → command execute → commit clears.
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 发布 v1', []) })
    await vi.waitFor(() => { expect(b.shell.snapshot.draft).toBe('') })
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.view.getByText('已执行 /goal 发布 v1')).toBeTruthy()
    expect(b.sink).not.toHaveBeenCalled()
  })
})

describe('scenario C: pasted /goal xxx + enter (menu never opened)', () => {
  it('adjudicates on enter, claims and submits in one stroke', async () => {
    const b = await bench()
    // Paste lands whole; caret at end means detectTrigger sees no token under
    // the caret mid-whitespace — menu stays closed; enter runs adjudication.
    act(() => { b.shell.setDraft('/goal 尽快发布') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 尽快发布', []) })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.shell.snapshot.draft).toBe('')
    expect(b.sink).not.toHaveBeenCalled()
  })
})

describe('scenario D: execute-kind /compact', () => {
  it('menu pick executes immediately without touching the draft machine phase', async () => {
    const b = await bench()
    b.type('/comp')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    act(() => { b.controller.pick('command', 0) })
    // 'handled': no claim, machine still plain; the source ran the detached execute.
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.executed).toContain('/compact')
  })

  it('bare /compact + enter executes; trailing text falls to the default sink (scenario I twin)', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/compact') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.executed).toContain('/compact') })
    // 'handled' flows back as the adjudicated event one microtask later.
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    cleanup()
    const b2 = await bench()
    act(() => { b2.shell.setDraft('/compact 现在') })
    fireEvent.keyDown(b2.textarea, { key: 'Enter' })
    // execute with trailing → matchEnter answers undefined → default sink.
    await vi.waitFor(() => { expect(b2.sink).toHaveBeenCalledWith('/compact 现在', [], 'queue', expect.any(AbortSignal), expect.any(Function)) })
    expect(b2.executed).toHaveLength(0)
  })
})

describe('scenario: images ride an accepting command through the real pipeline', () => {
  it('adjudication reports the image count; the claim chain serializes, submits, and consumes', async () => {
    const b = await bench()
    act(() => { b.shell.addAttachments(['img-1' as DraftAttachmentId]) })
    act(() => { b.shell.setDraft('/vision 这张图是什么') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/vision 这张图是什么', [PNG]) })
    // The envelope the controller forwarded to matchEnter carried the count.
    expect(b.envelopes).toEqual([{ attachments: 1 }])
    expect(b.serialize).toHaveBeenCalledWith(['img-1'])
    await vi.waitFor(() => { expect(b.shell.snapshot.draft).toBe('') })
    expect(b.release).toHaveBeenCalledWith(['img-1'])
    expect(b.shell.snapshot.attachmentIds).toEqual([])
    expect(b.sink).not.toHaveBeenCalled()
  })

  it('an imageless enter adjudicates with a zero-image envelope', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/goal 发布') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 发布', []) })
    expect(b.envelopes).toEqual([{ attachments: 0 }])
    expect(b.serialize).not.toHaveBeenCalled()
    expect(b.release).not.toHaveBeenCalled()
  })
})

describe('scenario H: the command chip deletes whole', () => {
  it.each(['goal', '目标', 'plan', '计划', 'feedback', '反馈'])('keeps /%s claimed until the chip itself is deleted', async (name) => {
    const { source } = commandSource([{ name, description: name, input: { hint: '目标内容' } }],
      () => Promise.resolve({ kind: 'success' }))
    const b = await scopedBench((triggers) => { triggers.registerSource(source) })
    b.type(`/${name}`)
    await b.space()
    expect(b.shell.snapshot.phase).toBe('claimed')
    b.append('这是目标')
    for (let i = 0; i < 5; i++) {
      const { end } = b.shell.caretSpan()
      b.erase(end - 1, end)
    }
    expect(b.shell.snapshot.draft).toBe(`/${name}`)
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.view.container.querySelector('[data-composer-command]')?.textContent).toBe(`/${name}`)
    b.append(' ')
    await act(async () => {})
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.shell.snapshot.draft).toBe(`/${name} `)
    b.erase(0, 1)
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.shell.snapshot.draft).toBe(' ')
    expect(b.view.container.querySelector('[data-composer-command]')).toBeNull()
  })

  it('the first deletion at the chip edge selects the chip and the second removes it', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.append('发布')
    for (let i = 0; i < 3; i++) {
      const { end } = b.shell.caretSpan()
      b.erase(end - 1, end)
    }
    expect(b.shell.snapshot.draft).toBe('/goal')
    const chip = (): Element | null => b.view.container.querySelector('[data-composer-command]')
    b.deleteCharacter(true)
    expect(chip()?.hasAttribute('data-selected')).toBe(true)
    expect(b.textarea.hasAttribute('data-composer-chip-selected')).toBe(true)
    expect(b.shell.snapshot.phase).toBe('claimed')
    b.deleteCharacter(true)
    expect(chip()).toBeNull()
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.textarea.hasAttribute('data-composer-chip-selected')).toBe(false)
  })

  it('a key that deletes nothing, or typing, clears a selected chip without deleting it', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.erase(1, 2)
    const chip = (): Element | null => b.view.container.querySelector('[data-composer-command]')
    b.deleteCharacter(true)
    expect(chip()?.hasAttribute('data-selected')).toBe(true)
    fireEvent.keyDown(b.textarea, { key: 'Shift' })
    await act(async () => {})
    expect(chip()?.hasAttribute('data-selected')).toBe(true)
    fireEvent.keyDown(b.textarea, { key: 'Escape' })
    await act(async () => {})
    expect(chip()?.hasAttribute('data-selected')).toBe(false)
    expect(b.textarea.hasAttribute('data-composer-chip-selected')).toBe(false)
    b.deleteCharacter(true)
    expect(chip()?.hasAttribute('data-selected')).toBe(true)
    b.append('发布')
    expect(chip()?.hasAttribute('data-selected')).toBe(false)
    expect(b.shell.snapshot.draft).toBe('/goal发布')
    expect(b.shell.snapshot.phase).toBe('claimed')
  })

  it('a platform deletion shortcut keeps the selection its first press made and deletes on the second', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.erase(1, 2)
    const chip = (): Element | null => b.view.container.querySelector('[data-composer-command]')
    // macOS maps Ctrl+H to a backward character deletion inside the same keydown.
    const pressCtrlH = async (): Promise<void> => {
      act(() => {
        fireEvent.keyDown(b.textarea, { key: 'h', ctrlKey: true })
        b.shell.editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true)
        b.shell.editor.update(() => {}, { discrete: true })
      })
      await act(async () => {})
    }
    await pressCtrlH()
    expect(chip()?.hasAttribute('data-selected')).toBe(true)
    await pressCtrlH()
    expect(chip()).toBeNull()
    expect(b.shell.snapshot.phase).toBe('plain')
  })

  it('a deletion input event selects the chip first and lets the second one delete it', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.erase(1, 2)
    const chip = (): Element | null => b.view.container.querySelector('[data-composer-command]')
    // Lexical's default input handling runs below this probe; iOS deletes a ranged
    // deleteContentBackward there directly, so the selecting step must consume it first.
    const reachedDefault = vi.fn(() => false)
    onTestFinished(b.shell.editor.registerCommand(BEFORE_INPUT_COMMAND, reachedDefault, COMMAND_PRIORITY_LOW))
    const deleteByInput = (): InputEvent => {
      const event = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true })
      act(() => {
        b.shell.editor.dispatchCommand(BEFORE_INPUT_COMMAND, event)
        b.shell.editor.update(() => {}, { discrete: true })
      })
      return event
    }
    expect(deleteByInput().defaultPrevented).toBe(true)
    expect(reachedDefault).not.toHaveBeenCalled()
    expect(chip()?.hasAttribute('data-selected')).toBe(true)
    expect(b.shell.snapshot.phase).toBe('claimed')
    deleteByInput()
    expect(reachedDefault).toHaveBeenCalledTimes(1)
    expect(chip()).toBeNull()
    expect(b.shell.snapshot.phase).toBe('plain')
  })

  it('Delete before the chip selects it first and removes it on the second press', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.append('发布')
    act(() => {
      b.shell.editor.update(() => {
        const paragraph = $getRoot().getFirstChild()
        if (!$isElementNode(paragraph)) throw new Error('missing paragraph')
        paragraph.select(0, 0)
      }, { discrete: true })
    })
    const chip = (): Element | null => b.view.container.querySelector('[data-composer-command]')
    b.deleteCharacter(false)
    expect(chip()?.hasAttribute('data-selected')).toBe(true)
    b.deleteCharacter(false)
    expect(chip()).toBeNull()
    expect(b.shell.snapshot.draft).toBe(' 发布')
    expect(b.shell.snapshot.phase).toBe('plain')
  })

  it('keeps text written at the chip boundary out of the chip', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.append('发布')
    // The caret right after the chip: Lexical writes into the argument text.
    act(() => {
      b.shell.editor.update(() => {
        const paragraph = $getRoot().getFirstChild()
        if (!$isElementNode(paragraph)) throw new Error('missing paragraph')
        paragraph.select(1, 1).insertText('立即')
      }, { discrete: true })
    })
    expect(b.shell.snapshot.draft).toBe('/goal立即 发布')
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.view.container.querySelector('[data-composer-command]')?.textContent).toBe('/goal')
  })

  it('deleting the chip releases the claim; the arguments left behind send as a plain message', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    // Space adjudication claims (space column, leadingInput).
    await b.space()
    expect(b.shell.snapshot.phase).toBe('claimed')
    b.append('发布')
    b.erase(0, 1)
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.shell.snapshot.draft).toBe(' 发布')
    expect(b.view.container.querySelector('[data-composer-command]')).toBeNull()
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    expect(b.sink).toHaveBeenCalledWith('发布', [], 'queue', expect.any(AbortSignal), expect.any(Function))
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('typing before the chip turns it into its literal token and releases the claim', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.append('发布')
    act(() => {
      b.shell.editor.update(() => {
        const paragraph = $getRoot().getFirstChild()
        if (!$isElementNode(paragraph)) throw new Error('missing paragraph')
        paragraph.getFirstChild()?.insertBefore($createTextNode('看看 '))
      }, { discrete: true })
    })
    expect(b.shell.snapshot.phase).toBe('plain')
    expect(b.shell.snapshot.draft).toBe('看看 /goal 发布')
    expect(b.view.container.querySelector('[data-composer-command]')).toBeNull()
  })

  it('undoing the chip deletion restores the chip and its claim', async () => {
    const b = await bench()
    b.type('/goal')
    await vi.waitFor(() => { expect(b.controller.menu.getSnapshot().open).toBe(true) })
    await b.space()
    b.append('发布')
    b.erase(0, 1)
    expect(b.shell.snapshot.phase).toBe('plain')
    act(() => {
      b.shell.editor.dispatchCommand(UNDO_COMMAND, undefined)
      b.shell.editor.update(() => {}, { discrete: true }) // the history restore commits on the next flush
    })
    expect(b.shell.snapshot.phase).toBe('claimed')
    expect(b.shell.snapshot.claim?.name).toBe('goal')
    expect(b.shell.snapshot.draft).toBe('/goal 发布')
    expect(b.view.container.querySelector('[data-composer-command]')?.textContent).toBe('/goal')
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.execute).toHaveBeenCalledWith('/goal 发布', []) })
  })
})

describe('scenario: reference decoration follows the current lexicon', () => {
  it('decorates only the current text when its catalog arrives and clears decoration for an empty catalog', async () => {
    let roll: readonly string[] | undefined
    let notify: (() => void) | undefined
    const b = await scopedBench((inputTriggers) => {
      inputTriggers.registerSource({
        trigger: '/', name: 'skill',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        lexicon: () => roll,
        subscribeLexicon: (_session: ClientSessionContext, listener: () => void) => {
          notify = listener
          return () => { notify = undefined }
        },
      } as never)
    })
    b.type('/older now')
    expect(b.view.container.querySelector('[data-composer-text-ref]')).toBeNull()
    b.type('/deploy now')
    const draft = b.shell.draftSnapshot
    expect(b.view.container.querySelector('[data-composer-text-ref]')).toBeNull()
    act(() => {
      roll = ['older']
      notify?.()
    })
    expect(b.controller.lexicon.getSnapshot().get('/')).toEqual(['older'])
    expect(b.view.container.querySelector('[data-composer-text-ref]')).toBeNull()
    act(() => {
      roll = ['older', 'deploy']
      notify?.()
    })
    await vi.waitFor(() => {
      expect(b.view.container.querySelector('[data-composer-text-ref]')?.textContent).toBe('/deploy')
    })
    expect(b.shell.draftSnapshot).toBe(draft)
    act(() => {
      roll = []
      notify?.()
    })
    await vi.waitFor(() => { expect(b.view.container.querySelector('[data-composer-text-ref]')).toBeNull() })
    expect(b.shell.draftSnapshot).toBe(draft)
    expect(b.shell.snapshot.draft).toBe('/deploy now')
  })
})

describe('scenario I: unknown /xyz + enter', () => {
  it('adjudication misses in one hop and the whole line rides the default sink', async () => {
    const b = await bench()
    act(() => { b.shell.setDraft('/xyz 干点啥') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.sink).toHaveBeenCalledWith('/xyz 干点啥', [], 'queue', expect.any(AbortSignal), expect.any(Function)) })
    await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
    expect(b.execute).not.toHaveBeenCalled()
  })

  it('adjudication failure (source warmup throw) notices and keeps the draft', async () => {
    const b = await scopedBench((inputTriggers) => {
      inputTriggers.registerSource({
        trigger: '/', name: 'command',
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        matchEnter: () => Promise.reject(new Error('目录预热失败')),
      } as never)
    })
    act(() => { b.shell.setDraft('/plan 上线') })
    fireEvent.keyDown(b.textarea, { key: 'Enter' })
    await vi.waitFor(() => { expect(b.view.getByText('目录预热失败')).toBeTruthy() })
    // Never a silent downgrade: draft retained, sink untouched.
    expect(b.shell.snapshot.draft).toBe('/plan 上线')
    expect(b.sink).not.toHaveBeenCalled()
  })
})
